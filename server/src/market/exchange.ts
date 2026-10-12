/**
 * ccxt 行情接入层。
 *
 * 只访问**公开**的合约行情接口，无需 API Key：
 *   - loadMarkets / fetchOHLCV / fetchTicker
 *   - 支持 5 家主流交易所的 USDT 本位永续合约，并可在请求失败时自动降级
 *   - 内存 + 磁盘两级缓存，避免重复拉取
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ccxt, { type Exchange as CcxtExchange } from 'ccxt'

import type { Candle, ExchangeId, Instrument, Timeframe } from '../../../shared/types'
import { TIMEFRAME_MS } from '../../../shared/types'
import {
  fetchVisionKlines,
  isVisionAvailable,
  supportsTimeframe as visionSupports,
  toVisionSymbol,
  VISION_EARLIEST_MS,
} from './binanceVision'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = path.resolve(__dirname, '../../../.cache/klines')

/** ccxt 单次请求的最大 K 线根数（保守值，按交易所差异化） */
const MAX_LIMIT: Record<ExchangeId, number> = {
  binanceusdm: 1500,
  okx: 300,
  bybit: 1000,
  bitget: 1000,
  gate: 1000,
}

/**
 * 单次 HTTP 请求超时。10s 是折中值：
 * 足够覆盖跨区域访问正常交易所的抖动，又不会让连不通的数据源
 * 把整体响应拖到几十秒。真正不可达的地址会在 10s 内明确失败。
 */
const DEFAULT_TIMEOUT = 10_000
/** 单次请求最多分页次数，防止参数异常导致无限循环 */
const MAX_PAGES = 400

/**
 * 各交易所允许回溯的最大 K 线根数。
 *
 * 交易所普遍限制「只能取最近 N 根」：
 *   - Gate 期货：超过 10000 根直接报 `Candlestick too long ago`
 *   - Binance 期货：单次窗口约 1500 根，但历史回溯很长，这里给一个保守值
 * 当用户选择的区间超过该上限时，自动收缩到允许范围内并给出提示，
 * 而不是直接把错误抛给用户。
 */
const MAX_LOOKBACK_BARS: Record<ExchangeId, number> = {
  binanceusdm: 20_000,
  okx: 20_000,
  bybit: 20_000,
  bitget: 20_000,
  gate: 10_000,
}

/** 交易所返回的「回溯过久」类错误特征，用于触发自动收缩后重试 */
const TOO_OLD_PATTERNS = [
  /too long ago/i,
  /maximum \d+ points/i,
  /invalid param value/i,
  /start time is invalid/i,
  /time range/i,
]

interface MemoryEntry {
  expires: number
  data: Candle[]
}

const memoryCache = new Map<string, MemoryEntry>()
const MEMORY_TTL_MS = 5 * 60 * 1000

/** 已初始化好的 exchange 实例（markets 只加载一次） */
const instances = new Map<ExchangeId, Promise<CcxtExchange>>()

/**
 * 加载失败的冷却期。
 *
 * 若不冷却，`loadMarkets` 失败的实例会从 instances 中删除，
 * 导致**每次**请求都重新等满一次 10s 超时 —— 这正是
 * /api/instruments 每次都要 20s 的原因之一。
 */
const LOAD_FAIL_COOLDOWN_MS = 2 * 60 * 1000
const loadFailures = new Map<ExchangeId, { until: number; message: string }>()

/** 合约列表内存缓存：列表变化极慢，10 分钟内直接复用 */
const INSTRUMENTS_TTL_MS = 10 * 60 * 1000
const instrumentsCache = new Map<ExchangeId, { expires: number; data: Instrument[] }>()

export class MarketError extends Error {
  readonly exchangeId: ExchangeId
  readonly rootCause: unknown

  constructor(message: string, exchange: ExchangeId, rootCause?: unknown) {
    super(message)
    this.name = 'MarketError'
    this.exchangeId = exchange
    this.rootCause = rootCause
  }
}

/* ------------------------------------------------------------------ */
/* 实例管理                                                            */
/* ------------------------------------------------------------------ */

export function createExchange(id: ExchangeId): CcxtExchange {
  const common = {
    enableRateLimit: true,
    timeout: DEFAULT_TIMEOUT,
    options: { defaultType: 'swap' },
  } as const

  switch (id) {
    case 'binanceusdm':
      return new ccxt.binanceusdm({ ...common, options: { defaultType: 'future' } })
    case 'okx':
      return new ccxt.okx(common)
    case 'bybit':
      return new ccxt.bybit(common)
    case 'bitget':
      return new ccxt.bitget(common)
    case 'gate':
      return new ccxt.gate(common)
    default:
      throw new MarketError(`不支持的交易所: ${id}`, id)
  }
}

async function getInstance(id: ExchangeId): Promise<CcxtExchange> {
  const fail = loadFailures.get(id)
  if (fail && fail.until > Date.now()) {
    throw new MarketError(`${id} 近期连接失败（${fail.message}），冷却中`, id)
  }
  let p = instances.get(id)
  if (!p) {
    p = (async () => {
      const ex = createExchange(id)
      await ex.loadMarkets()
      return ex
    })()
    p.catch((err: unknown) => {
      instances.delete(id)
      loadFailures.set(id, {
        until: Date.now() + LOAD_FAIL_COOLDOWN_MS,
        message: err instanceof Error ? err.message : String(err),
      })
    })
    instances.set(id, p)
  }
  return p
}

/* ------------------------------------------------------------------ */
/* 合约列表                                                            */
/* ------------------------------------------------------------------ */

export interface ListInstrumentsResult {
  instruments: Instrument[]
  /** 实际提供数据的交易所（发生降级时与请求的不同） */
  exchange: ExchangeId
  /** 原始请求的交易所不可用时降级到的交易所 */
  fallbackFrom?: ExchangeId
}

/**
 * 获取合约列表。
 *
 * 与 K 线一样支持自动降级：当请求的交易所不可达（地域限制/网络不通）时，
 * 并发尝试其他交易所，避免整个下拉框因为一家数据源超时而空白。
 *
 * 关键：**谁先成功就立即用谁**，不再用 allSettled 等全部结束。
 * 之前的实现必须等最慢的那家（连不通的源要等满 10s 超时，
 * loadMarkets 内部还可能串行发多个请求，达 20s）结束后才能返回，
 * 即使第一家早就拿到了数据 —— 这就是 /api/instruments 慢 20s 的根因。
 *
 * 为保留数据源偏好，采用错峰启动：排前面的源先发车，
 * 排后面的源延迟 500ms×序号 再启动。这样：
 *   - 首选源可达时，几乎总是它先返回（偏好不丢）；
 *   - 首选源连不通时，最快 1~2s 就能由备选源给出结果。
 */
export async function listInstrumentsWithFallback(
  id: ExchangeId,
  query?: string,
): Promise<ListInstrumentsResult> {
  const errors: string[] = []
  let firstError: unknown

  // 已知可用的降级源优先，其余紧随其后
  const preferred = preferredFallback.get(id)
  const chain = fallbackChain(id)
  const ordered = preferred && preferred !== id
    ? [preferred, ...chain.filter((x) => x !== preferred)]
    : chain

  const tasks = ordered.map(
    (exId, i) =>
      new Promise<{ exId: ExchangeId; instruments: Instrument[] }>((resolve, reject) => {
        setTimeout(
          () => {
            listInstruments(exId, query).then(
              (instruments) => {
                if (instruments.length === 0) reject(new Error(`${exId} 未返回任何合约`))
                else resolve({ exId, instruments })
              },
              (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
            )
          },
          INSTRUMENT_STAGGER_MS * i,
        )
      }),
  )

  // 任意一家成功即返回；全部失败时才汇总错误
  const winner = await new Promise<{ exId: ExchangeId; instruments: Instrument[] }>(
    (resolve, reject) => {
      let remaining = tasks.length
      tasks.forEach((p, i) => {
        p.then(resolve, (err: unknown) => {
          if (!firstError) firstError = err
          errors.push(`${ordered[i]}: ${err instanceof Error ? err.message : String(err)}`)
          if (--remaining === 0) {
            reject(
              new MarketError(
                `全部交易所均无法获取合约列表。\n${errors.join('\n')}`,
                id,
                firstError,
              ),
            )
          }
        })
      })
    },
  )

  if (winner.exId !== id) preferredFallback.set(id, winner.exId)
  return {
    instruments: winner.instruments,
    exchange: winner.exId,
    fallbackFrom: winner.exId === id ? undefined : id,
  }
}

/** 错峰启动间隔：靠后的数据源晚一点发车，见 listInstrumentsWithFallback 注释 */
const INSTRUMENT_STAGGER_MS = 500

export async function listInstruments(id: ExchangeId, query?: string): Promise<Instrument[]> {
  let cache = instrumentsCache.get(id)
  if (!cache || cache.expires < Date.now()) {
    const ex = await getInstance(id)
    cache = { expires: Date.now() + INSTRUMENTS_TTL_MS, data: buildInstruments(ex) }
    instrumentsCache.set(id, cache)
  }
  const out = filterInstruments(cache.data, query)
  return out
}

/** 从已加载的 markets 构建合约列表（不做查询过滤） */
function buildInstruments(ex: CcxtExchange): Instrument[] {
  const out: Instrument[] = []
  for (const m of Object.values(ex.markets ?? {})) {
    if (!m) continue
    if (!m.active) continue
    if (!m.swap) continue
    if (m.linear === false) continue
    if (m.quote !== 'USDT' && m.settle !== 'USDT') continue
    const symbol = m.symbol
    if (!symbol || !symbol.includes(':USDT')) continue
    const label = `${m.base}/${m.quote}`
    out.push({
      symbol,
      id: m.id,
      base: m.base ?? '',
      quote: m.quote ?? '',
      label,
      type: m.type ?? 'swap',
      maxLeverage: typeof m.limits?.leverage?.max === 'number' ? m.limits.leverage.max : undefined,
      pricePrecision: typeof m.precision?.price === 'number' ? m.precision.price : undefined,
      amountPrecision: typeof m.precision?.amount === 'number' ? m.precision.amount : undefined,
      contractSize: typeof m.contractSize === 'number' ? m.contractSize : undefined,
      linear: m.linear,
    })
  }

  // USDT 本位永续按成交活跃度大致排序：先主流币，再按字母序
  const priority = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'TON']
  out.sort((a, b) => {
    const ia = priority.indexOf(a.base)
    const ib = priority.indexOf(b.base)
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
    return a.symbol.localeCompare(b.symbol)
  })
  return out
}

/** 按关键字过滤合约列表（base / 符号 / 显示名） */
function filterInstruments(list: Instrument[], query?: string): Instrument[] {
  const q = (query ?? '').trim().toUpperCase()
  if (!q) return list
  return list.filter(
    (i) => i.symbol.toUpperCase().includes(q) || i.label.includes(q) || i.base.includes(q),
  )
}

/* ------------------------------------------------------------------ */
/* K 线拉取                                                            */
/* ------------------------------------------------------------------ */

export interface FetchKlinesOptions {
  exchange: ExchangeId
  symbol: string
  timeframe: Timeframe
  /** 起始时间（毫秒）。缺省时按 until - 目标根数 推算 */
  since?: number
  /** 结束时间（毫秒，含）。缺省为当前时间 */
  until?: number
  /** 目标根数上限，用于给 since 兜底 */
  targetBars?: number
  /** 是否使用缓存 */
  useCache?: boolean
}

export interface FetchKlinesResult {
  candles: Candle[]
  cached: boolean
  exchange: ExchangeId
  /** 主交易所失败时降级到的备选交易所 */
  fallbackFrom?: ExchangeId
  /** 因交易所回溯上限而收缩区间时的说明 */
  clampNote?: string
  /** 实际数据来源标签，如 'Binance Data Vision（全历史现货）' */
  sourceLabel?: string
}

const ALL_EXCHANGES: ExchangeId[] = ['binanceusdm', 'okx', 'bybit', 'bitget', 'gate']

/**
 * 记住每家「请求的交易所」上一次真正取到数据的交易所。
 * 这样在某个数据源被网络/地域限制时，后续请求可以直接命中可用源，不必重复等待超时。
 */
const preferredFallback = new Map<ExchangeId, ExchangeId>()

/** 备选交易所顺序：用户指定的优先，其次是用过可用的，最后是其余 */
function fallbackChain(primary: ExchangeId): ExchangeId[] {
  const chain: ExchangeId[] = [primary]
  const preferred = preferredFallback.get(primary)
  if (preferred && preferred !== primary) chain.push(preferred)
  for (const x of ALL_EXCHANGES) if (!chain.includes(x)) chain.push(x)
  return chain
}

export async function fetchKlines(opts: FetchKlinesOptions): Promise<FetchKlinesResult> {
  // 关键：until 不能超过当前时间。
  // 前端常把 until 设为「当天 23:59」，在当天早些时候这仍是未来时间；
  // 若把未来时间交给交易所，分页游标会推进到未来，交易所会以
  // `from greater than to` / `Invalid param` 拒绝请求。
  const requestedUntil = opts.until ?? Date.now()
  const now = Date.now()
  const until = Math.min(requestedUntil, now)
  const tfMs = TIMEFRAME_MS[opts.timeframe]
  const targetBars = Math.max(200, opts.targetBars ?? 3000)
  let since = Math.min(opts.since ?? until - targetBars * tfMs, until)
  let clampNote: string | undefined
  let truncatedFuture = requestedUntil > now

  // 缓存键的时间按周期向下取整：until 通常是 Date.now()，毫秒级漂移会让
  // 每次请求都落到不同的键上（旧的磁盘缓存就是这么膨胀起来的，见 cachePrefixFor 注释）。
  const cachePrefix = cachePrefixFor(opts.exchange, opts.symbol, opts.timeframe)
  const cacheKey = `${cachePrefix}${alignFloor(since, tfMs)}_${alignFloor(until, tfMs)}`
  if (opts.useCache !== false) {
    const mem = memoryCache.get(cacheKey)
    if (mem && mem.expires > Date.now()) {
      return { candles: mem.data, cached: true, exchange: opts.exchange }
    }
    const disk = findDiskCache(cachePrefix, since, until, tfMs)
    if (disk) {
      memoryCache.set(cacheKey, { expires: Date.now() + MEMORY_TTL_MS, data: disk })
      return { candles: disk, cached: true, exchange: opts.exchange }
    }
  }

  const chain = fallbackChain(opts.exchange)
  const errors: string[] = []

  /**
   * 收缩区间到交易所允许的最大回溯窗口。
   *
   * 关键：交易所的「最近 N 根」是相对**当前时间**（now）计算的，
   * 而不是相对请求里的 until。若用 `until - maxBars*tfMs` 去算，
   * 当 until 比 now 稍晚时（很常见，因为 until 常取当天 23:59），
   * 会把 since 收缩到交易所真实最早时间**之后**，触发
   * `from greater than to` 而被拒绝。
   *
   * 这里改为以 now 为基准，并额外留 2 根 K 线的安全边际。
   */
  const clampToLookback = (exId: ExchangeId): boolean => {
    const maxBars = MAX_LOOKBACK_BARS[exId] ?? 20_000
    const base = Math.min(until, Date.now())
    const earliest = base - Math.max(1, maxBars - 2) * tfMs
    if (since >= earliest) return false
    const dropped = Math.floor((earliest - since) / tfMs)
    since = earliest
    clampNote =
      `${exId} 仅支持最近约 ${maxBars.toLocaleString()} 根 K 线，` +
      `已自动收缩回测区间（向前截去约 ${dropped.toLocaleString()} 根）。`
    return true
  }

  const done = (candles: Candle[], exId: ExchangeId): FetchKlinesResult => {
    // 用收缩后的 since 作为最终缓存键，便于后续命中
    const finalKey = `${cachePrefix}${alignFloor(since, tfMs)}_${alignFloor(until, tfMs)}`
    memoryCache.set(finalKey, { expires: Date.now() + MEMORY_TTL_MS, data: candles })
    writeDiskCache(cachePrefix, since, until, tfMs, candles)
    if (exId !== opts.exchange) preferredFallback.set(opts.exchange, exId)
    let note = clampNote
    if (truncatedFuture) {
      const extra = `结束时间晚于当前时间，已按当前时刻截断到 ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC。`
      note = note ? `${note} ${extra}` : extra
      truncatedFuture = false
    }
    return {
      candles,
      cached: false,
      exchange: exId,
      fallbackFrom: exId === opts.exchange ? undefined : opts.exchange,
      clampNote: note,
    }
  }

  /**
   * Binance Vision 全历史源的成功收尾。
   *
   * 这里的交易所标记仍写作 `binanceusdm`，因为对使用者而言
   * 「Binance 系数据」是一个整体概念；差异通过 sourceLabel 与
   * warnings 明确告知，且价格本身就是同源的现货价。
   */
  const doneVision = (candles: Candle[]): FetchKlinesResult => {
    const visionPrefix = cachePrefixFor('vision', opts.symbol, opts.timeframe)
    const finalKey = `${visionPrefix}${alignFloor(since, tfMs)}_${alignFloor(until, tfMs)}`
    memoryCache.set(finalKey, { expires: Date.now() + MEMORY_TTL_MS, data: candles })
    writeDiskCache(visionPrefix, since, until, tfMs, candles)

    const from = candles[0].timestamp
    const to = candles[candles.length - 1].timestamp
    const days = Math.round((to - from) / 86400_000)
    let note =
      `行情取自 Binance Data Vision 全历史镜像（${toVisionSymbol(opts.symbol)} 现货，` +
      `覆盖 ${new Date(from).toISOString().slice(0, 10)} 至 ${new Date(to).toISOString().slice(0, 10)}，` +
      `共 ${candles.length.toLocaleString()} 根 / ${days} 天），` +
      `不受交易所「最近 N 根」限制，交易样本更完整。`
    if (truncatedFuture) {
      const extra = `结束时间晚于当前时间，已按当前时刻截断到 ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC。`
      note = `${note} ${extra}`
      truncatedFuture = false
    }

    return {
      candles,
      cached: false,
      exchange: opts.exchange,
      clampNote: note,
      sourceLabel: 'Binance Data Vision（全历史现货）',
    }
  }

  const attempt = async (exId: ExchangeId): Promise<Candle[]> => {
    clampToLookback(exId)
    try {
      const candles = await fetchFromExchange(exId, opts.symbol, opts.timeframe, since, until)
      if (candles.length === 0) throw new Error(`${exId} 返回空数据`)
      return candles
    } catch (err) {
      // 交易所仍报「回溯过久」时，说明其实际上限比声明的更紧：再收缩重试一次。
      // 同样以 now 为基准，避免 until 偏晚导致的 from > to。
      const msg = err instanceof Error ? err.message : String(err)
      if (isTooOldError(msg)) {
        const maxBars = MAX_LOOKBACK_BARS[exId] ?? 20_000
        const tighter = Math.floor(maxBars * 0.9)
        const base = Math.min(until, Date.now())
        const earliest = base - tighter * tfMs
        if (earliest > since) {
          since = earliest
          clampNote =
            `${exId} 仅支持近期 K 线，已自动收缩回测区间到最近约 ${tighter.toLocaleString()} 根。`
          const candles = await fetchFromExchange(exId, opts.symbol, opts.timeframe, since, until)
          if (candles.length === 0) throw new Error(`${exId} 返回空数据`)
          return candles
        }
      }
      throw err
    }
  }

  /* ---------- 0) 全历史源优先：Binance Data Vision ---------- */
  // 它没有「最近 N 根」限制，能覆盖 2017 年至今全部历史，
  // 因此当请求区间超出 ccxt 交易所的回溯上限时，先走这条路径，
  // 让 TradingView 上能看到的样本在这里同样拿得到。
  //
  // 判定用的是「实际会用的交易所」的上限：用户可能选了 binanceusdm，
  // 但本机连不通、真正会降级到 gate（10000 根），此时必须按 gate 的上限判断，
  // 否则会误以为 20000 根够用，从而错过全历史源。
  const requiredBars = Math.ceil((until - since) / tfMs)
  const effectiveExchange = preferredFallback.get(opts.exchange) ?? opts.exchange
  const effectiveCap = Math.min(
    MAX_LOOKBACK_BARS[opts.exchange] ?? 20_000,
    MAX_LOOKBACK_BARS[effectiveExchange] ?? 20_000,
  )
  const visionEligible =
    requiredBars > effectiveCap * 0.9 &&
    visionSupports(opts.timeframe) &&
    since >= VISION_EARLIEST_MS - 86400_000

  if (visionEligible && (await isVisionAvailable())) {
    try {
      const candles = await fetchVisionKlines({
        symbol: opts.symbol,
        timeframe: opts.timeframe,
        since,
        until,
      })
      if (candles.length >= 200) return doneVision(candles)
      errors.push(`binance-vision: 仅返回 ${candles.length} 根，不足以计算指标`)
    } catch (err) {
      errors.push(`binance-vision: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 1) 再单独尝试用户指定的交易所
  const [primary, ...rest] = chain
  try {
    return done(await attempt(primary), primary)
  } catch (err) {
    errors.push(`${primary}: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2) 主源不可用时，其余交易所并行竞速，取最先成功的一家，
  //    避免被多个连不通的数据源依次超时拖慢（常见于地域/网络限制）。
  if (rest.length > 0) {
    const settled = await Promise.allSettled(rest.map((exId) => attempt(exId)))
    let winnerIndex = -1
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i]
      if (r.status === 'fulfilled') {
        winnerIndex = i
        break
      }
      errors.push(`${rest[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
    }
    if (winnerIndex >= 0) {
      const r = settled[winnerIndex] as PromiseFulfilledResult<Candle[]>
      return done(r.value, rest[winnerIndex])
    }
  }

  throw new MarketError(
    `全部交易所均无法获取 ${opts.symbol} ${opts.timeframe} 的行情数据。\n${errors.join('\n')}`,
    opts.exchange,
    errors,
  )
}

/** 判断是否是「区间回溯过久」类错误 */
function isTooOldError(message: string): boolean {
  return TOO_OLD_PATTERNS.some((re) => re.test(message))
}

async function fetchFromExchange(
  exId: ExchangeId,
  symbol: string,
  timeframe: Timeframe,
  since: number,
  until: number,
): Promise<Candle[]> {
  const ex = await getInstance(exId)

  if (!ex.markets?.[symbol]) {
    // 尝试用统一符号匹配一次
    const alt = Object.keys(ex.markets ?? {}).find(
      (s) => s.toUpperCase() === symbol.toUpperCase(),
    )
    if (!alt) throw new Error(`${exId} 不存在合约 ${symbol}`)
    symbol = alt
  }

  const limit = MAX_LIMIT[exId]
  const tfMs = TIMEFRAME_MS[timeframe]
  const all: Candle[] = []
  let cursor = since
  let pages = 0

  while (cursor <= until && pages < MAX_PAGES) {
    pages++
    const batch = (await ex.fetchOHLCV(symbol, timeframe, cursor, limit)) as number[][]
    if (!batch || batch.length === 0) break

    for (const row of batch) {
      const ts = row[0]
      if (ts == null || ts > until) continue
      const c: Candle = {
        timestamp: ts,
        open: row[1],
        high: row[2],
        low: row[3],
        close: row[4],
        volume: row[5] ?? 0,
      }
      if (
        !Number.isFinite(c.open) ||
        !Number.isFinite(c.high) ||
        !Number.isFinite(c.low) ||
        !Number.isFinite(c.close) ||
        c.close <= 0
      ) {
        continue
      }
      all.push(c)
    }

    // 注意：不能用「返回条数 < limit」来判断结束。
    // 多数交易所会自行收敛单次条数（例如 Gate 期货实际上限为 999，而声明值更大），
    // 用条数判断会导致分页在第一页就提前终止、只取到很短的区间。
    // 正确的终止条件：已覆盖到 until，或时间游标不再前进。
    const lastTs = batch[batch.length - 1][0]
    if (lastTs >= until) break
    const next = lastTs + tfMs
    if (next <= cursor) break
    cursor = next
  }

  // 去重 + 升序
  const seen = new Set<number>()
  const dedup: Candle[] = []
  for (const c of all) {
    if (seen.has(c.timestamp)) continue
    seen.add(c.timestamp)
    dedup.push(c)
  }
  dedup.sort((a, b) => a.timestamp - b.timestamp)
  return dedup
}

export interface LastPriceResult {
  price: number
  /** 实际给出报价的交易所（可能已降级） */
  exchange: ExchangeId
}

/** 当前成交价，用于展示。与 K 线一致支持自动降级。 */
export async function fetchLastPrice(
  exchange: ExchangeId,
  symbol: string,
): Promise<LastPriceResult | null> {
  for (const exId of fallbackChain(exchange)) {
    try {
      const ex = await getInstance(exId)
      const t = await ex.fetchTicker(symbol)
      const p = t.last ?? t.close
      if (typeof p === 'number' && Number.isFinite(p)) {
        if (exId !== exchange) preferredFallback.set(exchange, exId)
        return { price: p, exchange: exId }
      }
    } catch {
      // 换下一个数据源
    }
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 磁盘缓存                                                            */
/* ------------------------------------------------------------------ */

/** 磁盘缓存有效期 */
const DISK_TTL_MS = 24 * 3600 * 1000
/** 同一「数据源 + 品种 + 周期」最多保留的缓存文件数（按修改时间淘汰旧的） */
const MAX_CACHE_FILES = 3

function sanitizeCachePart(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** 缓存文件名前缀：`数据源_品种_周期_`，例如 binanceusdm_BTC_USDT_USDT_1h_ */
function cachePrefixFor(source: string, symbol: string, timeframe: string): string {
  return `${sanitizeCachePart(source)}_${sanitizeCachePart(symbol)}_${sanitizeCachePart(timeframe)}_`
}

/** 按周期向下取整到 bar 边界 */
function alignFloor(t: number, tfMs: number): number {
  return Math.floor(t / tfMs) * tfMs
}

/**
 * 缓存文件名：`<前缀><起>_<止>.json`，时间取整到 bar 边界。
 *
 * 旧实现直接把毫秒级 since/until 拼进文件名，而 until 通常是 Date.now()，
 * 于是**每次回测**都会写一个约 1MB 的新文件（实测一天 158 个 / 141MB），
 * 且两个源（vision / binanceusdm）各写一份。取整后同一根 bar 内重复运行
 * 会落在同一个文件上。
 */
function cacheFileNameFor(prefix: string, since: number, until: number, tfMs: number): string {
  return `${prefix}${alignFloor(since, tfMs)}_${alignFloor(until, tfMs)}.json`
}

/** 从缓存文件名解析其覆盖范围（毫秒），不符合命名规则时返回 null */
function parseCacheRange(file: string, prefix: string): { since: number; until: number } | null {
  if (!file.startsWith(prefix) || !file.endsWith('.json')) return null
  const m = /_(\d+)_(\d+)\.json$/.exec(file)
  if (!m) return null
  return { since: Number(m[1]), until: Number(m[2]) }
}

function readCandlesFile(file: string): Candle[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Candle[]
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 查找可复用的磁盘缓存。
 *
 * 命中条件（缺一不可）：
 *  - 文件名前缀相同（同数据源 + 品种 + 周期）
 *  - 覆盖请求区间：起点不晚于请求的第一根 bar，终点不早于请求的最后一根 bar
 *  - 未超过 24 小时有效期
 *
 * 多个候选时优先取范围最小的（冗余最少）；读取后还会用文件内
 * 实际 K 线范围复核一次，避免文件名与实际内容不一致。
 */
function findDiskCache(prefix: string, since: number, until: number, tfMs: number): Candle[] | null {
  let names: string[]
  try {
    names = fs.readdirSync(CACHE_DIR)
  } catch {
    return null
  }

  const headBar = Math.ceil(since / tfMs) * tfMs
  const tailBar = alignFloor(until, tfMs)
  const now = Date.now()

  const candidates: { file: string; since: number; until: number }[] = []
  for (const name of names) {
    const range = parseCacheRange(name, prefix)
    if (!range) continue
    if (range.since > headBar || range.until < tailBar) continue
    const file = path.join(CACHE_DIR, name)
    try {
      if (now - fs.statSync(file).mtimeMs > DISK_TTL_MS) continue
    } catch {
      continue
    }
    candidates.push({ file, ...range })
  }
  candidates.sort((a, b) => a.until - a.since - (b.until - b.since))

  for (const c of candidates) {
    const data = readCandlesFile(c.file)
    if (!data) continue
    if (data[0].timestamp > headBar) continue
    if (data[data.length - 1].timestamp < tailBar) continue
    // 延长有效期，让活跃缓存不被淘汰
    try {
      const stamp = new Date()
      fs.utimesSync(c.file, stamp, stamp)
    } catch {
      /* 忽略 */
    }
    // 裁剪到请求区间：缓存文件可能覆盖得更宽（头部多出的是更长的预热历史），
    // 这里保证返回值与「未命中、重新拉取」时完全一致。
    return data.filter((c) => c.timestamp >= since && c.timestamp <= until)
  }
  return null
}

function writeDiskCache(
  prefix: string,
  since: number,
  until: number,
  tfMs: number,
  data: Candle[],
): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    const file = path.join(CACHE_DIR, cacheFileNameFor(prefix, since, until, tfMs))
    fs.writeFileSync(file, JSON.stringify(data), 'utf8')
    pruneDiskCache(prefix, file)
  } catch {
    // 缓存写入失败不影响主流程
  }
}

/** 同一前缀只保留最新的 MAX_CACHE_FILES 个文件，避免缓存目录无限膨胀 */
function pruneDiskCache(prefix: string, keepFile: string): void {
  try {
    const files = fs
      .readdirSync(CACHE_DIR)
      .filter((name) => parseCacheRange(name, prefix) !== null)
      .map((name) => {
        const file = path.join(CACHE_DIR, name)
        return { file, mtime: fs.statSync(file).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)

    files.forEach((f, i) => {
      if (f.file === keepFile || i < MAX_CACHE_FILES) return
      try {
        fs.unlinkSync(f.file)
      } catch {
        /* 忽略 */
      }
    })
  } catch {
    /* 忽略 */
  }
}

export function clearMemoryCache(): void {
  memoryCache.clear()
}

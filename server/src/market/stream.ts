/**
 * 实时行情流（ccxt.pro WebSocket）。
 *
 * 作用：给价格类警报提供秒级价格更新，并在 K 线收盘后**立刻**把指标 / Pine 条件判掉，
 * 不必等下一次 REST 轮询。消费者见 `alerts/monitor.ts`。
 *
 * 订阅按「交易所 + 品种（+ 周期）」增量维护：只有被启用的警报需要的订阅才会存在，
 * 警报增删改后由 `alerts/monitor.refreshSubscriptions()` 做 diff，没有订阅时不占连接。
 *
 * ## 本机实测踩过的两个坑
 *
 * 1. **走代理时必须用 `wssProxy`，不能只用 `wsProxy`**。交易所行情流是 `wss://`，
 *    ccxt 把这两个开关分开处理：只设 `wsProxy` 时 wss 连接会绕过代理直连，
 *    被墙时表现为 `socket hang up`（binance）/ 代理返回 `301`（bybit）、`403`（bitget）。
 *    正确的组合是 REST 引导用 `httpsProxy`、行情流用 `wssProxy`（实测 5 家全通）。
 * 2. **必须显式 `loadMarkets()`**。部分交易所（实测 okx）的 `watch*` 不会自动加载
 *    市场信息，不先加载会抛 `markets not loaded`。
 *
 * 断线由 `watch*` 抛错暴露，这里做指数退避重连（ccxt 内部会重新订阅）。退避期间
 * 缓存会变旧，`alerts/evaluator.createSnapshot()` 检测到不新鲜就回落 REST 取数，
 * 因此 WS 挂掉只会让延迟退回到轮询级别，不会漏警报。
 */

import ccxt from 'ccxt'
import type { Candle, ExchangeId, Timeframe } from '../../../shared/types'
import { TIMEFRAME_MS } from '../../../shared/types'
import type { AlertStreamStatus } from '../../../shared/types'
import { fetchKlines, resolveProxyUrl } from './exchange'

/** OHLCV 订阅播种的历史根数：满足 Pine 脚本 500 根的暖机需求 */
export const SEED_BARS = 500
/** 内存中滚动窗口的保留上限（避免长跑后无限增长） */
const MAX_BUFFER = 800
/** 重连退避区间 */
const RECONNECT_MIN_MS = 2_000
const RECONNECT_MAX_MS = 30_000
/** ticker 新鲜度阈值：超过就认为 WS 没在推进，回落 REST */
const TICKER_STALE_MS = 15_000

/** 各交易所的默认合约类型，与 `market/exchange.createExchange()` 保持一致 */
const EXCHANGE_OPTIONS: Record<ExchangeId, { defaultType: string }> = {
  binanceusdm: { defaultType: 'future' },
  okx: { defaultType: 'swap' },
  bybit: { defaultType: 'swap' },
  bitget: { defaultType: 'swap' },
  gate: { defaultType: 'swap' },
}

/** 只声明用到的部分，避免依赖 ccxt 的深层类型（其 .d.ts 未声明 wsProxy/wssProxy） */
interface ProExchangeLike {
  loadMarkets: (reload?: boolean) => Promise<unknown>
  watchTicker: (symbol: string) => Promise<{ last?: number; close?: number }>
  watchOHLCV: (symbol: string, timeframe?: string) => Promise<number[][]>
  unwatchTicker?: (symbol: string) => Promise<unknown>
  unwatchOHLCV?: (symbol: string, timeframe?: string) => Promise<unknown>
  close: () => Promise<void>
}

/** 一条订阅：ticker 只要最新价；ohlcv 维护滚动 K 线窗口 */
export interface StreamSubscription {
  exchange: ExchangeId
  symbol: string
  kind: 'ticker' | 'ohlcv'
  timeframe?: Timeframe
}

/** 订阅更新事件的形状（监听者据此决定要重算哪些警报） */
export interface StreamUpdate {
  exchange: ExchangeId
  symbol: string
  kind: 'ticker' | 'ohlcv'
  timeframe?: Timeframe
}

type UpdateListener = (u: StreamUpdate) => void

interface ActiveSub {
  spec: StreamSubscription
  cancelled: boolean
}

interface TickerEntry {
  price: number
  /** 收到该价格的本地时间 */
  at: number
}

interface OhlcvEntry {
  candles: Candle[]
  /** 最近一次收到 WS 报文的本地时间；0 = 尚未收到过 WS 数据 */
  at: number
}

/* ------------------------------------------------------------------ */
/* 内部状态                                                            */
/* ------------------------------------------------------------------ */

const instances = new Map<ExchangeId, Promise<ProExchangeLike>>()
const subs = new Map<string, ActiveSub>()
const tickerCache = new Map<string, TickerEntry>()
const ohlcvCache = new Map<string, OhlcvEntry>()
const activeExchanges = new Map<ExchangeId, number>()
const listeners = new Set<UpdateListener>()

let lastMessageAt: number | undefined
let lastError: string | undefined

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const tickerKey = (ex: ExchangeId, symbol: string): string => `${ex}|${symbol}`
const ohlcvKey = (ex: ExchangeId, symbol: string, tf: Timeframe): string => `${ex}|${symbol}|${tf}`
const subKey = (s: StreamSubscription): string => `${s.exchange}|${s.symbol}|${s.kind}|${s.timeframe ?? ''}`

/** 懒加载并复用每个交易所的 pro 实例（含一次 loadMarkets） */
function getInstance(id: ExchangeId): Promise<ProExchangeLike> {
  const hit = instances.get(id)
  if (hit) return hit
  const p = (async () => {
    const proxy = resolveProxyUrl()
    const Ctor = (ccxt.pro as unknown as Record<ExchangeId, new (o: Record<string, unknown>) => ProExchangeLike>)[id]
    const ex = new Ctor({
      enableRateLimit: true,
      options: EXCHANGE_OPTIONS[id],
      // REST 引导走 httpsProxy；wss:// 行情流必须显式走 wssProxy（见文件头说明）
      ...(proxy ? { httpsProxy: proxy, wssProxy: proxy } : {}),
    })
    await ex.loadMarkets()
    return ex
  })()
  instances.set(id, p)
  // 加载失败不能把 rejected 的 Promise 长期缓存住，否则后续重试会立刻失败
  p.catch(() => {
    if (instances.get(id) === p) instances.delete(id)
  })
  return p
}

function markAlive(id: ExchangeId): void {
  const now = Date.now()
  activeExchanges.set(id, now)
  lastMessageAt = now
}

function emit(u: StreamUpdate): void {
  for (const cb of listeners) {
    try {
      cb(u)
    } catch {
      /* 监听者自己的异常不影响行情流 */
    }
  }
}

/** 注册订阅更新监听；返回取消注册的函数 */
export function onStreamUpdate(cb: UpdateListener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/**
 * 把一批 K 线按时间戳并入滚动窗口（ccxt 的 watchOHLCV 可能重复推送整段缓存）。
 *
 * 键必须与 `streamCandles` 的读取键一致（`ohlcvKey`）—— 原先写入用的是订阅键
 * （`subKey`，多一段 kind），读的时候却按 `ohlcvKey` 查，导致 `streamCandles`
 * 永远查不到数据、WS 优先的路径静默退回 REST 轮询。
 */
function mergeOhlcv(
  exchange: ExchangeId,
  symbol: string,
  timeframe: Timeframe,
  raw: readonly number[][],
): void {
  const key = ohlcvKey(exchange, symbol, timeframe)
  const merged = new Map<number, Candle>()
  for (const c of ohlcvCache.get(key)?.candles ?? []) merged.set(c.timestamp, c)
  for (const bar of raw) {
    const ts = Number(bar[0])
    if (!Number.isFinite(ts)) continue
    merged.set(ts, {
      timestamp: ts,
      open: Number(bar[1]),
      high: Number(bar[2]),
      low: Number(bar[3]),
      close: Number(bar[4]),
      volume: Number(bar[5]) || 0,
    })
  }
  const candles = [...merged.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_BUFFER)
  ohlcvCache.set(key, { candles, at: Date.now() })
}

/** 订阅后用 REST 播种一次历史 K 线，让指标 / Pine 立刻有足够暖机数据 */
async function seedCandles(spec: StreamSubscription, tf: Timeframe): Promise<void> {
  try {
    const res = await fetchKlines({
      exchange: spec.exchange,
      symbol: spec.symbol,
      timeframe: tf,
      targetBars: SEED_BARS,
      useCache: true,
    })
    mergeOhlcv(
      spec.exchange,
      spec.symbol,
      tf,
      res.candles.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]),
    )
  } catch (err) {
    // 播种失败不致命：WS 自己会推增量，REST 兜底也照常可用
    lastError = `K 线播种失败 ${spec.exchange} ${spec.symbol} ${tf}：${
      err instanceof Error ? err.message : String(err)
    }`
  }
}

/** 一条订阅的收发循环：断线退避重连，取消后退出并主动退订 */
async function runLoop(entry: ActiveSub, key: string): Promise<void> {
  const spec = entry.spec
  let backoff = RECONNECT_MIN_MS
  let seeded = false

  while (!entry.cancelled) {
    try {
      const ex = await getInstance(spec.exchange)
      if (entry.cancelled) break

      if (spec.kind === 'ticker') {
        const t = await ex.watchTicker(spec.symbol)
        const p = t.last ?? t.close
        if (typeof p === 'number' && Number.isFinite(p)) {
          tickerCache.set(tickerKey(spec.exchange, spec.symbol), { price: p, at: Date.now() })
          markAlive(spec.exchange)
          emit({ exchange: spec.exchange, symbol: spec.symbol, kind: 'ticker' })
        }
      } else {
        const tf = spec.timeframe ?? '1h'
        if (!seeded) {
          seeded = true
          await seedCandles(spec, tf)
        }
        const raw = await ex.watchOHLCV(spec.symbol, tf)
        if (Array.isArray(raw) && raw.length > 0) {
          mergeOhlcv(spec.exchange, spec.symbol, tf, raw)
          markAlive(spec.exchange)
          emit({ exchange: spec.exchange, symbol: spec.symbol, kind: 'ohlcv', timeframe: tf })
        }
      }
      backoff = RECONNECT_MIN_MS
    } catch (err) {
      if (entry.cancelled) break
      lastError = `WS ${spec.exchange} ${spec.symbol} ${spec.kind}${
        spec.timeframe ? `/${spec.timeframe}` : ''
      }：${err instanceof Error ? err.message : String(err)}`
      await sleep(backoff)
      backoff = Math.min(RECONNECT_MAX_MS, backoff * 2)
    }
  }

  subs.delete(key)
  // 主动退订，别在连接上留下没人消费的流（失败就算了，进程退出时连接一起关）
  try {
    const ex = await getInstance(spec.exchange)
    if (spec.kind === 'ticker') await ex.unwatchTicker?.(spec.symbol)
    else await ex.unwatchOHLCV?.(spec.symbol, spec.timeframe)
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 多来源订阅注册表：`来源名 → 该来源当前需要的订阅`。
 *
 * 原实现是「声明式全量覆盖」（谁调用 `syncSubscriptions` 谁就把别人的订阅全顶掉），
 * 而 `alerts/monitor.ts` 每一轮轮询都会用它自己那份覆盖一次 —— 图表侧若直接调用，
 * 下一个 monitor tick 就会把图表的订阅取消掉。改为各来源各占一路，由这里取并集
 * 后再走下面的增量 diff。
 */
const subscriptionSources = new Map<string, readonly StreamSubscription[]>()

/** 注册/更新某个来源的订阅集合（空数组 = 该来源退订全部） */
export function setSubscriptionSource(name: string, subs: readonly StreamSubscription[]): void {
  if (subs.length === 0) subscriptionSources.delete(name)
  else subscriptionSources.set(name, subs)
  applySubscriptions()
}

/**
 * 把订阅集合同步到 `desired`（增量 diff：新增的开启、不再需要的取消）。
 * 等价于把「警报」这一路来源设为 `desired`，保留给原调用者使用。
 */
export function syncSubscriptions(desired: readonly StreamSubscription[]): void {
  setSubscriptionSource('alerts', desired)
}

/** 按注册表里的并集做增量 diff */
function applySubscriptions(): void {
  const want = new Map<string, StreamSubscription>()
  for (const list of subscriptionSources.values()) {
    for (const s of list) want.set(subKey(s), s)
  }

  for (const [key, entry] of subs) {
    if (!want.has(key)) entry.cancelled = true
  }
  for (const [key, spec] of want) {
    if (subs.has(key)) continue
    const entry: ActiveSub = { spec, cancelled: false }
    subs.set(key, entry)
    // 兜一层 catch：fire-and-forget 的 Promise 若 reject 会变成未处理拒绝并可能带崩进程
    void runLoop(entry, key).catch((err) => {
      lastError = `WS 订阅异常 ${spec.exchange} ${spec.symbol}：${
        err instanceof Error ? err.message : String(err)
      }`
    })
  }
}

/** 当前缓存的实时价格；无订阅或已过期（`TICKER_STALE_MS`）时返回 null */
export function streamPrice(exchange: ExchangeId, symbol: string, now = Date.now()): number | null {
  const hit = tickerCache.get(tickerKey(exchange, symbol))
  if (!hit) return null
  return now - hit.at <= TICKER_STALE_MS ? hit.price : null
}

/**
 * 当前缓存的滚动 K 线窗口；未收到过 WS 数据、或窗口明显落后于当前时刻时返回 null。
 *
 * 「落后」判定：距最近一条 WS 报文不超过 1 分钟，或最后一根 K 线的开盘时间距今不超过
 * 两个周期（后者照顾 1w 这类报文很稀疏的长周期）。
 */
export function streamCandles(
  exchange: ExchangeId,
  symbol: string,
  timeframe: Timeframe,
  now = Date.now(),
): Candle[] | null {
  const hit = ohlcvCache.get(ohlcvKey(exchange, symbol, timeframe))
  if (!hit || hit.at === 0 || hit.candles.length === 0) return null
  const fresh =
    now - hit.at <= 60_000 ||
    hit.candles[hit.candles.length - 1].timestamp + 2 * TIMEFRAME_MS[timeframe] >= now
  return fresh ? hit.candles : null
}

/** WS 行情流状态（供 /api/alerts 展示） */
export function streamStatus(now = Date.now()): AlertStreamStatus {
  let tickerSubscriptions = 0
  let ohlcvSubscriptions = 0
  for (const entry of subs.values()) {
    if (entry.cancelled) continue
    if (entry.spec.kind === 'ticker') tickerSubscriptions += 1
    else ohlcvSubscriptions += 1
  }
  const active: ExchangeId[] = []
  for (const [id, at] of activeExchanges) if (now - at <= 60_000) active.push(id)
  return {
    tickerSubscriptions,
    ohlcvSubscriptions,
    activeExchanges: active,
    ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
  }
}

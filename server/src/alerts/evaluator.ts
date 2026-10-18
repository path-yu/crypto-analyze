/**
 * 警报条件判定。
 *
 * 设计要点：
 *  - **全部条件都是「边沿触发」**：只有从未满足变为满足的那一刻才算触发，
 *    避免行情贴着阈值来回抖动时每 tick 都推一条消息。
 *  - **同一根 K 线只判一次**：指标 / Pine 类条件按「已收盘 K 线」的开盘时间
 *    （`state.lastBarTime`）去重，同一根 K 线内重复轮询不会重复触发。
 *  - **以创建时刻为起点**：首次判定只把当时那根已收盘 K 线记为基线（不推送），
 *    因此警报只对「创建之后收盘」的 K 线负责，不会因为创建前那根刚好带信号就立刻推一条。
 *    指标 / Pine 类仍会取足够长的历史做暖机（Pine 500 根），否则脚本根本算不出信号。
 *  - 判定失败（行情接口异常 / 脚本报错）不算触发，只把原因写进 `state.lastError`，
 *    面板上会显示出来，方便排查。
 */

import type {
  AlertCondition,
  AlertRuntimeState,
  Candle,
  ExchangeId,
  PriceAlert,
  Timeframe,
} from '../../../shared/types'
import { TIMEFRAME_MS, describeAlertCondition } from '../../../shared/types'
import { fetchKlines, fetchLastPrice } from '../market/exchange'
import { SEED_BARS, streamCandles, streamPrice } from '../market/stream'
import { atr, ema, rsi, sma } from '../indicators/ta'
import { runPineTsSignals, type PineSignal } from '../pine'
import { listPineScripts } from '../pine/store'

/** 一次判定的结果 */
export interface AlertEvaluation {
  /** 是否应推送 */
  fire: boolean
  /** 判定得到的当前值（价格或指标值），用于渲染提示信息 */
  value: number
  /** 写回运行期状态的补丁 */
  state: Partial<AlertRuntimeState>
  /**
   * Pine 类专用：本根 K 线上**实际命中**的信号方向（做多开仓 / 做空开仓 / 平仓）。
   *
   * `PineSignal` 只有布尔位、不含任何文字，所以「脚本里到底发生了什么」只能由信号位翻译。
   * 提示信息据此把「Pine 任意信号」换成具体方向；非 Pine 类或该根无信号时为空。
   */
  signalNote?: string
  /** 判定失败的原因；有值时 `fire` 必为 false */
  error?: string
}

/* ------------------------------------------------------------------ */
/* 行情快照                                                            */
/* ------------------------------------------------------------------ */

/**
 * 同一次判定内、同一「交易所 + 品种」共用的行情快照。
 *
 * 取数**优先走 WebSocket 缓存**（`market/stream.ts`）：价格是秒级的，K 线在收盘瞬间
 * 就已更新；只有 WS 没订阅 / 数据过期时才回落 REST。因此 WS 挂掉只会让延迟退回
 * 轮询级别，不会漏警报。
 */
export interface MarketSnapshot {
  exchange: ExchangeId
  symbol: string
  lastPrice(): Promise<number | null>
  candles(timeframe: Timeframe, bars: number): Promise<Candle[]>
  pine(opts: {
    scriptId: string
    source: string
    timeframe: Timeframe
    bars: number
  }): Promise<PineSignal[]>
}

export function createSnapshot(exchange: ExchangeId, symbol: string): MarketSnapshot {
  let pricePromise: Promise<number | null> | null = null
  const candleCache = new Map<string, Promise<Candle[]>>()
  const pineCache = new Map<string, Promise<PineSignal[]>>()

  const getCandles = (timeframe: Timeframe, bars: number): Promise<Candle[]> => {
    // WS 缓存优先：新鲜且根数够就直接用，省掉一次 REST 请求
    const cached = streamCandles(exchange, symbol, timeframe)
    if (cached && cached.length >= Math.min(bars, SEED_BARS)) return Promise.resolve(cached)

    const key = `${timeframe}:${bars}`
    const hit = candleCache.get(key)
    if (hit) return hit
    const p = fetchKlines({
      exchange,
      symbol,
      timeframe,
      targetBars: bars,
      // 同一根 K 线内复用缓存：指标只看已收盘 K 线，缓存不影响正确性，还能省接口
      useCache: true,
    }).then((r) => r.candles)
    candleCache.set(key, p)
    return p
  }

  return {
    exchange,
    symbol,
    lastPrice() {
      const live = streamPrice(exchange, symbol)
      if (live !== null) return Promise.resolve(live)
      pricePromise ??= fetchLastPrice(exchange, symbol).then((r) => r?.price ?? null)
      return pricePromise
    },
    candles: getCandles,
    pine(opts) {
      const key = `${opts.scriptId}:${opts.timeframe}:${opts.bars}`
      const hit = pineCache.get(key)
      if (hit) return hit
      const p = (async () => {
        const candles = await getCandles(opts.timeframe, opts.bars)
        const run = await runPineTsSignals(opts.source, candles, {
          tickerId: `${exchange}:${symbol}`,
          timeframe: opts.timeframe,
        })
        const err = run.diagnostics.find((d) => d.severity === 'error')
        if (err) throw new Error(`Pine 脚本执行失败：${err.message}`)
        return run.signals
      })()
      pineCache.set(key, p)
      return p
    },
  }
}

/** 最近一根**已收盘** K 线的下标；数据不足时返回 -1 */
function lastClosedIndex(candles: readonly Candle[], timeframe: Timeframe, now: number): number {
  const tfMs = TIMEFRAME_MS[timeframe]
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].timestamp + tfMs <= now) return i
  }
  return -1
}

/* ------------------------------------------------------------------ */
/* 判定                                                                */
/* ------------------------------------------------------------------ */

const PRICE_KINDS = new Set<AlertCondition['kind']>([
  'priceCrossUp',
  'priceCrossDown',
  'priceRise',
  'priceFall',
])

function indicatorSeries(cond: AlertCondition, candles: readonly Candle[]): number[] {
  const closes = candles.map((c) => c.close)
  const period = cond.period ?? 14
  switch (cond.indicator) {
    case 'sma':
      return sma(closes, period)
    case 'ema':
      return ema(closes, period)
    case 'rsi':
      return rsi(closes, period)
    case 'atr':
      return atr(
        candles.map((c) => c.high),
        candles.map((c) => c.low),
        closes,
        period,
      )
    case 'close':
    default:
      return closes
  }
}

/** 指标类需要的 K 线根数：至少 200 根（fetchKlines 的下限）+ 周期余量 */
function barsFor(cond: AlertCondition): number {
  const period = cond.period ?? 14
  return Math.max(200, Math.round(period * 8))
}

/** Pine 类需要的 K 线根数：脚本大多有 100~200 根的暖机需求 */
const PINE_BARS = 500

export function pineScriptSource(id?: string): { id: string; name: string; source: string } | null {
  const scripts = listPineScripts()
  if (scripts.length === 0) return null
  if (id) {
    const hit = scripts.find((s) => s.id === id)
    return hit ? { id: hit.id, name: hit.name, source: hit.source } : null
  }
  const first = scripts[0]
  return { id: first.id, name: first.name, source: first.source }
}

/**
 * 把一根 K 线上的脚本信号翻译成中文方向标签。
 *
 * `PineSignal` 只有 `canLong / canShort / forceClose` 三个布尔位（由脚本的券商账本折算而来），
 * 脚本里的文字（`alertcondition` / `plotshape(..., text=…)`）既不逐 bar 绑定、多数脚本也没写，
 * 所以「脚本里发生了什么」只能由这三个位描述；同根同时命中多个时用 ` + ` 连接。
 */
function pineDirectionLabel(sig: PineSignal): string {
  const parts: string[] = []
  if (sig.canLong) parts.push('做多开仓')
  if (sig.canShort) parts.push('做空开仓')
  if (sig.forceClose) parts.push('平仓')
  return parts.join(' + ')
}

/** 判定单条警报 */
export async function evaluateAlert(
  alert: PriceAlert,
  snap: MarketSnapshot,
  now = Date.now(),
): Promise<AlertEvaluation> {
  const cond = alert.condition
  const st: AlertRuntimeState = alert.state ?? {}
  const baseState: Partial<AlertRuntimeState> = { checkedAt: now, lastError: undefined }

  try {
    /* ---------------- 价格类 ---------------- */
    if (PRICE_KINDS.has(cond.kind)) {
      const price = await snap.lastPrice()
      if (price === null || !Number.isFinite(price)) throw new Error('无法获取最新成交价')
      const th = Number(cond.value)

      if (cond.kind === 'priceCrossUp' || cond.kind === 'priceCrossDown') {
        const prev = st.lastPrice
        const up = cond.kind === 'priceCrossUp'
        // 首次观测只记录基准，不触发（否则建完警报立刻就会因为「已在阈值上方」而推送）
        const fire = prev !== undefined && (up ? prev < th && price >= th : prev >= th && price < th)
        return { fire, value: price, state: { ...baseState, lastPrice: price, lastValue: price } }
      }

      // 涨 / 跌幅：基准价在首次观测时记录，触发后重置（下一次要再走一个 N% 才会触发）
      let base = st.basePrice
      if (base === undefined || !Number.isFinite(base) || base <= 0) {
        return { fire: false, value: price, state: { ...baseState, basePrice: price, lastPrice: price, lastValue: price } }
      }
      const changePct = ((price - base) / base) * 100
      const rising = cond.kind === 'priceRise'
      const fire = rising ? changePct >= th : changePct <= -th
      return {
        fire,
        value: price,
        state: {
          ...baseState,
          basePrice: fire ? price : base,
          lastPrice: price,
          lastValue: price,
        },
      }
    }

    /* ---------------- 指标类 ---------------- */
    if (cond.kind === 'indicatorCrossUp' || cond.kind === 'indicatorCrossDown') {
      const bars = barsFor(cond)
      const candles = await snap.candles(alert.timeframe, bars)
      const idx = lastClosedIndex(candles, alert.timeframe, now)
      if (idx < 1) throw new Error('K 线数据不足，无法计算指标')

      // 同一根已收盘 K 线只判一次。去重必须排在算指标之前 —— WS 每次行情推送都会
      // 触发一次判定，而只要最后一根收盘 K 线没变，结果必然相同，没必要重算。
      const barTime = candles[idx].timestamp
      if (st.lastBarTime === barTime) {
        return { fire: false, value: candles[idx].close, state: { ...baseState } }
      }

      const series = indicatorSeries(cond, candles)
      const cur = series[idx]
      const prev = series[idx - 1]
      if (!Number.isFinite(cur)) throw new Error('指标尚无有效值（K 线根数不够）')

      const th = Number(cond.value)
      const up = cond.kind === 'indicatorCrossUp'
      const matched = Number.isFinite(prev)
        ? up
          ? prev <= th && cur > th
          : prev >= th && cur < th
        : false
      // 首次判定（刚创建 / 刚改过条件）只建立基线：创建前就已经收盘的那根 K 线
      // 即便命中也不推送 —— 警报只对「创建之后收盘」的 K 线负责
      const baseline = st.lastBarTime === undefined
      return {
        fire: baseline ? false : matched,
        value: cur,
        state: { ...baseState, lastBarTime: barTime, lastMatched: matched, lastValue: cur },
      }
    }

    /* ---------------- Pine 信号类 ---------------- */
    // 与指标类同理：先定位最后一根已收盘 K 线并去重，同一根 K 线内不重复跑脚本。
    // PineTS 要跑完 500 根 K 线，WS 高频推送下若不去重会明显吃 CPU。
    const candles = await snap.candles(alert.timeframe, PINE_BARS)
    const idx = lastClosedIndex(candles, alert.timeframe, now)
    if (idx < 0) throw new Error('K 线数据不足，无法判定脚本信号')
    const barTime = candles[idx].timestamp
    if (st.lastBarTime === barTime) {
      return { fire: false, value: candles[idx].close, state: { ...baseState } }
    }

    const script = pineScriptSource(cond.pineScriptId)
    if (!script) {
      throw new Error(
        cond.pineScriptId ? '指定的 Pine 脚本不存在（可能已被删除）' : '没有可用的 Pine 脚本，请先在左侧保存一份',
      )
    }
    const signals = await snap.pine({
      scriptId: script.id,
      source: script.source,
      timeframe: alert.timeframe,
      bars: PINE_BARS,
    })
    if (idx >= signals.length) throw new Error('K 线数据不足，无法判定脚本信号')

    const sig = signals[idx]
    const matched =
      cond.kind === 'pineEntryLong'
        ? sig.canLong
        : cond.kind === 'pineEntryShort'
          ? sig.canShort
          : cond.kind === 'pineExit'
            ? Boolean(sig.forceClose)
            : sig.canLong || sig.canShort || Boolean(sig.forceClose)

    // 同指标类：首次判定只建基线，创建前那根已收盘 K 线上的信号不推送
    const baseline = st.lastBarTime === undefined
    return {
      fire: baseline ? false : matched,
      value: candles[idx].close,
      // 无论是否命中都带上方向：命中时进提示信息，「条件自测」也能看到这根到底出了什么信号
      signalNote: pineDirectionLabel(sig),
      state: { ...baseState, lastBarTime: barTime, lastMatched: matched, lastValue: candles[idx].close },
    }
  } catch (err) {
    return {
      fire: false,
      value: alert.state?.lastValue ?? 0,
      state: { checkedAt: now, lastError: err instanceof Error ? err.message : String(err) },
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/* ------------------------------------------------------------------ */
/* 提示信息渲染                                                        */
/* ------------------------------------------------------------------ */

/**
 * 自动文案（用户没填提示信息时使用）。
 *
 * Pine 类不走「警报名 · 条件标签」那套：条件标签固定是「Pine 任意信号」，看不出多空，
 * 所以署名换成**脚本名**、并优先用本次实际命中的方向（`signalNote`）。
 * 方向拿不到时（例如「测试推送」没有跑脚本）退回条件标签。
 */
export function autoMessage(
  alert: PriceAlert,
  value: number,
  signalNote?: string,
): { title: string; body: string } {
  const name = alert.name?.trim() || alert.symbol
  const cond = alert.condition
  const scriptName = cond.kind.startsWith('pine')
    ? pineScriptSource(cond.pineScriptId)?.name?.trim()
    : undefined
  const direction = signalNote?.trim()

  const title = `${scriptName || name} · ${direction || describeAlertCondition(cond)}`
  const body = direction
    ? `${alert.symbol} 出现「${direction}」信号`
    : `${alert.symbol} 触发「${describeAlertCondition(cond)}」，当前值 ${value}`
  return { title, body }
}

/**
 * 渲染提示信息：把 `{symbol}` `{price}` `{value}` `{name}` `{time}` `{condition}` 替换成实际值。
 * 未填写提示信息时回落到自动文案（Pine 类会带上脚本名与实际信号方向，无需手填）。
 */
export function renderMessage(
  alert: PriceAlert,
  value: number,
  at: number,
  signalNote?: string,
): { title: string; body: string } {
  const fallback = autoMessage(alert, value, signalNote)
  const template = (alert.message ?? '').trim()
  if (!template) return fallback

  const replace = (t: string): string =>
    t
      .replaceAll('{symbol}', alert.symbol)
      .replaceAll('{name}', alert.name?.trim() || alert.symbol)
      .replaceAll('{price}', String(value))
      .replaceAll('{value}', String(value))
      .replaceAll('{condition}', describeAlertCondition(alert.condition))
      .replaceAll('{time}', new Date(at).toLocaleString('zh-CN', { hour12: false }))

  // 单行 = 只当标题；多行 = 首行为标题，其余为正文
  const lines = replace(template).split('\n')
  if (lines.length === 1) {
    return { title: lines[0].trim() || fallback.title, body: `当前值 ${value} · ${alert.symbol}` }
  }
  return { title: lines[0].trim() || fallback.title, body: lines.slice(1).join('\n').trim() }
}

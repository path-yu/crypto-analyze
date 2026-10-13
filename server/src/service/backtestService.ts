/**
 * 业务编排层：拉取行情 → 计算指标 → 运行回测 → 汇总报告。
 */

import type {
  BacktestResult,
  Candle,
  ExchangeId,
  PineCompileMeta,
  PineDiagnostic,
  StrategyParams,
  Timeframe,
  Trade,
} from '../../../shared/types'
import { DEFAULT_STRATEGY_PARAMS, TIMEFRAME_MS, TIMEFRAMES } from '../../../shared/types'
import { computeFibTrendSeries, type FibTrendSeries } from '../indicators/fibTrendReversal'
import { computeSupertrendSeries, type SupertrendSeries } from '../indicators/supertrend'
import {
  emptyOrderBlockSignal,
  OrderBlockTracker,
  type OrderBlockSignal,
} from '../indicators/orderBlock'
import { compilePineCached } from '../pine/cache'
import { emptyPineSignal, runPineProgram, type PineSignal } from '../pine/execute'
import { runBacktest, type SignalProviderCtx } from '../backtest/engine'
import { computeReport } from '../backtest/metrics'
import { fetchKlines, MarketError } from '../market/exchange'

/**
 * 单次回测允许的最大 K 线根数。
 *
 * 接入 Binance Data Vision 全历史源后，15m 跑满 2 年约需 7 万根，
 * 原先 6 万的限制会把合法请求挡在门外。这里放宽到 20 万根：
 * 内存与计算量仍然可控（20 万根 × 约 100 字节 ≈ 20MB，
 * 指标层为 O(n) 滚动计算），却足以覆盖 15m 两年以上的完整区间。
 */
export const MAX_BARS = 200_000
/** 默认目标根数 */
export const DEFAULT_BARS = 5_000

export interface BacktestRequest {
  exchange?: ExchangeId
  symbol?: string
  timeframe?: Timeframe
  /** 起始时间（毫秒） */
  since?: number
  /** 结束时间（毫秒） */
  until?: number
  /** 未指定 since/until 时使用的目标根数 */
  bars?: number
  params?: Partial<StrategyParams>
  useCache?: boolean
  /** 合约最小变动价位（syminfo.mintick），用于把 slippageTicks 换算成价格 */
  tickSize?: number
  /** Pine 脚本（strategy = 'pine' 时必填） */
  pine?: {
    /** 原始 Pine 源码 */
    source: string
    /** 覆盖脚本内 input.* 默认值（键 = 顶层变量名） */
    inputs?: Record<string, number | boolean | string>
    /** 源文件名（诊断展示用） */
    name?: string
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

function clamp(v: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback
  return Math.min(hi, Math.max(lo, v))
}

/** 合并并校验策略参数 */
export function normalizeParams(input?: Partial<StrategyParams>): StrategyParams {
  const d = DEFAULT_STRATEGY_PARAMS
  const p: StrategyParams = { ...d, ...(input ?? {}) }

  p.sensitivity = clamp(p.sensitivity, 1, 200, d.sensitivity)
  p.atrLength = Math.round(clamp(p.atrLength, 1, 500, d.atrLength))
  p.atrMultiplier = clamp(p.atrMultiplier, 0.1, 50, d.atrMultiplier)
  p.slPercent = clamp(p.slPercent, 0.05, 50, d.slPercent)
  p.riskRewardRatio = clamp(p.riskRewardRatio, 0.1, 50, d.riskRewardRatio)
  p.commissionPercent = clamp(p.commissionPercent, 0, 2, d.commissionPercent)
  p.initialCapital = clamp(p.initialCapital, 10, 1e9, d.initialCapital)
  p.leverage = Math.round(clamp(p.leverage, 1, 125, d.leverage))
  p.positionSizePercent = clamp(p.positionSizePercent, 1, 100, d.positionSizePercent)

  if (!['RMA', 'SMA', 'EMA', 'WMA'].includes(p.atrSmoothing)) p.atrSmoothing = d.atrSmoothing
  if (!['Long Only', 'Short Only', 'Both'].includes(p.tradeDirection)) {
    p.tradeDirection = d.tradeDirection
  }
  if (!['ATR', 'Fixed Percent', 'Trend Switch', 'Zone OCO'].includes(p.exitStrategy)) {
    p.exitStrategy = d.exitStrategy
  }
  p.partialTp = Boolean(p.partialTp)
  p.allowReversePosition = Boolean(p.allowReversePosition)
  p.checkLiquidation = Boolean(p.checkLiquidation)
  // 金字塔式加仓：0 = 不限，其余取 1~20 的整数（1 = 不加仓）
  p.pyramiding = Math.round(clamp(p.pyramiding, 0, 20, d.pyramiding))
  // 滑点：0 = 不模拟（TradingView 的 slippage 以 tick 为单位）
  p.slippageTicks = Math.round(clamp(p.slippageTicks ?? 0, 0, 200, 0))

  // 策略选择与 SuperTrend 参数
  if (
    p.strategy !== 'fib-trend' &&
    p.strategy !== 'supertrend' &&
    p.strategy !== 'order-block' &&
    p.strategy !== 'pine'
  ) {
    p.strategy = d.strategy
  }
  const st = p.supertrend ?? d.supertrend
  p.supertrend = {
    atrPeriod: Math.round(clamp(st.atrPeriod, 1, 500, d.supertrend.atrPeriod)),
    multiplier: clamp(st.multiplier, 0.1, 50, d.supertrend.multiplier),
    useSmaAtr: Boolean(st.useSmaAtr),
    source: ['hl2', 'close', 'open', 'high', 'low'].includes(st.source)
      ? st.source
      : d.supertrend.source,
  }

  // 订单块参数
  const ob = { ...d.orderBlock, ...(p.orderBlock ?? {}) }
  p.orderBlock = {
    atrLen: Math.round(clamp(ob.atrLen, 1, 500, d.orderBlock.atrLen)),
    dispMult: clamp(ob.dispMult, 0.1, 50, d.orderBlock.dispMult),
    volLen: Math.round(clamp(ob.volLen, 1, 500, d.orderBlock.volLen)),
    impVolMult: clamp(ob.impVolMult, 0, 50, d.orderBlock.impVolMult),
    needOpp: Boolean(ob.needOpp),
    needBreak: Boolean(ob.needBreak),
    bodyZone: Boolean(ob.bodyZone),
    maxZones: Math.round(clamp(ob.maxZones, 1, 40, d.orderBlock.maxZones)),
    maxAge: Math.round(clamp(ob.maxAge, 2, 100_000, d.orderBlock.maxAge)),
    firstTouch: Boolean(ob.firstTouch),
    needCandle: Boolean(ob.needCandle),
    useRejection: Boolean(ob.useRejection),
    wickPct: clamp(ob.wickPct, 1, 99, d.orderBlock.wickPct),
    useRetestVol: Boolean(ob.useRetestVol),
    retestVolMax: clamp(ob.retestVolMax, 0.05, 50, d.orderBlock.retestVolMax),
    useTrend: Boolean(ob.useTrend),
    emaLen: Math.round(clamp(ob.emaLen, 2, 2000, d.orderBlock.emaLen)),
    allowLong: Boolean(ob.allowLong),
    allowShort: Boolean(ob.allowShort),
    slBuf: clamp(ob.slBuf, 0, 50, d.orderBlock.slBuf),
    rrTarget: clamp(ob.rrTarget, 0.2, 50, d.orderBlock.rrTarget),
    useBE: Boolean(ob.useBE),
    beAtR: clamp(ob.beAtR, 0.2, 50, d.orderBlock.beAtR),
    maxBars: Math.round(clamp(ob.maxBars, 0, 100_000, d.orderBlock.maxBars)),
  }

  // 订单块策略的固定语义（原脚本 strategy() 声明：pyramiding = 0、
  // 无分批止盈、方向由 allowLong / allowShort 决定、离场为区域止损 + 固定盈亏比）
  if (p.strategy === 'order-block' || p.strategy === 'pine') {
    p.exitStrategy = 'Zone OCO'
    p.partialTp = false
    p.tradeDirection = 'Both'
    p.pyramiding = 1
  }

  return p
}

export async function runBacktestService(req: BacktestRequest): Promise<BacktestResult> {
  const exchange: ExchangeId = req.exchange ?? 'binanceusdm'
  const symbol = (req.symbol ?? 'BTC/USDT:USDT').trim()
  const timeframe: Timeframe = req.timeframe ?? '1h'

  if (!TIMEFRAMES.includes(timeframe)) {
    throw new ValidationError(`不支持的周期: ${timeframe}`)
  }
  if (!symbol) throw new ValidationError('缺少交易对 symbol')

  const rawParams = normalizeParams(req.params)

  // 合约最小变动价位：由前端按所选合约的下单精度传入，用于 slippageTicks → 价格换算
  const rawTick = Number(req.tickSize)
  const tickSize = Number.isFinite(rawTick) && rawTick > 0 ? rawTick : 0
  // SuperTrend 是纯趋势策略：用「趋势反转离场」语义最贴近原 Pine（无 SL/TP）。
  // 强制覆盖退出模式与分批止盈，避免与策略本质冲突。
  const params: typeof rawParams =
    rawParams.strategy === 'supertrend'
      ? {
          ...rawParams,
          exitStrategy: 'Trend Switch',
          partialTp: false,
        }
      : rawParams

  const until = req.until && req.until > 0 ? req.until : Date.now()
  const targetBars = Math.round(clamp(req.bars ?? DEFAULT_BARS, 300, MAX_BARS, DEFAULT_BARS))
  const tfMs = TIMEFRAME_MS[timeframe]
  const since = req.since && req.since > 0 ? req.since : until - targetBars * tfMs

  if (since >= until) throw new ValidationError('起始时间必须早于结束时间')

  const requestedBars = Math.floor((until - since) / tfMs)
  if (requestedBars > MAX_BARS) {
    throw new ValidationError(
      `请求的 K 线数量约 ${requestedBars} 根，超过上限 ${MAX_BARS} 根，请缩短时间范围或使用更大周期`,
    )
  }

  // 指标预热：TSOT 需要 144 根，Fibonacci 通道需要 sensitivity*10 根；SuperTrend 只需 atrPeriod；
  // 订单块需要覆盖「区域最长存活 maxAge」，否则进入回测区间时存活区域会与 TradingView 不一致
  const fibWarmup = Math.max(200, Math.trunc(params.sensitivity * 10) + 20, 144 + 20)
  const stWarmup = Math.max(200, params.supertrend.atrPeriod + 20)
  const obWarmup = Math.max(
    200,
    params.orderBlock.maxAge + 50,
    params.orderBlock.atrLen + 20,
    params.orderBlock.volLen + 20,
    params.orderBlock.emaLen + 20,
  )
  const warmupBars = Math.min(1000, Math.max(fibWarmup, stWarmup, obWarmup))
  const fetchSince = since - warmupBars * tfMs

  const { candles: allCandles, cached, exchange: usedExchange, fallbackFrom, clampNote } = await fetchKlines({
    exchange,
    symbol,
    timeframe,
    since: fetchSince,
    until,
    targetBars: requestedBars + warmupBars,
    useCache: req.useCache,
  })

  if (allCandles.length < 200) {
    throw new ValidationError(
      `仅获取到 ${allCandles.length} 根 K 线，不足以计算指标（至少需要 200 根），请扩大时间范围`,
    )
  }

  // 找到用户请求起始时间对应的下标，之前的部分只用于指标预热、不参与交易
  let tradeFromIndex = 0
  while (tradeFromIndex < allCandles.length && allCandles[tradeFromIndex].timestamp < since) {
    tradeFromIndex++
  }
  if (tradeFromIndex >= allCandles.length - 1) tradeFromIndex = 0

  let series: FibTrendSeries | SupertrendSeries | { signals: OrderBlockSignal[] } | { signals: PineSignal[] }
  /**
   * 订单块策略的信号依赖持仓（原脚本的区域扫描带 `position_size == 0` 条件），
   * 因此不能提前算好：由引擎在每根 K 线收盘、挂单撮合之后回调这里，
   * 再把结果写回 signals[index]，图表标记与统计都读同一份数组。
   */
  let signalProvider: ((index: number, ctx: SignalProviderCtx) => void) | undefined
  /** Pine 编译产物（源码 / TS / 诊断 / 元信息），仅在 strategy = 'pine' 时返回 */
  let pineArtifact:
    | { source: string; ts: string; diagnostics: PineDiagnostic[]; meta: PineCompileMeta }
    | undefined

  if (params.strategy === 'supertrend') {
    series = computeSupertrendSeries(allCandles, params.supertrend)
  } else if (params.strategy === 'order-block') {
    const signals = allCandles.map(() => emptyOrderBlockSignal())
    const tracker = new OrderBlockTracker(allCandles, params.orderBlock, tickSize)
    signalProvider = (index, ctx) => {
      signals[index] = tracker.step(index, ctx.flat)
    }
    series = { signals }
  } else if (params.strategy === 'pine') {
    const source = req.pine?.source
    if (!source || typeof source !== 'string') {
      throw new ValidationError('缺少 Pine 脚本源码（req.pine.source）')
    }
    const comp = compilePineCached(source, { sourceName: req.pine?.name })
    if (!comp.ok) {
      const first = comp.diagnostics.find((d) => d.severity === 'error')
      throw new ValidationError(
        `Pine 脚本编译失败：第 ${first?.line ?? 0} 行第 ${first?.column ?? 0} 列 · ${first?.message ?? '未知错误'}`,
      )
    }
    // 与 order-block 一致：脚本只产信号，撮合仍由引擎的 Zone OCO 通路完成。
    const program = runPineProgram(comp.ts, allCandles, {
      inputs: req.pine?.inputs,
      tickSize,
      timeframe,
    })
    const signals = allCandles.map(() => emptyPineSignal())
    signalProvider = (index, ctx) => {
      signals[index] = program.step(index, ctx)
    }
    series = { signals }
    pineArtifact = {
      source,
      ts: comp.ts,
      diagnostics: comp.diagnostics,
      meta: program.meta,
    }
  } else {
    series = computeFibTrendSeries(allCandles, {
      sensitivity: params.sensitivity,
      atrLength: params.atrLength,
      atrSmoothing: params.atrSmoothing,
      atrMultiplier: params.atrMultiplier,
    })
  }

  const { trades, equityCurve } = runBacktest({
    candles: allCandles,
    series,
    params,
    tradeFromIndex,
    signalProvider,
    tickSize,
  })

  /* -------- 裁剪到用户请求的区间 -------- */
  const candles = allCandles.slice(tradeFromIndex)
  const equity = equityCurve.slice(tradeFromIndex)
  const adjustedTrades: Trade[] = trades.map((t) => ({
    ...t,
    entryIndex: t.entryIndex - tradeFromIndex,
    exitIndex: t.exitIndex - tradeFromIndex,
    fills: t.fills.map((f) => ({ ...f })),
  }))

  const signalPoints = series.signals.slice(tradeFromIndex).map((s, i) => ({
    timestamp: candles[i].timestamp,
    imbaTrendLine: s.imbaTrendLine,
    tsotTrendValue: s.tsotTrendValue,
    atrLongStop: s.atrLongStop,
    atrShortStop: s.atrShortStop,
    canLong: s.canLong,
    canShort: s.canShort,
    supertrendUp: (s as Partial<SupertrendSeries['signals'][number]>).supertrendUp,
    supertrendDn: (s as Partial<SupertrendSeries['signals'][number]>).supertrendDn,
    supertrendDirection: (s as Partial<SupertrendSeries['signals'][number]>).supertrendDirection,
    obStopLoss: (s as Partial<OrderBlockSignal>).obStopLoss,
    obTakeProfit: (s as Partial<OrderBlockSignal>).obTakeProfit,
    entryQty: (s as Partial<PineSignal>).entryQty,
  }))

  const warnings: string[] = []
  if (fallbackFrom) {
    warnings.push(
      `${fallbackFrom} 数据源不可用，已自动切换到 ${usedExchange} 获取行情，价格可能存在细微差异。`,
    )
  }
  if (clampNote) {
    warnings.push(clampNote)
  }
  if (equity.length < candles.length) {
    warnings.push('资金曲线长度与 K 线长度不一致，请检查数据完整性。')
  }

  // 金字塔加仓会显著改变交易笔数：主动提示，避免使用者把
  // 「同一根 K 线出现多笔同向交易」误判为重复计算。
  if (params.pyramiding > 1) {
    const pyraTrades = adjustedTrades.filter(
      (t, i, arr) => arr.some((o, j) => j !== i && o.entryTime === t.entryTime && o.side === t.side),
    ).length
    if (pyraTrades > 0) {
      warnings.push(
        `已启用金字塔式加仓（上限 ${params.pyramiding} 单）：其中 ${pyraTrades} 笔交易是在已有同向持仓时追加的，` +
          `因此同一根 K 线上的开仓会拆成多笔，与 TradingView 的成交明细一致。`,
      )
    }
  }

  const report = computeReport(adjustedTrades, equity, candles, {
    symbol,
    exchange: usedExchange,
    timeframe,
    leverage: params.leverage,
    params,
    warnings,
  })

  return {
    report,
    candles,
    trades: adjustedTrades,
    equityCurve: equity,
    signals: signalPoints,
    meta: {
      exchange: usedExchange,
      fetchedAt: Date.now(),
      dataFrom: candles[0]?.timestamp ?? 0,
      dataTo: candles[candles.length - 1]?.timestamp ?? 0,
      cached,
      strategy: params.strategy,
    },
    pine: pineArtifact,
  }
}

/** 仅取指标序列，用于「只看图不看回测」的轻量场景 */
export async function previewSeries(
  exchange: ExchangeId,
  symbol: string,
  timeframe: Timeframe,
  bars: number,
  params: Partial<StrategyParams>,
): Promise<{ candles: Candle[]; series: FibTrendSeries; exchange: ExchangeId }> {
  const p = normalizeParams(params)
  const until = Date.now()
  const tfMs = TIMEFRAME_MS[timeframe]
  const since = until - bars * tfMs
  const { candles, exchange: used } = await fetchKlines({
    exchange,
    symbol,
    timeframe,
    since,
    until,
    targetBars: bars,
  })
  const series = computeFibTrendSeries(candles, {
    sensitivity: p.sensitivity,
    atrLength: p.atrLength,
    atrSmoothing: p.atrSmoothing,
    atrMultiplier: p.atrMultiplier,
  })
  return { candles, series, exchange: used }
}

export { MarketError }

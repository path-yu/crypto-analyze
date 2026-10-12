/**
 * 绩效统计 —— 根据交易列表与资金曲线计算完整回测报告。
 *
 * 时区约定：按 UTC+8（Asia/Shanghai）切分小时 / 星期 / 月份维度，
 * 便于国内用户阅读。
 */

import type {
  Candle,
  EquityPoint,
  ExchangeId,
  PerformanceReport,
  StrategyParams,
  Timeframe,
  Trade,
  TradeStats,
} from '../../../shared/types'
import { TIMEFRAME_MS } from '../../../shared/types'

const TZ_OFFSET_MS = 8 * 3600 * 1000
const MS_PER_YEAR = 365 * 24 * 3600 * 1000

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** 样本标准差 */
function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

export interface ReportMeta {
  symbol: string
  exchange: ExchangeId
  timeframe: Timeframe
  leverage: number
  params: StrategyParams
  warnings?: string[]
}

export function computeReport(
  trades: readonly Trade[],
  equityCurve: readonly EquityPoint[],
  candles: readonly Candle[],
  meta: ReportMeta,
): PerformanceReport {
  const params = meta.params
  const initialCapital = params.initialCapital
  const startTime = candles.length ? candles[0].timestamp : 0
  const endTime = candles.length ? candles[candles.length - 1].timestamp : 0
  const finalEquity =
    equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialCapital

  const netProfit = finalEquity - initialCapital
  const totalReturnPercent = initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0

  /* ---------------- 年化收益 ---------------- */
  const spanMs = Math.max(1, endTime - startTime)
  const years = spanMs / MS_PER_YEAR
  const growth = initialCapital > 0 ? finalEquity / initialCapital : 1
  let annualizedReturnPercent = 0
  if (years > 0) {
    annualizedReturnPercent =
      growth > 0 ? (Math.pow(growth, 1 / years) - 1) * 100 : -100
  }

  /* ---------------- 最大回撤 ---------------- */
  let maxDrawdownPercent = 0
  let maxDrawdownAbs = 0
  let ddStart = startTime
  let ddEnd = startTime
  let ddBars = 0
  // peakIndex 为当前回撤起点（历史权益峰值）在曲线中的下标
  let peakIndex = 0

  for (let i = 0; i < equityCurve.length; i++) {
    const pt = equityCurve[i]
    if (pt.drawdownAbs <= 1e-12) {
      peakIndex = i
      continue
    }
    if (pt.drawdownAbs > maxDrawdownAbs) {
      maxDrawdownAbs = pt.drawdownAbs
      maxDrawdownPercent = pt.drawdownPercent
      ddStart = equityCurve[peakIndex].timestamp
      ddEnd = pt.timestamp
      ddBars = i - peakIndex
    }
  }

  /* ---------------- 逐 bar 收益序列 ---------------- */
  const barReturns: number[] = []
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity
    const cur = equityCurve[i].equity
    if (prev > 0) barReturns.push(cur / prev - 1)
  }

  const barsPerYear = MS_PER_YEAR / TIMEFRAME_MS[meta.timeframe]
  const retMean = mean(barReturns)
  const retStd = stdev(barReturns)
  const sharpeRatio = retStd > 0 ? (retMean / retStd) * Math.sqrt(barsPerYear) : 0

  const downside = barReturns.filter((r) => r < 0)
  const downStd = stdev(downside)
  const sortinoRatio = downStd > 0 ? (retMean / downStd) * Math.sqrt(barsPerYear) : 0

  const volatilityPercent = retStd * Math.sqrt(barsPerYear) * 100
  const calmarRatio =
    maxDrawdownPercent < 0 ? annualizedReturnPercent / Math.abs(maxDrawdownPercent) : 0

  /* ---------------- 交易统计 ---------------- */
  const stats = computeTradeStats(trades)

  const pnls = trades.map((t) => t.netPnl)
  const pnlStd = stdev(pnls)
  const sqn = pnlStd > 0 ? (Math.sqrt(trades.length) * mean(pnls)) / pnlStd : 0

  /* ---------------- 买入持有基准 ---------------- */
  const firstClose = candles.length ? candles[0].close : 0
  const lastClose = candles.length ? candles[candles.length - 1].close : 0
  const buyHoldReturnPercent = firstClose > 0 ? (lastClose / firstClose - 1) * 100 : 0

  /* ---------------- 交易分析维度 ---------------- */
  const hourMap = new Map<number, { pnl: number; trades: number }>()
  for (let h = 0; h < 24; h++) hourMap.set(h, { pnl: 0, trades: 0 })
  const weekdayMap = new Map<number, { pnl: number; trades: number }>()
  for (let w = 0; w < 7; w++) weekdayMap.set(w, { pnl: 0, trades: 0 })

  for (const t of trades) {
    const d = new Date(t.entryTime + TZ_OFFSET_MS)
    const h = d.getUTCHours()
    const w = d.getUTCDay()
    const he = hourMap.get(h)!
    he.pnl += t.netPnl
    he.trades += 1
    const we = weekdayMap.get(w)!
    we.pnl += t.netPnl
    we.trades += 1
  }

  const hourlyPnl = [...hourMap.entries()]
    .map(([hour, v]) => ({ hour, pnl: v.pnl, trades: v.trades }))
    .sort((a, b) => a.hour - b.hour)
  const weekdayPnl = [...weekdayMap.entries()]
    .map(([weekday, v]) => ({ weekday, pnl: v.pnl, trades: v.trades }))
    .sort((a, b) => a.weekday - b.weekday)

  /* ---------------- 月度收益 ---------------- */
  const monthlyReturns = computeMonthlyReturns(equityCurve, initialCapital)

  /* ---------------- 提示信息 ---------------- */
  const warnings = [...(meta.warnings ?? [])]
  if (trades.length < 30) {
    warnings.push(`样本量偏小（仅 ${trades.length} 笔交易），统计指标参考价值有限。`)
  }
  if (params.leverage > 20) {
    warnings.push(`杠杆 ${params.leverage}x 偏高，实际交易中滑点与资金费率会显著放大亏损。`)
  }
  if (maxDrawdownPercent < -50) {
    warnings.push('最大回撤超过 50%，请谨慎评估风险承受能力。')
  }

  return {
    symbol: meta.symbol,
    exchange: meta.exchange,
    timeframe: meta.timeframe,
    leverage: meta.leverage,
    startTime,
    endTime,
    bars: candles.length,
    params,
    initialCapital,
    finalEquity,
    netProfit,
    totalReturnPercent,
    annualizedReturnPercent,
    maxDrawdownPercent,
    maxDrawdownAbs,
    maxDrawdownStart: ddStart,
    maxDrawdownEnd: ddEnd,
    maxDrawdownBars: ddBars,
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
    sqn,
    volatilityPercent,
    buyHoldReturnPercent,
    stats,
    hourlyPnl,
    weekdayPnl,
    monthlyReturns,
    warnings,
  }
}

export function computeTradeStats(trades: readonly Trade[]): TradeStats {
  const total = trades.length
  let wins = 0
  let losses = 0
  let breakEven = 0
  let grossProfit = 0
  let grossLoss = 0
  let longTrades = 0
  let longWins = 0
  let shortTrades = 0
  let shortWins = 0
  let totalFees = 0
  let totalVolume = 0
  let largestWin = 0
  let largestLoss = 0
  let barsSum = 0
  let maxBarsHeld = 0
  let curWinStreak = 0
  let curLossStreak = 0
  let maxConsecutiveWins = 0
  let maxConsecutiveLosses = 0
  const exitReasonCounts: Record<string, number> = {}

  for (const t of trades) {
    totalFees += t.fee
    // 成交额 = 开仓名义价值 + 各笔平仓名义价值
    totalVolume += t.notional * (1 + t.fills.reduce((a, f) => a + f.portion, 0))
    barsSum += t.barsHeld
    if (t.barsHeld > maxBarsHeld) maxBarsHeld = t.barsHeld

    exitReasonCounts[t.exitReason] = (exitReasonCounts[t.exitReason] ?? 0) + 1

    if (t.side === 'long') {
      longTrades++
    } else {
      shortTrades++
    }

    if (t.netPnl > 0) {
      wins++
      grossProfit += t.netPnl
      if (t.side === 'long') longWins++
      else shortWins++
      if (t.netPnl > largestWin) largestWin = t.netPnl
      curWinStreak++
      curLossStreak = 0
      if (curWinStreak > maxConsecutiveWins) maxConsecutiveWins = curWinStreak
    } else if (t.netPnl < 0) {
      losses++
      grossLoss += Math.abs(t.netPnl)
      if (t.netPnl < largestLoss) largestLoss = t.netPnl
      curLossStreak++
      curWinStreak = 0
      if (curLossStreak > maxConsecutiveLosses) maxConsecutiveLosses = curLossStreak
    } else {
      breakEven++
      curWinStreak = 0
      curLossStreak = 0
    }
  }

  const netProfit = grossProfit - grossLoss
  const avgWin = wins > 0 ? grossProfit / wins : 0
  const avgLoss = losses > 0 ? grossLoss / losses : 0

  return {
    totalTrades: total,
    winningTrades: wins,
    losingTrades: losses,
    breakEvenTrades: breakEven,
    winRate: total > 0 ? (wins / total) * 100 : 0,
    longTrades,
    longWinRate: longTrades > 0 ? (longWins / longTrades) * 100 : 0,
    shortTrades,
    shortWinRate: shortTrades > 0 ? (shortWins / shortTrades) * 100 : 0,
    grossProfit,
    grossLoss,
    netProfit,
    avgTrade: total > 0 ? netProfit / total : 0,
    avgWin,
    avgLoss,
    // 无亏损交易时盈亏比应为无穷大（而非 0，0 会被误读为「非常差」）。
    // 与 profitFactor 的处理保持一致：有盈利才返回 Infinity，否则为 0。
    payoffRatio: avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy: total > 0 ? (wins / total) * avgWin - (losses / total) * avgLoss : 0,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    avgBarsHeld: total > 0 ? barsSum / total : 0,
    maxBarsHeld,
    largestWin,
    largestLoss,
    totalFees,
    totalVolume,
    exitReasonCounts,
  }
}

/** 按自然月聚合资金曲线，得到月度收益率 */
function computeMonthlyReturns(
  equityCurve: readonly EquityPoint[],
  initialCapital: number,
): { month: string; returnPercent: number }[] {
  if (equityCurve.length === 0) return []
  const out: { month: string; returnPercent: number }[] = []
  let curMonth = ''
  let monthStartEquity = initialCapital
  let lastEquity = initialCapital

  for (const pt of equityCurve) {
    const d = new Date(pt.timestamp + TZ_OFFSET_MS)
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    if (key !== curMonth) {
      if (curMonth) {
        out.push({
          month: curMonth,
          returnPercent:
            monthStartEquity > 0 ? (lastEquity / monthStartEquity - 1) * 100 : 0,
        })
      }
      curMonth = key
      monthStartEquity = lastEquity
    }
    lastEquity = pt.equity
  }
  if (curMonth) {
    out.push({
      month: curMonth,
      returnPercent: monthStartEquity > 0 ? (lastEquity / monthStartEquity - 1) * 100 : 0,
    })
  }
  return out
}

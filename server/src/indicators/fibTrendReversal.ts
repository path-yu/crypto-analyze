/**
 * 「Fibonacci Trend Reversals」Pine Script 的信号层移植。
 *
 * 包含两个原始作者模块：
 *   1) Fibonacci Retracement Trend Reversal (AKA [IMBA]Algo by @IMBA_TRADER)
 *   2) TSOT | Trend Strength Over Time © federalTacos5392b
 *
 * 移植时严格保持 Pine 的逐 bar 求值顺序与 na 传播语义。
 */

import type { Candle, SignalBar } from '../../../shared/types'
import {
  atr as atrSeries,
  highest,
  isNa,
  lowest,
  NA,
  percentileNearestRank,
} from './ta'

/** TSOT 用到的短周期集合 */
const TSOT_LENGTHS = [13, 21, 34, 55, 89] as const
/** TSOT 的长周期参考长度 */
const TSOT_BASE_LENGTH = 144

export interface FibTrendInputs {
  /** 脚本里的 Sensitivity（内部 ×10 当作窗口长度） */
  sensitivity: number
  atrLength: number
  atrSmoothing: 'RMA' | 'SMA' | 'EMA' | 'WMA'
  atrMultiplier: number
}

/** 指标层的中间结果，回测引擎与前端绘图都会用到 */
export interface FibTrendSeries {
  imbaTrendLine: number[]
  fib236: number[]
  fib5: number[]
  fib786: number[]
  atr: number[]
  atrLongStop: number[]
  atrShortStop: number[]
  tsotTrendValue: number[]
  tsotBullish: boolean[]
  tsotBearish: boolean[]
  canLong: boolean[]
  canShort: boolean[]
  /** 每个 bar 到图上的信号快照（含 na 的会被保留为 NaN） */
  signals: SignalBar[]
}

/**
 * 计算整套指标与信号。
 *
 * 注意 Pine 中 `is_long_trend` / `is_short_trend` 是 `var`（跨 bar 持久化），
 * 且 `can_long` 的赋值发生在更新这两个变量之前 —— 因此每根 bar 用的是
 * **上一根 bar 结束时**的趋势状态。这里用 state 变量逐 bar 复刻。
 */
export function computeFibTrendSeries(
  candles: readonly Candle[],
  inputs: FibTrendInputs,
): FibTrendSeries {
  const n = candles.length

  const high = candles.map((c) => c.high)
  const low = candles.map((c) => c.low)
  const close = candles.map((c) => c.close)
  const open = candles.map((c) => c.open)

  /* ---------- 1. Fibonacci Retracement Trend Reversal ---------- */
  // sensitivity_input *= 10 后作为 highest/lowest 的窗口
  const window = Math.max(2, Math.trunc(inputs.sensitivity * 10))
  const highLine = highest(high, window)
  const lowLine = lowest(low, window)

  const fib236 = new Array<number>(n).fill(NA)
  const fib5 = new Array<number>(n).fill(NA)
  const fib786 = new Array<number>(n).fill(NA)
  for (let i = 0; i < n; i++) {
    if (isNa(highLine[i]) || isNa(lowLine[i])) continue
    const channelRange = highLine[i] - lowLine[i]
    fib236[i] = highLine[i] - channelRange * 0.236
    fib5[i] = highLine[i] - channelRange * 0.5
    fib786[i] = highLine[i] - channelRange * 0.786
  }
  const imbaTrendLine = fib5

  /* ---------- 2. TSOT | Trend Strength Over Time ---------- */
  const percentileShortHigh = TSOT_LENGTHS.map((len) => percentileNearestRank(high, len, 75))
  const percentileShortLow = TSOT_LENGTHS.map((len) => percentileNearestRank(low, len, 25))
  const highestHigh = percentileNearestRank(high, TSOT_BASE_LENGTH, 75)
  const lowestLow = percentileNearestRank(low, TSOT_BASE_LENGTH, 25)

  /* ---------- 3. ATR SL Finder ---------- */
  const atr = atrSeries(high, low, close, inputs.atrLength, inputs.atrSmoothing)
  const atrLongStop = new Array<number>(n).fill(NA)
  const atrShortStop = new Array<number>(n).fill(NA)
  for (let i = 0; i < n; i++) {
    if (isNa(atr[i])) continue
    const offset = atr[i] * inputs.atrMultiplier
    atrShortStop[i] = high[i] + offset // x  ：空头止损
    atrLongStop[i] = low[i] - offset // x2 ：多头止损
  }

  /* ---------- 4. 逐 bar 求趋势强度与开仓信号 ---------- */
  const tsotTrendValue = new Array<number>(n).fill(NA)
  const tsotBullish = new Array<boolean>(n).fill(false)
  const tsotBearish = new Array<boolean>(n).fill(false)
  const canLongArr = new Array<boolean>(n).fill(false)
  const canShortArr = new Array<boolean>(n).fill(false)

  // Pine 的 var 变量
  let isLongTrend = false
  let isShortTrend = false

  for (let i = 0; i < n; i++) {
    const hh = highestHigh[i]
    const ll = lowestLow[i]

    let countBull = 0
    let countBear = 0
    let weakBullCount = 0
    let weakBearCount = 0

    if (!isNa(hh) && !isNa(ll)) {
      for (const arr of percentileShortHigh) {
        const v = arr[i]
        if (isNa(v)) continue
        if (v > hh) countBull++
        else if (v < ll) countBear++
        else if (v > ll && v < hh) weakBearCount++
      }
      for (const arr of percentileShortLow) {
        const v = arr[i]
        if (isNa(v)) continue
        if (v > hh) countBull++
        else if (v < ll) countBear++
        else if (v < hh && v > ll) weakBullCount++
      }
    }

    const bullStrength =
      10 * (countBull + 0.5 * weakBullCount - 0.5 * weakBearCount - countBear)
    const bearStrength =
      10 * (countBear + 0.5 * weakBearCount - 0.5 * weakBullCount - countBull)
    // 代数上 bearStrength === -bullStrength，因此 currentTrendValue === 2*bullStrength
    const currentTrendValue = bullStrength - bearStrength

    tsotTrendValue[i] = currentTrendValue
    const isBullish = currentTrendValue > 0
    const isBearish = currentTrendValue < 0
    tsotBullish[i] = isBullish
    tsotBearish[i] = isBearish

    // can_long / can_short 使用「上一根 bar 结束时」的 is_*_trend
    const trendLine = imbaTrendLine[i]
    if (!isNa(trendLine)) {
      const c = close[i]
      const o = open[i]
      const cl = c >= trendLine && o < trendLine && !isLongTrend && isBullish
      const cs = c <= trendLine && o > trendLine && !isShortTrend && isBearish
      canLongArr[i] = cl
      canShortArr[i] = cs
      if (cl) {
        isLongTrend = true
        isShortTrend = false
      } else if (cs) {
        isShortTrend = true
        isLongTrend = false
      }
    }
  }

  const signals: SignalBar[] = new Array(n)
  for (let i = 0; i < n; i++) {
    signals[i] = {
      imbaTrendLine: imbaTrendLine[i],
      canLong: canLongArr[i],
      canShort: canShortArr[i],
      tsotBullish: tsotBullish[i],
      tsotBearish: tsotBearish[i],
      tsotTrendValue: tsotTrendValue[i],
      atr: atr[i],
      atrShortStop: atrShortStop[i],
      atrLongStop: atrLongStop[i],
      // SuperTrend 字段在 fib 策略下不适用，统一填 NaN
      supertrendUp: NA,
      supertrendDn: NA,
      supertrendDirection: 0,
    }
  }

  return {
    imbaTrendLine,
    fib236,
    fib5,
    fib786,
    atr,
    atrLongStop,
    atrShortStop,
    tsotTrendValue,
    tsotBullish,
    tsotBearish,
    canLong: canLongArr,
    canShort: canShortArr,
    signals,
  }
}

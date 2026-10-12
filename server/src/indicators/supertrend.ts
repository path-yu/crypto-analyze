/**
 * SuperTrend 策略（KivancOzbilgic 原版 Pine v4 移植）。
 *
 * 与原 Pine 一一对应：
 *   - `atr2 = sma(tr, Periods)`，`atr = changeATR ? atr(Periods) : atr2`
 *   - `up   = src - Multiplier * atr`（多头支撑线）
 *   - `dn   = src + Multiplier * atr`（空头阻力线）
 *   - `up / dn` 的"只升/只降"约束（`close[1] > up1 ? max(up, up1) : up`）
 *   - `trend` 翻转规则：`close < up1` → -1，`close > dn1` → 1
 *   - `buySignal  = trend == 1 and trend[1] == -1`
 *   - `sellSignal = trend == -1 and trend[1] == 1`
 *
 * 输出形态与 fibTrendReversal 对齐：
 *   - `signals[i].canLong / canShort` 直接喂给现有回测引擎
 *   - `signals[i].atrLongStop / atrShortStop` 填上 up / dn（Trend Switch
 *     模式不消费这些字段，但 trade 记录里会留作展示用）
 *   - `signals[i].supertrendUp / supertrendDn / supertrendDirection` 用于前端绘图
 *
 * 入场/离场语义：原脚本没有 strategy.exit，只在趋势翻转时由反向 entry
 * 关闭上一笔仓位。引擎的 `exitStrategy === 'Trend Switch'` 正好对应——
 * 一根 K 线上同时平旧仓并开反向仓，复刻"同 bar 反手"。
 */

import type { Candle } from '../../../shared/types'
import { atr, isNa, NA, trueRange } from './ta'

export interface SupertrendInputs {
  atrPeriod: number
  multiplier: number
  useSmaAtr: boolean
  source: 'hl2' | 'close' | 'open' | 'high' | 'low'
}

/** 与 fibTrendReversal 的 signals 形状兼容，供回测引擎消费 */
export interface SupertrendSignal {
  imbaTrendLine: number
  canLong: boolean
  canShort: boolean
  tsotBullish: boolean
  tsotBearish: boolean
  tsotTrendValue: number
  atr: number
  atrShortStop: number
  atrLongStop: number
  supertrendUp: number
  supertrendDn: number
  supertrendDirection: number
}

export interface SupertrendSeries {
  up: number[]
  dn: number[]
  direction: number[]
  signals: SupertrendSignal[]
}

function pickSource(c: Candle, src: SupertrendInputs['source']): number {
  switch (src) {
    case 'open':
      return c.open
    case 'high':
      return c.high
    case 'low':
      return c.low
    case 'close':
      return c.close
    case 'hl2':
    default:
      return (c.high + c.low) / 2
  }
}

export function computeSupertrendSeries(
  candles: readonly Candle[],
  inputs: SupertrendInputs,
): SupertrendSeries {
  const n = candles.length
  const high = candles.map((c) => c.high)
  const low = candles.map((c) => c.low)
  const close = candles.map((c) => c.close)
  const src = candles.map((c) => pickSource(c, inputs.source))

  // ATR 选择：RMA（`ta.atr`）或 SMA
  const atrArr = inputs.useSmaAtr
    ? (() => {
        // ta.atr 的 SMA 分支：先 tr 再 sma
        const tr = trueRange(high, low, close)
        return (function smaInline(arr: readonly number[], len: number): number[] {
          const out = new Array<number>(arr.length).fill(NA)
          if (len <= 0) return out
          let sum = 0
          for (let i = 0; i < arr.length; i++) {
            sum += arr[i]
            if (i >= len) sum -= arr[i - len]
            if (i >= len - 1) out[i] = sum / len
          }
          return out
        })(tr, inputs.atrPeriod)
      })()
    : atr(high, low, close, inputs.atrPeriod, 'RMA')

  const up = new Array<number>(n).fill(NA)
  const dn = new Array<number>(n).fill(NA)
  const direction = new Array<number>(n).fill(0)
  const signals: SupertrendSignal[] = new Array(n)

  for (let i = 0; i < n; i++) {
    const a = atrArr[i]
    const prevClose = i > 0 ? close[i - 1] : NA
    const prevUp = i > 0 ? up[i - 1] : NA
    const prevDn = i > 0 ? dn[i - 1] : NA
    const prevDir = i > 0 ? direction[i - 1] : 1 // Pine 中 trend 初始为 1

    if (isNa(a) || isNa(src[i])) {
      // 预热期（ATR 尚未成形）：方向沿用前一根（对齐 Pine 的 nz(trend[1], trend)，
      // 初始为 1）。若此处把方向留成 0，后续所有翻转判断都会失效，
      // 导致 canLong/canShort 永远不触发（表现为 0 笔交易）。
      const carried = i > 0 ? direction[i - 1] : 1
      direction[i] = carried
      signals[i] = {
        imbaTrendLine: NA,
        canLong: false,
        canShort: false,
        tsotBullish: carried === 1,
        tsotBearish: carried === -1,
        tsotTrendValue: carried,
        atr: NA,
        atrShortStop: NA,
        atrLongStop: NA,
        supertrendUp: NA,
        supertrendDn: NA,
        supertrendDirection: carried,
      }
      continue
    }

    // up = src - Mult * atr；受 close[1] > up1 ? max(up,up1) : up 约束
    const rawUp = src[i] - inputs.multiplier * a
    const rawDn = src[i] + inputs.multiplier * a
    const curUp =
      !isNa(prevClose) && !isNa(prevUp) && prevClose > prevUp ? Math.max(rawUp, prevUp) : rawUp
    const curDn =
      !isNa(prevClose) && !isNa(prevDn) && prevClose < prevDn ? Math.min(rawDn, prevDn) : rawDn

    up[i] = curUp
    dn[i] = curDn

    // 趋势翻转：close[1] 已在上面用过了；这里用当前 close 与前一根 up1/dn1 比较
    // 对齐 Pine：trend == -1 and close > dn1 → 1；trend == 1 and close < up1 → -1
    let dir = prevDir
    if (prevDir === -1) {
      if (!isNa(prevDn) && close[i] > prevDn) dir = 1
    } else if (prevDir === 1) {
      if (!isNa(prevUp) && close[i] < prevUp) dir = -1
    }
    direction[i] = dir

    const canLong = dir === 1 && prevDir === -1
    const canShort = dir === -1 && prevDir === 1

    signals[i] = {
      imbaTrendLine: NA,
      canLong,
      canShort,
      tsotBullish: dir === 1,
      tsotBearish: dir === -1,
      tsotTrendValue: dir,
      atr: a,
      // 供引擎 ATR 模式参考（SuperTrend 走 Trend Switch，不会用到）
      atrLongStop: curUp,
      atrShortStop: curDn,
      supertrendUp: dir === 1 ? curUp : NA,
      supertrendDn: dir === -1 ? curDn : NA,
      supertrendDirection: dir,
    }
  }

  return { up, dn, direction, signals }
}

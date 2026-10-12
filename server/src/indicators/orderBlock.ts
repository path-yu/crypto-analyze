/**
 * Volume Order Block Retest Strategy 信号层（Pine v6 原版一一对应移植）。
 *
 * 与 fib / supertrend 不同，本策略的信号**依赖当前是否持仓**：
 * 原脚本的区域扫描外层带有 `flat = strategy.position_size == 0` 条件，
 * 持仓期间触及区域既不会产生信号、也不会把区域标记为已消耗。
 * 因此这里做成状态机，由引擎在每根 K 线收盘（挂单撮合之后）驱动一次
 * `step(index, flat)`，而不是一次性算出整条 signals 数组。
 *
 * 与原 Pine 的对应关系：
 *   - 脉冲：`body >= nz(atr[1]) * dispMult` 且 `volume >= nz(volSma[1]) * impVolMult`
 *   - 区域：脉冲前一根 K 线的 high/low（`bodyZone` 时取实体）
 *   - 重叠：同向区域且 `top >= z.bottom and bottom <= z.top` 时不重复创建
 *   - 失效：`close` 反向穿越区域，或 `bar_index - bornBar > maxAge`
 *   - 触及：`high >= z.bottom and low <= z.top`
 *   - 消耗：`firstTouch` 为真时，只在真正发出信号的那一根标记 used
 *   - 入场：止损 = 区域外侧 ± ATR×slBuf，风险 = |close - 止损|，
 *          目标 = close ± 风险×rrTarget（风险必须 > syminfo.mintick）
 */

import type { Candle, OrderBlockConfig } from '../../../shared/types'
import { atr, ema, isNa, NA, sma } from './ta'

const MAX_ZONES_HARD_CAP = 40

interface Zone {
  top: number
  bottom: number
  /** 创建时的成交量（原脚本用于回踩缩量比较） */
  impVol: number
  bornBar: number
  isBull: boolean
  used: boolean
}

/** 与 fib / supertrend 的 signals 形状兼容，供回测引擎消费 */
export interface OrderBlockSignal {
  imbaTrendLine: number
  tsotTrendValue: number
  atrLongStop: number
  atrShortStop: number
  canLong: boolean
  canShort: boolean
  /** 本次信号对应的区域止损价（无信号时为 NaN） */
  obStopLoss: number
  /** 本次信号对应的目标止盈价（无信号时为 NaN） */
  obTakeProfit: number
  /** 本次信号的风险（|信号收盘 - 止损|，无信号时为 NaN），引擎据此计算保本触发 */
  obRisk: number
}

/** 无信号的空信号（预热期与未触发时使用） */
export function emptyOrderBlockSignal(): OrderBlockSignal {
  return {
    imbaTrendLine: NA,
    tsotTrendValue: NA,
    atrLongStop: NA,
    atrShortStop: NA,
    canLong: false,
    canShort: false,
    obStopLoss: NA,
    obTakeProfit: NA,
    obRisk: NA,
  }
}

export class OrderBlockTracker {
  private readonly candles: readonly Candle[]
  private readonly cfg: OrderBlockConfig
  private readonly atrArr: number[]
  private readonly volSmaArr: number[]
  private readonly emaArr: number[]
  /** 合约最小变动价位（syminfo.mintick）；未知时按 0 处理 */
  private readonly tickSize: number

  private zones: Zone[] = []

  /** 当前已处理到的 bar 下标，用于防御乱序调用 */
  private cursor = -1

  constructor(candles: readonly Candle[], cfg: OrderBlockConfig, tickSize = 0) {
    this.candles = candles
    this.cfg = cfg
    this.tickSize = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0

    const high = candles.map((c) => c.high)
    const low = candles.map((c) => c.low)
    const close = candles.map((c) => c.close)
    const volume = candles.map((c) => c.volume)

    // 原脚本：ta.atr(atrLen) / ta.sma(volume, volLen) / ta.ema(close, emaLen)
    this.atrArr = atr(high, low, close, cfg.atrLen, 'RMA')
    this.volSmaArr = sma(volume, cfg.volLen)
    this.emaArr = ema(close, cfg.emaLen)
  }

  /** 当前存活区域数（调试/测试用） */
  get zoneCount(): number {
    return this.zones.length
  }

  /**
   * 处理第 index 根 K 线并返回该 bar 收盘后的信号。
   *
   * @param index bar 下标（0 起）
   * @param flat  当前是否空仓 —— 对应原脚本的 `strategy.position_size == 0`
   */
  step(index: number, flat: boolean): OrderBlockSignal {
    if (index <= this.cursor) {
      // 乱序/重复调用：不推进状态
      return emptyOrderBlockSignal()
    }
    this.cursor = index

    const { cfg } = this
    const bar = this.candles[index]
    if (!bar) return emptyOrderBlockSignal()

    const prevBar = index > 0 ? this.candles[index - 1] : null
    const atrNow = this.atrArr[index]
    const emaNow = this.emaArr[index]

    const body = Math.abs(bar.close - bar.open)
    const rng = bar.high - bar.low
    const upW = bar.high - Math.max(bar.open, bar.close)
    const loW = Math.min(bar.open, bar.close) - bar.low

    // 脉冲判定用的是「上一根」的 ATR / 量能 SMA，na 时 nz() 取 0
    const atrPrevRaw = index > 0 ? this.atrArr[index - 1] : NA
    const volSmaPrevRaw = index > 0 ? this.volSmaArr[index - 1] : NA
    const atrPrev = isNa(atrPrevRaw) ? 0 : atrPrevRaw
    const volSmaPrev = isNa(volSmaPrevRaw) ? 0 : volSmaPrevRaw

    const bigBody = body >= atrPrev * cfg.dispMult
    const bigVol = bar.volume >= volSmaPrev * cfg.impVolMult

    // needBreak / needOpp 引用前一根；前一根不存在时 Pine 的比较结果为 na（按 false 处理）
    const breakOKLong = !cfg.needBreak || (prevBar !== null && bar.close > prevBar.high)
    const breakOKShort = !cfg.needBreak || (prevBar !== null && bar.close < prevBar.low)
    const oppOKLong = !cfg.needOpp || (prevBar !== null && prevBar.close < prevBar.open)
    const oppOKShort = !cfg.needOpp || (prevBar !== null && prevBar.close > prevBar.open)

    const bullImpulse =
      bar.close > bar.open && bigBody && bigVol && breakOKLong && oppOKLong
    const bearImpulse =
      bar.close < bar.open && bigBody && bigVol && breakOKShort && oppOKShort

    /* ---------- 先处理已有区域（原脚本在创建新区域之前扫描） ---------- */
    let longSig = false
    let shortSig = false
    let sigBottom = NA
    let sigTop = NA

    for (let k = this.zones.length - 1; k >= 0; k--) {
      const z = this.zones[k]
      const dead =
        (z.isBull && bar.close < z.bottom) ||
        (!z.isBull && bar.close > z.top) ||
        index - z.bornBar > cfg.maxAge
      if (dead) {
        this.zones.splice(k, 1)
        continue
      }

      const touched = bar.high >= z.bottom && bar.low <= z.top
      // 消耗判断：firstTouch 为真时，已用过的区域不再产生信号
      if (!touched || !flat || (cfg.firstTouch && z.used)) continue

      const volOK = !cfg.useRetestVol || bar.volume <= z.impVol * cfg.retestVolMax

      if (z.isBull) {
        const rej = !cfg.useRejection || (rng > 0 && (loW / rng) * 100 >= cfg.wickPct)
        const trendOK = !cfg.useTrend || bar.close > emaNow
        const candleOK = !cfg.needCandle || bar.close > bar.open
        if (
          candleOK &&
          bar.close > z.bottom &&
          rej &&
          volOK &&
          trendOK &&
          cfg.allowLong &&
          !longSig &&
          !shortSig
        ) {
          longSig = true
          sigBottom = z.bottom
          z.used = true
        }
      } else {
        const rej = !cfg.useRejection || (rng > 0 && (upW / rng) * 100 >= cfg.wickPct)
        const trendOK = !cfg.useTrend || bar.close < emaNow
        const candleOK = !cfg.needCandle || bar.close < bar.open
        if (
          candleOK &&
          bar.close < z.top &&
          rej &&
          volOK &&
          trendOK &&
          cfg.allowShort &&
          !longSig &&
          !shortSig
        ) {
          shortSig = true
          sigTop = z.top
          z.used = true
        }
      }
    }

    /* ---------- 再创建新区域 ---------- */
    if (index > Math.max(cfg.atrLen, cfg.volLen) + 1 && prevBar !== null) {
      if (bullImpulse && cfg.allowLong) {
        this.addZone(true, this.zoneTop(prevBar), this.zoneBottom(prevBar), index)
      }
      if (bearImpulse && cfg.allowShort) {
        this.addZone(false, this.zoneTop(prevBar), this.zoneBottom(prevBar), index)
      }
    }

    /* ---------- 入场价（止损/目标按信号 bar 收盘价计算） ---------- */
    let stopLoss = NA
    let takeProfit = NA
    let risk = NA

    if (longSig && flat && Number.isFinite(atrNow)) {
      const stopPx = sigBottom - atrNow * cfg.slBuf
      const r = bar.close - stopPx
      if (r > this.tickSize) {
        stopLoss = stopPx
        risk = r
        takeProfit = bar.close + r * cfg.rrTarget
      }
    } else if (shortSig && flat && Number.isFinite(atrNow)) {
      const stopPx = sigTop + atrNow * cfg.slBuf
      const r = stopPx - bar.close
      if (r > this.tickSize) {
        stopLoss = stopPx
        risk = r
        takeProfit = bar.close - r * cfg.rrTarget
      }
    }

    const validLong = longSig && flat && Number.isFinite(risk)
    const validShort = shortSig && flat && Number.isFinite(risk)

    return {
      imbaTrendLine: NA,
      tsotTrendValue: NA,
      atrLongStop: validLong ? stopLoss : NA,
      atrShortStop: validShort ? stopLoss : NA,
      canLong: validLong,
      canShort: validShort,
      obStopLoss: stopLoss,
      obTakeProfit: takeProfit,
      obRisk: risk,
    }
  }

  /** 区域上沿：bodyZone 时取前一根实体上沿，否则取最高价 */
  private zoneTop(prev: Candle): number {
    return this.cfg.bodyZone ? Math.max(prev.open, prev.close) : prev.high
  }

  /** 区域下沿 */
  private zoneBottom(prev: Candle): number {
    return this.cfg.bodyZone ? Math.min(prev.open, prev.close) : prev.low
  }

  /** 同向区域已覆盖新区间时不重复创建 */
  private overlaps(isBull: boolean, top: number, bottom: number): boolean {
    for (const z of this.zones) {
      if (z.isBull === isBull && top >= z.bottom && bottom <= z.top) return true
    }
    return false
  }

  private addZone(isBull: boolean, top: number, bottom: number, index: number): void {
    if (this.overlaps(isBull, top, bottom)) return

    const bar = this.candles[index]
    this.zones.push({
      top,
      bottom,
      impVol: bar.volume,
      bornBar: index,
      isBull,
      used: false,
    })

    // 超出上限时丢弃最旧的一个（对应 Pine 的 array.shift）
    const cap = Math.min(MAX_ZONES_HARD_CAP, Math.max(1, Math.trunc(this.cfg.maxZones)))
    if (this.zones.length > cap) this.zones.shift()
  }
}

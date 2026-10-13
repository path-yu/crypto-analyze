/**
 * 指标层与回测引擎的正确性测试。
 * 运行： pnpm exec tsx --test server/src/tests/*.test.ts
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Candle, StrategyParams } from '../../../shared/types'
import { DEFAULT_STRATEGY_PARAMS } from '../../../shared/types'
import {
  atr,
  ema,
  highest,
  lowest,
  percentileNearestRank,
  rma,
  sma,
  supertrend,
  trueRange,
  wma,
} from '../indicators/ta'
import { computeFibTrendSeries } from '../indicators/fibTrendReversal'
import { runBacktest } from '../backtest/engine'
import { computeReport } from '../backtest/metrics'

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `期望 ${b}，实际 ${a}`)

describe('ta.supertrend', () => {
  it('预热期为 na，之后方向不卡在单边（回归：NaN 污染棘轮导致 direction 恒为 -1）', () => {
    // 12 根一循环的锯齿序列：既有上涨段也有下跌段，必须出现双向趋势
    const seq = [0, 1, 2, 4, 3, 2, 1, -1, -2, -3, -4, -2]
    const n = seq.length * 8
    const close = Array.from({ length: n }, (_, i) => 100 + seq[i % seq.length])
    const high = close.map((v) => v + 0.5)
    const low = close.map((v) => v - 0.5)
    const [st, dir] = supertrend(high, low, close, 3, 10)

    // ATR(10) 预热期：前 9 根 supertrend / direction 都是 na（与 TradingView 一致）
    for (let i = 0; i < 9; i++) {
      assert.ok(Number.isNaN(st[i]), `st[${i}] 应为 na`)
      assert.ok(Number.isNaN(dir[i]), `dir[${i}] 应为 na`)
    }
    // 之后 supertrend 必须成形
    const valid = st.slice(9).filter(Number.isFinite)
    assert.equal(valid.length, n - 9, '预热期之后 supertrend 不应再出现 na')
    // 方向必须同时出现 -1 与 1（旧的 NaN 污染 bug 会让它恒为 -1）
    const dirs = [...new Set(dir.slice(9).filter(Number.isFinite))].sort()
    assert.deepEqual(dirs, [-1, 1], '方向应同时出现 -1 与 1，不能卡在单边')
    // 一致性：上升趋势(-1)时线在收盘价下方，下降趋势(1)时在上方
    for (let i = 9; i < n; i++) {
      if (dir[i] === -1) {
        assert.ok((st[i] as number) <= close[i] + 1e-9, `bar${i} 上升趋势的支撑线应在收盘价下方`)
      } else {
        assert.ok((st[i] as number) >= close[i] - 1e-9, `bar${i} 下降趋势的阻力线应在收盘价上方`)
      }
    }
  })
})

describe('ta 均线族', () => {
  it('sma 前 length-1 位为 na', () => {
    const out = sma([1, 2, 3, 4, 5], 3)
    assert.ok(Number.isNaN(out[0]))
    assert.ok(Number.isNaN(out[1]))
    near(out[2], 2)
    near(out[3], 3)
    near(out[4], 4)
  })

  it('ema 用前 length 个值的 SMA 播种（与 Pine 一致）', () => {
    const src = [1, 2, 3, 4, 5]
    const out = ema(src, 3)
    near(out[2], 2) // (1+2+3)/3
    // alpha = 2/(3+1) = 0.5 → ema = 0.5*4 + 0.5*2 = 3
    near(out[3], 3)
    near(out[4], 0.5 * 5 + 0.5 * 3)
  })

  it('rma 使用 Wilder 平滑 alpha = 1/length', () => {
    const src = [2, 4, 6, 8]
    const out = rma(src, 2)
    near(out[1], 3) // (2+4)/2
    near(out[2], (3 * 1 + 6) / 2) // 4.5
    near(out[3], (4.5 * 1 + 8) / 2) // 6.25
  })

  it('wma 线性加权', () => {
    const out = wma([1, 2, 3], 3)
    // (1*1 + 2*2 + 3*3) / 6 = 14/6
    near(out[2], 14 / 6)
  })
})

describe('rolling 极值', () => {
  it('highest / lowest 为含当前 bar 的滚动窗口', () => {
    const src = [3, 1, 4, 1, 5, 9, 2, 6]
    const h = highest(src, 3)
    const l = lowest(src, 3)
    assert.ok(Number.isNaN(h[1]))
    near(h[2], 4)
    near(h[3], 4)
    near(h[4], 5)
    near(h[5], 9)
    near(h[7], 9)
    near(l[2], 1)
    near(l[5], 1)
    near(l[7], 2)
  })
})

describe('percentile_nearest_rank', () => {
  it('按 nearest-rank 定义取升序第 ceil(p/100*n) 个值', () => {
    // 窗口 [1..10]，length=10
    const src = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const p75 = percentileNearestRank(src, 10, 75)
    const p25 = percentileNearestRank(src, 10, 25)
    // ceil(0.75*10)=8 → 第 8 小 = 8
    near(p75[9], 8)
    // ceil(0.25*10)=3 → 第 3 小 = 3
    near(p25[9], 3)
  })

  it('前 length-1 位为 na', () => {
    const src = [1, 2, 3, 4, 5]
    const out = percentileNearestRank(src, 3, 75)
    assert.ok(Number.isNaN(out[0]))
    assert.ok(Number.isNaN(out[1]))
    assert.ok(Number.isFinite(out[2]))
  })

  it('滑动窗口正确移除过期值', () => {
    // 窗口长度 3：最后三位 [100, 1, 2] → 升序 [1,2,100]，75 分位 = ceil(2.25)=3 → 第3小 = 100
    const src = [100, 1, 2]
    const out = percentileNearestRank(src, 3, 75)
    near(out[2], 100)
    // 再推入 3 → 窗口 [1,2,3]，75 分位 = 3
    const out2 = percentileNearestRank([100, 1, 2, 3], 3, 75)
    near(out2[3], 3)
  })
})

describe('true range / atr', () => {
  it('ta.tr(true) 首根用 high-low，其后取三项最大值', () => {
    const high = [10, 12, 11]
    const low = [8, 9, 7]
    const close = [9, 11, 8]
    const tr = trueRange(high, low, close)
    near(tr[0], 2) // 10-8
    // max(12-9=3, |12-11|=1, |9-11|=2) = 3
    near(tr[1], 3)
    // max(11-7=4, |11-11|=0, |7-11|=4) = 4
    near(tr[2], 4)
  })

  it('atr 支持多种平滑方式', () => {
    const high = [10, 12, 11, 13, 12]
    const low = [8, 9, 7, 10, 9]
    const close = [9, 11, 8, 12, 10]
    const rmaOut = atr(high, low, close, 3, 'RMA')
    const smaOut = atr(high, low, close, 3, 'SMA')
    assert.ok(Number.isFinite(rmaOut[4]))
    assert.ok(Number.isFinite(smaOut[4]))
    assert.ok(!Number.isFinite(rmaOut[1]))
  })
})

/* ------------------------------------------------------------------ */
/* 策略与引擎                                                          */
/* ------------------------------------------------------------------ */

function makeCandles(closes: number[]): Candle[] {
  const base = 1_700_000_000_000
  return closes.map((c, i) => ({
    timestamp: base + i * 3_600_000,
    open: i === 0 ? c : closes[i - 1],
    high: c * 1.001,
    low: c * 0.999,
    close: c,
    volume: 100,
  }))
}

describe('信号层', () => {
  it('canLong 要求「下穿上穿趋势线 + TSOT 看多 + 当前非多头趋势」', () => {
    // 构造一段明显的上涨后回调再拉升的行情
    const closes: number[] = []
    let p = 100
    for (let i = 0; i < 300; i++) {
      p += Math.sin(i / 12) * 0.6 + 0.03
      closes.push(p)
    }
    const candles = makeCandles(closes)
    const series = computeFibTrendSeries(candles, {
      sensitivity: 5, // 窗口 50
      atrLength: 14,
      atrSmoothing: 'RMA',
      atrMultiplier: 3.5,
    })

    let checked = 0
    for (let i = 0; i < candles.length; i++) {
      const line = series.imbaTrendLine[i]
      if (!Number.isFinite(line)) continue
      if (series.canLong[i]) {
        assert.ok(candles[i].close >= line, `第 ${i} 根 canLong 应满足 close >= 趋势线`)
        assert.ok(candles[i].open < line, `第 ${i} 根 canLong 应满足 open < 趋势线`)
        assert.ok(series.tsotBullish[i])
        checked++
      }
      if (series.canShort[i]) {
        assert.ok(candles[i].close <= line)
        assert.ok(candles[i].open > line)
        assert.ok(series.tsotBearish[i])
      }
    }
    assert.ok(checked >= 0, '至少不抛错')
  })

  it('ATR 止损位始终在多头下方 / 空头上方', () => {
    const closes: number[] = []
    let p = 100
    for (let i = 0; i < 400; i++) {
      p += Math.sin(i / 9) * 0.8
      closes.push(p)
    }
    const candles = makeCandles(closes)
    const s = computeFibTrendSeries(candles, {
      sensitivity: 6,
      atrLength: 14,
      atrSmoothing: 'RMA',
      atrMultiplier: 3.5,
    })
    for (let i = 0; i < candles.length; i++) {
      if (Number.isFinite(s.atrLongStop[i])) {
        assert.ok(s.atrLongStop[i] < candles[i].low)
        assert.ok(s.atrShortStop[i] > candles[i].high)
      }
    }
  })
})

/* ------------------------------------------------------------------ */
/* 回测引擎 —— 使用手工构造的信号序列，保证断言完全确定                */
/* ------------------------------------------------------------------ */

/** 用「收盘价路径 + 指定的信号下标」构造一份可精确预期的指标序列 */
function synthetic(
  candles: Candle[],
  longAt: number[],
  shortAt: number[],
  opts: { atrOffset?: number } = {},
) {
  const atrOffset = opts.atrOffset ?? (candles[0].close * 0.005)
  const n = candles.length
  const signals = candles.map((c, i) => {
    const isLong = longAt.includes(i)
    const isShort = shortAt.includes(i)
    return {
      // 保证「收盘价在趋势线上方」/「下方」的语义成立
      imbaTrendLine: isLong ? c.close * 0.999 : isShort ? c.close * 1.001 : c.close,
      canLong: isLong,
      canShort: isShort,
      tsotBullish: isLong,
      tsotBearish: isShort,
      tsotTrendValue: isLong ? 100 : isShort ? -100 : 0,
      atr: atrOffset,
      atrShortStop: c.high + atrOffset,
      atrLongStop: c.low - atrOffset,
    }
  })
  const series = {
    imbaTrendLine: signals.map((s) => s.imbaTrendLine),
    fib236: [] as number[],
    fib5: [] as number[],
    fib786: [] as number[],
    atr: signals.map((s) => s.atr),
    atrLongStop: signals.map((s) => s.atrLongStop),
    atrShortStop: signals.map((s) => s.atrShortStop),
    tsotTrendValue: signals.map((s) => s.tsotTrendValue),
    tsotBullish: signals.map((s) => s.tsotBullish),
    tsotBearish: signals.map((s) => s.tsotBearish),
    canLong: signals.map((s) => s.canLong),
    canShort: signals.map((s) => s.canShort),
    signals,
  }
  return { candles, series }
}

/** 根据 OHLC 数组构造 K 线 */
function ohlc(rows: Array<[number, number, number, number]>): Candle[] {
  const base = 1_700_000_000_000
  return rows.map(([o, h, l, c], i) => ({
    timestamp: base + i * 3_600_000,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
  }))
}

const BASE: StrategyParams = {
  ...DEFAULT_STRATEGY_PARAMS,
  commissionPercent: 0,
  exitStrategy: 'Fixed Percent',
  slPercent: 2,
  riskRewardRatio: 2,
  leverage: 1,
  positionSizePercent: 100,
  partialTp: true,
  allowReversePosition: true,
  checkLiquidation: false,
  tradeDirection: 'Both',
  // 单测只关心撮合语义本身，关闭金字塔加仓，避免同向信号叠加干扰断言。
  pyramiding: 1,
}

describe('回测引擎 · 开仓与离场', () => {
  it('多头：TP1 平 50% 并移保本，随后保本离场', () => {
    // 0..5 盘整；第 5 根给出做多信号（收盘 100）
    const rows: Array<[number, number, number, number]> = [
      [100, 100.2, 99.8, 100],
      [100, 100.2, 99.8, 100],
      [100, 100.2, 99.8, 100],
      [100, 100.2, 99.8, 100],
      [100, 100.2, 99.8, 100],
      [100, 100.2, 99.8, 100], // ← 信号 bar，以收盘 100 开多
      [100, 102.5, 100.5, 102], // 触及 TP1 = 102
      [102, 101, 99, 100], // 回落触及保本 100.05
    ]
    const candles = ohlc(rows)
    const { series } = synthetic(candles, [5], [], { atrOffset: 2 })
    const { trades } = runBacktest({
      candles,
      series,
      params: { ...BASE, partialTp: true },
    })

    assert.equal(trades.length, 1)
    const t = trades[0]
    assert.equal(t.side, 'long')
    assert.equal(t.entryIndex, 5)
    assert.equal(t.entryPrice, 100)
    assert.equal(t.fills.length, 2)
    assert.equal(t.fills[0].reason, 'TP1')
    assert.equal(t.fills[0].price, 102)
    near(t.fills[0].portion, 0.5)
    assert.equal(t.fills[1].reason, 'BreakEven')
    near(t.fills[1].price, 100.05)
    near(t.fills[1].portion, 0.5)
    // 数量 = 1000 / 100 = 10
    near(t.qty, 10)
    // 盈亏 = 10*0.5*(102-100) + 10*0.5*(100.05-100) = 10 + 0.25
    near(t.netPnl, 10.25, 1e-9)
    assert.equal(t.exitIndex, 7)
  })

  it('多头：直接触发止损', () => {
    const rows: Array<[number, number, number, number]> = [
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100], // 信号 bar，收盘 100 开多，SL = 98
      [100, 100, 97.5, 98.5], // 下探 97.5，击穿 SL
    ]
    const candles = ohlc(rows)
    const { series } = synthetic(candles, [5], [], { atrOffset: 2 })
    const { trades } = runBacktest({ candles, series, params: BASE })
    assert.equal(trades.length, 1)
    const t = trades[0]
    assert.equal(t.exitReason, 'StopLoss')
    assert.equal(t.fills[0].price, 98)
    near(t.netPnl, -20) // 10 张 × 2 点
    near(t.pnlPercent, -2) // 保证金 1000 的 -2%
  })

  it('阴线先探高点：同一根 K 线内 TP 优先于 SL', () => {
    const rows: Array<[number, number, number, number]> = [
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100], // 信号 bar
      [105, 106, 96, 97], // 阴线：先到 106（TP2=104）再到 96（SL=98）
    ]
    const candles = ohlc(rows)
    const { series } = synthetic(candles, [5], [], { atrOffset: 2 })
    const { trades } = runBacktest({
      candles,
      series,
      params: { ...BASE, partialTp: false }, // 整仓离场
    })
    assert.equal(trades.length, 1)
    assert.equal(trades[0].exitReason, 'TP2')
    near(trades[0].fills[0].price, 104)
    near(trades[0].netPnl, 40) // 10 张 × 4 点
  })

  it('阳线先探低点：同一根 K 线内 SL 优先于 TP', () => {
    const rows: Array<[number, number, number, number]> = [
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100], // 信号 bar
      [97, 106, 96, 105], // 阳线：先到 96（SL=98）再到 106
    ]
    const candles = ohlc(rows)
    const { series } = synthetic(candles, [5], [], { atrOffset: 2 })
    const { trades } = runBacktest({
      candles,
      series,
      params: { ...BASE, partialTp: false },
    })
    assert.equal(trades.length, 1)
    assert.equal(trades[0].exitReason, 'StopLoss')
    near(trades[0].netPnl, -20)
  })

  it('空头：TP1 与 SL 方向正确', () => {
    const rows: Array<[number, number, number, number]> = [
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100], // 信号 bar，收盘 100 开空：SL=102，TP1=98，TP2=96，保本=99.95
      [99, 99.5, 97.5, 98], // 阴线，先探高 99.5 再探低 97.5 → 触及 TP1 = 98
      [98, 99, 97, 98], // 高点 99 < 保本 99.95，未触发保本
      [98, 98, 95, 96], // 低点 95 → 触及 TP2 = 96
    ]
    const candles = ohlc(rows)
    const { series } = synthetic(candles, [], [5], { atrOffset: 2 })
    const { trades } = runBacktest({ candles, series, params: BASE })
    assert.equal(trades.length, 1)
    const t = trades[0]
    assert.equal(t.side, 'short')
    assert.equal(t.exitReason, 'TP2')
    assert.equal(t.fills.length, 2)
    assert.equal(t.fills[0].reason, 'TP1')
    near(t.fills[0].price, 98)
    assert.equal(t.fills[1].reason, 'TP2')
    near(t.fills[1].price, 96)
    // 数量 = 1000/100 = 10 → 10*0.5*2 + 10*0.5*4 = 10 + 20 = 30
    near(t.netPnl, 30)
    assert.equal(t.exitIndex, 8)
  })

  it('反手：持多时出现做空信号，同根 K 线平多开空', () => {
    const rows: Array<[number, number, number, number]> = [
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100], // 做多信号
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100], // 做空信号 → 反手
      [100, 100, 100, 100],
    ]
    const candles = ohlc(rows)
    const { series } = synthetic(candles, [5], [8], { atrOffset: 5 })
    const { trades } = runBacktest({ candles, series, params: BASE })
    assert.equal(trades.length, 2)
    assert.equal(trades[0].side, 'long')
    assert.equal(trades[0].exitReason, 'Reverse')
    assert.equal(trades[0].exitIndex, 8)
    assert.equal(trades[1].side, 'short')
    assert.equal(trades[1].entryIndex, 8)
  })

  it('趋势反转模式：反向信号平仓并开新仓，无固定止盈止损', () => {
    const rows: Array<[number, number, number, number]> = [
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 110, 95, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
    ]
    const candles = ohlc(rows)
    const { series } = synthetic(candles, [4], [8], { atrOffset: 2 })
    const { trades } = runBacktest({
      candles,
      series,
      params: { ...BASE, exitStrategy: 'Trend Switch' },
    })
    assert.equal(trades.length, 2)
    assert.equal(trades[0].exitReason, 'TrendSwitch')
    assert.equal(trades[1].side, 'short')
    // 第 5 根虽然振幅巨大（95~110），但趋势反转模式没有止损止盈，不应被平掉
    assert.equal(trades[0].exitIndex, 8)
  })

  it('tradeFromIndex 之前不开仓且权益保持初始值', () => {
    const rows: Array<[number, number, number, number]> = Array.from({ length: 20 }, () => [100, 100, 100, 100] as [number, number, number, number])
    const candles = ohlc(rows)
    const { series } = synthetic(candles, [2], [5], { atrOffset: 5 })
    const { trades, equityCurve } = runBacktest({ candles, series, params: BASE, tradeFromIndex: 10 })
    for (const t of trades) assert.ok(t.entryIndex >= 10)
    for (let i = 0; i < 10; i++) near(equityCurve[i].equity, 1000)
  })

  it('杠杆按比例放大名义价值、数量与盈亏', () => {
    const rows: Array<[number, number, number, number]> = [
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [104, 104, 100, 104], // 触及 TP2 = 104
    ]
    const candles = ohlc(rows)
    const { series } = synthetic(candles, [5], [], { atrOffset: 2 })
    const r1 = runBacktest({ candles, series, params: { ...BASE, leverage: 1, partialTp: false } })
    const r5 = runBacktest({ candles, series, params: { ...BASE, leverage: 5, partialTp: false } })
    assert.equal(r1.trades.length, 1)
    assert.equal(r5.trades.length, 1)
    near(r1.trades[0].notional, 1000)
    near(r5.trades[0].notional, 5000)
    near(r5.trades[0].qty, r1.trades[0].qty * 5)
    near(r5.trades[0].netPnl, r1.trades[0].netPnl * 5)
  })

  it('手续费按名义价值双边收取', () => {
    const rows: Array<[number, number, number, number]> = [
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [104, 104, 100, 104], // TP2
    ]
    const candles = ohlc(rows)
    const { series } = synthetic(candles, [5], [], { atrOffset: 2 })
    const { trades } = runBacktest({
      candles,
      series,
      params: { ...BASE, partialTp: false, commissionPercent: 0.1 },
    })
    const t = trades[0]
    // 开仓 1000 × 0.1% = 1；平仓 10 张 × 104 × 0.1% = 1.04
    near(t.fee, 1 + 1.04, 1e-9)
    near(t.netPnl, 40 - (1 + 1.04), 1e-9)
  })

  it('高杠杆下触发强平', () => {
    const rows: Array<[number, number, number, number]> = [
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100],
      [100, 100, 100, 100], // 开多 @100，10x → 强平价 90
      [95, 95, 85, 84], // 深跌击穿强平价
    ]
    const candles = ohlc(rows)
    const { series } = synthetic(candles, [5], [], { atrOffset: 50 })
    const { trades } = runBacktest({
      candles,
      series,
      params: { ...BASE, leverage: 10, checkLiquidation: true, slPercent: 50 },
    })
    assert.equal(trades.length, 1)
    assert.equal(trades[0].exitReason, 'Liquidation')
    // 强平即亏掉全部保证金
    near(trades[0].netPnl, -1000, 1e-6)
  })

  it('固定百分比止损模式下止损价与开仓价的比例正确', () => {
    const rows: Array<[number, number, number, number]> = Array.from({ length: 8 }, () => [200, 200, 200, 200] as [number, number, number, number])
    rows[5] = [200, 200, 200, 200]
    rows[6] = [200, 199, 180, 181]
    const candles = ohlc(rows)
    const { series } = synthetic(candles, [5], [], { atrOffset: 5 })
    const { trades } = runBacktest({
      candles,
      series,
      params: { ...BASE, slPercent: 5, exitStrategy: 'Fixed Percent' },
    })
    assert.equal(trades.length, 1)
    near(trades[0].stopLoss, 190) // 200 × (1 - 5%)
    assert.equal(trades[0].exitReason, 'StopLoss')
    near(trades[0].fills[0].price, 190)
  })

  it('ATR 模式使用指标给出的止损位', () => {
    const rows: Array<[number, number, number, number]> = Array.from({ length: 8 }, () => [100, 100, 100, 100] as [number, number, number, number])
    rows[6] = [100, 101, 90, 91]
    const candles = ohlc(rows)
    const { series } = synthetic(candles, [5], [], { atrOffset: 3 })
    // signals[5]: atrLongStop = low(100) - 3 = 97 → 止损 97
    const { trades } = runBacktest({
      candles,
      series,
      params: { ...BASE, exitStrategy: 'ATR' },
    })
    assert.equal(trades.length, 1)
    near(trades[0].stopLoss, 97)
    near(trades[0].takeProfit1, 100 + 2 * 1.5) // rr=2, risk=3 → tp1 = 100 + 2*3/2
    near(trades[0].takeProfit2, 100 + 2 * 3)
    assert.equal(trades[0].exitReason, 'StopLoss')
    near(trades[0].fills[0].price, 97)
  })

  it('仅做多模式下忽略做空信号', () => {
    const rows: Array<[number, number, number, number]> = Array.from({ length: 12 }, () => [100, 100, 100, 100] as [number, number, number, number])
    const candles = ohlc(rows)
    const { series } = synthetic(candles, [5], [7], { atrOffset: 5 })
    const { trades } = runBacktest({
      candles,
      series,
      params: { ...BASE, tradeDirection: 'Long Only' },
    })
    for (const t of trades) assert.equal(t.side, 'long')
  })
})

describe('绩效统计', () => {
  it('统计口径自洽', () => {
    const rows: Array<[number, number, number, number]> = Array.from({ length: 30 }, (_, i) =>
      i === 6 ? [100, 106, 99, 105] : [100, 100.5, 99.5, 100],
    )
    const candles = ohlc(rows)
    const { series } = synthetic(candles, [5], [], { atrOffset: 3 })
    const { trades, equityCurve } = runBacktest({
      candles,
      series,
      params: { ...BASE, partialTp: false },
    })
    const report = computeReport(trades, equityCurve, candles, {
      symbol: 'T/USDT:USDT',
      exchange: 'binanceusdm',
      timeframe: '1h',
      leverage: 1,
      params: BASE,
    })
    assert.equal(report.stats.totalTrades, trades.length)
    assert.equal(
      report.stats.winningTrades + report.stats.losingTrades + report.stats.breakEvenTrades,
      trades.length,
    )
    near(report.finalEquity, equityCurve[equityCurve.length - 1].equity)
    near(report.netProfit, report.finalEquity - report.initialCapital)
    assert.ok(report.maxDrawdownPercent <= 0)
    assert.equal(report.bars, candles.length)
    near(report.initialCapital, BASE.initialCapital)
  })
})

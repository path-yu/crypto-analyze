/**
 * Volume Order Block Retest 策略测试：
 *  1) 状态机指标层（脉冲 → 区域 → 回踩 → 消耗 / 失效 / 重叠）
 *  2) 引擎的 Zone OCO 撮合（下一根开盘入场、OCO 止盈止损、保本触发、时间止损、滑点）
 *
 * 运行：npx tsx --test server/src/tests/*.test.ts
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Candle, StrategyParams } from '../../../shared/types'
import { DEFAULT_ORDER_BLOCK, DEFAULT_STRATEGY_PARAMS } from '../../../shared/types'
import { emptyOrderBlockSignal, OrderBlockTracker } from '../indicators/orderBlock'
import { runBacktest, type StrategySeriesCore } from '../backtest/engine'

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `期望 ${b}，实际 ${a}`)

const BASE_TS = 1_700_000_000_000

/** 用 [open, high, low, close, volume] 构造 K 线 */
function bars(rows: Array<[number, number, number, number, number?]>): Candle[] {
  return rows.map(([o, h, l, c, v], i) => ({
    timestamp: BASE_TS + i * 3_600_000,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v ?? 10,
  }))
}

/** 盘整 K 线：围绕 100 波动，用于铺垫 */
const flat = (): [number, number, number, number, number] => [100, 100.5, 99.5, 100, 10]

const TRACKER_CFG = {
  ...DEFAULT_ORDER_BLOCK,
  atrLen: 3,
  volLen: 3,
  emaLen: 2,
  maxAge: 100,
  bodyZone: false,
  useTrend: false,
  useRejection: false,
  useRetestVol: false,
  needOpp: false,
  needBreak: false,
}

/* ------------------------------------------------------------------ */
/* 1) 状态机指标层                                                      */
/* ------------------------------------------------------------------ */

describe('订单块 · 区域状态机', () => {
  it('放量脉冲建立区域，回踩触及后给出做多信号（止损/目标按收盘价计算）', () => {
    const candles = bars([
      flat(),
      flat(),
      flat(),
      flat(),
      flat(),
      flat(),
      // 第 6 根：脉冲（实体 5.5 ≥ ATR×0.8，量能 30 ≥ SMA×1）
      [100, 106, 100, 105.5, 30],
      // 第 7 根：回踩区域（low 100.2 ≤ 区域上沿 100.5），阳线收在区域上方
      [103, 104, 100.2, 103.5, 12],
      // 第 8 根：再次触及 —— 区域已被消耗
      [103, 104, 100.3, 103.2, 12],
    ])

    const tracker = new OrderBlockTracker(candles, TRACKER_CFG, 0.1)

    for (let i = 0; i <= 5; i++) {
      const s = tracker.step(i, true)
      assert.equal(s.canLong, false)
      assert.equal(s.canShort, false)
    }
    assert.equal(tracker.zoneCount, 0, '第 5 根尚无脉冲')

    // 第 6 根：脉冲 → 用第 5 根的高/低建立多头区域
    tracker.step(6, true)
    assert.equal(tracker.zoneCount, 1, '脉冲后应建立一个区域')

    // 第 7 根：回踩 → 信号
    const sig = tracker.step(7, true)
    assert.equal(sig.canLong, true)
    assert.equal(sig.canShort, false)
    // 止损在区域下沿外侧，目标在收盘价上方，风险 = |收盘 - 止损|
    assert.ok(sig.obStopLoss < 99.5, `止损应低于区域下沿，实际 ${sig.obStopLoss}`)
    assert.ok(sig.obTakeProfit > candles[7].close)
    near(sig.obRisk, candles[7].close - sig.obStopLoss)
    near(sig.obTakeProfit, candles[7].close + sig.obRisk * TRACKER_CFG.rrTarget)

    // 第 8 根：同一区域再次触及 —— firstTouch = true 时不再触发
    const again = tracker.step(8, true)
    assert.equal(again.canLong, false, '区域已被消耗，不应重复触发')
  })

  it('持仓期间（flat = false）不产生信号，也不消耗区域', () => {
    const candles = bars([
      flat(),
      flat(),
      flat(),
      flat(),
      flat(),
      flat(),
      [100, 106, 100, 105.5, 30],
      [103, 104, 100.2, 103.5, 12], // 持仓中触及
      [103, 104, 100.2, 103.5, 12], // 已空仓，再次触及
    ])

    const tracker = new OrderBlockTracker(candles, TRACKER_CFG, 0.1)
    for (let i = 0; i <= 6; i++) tracker.step(i, true)

    const held = tracker.step(7, false)
    assert.equal(held.canLong, false, '持仓时不产生信号')

    const after = tracker.step(8, true)
    assert.equal(after.canLong, true, '区域未被消耗，空仓后仍可触发')
  })

  it('收盘反向穿越区域后区域失效', () => {
    const candles = bars([
      flat(),
      flat(),
      flat(),
      flat(),
      flat(),
      flat(),
      [100, 106, 100, 105.5, 30], // 建立多头区域 [99.5, 100.5]
      [99, 99.5, 95, 96, 12], // 收盘 96 < 区域下沿 → 区域死亡
    ])

    const tracker = new OrderBlockTracker(candles, TRACKER_CFG, 0.1)
    for (let i = 0; i <= 6; i++) tracker.step(i, true)
    assert.equal(tracker.zoneCount, 1)

    const s = tracker.step(7, true)
    assert.equal(s.canLong, false)
    assert.equal(tracker.zoneCount, 0, '反向穿越后区域应被移除')
  })

  it('同向且被已有区域覆盖时不重复创建', () => {
    const candles = bars([
      flat(),
      flat(),
      flat(),
      flat(),
      flat(),
      flat(),
      [100, 106, 100, 105.5, 30], // 区域 A = [99.5, 100.5]
      [105, 110, 104.5, 109.5, 40], // 再脉冲：区域 B = [100, 106] 与 A 重叠
    ])

    const tracker = new OrderBlockTracker(candles, TRACKER_CFG, 0.1)
    for (let i = 0; i <= 7; i++) tracker.step(i, true)
    assert.equal(tracker.zoneCount, 1, '重叠区域不应重复创建')
  })
})

/* ------------------------------------------------------------------ */
/* 2) 引擎 · Zone OCO                                                   */
/* ------------------------------------------------------------------ */

const OB_PARAMS: StrategyParams = {
  ...DEFAULT_STRATEGY_PARAMS,
  strategy: 'order-block',
  exitStrategy: 'Zone OCO',
  tradeDirection: 'Both',
  partialTp: false,
  pyramiding: 1,
  commissionPercent: 0,
  initialCapital: 1000,
  leverage: 1,
  positionSizePercent: 100,
  checkLiquidation: false,
  slippageTicks: 0,
  orderBlock: { ...DEFAULT_ORDER_BLOCK, useBE: false, maxBars: 60 },
}

/** 在第 signalIndex 根注入一个多头信号 */
function seriesWithLong(candles: Candle[], signalIndex: number, stop: number, tp: number): StrategySeriesCore {
  const signals = candles.map(() => emptyOrderBlockSignal())
  signals[signalIndex] = {
    ...emptyOrderBlockSignal(),
    canLong: true,
    atrLongStop: stop,
    obStopLoss: stop,
    obTakeProfit: tp,
    obRisk: candles[signalIndex].close - stop,
  }
  return { signals }
}

describe('回测引擎 · 订单块离场（Zone OCO）', () => {
  it('信号后下一根开盘入场，触及目标价整仓离场', () => {
    const candles = bars([
      flat(),
      flat(),
      flat(),
      flat(),
      flat(),
      [100, 100.2, 99.8, 100], // 信号 bar（收盘 100，止损 98，目标 103）
      [100.5, 101, 100.4, 100.8], // 本根开盘 100.5 成交；挂单尚未生效
      [101, 103.5, 100.8, 103], // 触及 103
    ])
    const { trades } = runBacktest({
      candles,
      series: seriesWithLong(candles, 5, 98, 103),
      params: OB_PARAMS,
    })

    assert.equal(trades.length, 1)
    const t = trades[0]
    assert.equal(t.side, 'long')
    assert.equal(t.entryIndex, 6, '应在信号后一根成交')
    near(t.entryPrice, 100.5, 1e-9) // 该根开盘价
    assert.equal(t.exitReason, 'TP2')
    near(t.exitPrice, 103)
    assert.equal(t.exitIndex, 7)
  })

  it('保本触发后回落，按保本价离场', () => {
    const candles = bars([
      flat(),
      flat(),
      flat(),
      flat(),
      flat(),
      [100, 100.2, 99.8, 100], // 信号：止损 98，目标 108，风险 2 → 保本触发 = 入场价 + 1R
      [100.5, 101, 100.4, 100.8], // 入场 100.5
      [101, 103, 100.9, 102.5], // high 103 ≥ 100.5 + 2 = 102.5 → 收盘后移动止损到 100.5
      [102, 102.5, 100, 100.2], // 回落击穿 100.5 → 保本离场
    ])
    const { trades } = runBacktest({
      candles,
      series: seriesWithLong(candles, 5, 98, 108),
      params: { ...OB_PARAMS, orderBlock: { ...OB_PARAMS.orderBlock, useBE: true, beAtR: 1 } },
    })

    assert.equal(trades.length, 1)
    const t = trades[0]
    near(t.entryPrice, 100.5)
    assert.equal(t.exitReason, 'BreakEven')
    near(t.exitPrice, 100.5)
    assert.equal(t.exitIndex, 8)
  })

  it('持仓超过 maxBars 根后，下一根开盘市价平仓（时间止损）', () => {
    const candles = bars([
      flat(),
      flat(),
      flat(),
      flat(),
      flat(),
      [100, 100.2, 99.8, 100], // 信号：止损 90、目标 200（都不会触发）
      [100.5, 101, 100.4, 100.8], // 入场（entryIndex = 6）
      [100.6, 101, 100, 100.5], // 持仓 1 根
      [100.5, 101, 100, 100.5], // 持仓 2 根 → 达到 maxBars
      [100.8, 101, 100, 100.5], // 本根开盘 100.8 成交
    ])
    const { trades } = runBacktest({
      candles,
      series: seriesWithLong(candles, 5, 90, 200),
      params: { ...OB_PARAMS, orderBlock: { ...OB_PARAMS.orderBlock, maxBars: 2 } },
    })

    assert.equal(trades.length, 1)
    const t = trades[0]
    assert.equal(t.exitReason, 'TimeStop')
    assert.equal(t.exitIndex, 9, '时间止损在下一根开盘成交')
    near(t.exitPrice, 100.8)
  })

  it('滑点：市价入场与止损成交都按劣势价（slippage = 2 tick）', () => {
    const candles = bars([
      flat(),
      flat(),
      flat(),
      flat(),
      flat(),
      [100, 100.2, 99.8, 100], // 信号：止损 98
      [100.4, 100.6, 100.2, 100.5], // 入场 = 开盘 100.4 + 0.2 = 100.6
      [100.5, 100.6, 97.5, 98], // 击穿 98 → 成交 98 - 0.2 = 97.8
    ])
    const { trades } = runBacktest({
      candles,
      series: seriesWithLong(candles, 5, 98, 200),
      params: { ...OB_PARAMS, slippageTicks: 2 },
      tickSize: 0.1,
    })

    assert.equal(trades.length, 1)
    const t = trades[0]
    near(t.entryPrice, 100.6, 1e-9)
    assert.equal(t.exitReason, 'StopLoss')
    near(t.exitPrice, 97.8, 1e-9)
  })
})

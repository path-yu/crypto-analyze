// ===== 由 Pine 编译器生成，请勿手工修改 =====
// 源: BTC多空双向趋势系统_修复版
function __create(__pine) {
  const C = __pine.candles
  const n = C.length
  let __index = 0
  let __ctx = { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: NaN, side: null }
  let longCondition = NaN
  let shortCondition = NaN
  const emaLength = __pine.input.int("emaLength", 200, { title: "EMA 200 (大趋势过滤)" })
  const atrPeriod = __pine.input.int("atrPeriod", 10, { title: "SuperTrend ATR 周期" })
  const factor = __pine.input.float("factor", 3, { title: "SuperTrend 倍数" })
  const enableTrail = __pine.input.bool("enableTrail", true, { title: "开启追踪止盈" })
  const trailActivationPct = __pine.input.float("trailActivationPct", 3, { title: "激活阈值 (%)", step: 0.1 })
  const trailOffsetPct = __pine.input.float("trailOffsetPct", 1.5, { title: "回撤平仓 (%)", step: 0.1 })
  const __a_ema200 = __pine.ta.ema(C.close, emaLength)
  const [__a_supertrend, __a_direction] = __pine.ta.supertrend(C.high, C.low, C.close, factor, atrPeriod)
  const meta = {"kind":"strategy","config":{"title":"BTC 多空双向趋势系统_修复版","overlay":true,"initial_capital":10000,"default_qty_type":"cash","default_qty_value":10000,"commission_type":"percent","commission_value":0.04},"inputs":[{"name":"emaLength","type":"int","title":"EMA 200 (大趋势过滤)","default":200},{"name":"atrPeriod","type":"int","title":"SuperTrend ATR 周期","default":10},{"name":"factor","type":"float","title":"SuperTrend 倍数","default":3},{"name":"enableTrail","type":"bool","title":"开启追踪止盈","default":true},{"name":"trailActivationPct","type":"float","title":"激活阈值 (%)","step":0.1,"default":3},{"name":"trailOffsetPct","type":"float","title":"回撤平仓 (%)","step":0.1,"default":1.5}],"plotTitles":[],"alerts":[]}
  const plots = {}
  const markers = []
  const barColor = []

  function step(index, ctx) {
    __index = index
    __ctx = ctx
    let __entryDir = null
    let __entryId = null
    let __entryQty = NaN
    let __exitStop = NaN
    let __exitLimit = NaN
    let __forceClose = false
    ;__pine.plot(plots, __a_ema200[__index], "EMA 200", __index)
    ;__pine.plot(plots, ((__pine.lt(__a_direction[__index], 0)) ? (__a_supertrend[__index]) : (NaN)), "上涨支撑线", __index)
    ;__pine.plot(plots, ((__pine.gt(__a_direction[__index], 0)) ? (__a_supertrend[__index]) : (NaN)), "下跌阻力线", __index)
    longCondition = ((__pine.gt(C.close[__index], __a_ema200[__index]) && __pine.lt(__a_direction[__index], 0)) && __pine.gt(__pine.at(__a_direction, __index, 1), 0))
    shortCondition = ((__pine.lt(C.close[__index], __a_ema200[__index]) && __pine.gt(__a_direction[__index], 0)) && __pine.lt(__pine.at(__a_direction, __index, 1), 0))
    if (longCondition) {
      ;__entryDir = 'long'; __entryId = "Long"; __entryQty = NaN; __exitStop = NaN; __exitLimit = NaN
    }
    if (shortCondition) {
      ;__entryDir = 'short'; __entryId = "Short"; __entryQty = NaN; __exitStop = NaN; __exitLimit = NaN
    }
    if (__pine.neq(__ctx.positionSize, 0)) {
      let actTicks = Math.round((((__ctx.avgPrice * trailActivationPct) / 100) / __pine.ctx.mintick))
      let offsetTicks = Math.round((((__ctx.avgPrice * trailOffsetPct) / 100) / __pine.ctx.mintick))
      if (__pine.gt(__ctx.positionSize, 0)) {
        ;void 0
      }
      if (__pine.lt(__ctx.positionSize, 0)) {
        ;void 0
      }
    }
    if ((__pine.gt(__ctx.positionSize, 0) && __pine.gt(__a_direction[__index], 0))) {
      ;__forceClose = true
    }
    if ((__pine.lt(__ctx.positionSize, 0) && __pine.lt(__a_direction[__index], 0))) {
      ;__forceClose = true
    }
    const __obStop = __exitStop
    const __obTp = __exitLimit
    return {
      imbaTrendLine: NaN,
      tsotTrendValue: NaN,
      canLong: __entryDir === 'long',
      canShort: __entryDir === 'short',
      atrLongStop: NaN,
      atrShortStop: NaN,
      obStopLoss: __obStop,
      obTakeProfit: __obTp,
      obRisk: Number.isFinite(__obStop) ? Math.abs(C.close[__index] - __obStop) : NaN,
      entryQty: __entryQty,
      forceClose: __forceClose,
    }
  }

  return { step, meta, plots, markers, barColor }
}
globalThis.__pineProgram = { create: __create }

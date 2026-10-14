// ===== 由 Pine 编译器生成，请勿手工修改 =====
// 源: PumpRadar Pro
function __create(__pine) {
  const C = __pine.candles
  const n = C.length
  let __index = 0
  let __ctx = { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: NaN, side: null }
  let __cum_0 = 0
  let rng = NaN
  let delta = NaN
  let deltaEma = NaN
  let cvd = NaN
  let f1 = NaN
  let rangeComp = NaN
  let rangeBase = NaN
  let f2 = NaN
  let volPickup = NaN
  let f3 = NaN
  let upVol = NaN
  let dnVol = NaN
  let f4 = NaN
  let score = NaN
  let atrPct = NaN
  let atrBase = NaN
  let barPos = NaN
  let passAtr = NaN
  let passRej = NaN
  let longCond = NaN
  const __s_delta = []
  const __s_rangeComp = []
  const __s_atrPct = []
  const __s_cvd = []
  const cvdLen = __pine.input.int("cvdLen", 48, { title: "CVD：Delta EMA 平滑", group: "CVD" })
  const cvdBack = __pine.input.int("cvdBack", 48, { title: "CVD 回看根数", group: "CVD" })
  const rngLen = __pine.input.int("rngLen", 24, { title: "振幅窗口", group: "结构" })
  const rngSmaLen = __pine.input.int("rngSmaLen", 240, { title: "振幅基准均线", group: "结构" })
  const pickLen = __pine.input.int("pickLen", 96, { title: "量能基准均线", group: "量能" })
  const scoreMin = __pine.input.int("scoreMin", 3, { title: "最低评分 (1~4)", group: "门", minval: 1, maxval: 4 })
  const useSL = __pine.input.bool("useSL", true, { title: "结构止损", group: "风控" })
  const slBuf = __pine.input.float("slBuf", 0.5, { title: "止损缓冲 (%)", group: "风控", step: 0.1 })
  const beArm = __pine.input.float("beArm", 10, { title: "保本触发 (%)", group: "风控", step: 1 })
  const useTP50 = __pine.input.bool("useTP50", true, { title: "分批止盈", group: "风控" })
  const tpAt = __pine.input.float("tpAt", 20, { title: "分批触发 (%)", group: "风控", step: 1 })
  const useTrail = __pine.input.bool("useTrail", true, { title: "吊灯离场", group: "风控" })
  const trailPct = __pine.input.float("trailPct", 20, { title: "吊灯回撤 (%)", group: "风控", step: 1 })
  const maxBars = __pine.input.int("maxBars", 96, { title: "时间止损(根) 0=不限", group: "风控" })
  const useAtrFilter = __pine.input.bool("useAtrFilter", true, { title: "过滤：ATR% 高于基准时不开仓", group: "进场过滤" })
  const useRejFilter = __pine.input.bool("useRejFilter", true, { title: "过滤：点火K线须收在上半区", group: "进场过滤" })
  const atrRankTh = __pine.input.float("atrRankTh", 1, { title: "ATR% / 240均值 上限", group: "进场过滤", step: 0.1 })
  const __a_hiN = __pine.ta.highest(C.high, rngLen)
  const __a_loN = __pine.ta.lowest(C.low, rngLen)
  let sqStop = NaN
  let entryPx = NaN
  let hiMark = NaN
  let beDone = false
  let tpDone = false
  let held = 0
  const meta = {"kind":"strategy","config":{"title":"PumpRadar Pro 保本分批版","overlay":true,"commission_type":"percent","commission_value":0.055,"slippage":2,"initial_capital":10000,"default_qty_type":"percent_of_equity","default_qty_value":12,"pyramiding":0},"inputs":[{"name":"cvdLen","type":"int","title":"CVD：Delta EMA 平滑","group":"CVD","default":48},{"name":"cvdBack","type":"int","title":"CVD 回看根数","group":"CVD","default":48},{"name":"rngLen","type":"int","title":"振幅窗口","group":"结构","default":24},{"name":"rngSmaLen","type":"int","title":"振幅基准均线","group":"结构","default":240},{"name":"pickLen","type":"int","title":"量能基准均线","group":"量能","default":96},{"name":"scoreMin","type":"int","title":"最低评分 (1~4)","group":"门","minval":1,"maxval":4,"default":3},{"name":"useSL","type":"bool","title":"结构止损","group":"风控","default":true},{"name":"slBuf","type":"float","title":"止损缓冲 (%)","group":"风控","step":0.1,"default":0.5},{"name":"beArm","type":"float","title":"保本触发 (%)","group":"风控","step":1,"default":10},{"name":"useTP50","type":"bool","title":"分批止盈","group":"风控","default":true},{"name":"tpAt","type":"float","title":"分批触发 (%)","group":"风控","step":1,"default":20},{"name":"useTrail","type":"bool","title":"吊灯离场","group":"风控","default":true},{"name":"trailPct","type":"float","title":"吊灯回撤 (%)","group":"风控","step":1,"default":20},{"name":"maxBars","type":"int","title":"时间止损(根) 0=不限","group":"风控","default":96},{"name":"useAtrFilter","type":"bool","title":"过滤：ATR% 高于基准时不开仓","group":"进场过滤","default":true},{"name":"useRejFilter","type":"bool","title":"过滤：点火K线须收在上半区","group":"进场过滤","default":true},{"name":"atrRankTh","type":"float","title":"ATR% / 240均值 上限","group":"进场过滤","step":0.1,"default":1}],"plotTitles":[],"alerts":[]}
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
    rng = (C.high[__index] - C.low[__index])
    delta = (C.volume[__index] * ((__pine.gt(rng, 0)) ? (((C.close[__index] - C.open[__index]) / rng)) : (0))); __pine.serSet(__s_delta, __index, delta)
    deltaEma = __pine.ta.emaAt(__s_delta, __index, cvdLen)
    cvd = (__cum_0 += __pine.isNa(deltaEma) ? 0 : deltaEma); __pine.serSet(__s_cvd, __index, cvd)
    f1 = __pine.gt(cvd, __pine.at(__s_cvd, __index, cvdBack))
    rangeComp = ((__pine.gt(C.close[__index], 0)) ? (((__a_hiN[__index] - __a_loN[__index]) / C.close[__index])) : (NaN)); __pine.serSet(__s_rangeComp, __index, rangeComp)
    rangeBase = __pine.ta.smaAt(__s_rangeComp, __index, rngSmaLen)
    f2 = (__pine.gt(rangeBase, 0) && __pine.lt(rangeComp, (rangeBase * 0.8)))
    volPickup = (__pine.ta.smaAt(C.volume, __index, 6) / __pine.ta.smaAt(C.volume, __index, pickLen))
    f3 = __pine.gt(volPickup, 1.2)
    upVol = __pine.ta.sma(Math.max(delta, 0), 48)
    dnVol = __pine.ta.sma(Math.max((-delta), 0), 48)
    f4 = (__pine.gt(dnVol, 0) && __pine.gt((upVol / dnVol), 1.2))
    score = (((((f1) ? (1) : (0)) + ((f2) ? (1) : (0))) + ((f3) ? (1) : (0))) + ((f4) ? (1) : (0)))
    atrPct = ((__pine.gt(C.close[__index], 0)) ? (((__pine.ta.atrAt(C.high, C.low, C.close, __index, 14, 'RMA') / C.close[__index]) * 100)) : (NaN)); __pine.serSet(__s_atrPct, __index, atrPct)
    atrBase = __pine.ta.smaAt(__s_atrPct, __index, 240)
    barPos = ((__pine.gt(rng, 0)) ? (((C.close[__index] - C.low[__index]) / rng)) : (NaN))
    passAtr = ((!useAtrFilter) || ((!__pine.isNa(atrBase)) && __pine.le(atrPct, (atrBase * atrRankTh))))
    passRej = ((!useRejFilter) || (__pine.gt(rng, 0) && __pine.ge(barPos, 0.5)))
    longCond = (((__pine.ge(score, scoreMin) && passAtr) && passRej) && __pine.eq(__ctx.positionSize, 0))
    if (longCond) {
      ;__entryDir = 'long'; __entryId = "Radar"; __entryQty = NaN; __exitStop = sqStop; __exitLimit = NaN
      sqStop = (__pine.ta.lowestAt(C.low, __index, 24) * (1 - (slBuf / 100)))
      entryPx = C.close[__index]
      hiMark = C.close[__index]
      beDone = false
      tpDone = false
      held = 0
    }
    if (__pine.gt(__ctx.positionSize, 0)) {
      hiMark = Math.max(hiMark, C.high[__index])
      if ((((__pine.gt(beArm, 0) && (!beDone)) && __pine.ge(hiMark, (entryPx * (1 + (beArm / 100))))) && __pine.lt(sqStop, entryPx))) {
        sqStop = entryPx
        beDone = true
      }
      if (useSL) {
        ;__exitStop = sqStop
      }
      if (((useTP50 && (!tpDone)) && __pine.ge(C.high[__index], (entryPx * (1 + (tpAt / 100)))))) {
        ;__forceClose = true
        tpDone = true
      }
      if ((useTrail && __pine.lt(C.close[__index], (hiMark * (1 - (trailPct / 100)))))) {
        ;__forceClose = true
      }
      held = (held + 1)
      if ((__pine.gt(maxBars, 0) && __pine.ge(held, maxBars))) {
        ;__forceClose = true
      }
    } else {
      held = 0
    }
    ;__pine.mark(markers, longCond, "雷达触发", "belowbar", __index)
    ;__pine.plot(plots, score, "评分", __index)
    if (__entryId !== null) { if (__entryId === "Radar") { __exitStop = sqStop } }
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

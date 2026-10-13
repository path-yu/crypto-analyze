// ===== 由 Pine 编译器生成，请勿手工修改 =====
// 源: 突破支撑趋势
function __create(__pine) {
  const C = __pine.candles
  const n = C.length
  let __index = 0
  let __ctx = { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: NaN, side: null }
  const __hm_strategy_position_size = __pine.makeRing(2)
  let volumeSurge = NaN
  let trendUpOk = NaN
  let trendDownOk = NaN
  let inRange = NaN
  let longBreakout = NaN
  let shortBreakout = NaN
  let flatNow = NaN
  let flatPrev = NaN
  let posColor = NaN
  let p_res = NaN
  let p_sup = NaN
  let midChannel = NaN
  let p_mid = NaN
  const g_sr = "✧ Support / Resistance ✧"
  const g_vol = "✧ Volume Confirmation ✧"
  const g_trend = "✧ Trend Filter ✧"
  const g_risk = "✧ Risk Management ✧"
  const g_date = "✧ Backtest Range ✧"
  const g_vis = "✧ Visuals ✧"
  const pivotLeft = __pine.input.int("pivotLeft", 10, { title: "Pivot Left Bars", group: g_sr, minval: 1 })
  const pivotRight = __pine.input.int("pivotRight", 10, { title: "Pivot Right Bars", group: g_sr, minval: 1 })
  const volLength = __pine.input.int("volLength", 20, { title: "Volume Average Length", group: g_vol, minval: 1 })
  const volMultiplier = __pine.input.float("volMultiplier", 1.5, { title: "Volume Surge Multiplier", group: g_vol, minval: 1, step: 0.1 })
  const useTrendFilter = __pine.input.bool("useTrendFilter", true, { title: "Require EMA trend filter", group: g_trend })
  const emaLength = __pine.input.int("emaLength", 200, { title: "EMA Length", group: g_trend, minval: 1 })
  const atrLength = __pine.input.int("atrLength", 14, { title: "ATR Length", group: g_risk, minval: 1 })
  const atrStopMult = __pine.input.float("atrStopMult", 1.5, { title: "ATR Stop Multiplier", group: g_risk, minval: 0.1, step: 0.1 })
  const atrTargetMult = __pine.input.float("atrTargetMult", 3, { title: "ATR Target Multiplier", group: g_risk, minval: 0.1, step: 0.1 })
  const useStructStop = __pine.input.bool("useStructStop", true, { title: "Use broken swing level as stop (else pure ATR)", group: g_risk })
  const stopBufferAtr = __pine.input.float("stopBufferAtr", 0.25, { title: "Structural Stop ATR Buffer", group: g_risk, minval: 0, step: 0.05 })
  const startDate = __pine.input.time("startDate", __pine.timestamp("01 Jan 2018 00:00 +0000"), { title: "Start Date", group: g_date })
  const endDate = __pine.input.time("endDate", __pine.timestamp("31 Dec 2025 00:00 +0000"), { title: "End Date", group: g_date })
  const colorCandles = __pine.input.bool("colorCandles", true, { title: "Color candles by position", group: g_vis })
  const enableGlow = __pine.input.bool("enableGlow", true, { title: "Glow effect on S/R lines", group: g_vis })
  const showChannelGradient = __pine.input.bool("showChannelGradient", true, { title: "Gradient fill inside S/R channel", group: g_vis })
  const bullColor = __pine.input.color("bullColor", "#0097a7", { title: "Bullish / Long Color", group: g_vis })
  const bearColor = __pine.input.color("bearColor", "#ff195f", { title: "Bearish / Short Color", group: g_vis })
  const __a_ph = __pine.ta.pivothigh(C.high, pivotLeft, pivotRight)
  const __a_pl = __pine.ta.pivotlow(C.low, pivotLeft, pivotRight)
  let resistance = NaN
  let support = NaN
  const __a_avgVolume = __pine.ta.sma(C.volume, volLength)
  const __a_emaVal = __pine.ta.ema(C.close, emaLength)
  const __a_atrVal = __pine.ta.atr(C.high, C.low, C.close, atrLength, 'RMA')
  let longStopPrice = NaN
  let longTgtPrice = NaN
  let shortStopPrice = NaN
  let shortTgtPrice = NaN
  const meta = {"kind":"strategy","config":{"title":"Volume-Confirmed Support/Resistance Breakout Strategy","shorttitle":"Vol S/R Breakout","overlay":true,"initial_capital":10000,"default_qty_type":"percent_of_equity","default_qty_value":10,"commission_type":"percent","commission_value":0.01,"slippage":2,"pyramiding":0},"inputs":[{"name":"pivotLeft","type":"int","title":"Pivot Left Bars","minval":1,"default":10},{"name":"pivotRight","type":"int","title":"Pivot Right Bars","minval":1,"default":10},{"name":"volLength","type":"int","title":"Volume Average Length","minval":1,"default":20},{"name":"volMultiplier","type":"float","title":"Volume Surge Multiplier","minval":1,"step":0.1,"default":1.5},{"name":"useTrendFilter","type":"bool","title":"Require EMA trend filter","default":true},{"name":"emaLength","type":"int","title":"EMA Length","minval":1,"default":200},{"name":"atrLength","type":"int","title":"ATR Length","minval":1,"default":14},{"name":"atrStopMult","type":"float","title":"ATR Stop Multiplier","minval":0.1,"step":0.1,"default":1.5},{"name":"atrTargetMult","type":"float","title":"ATR Target Multiplier","minval":0.1,"step":0.1,"default":3},{"name":"useStructStop","type":"bool","title":"Use broken swing level as stop (else pure ATR)","default":true},{"name":"stopBufferAtr","type":"float","title":"Structural Stop ATR Buffer","minval":0,"step":0.05,"default":0.25},{"name":"startDate","type":"float","title":"Start Date"},{"name":"endDate","type":"float","title":"End Date"},{"name":"colorCandles","type":"bool","title":"Color candles by position","default":true},{"name":"enableGlow","type":"bool","title":"Glow effect on S/R lines","default":true},{"name":"showChannelGradient","type":"bool","title":"Gradient fill inside S/R channel","default":true},{"name":"bullColor","type":"color","title":"Bullish / Long Color","default":"#0097a7"},{"name":"bearColor","type":"color","title":"Bearish / Short Color","default":"#ff195f"}],"plotTitles":[],"alerts":[]}
  const plots = {}
  const markers = []
  const barColor = []

  function step(index, ctx) {
    __index = index
    __ctx = ctx
    __pine.push(__hm_strategy_position_size, __ctx.positionSize)
    let __entryDir = null
    let __exitStop = NaN
    let __exitLimit = NaN
    let __forceClose = false
    if ((!__pine.isNa(__a_ph[__index]))) {
      resistance = __a_ph[__index]
    }
    if ((!__pine.isNa(__a_pl[__index]))) {
      support = __a_pl[__index]
    }
    volumeSurge = __pine.gt(C.volume[__index], (__a_avgVolume[__index] * volMultiplier))
    trendUpOk = ((!useTrendFilter) || __pine.gt(C.close[__index], __a_emaVal[__index]))
    trendDownOk = ((!useTrendFilter) || __pine.lt(C.close[__index], __a_emaVal[__index]))
    inRange = (__pine.ge(C.timestamp[__index], startDate) && __pine.le(C.timestamp[__index], endDate))
    longBreakout = (((((!__pine.isNa(resistance)) && __pine.gt(C.close[__index], resistance)) && volumeSurge) && trendUpOk) && inRange)
    shortBreakout = (((((!__pine.isNa(support)) && __pine.lt(C.close[__index], support)) && volumeSurge) && trendDownOk) && inRange)
    if (longBreakout) {
      ;__entryDir = 'long'; __exitStop = longStopPrice; __exitLimit = longTgtPrice
      longStopPrice = (((useStructStop && (!__pine.isNa(support)))) ? ((support - (__a_atrVal[__index] * stopBufferAtr))) : ((C.close[__index] - (__a_atrVal[__index] * atrStopMult))))
      longTgtPrice = (C.close[__index] + (__a_atrVal[__index] * atrTargetMult))
    }
    if (shortBreakout) {
      ;__entryDir = 'short'; __exitStop = shortStopPrice; __exitLimit = shortTgtPrice
      shortStopPrice = (((useStructStop && (!__pine.isNa(resistance)))) ? ((resistance + (__a_atrVal[__index] * stopBufferAtr))) : ((C.close[__index] + (__a_atrVal[__index] * atrStopMult))))
      shortTgtPrice = (C.close[__index] - (__a_atrVal[__index] * atrTargetMult))
    }
    if (__pine.gt(__ctx.positionSize, 0)) {
      ;__exitStop = longStopPrice; __exitLimit = longTgtPrice
    }
    if (__pine.lt(__ctx.positionSize, 0)) {
      ;__exitStop = shortStopPrice; __exitLimit = shortTgtPrice
    }
    flatNow = __pine.eq(__ctx.positionSize, 0)
    flatPrev = __pine.neq(__pine.hist(__hm_strategy_position_size, 1), 0)
    if ((flatNow && flatPrev)) {
      longStopPrice = NaN
      longTgtPrice = NaN
      shortStopPrice = NaN
      shortTgtPrice = NaN
    }
    posColor = ((__pine.gt(__ctx.positionSize, 0)) ? (bullColor) : (((__pine.lt(__ctx.positionSize, 0)) ? (bearColor) : (NaN))))
    ;void 0
    ;__pine.plot(plots, ((enableGlow) ? (resistance) : (NaN)), "Resistance Glow Outer", __index)
    ;__pine.plot(plots, ((enableGlow) ? (resistance) : (NaN)), "Resistance Glow Inner", __index)
    p_res = __pine.plot(plots, resistance, "Resistance", __index)
    ;__pine.plot(plots, ((enableGlow) ? (support) : (NaN)), "Support Glow Outer", __index)
    ;__pine.plot(plots, ((enableGlow) ? (support) : (NaN)), "Support Glow Inner", __index)
    p_sup = __pine.plot(plots, support, "Support", __index)
    midChannel = ((((!__pine.isNa(resistance)) && (!__pine.isNa(support)))) ? (((resistance + support) / 2)) : (NaN))
    p_mid = __pine.plot(plots, ((showChannelGradient) ? (midChannel) : (NaN)), "Channel Midline", __index)
    ;__pine.plot(plots, ((useTrendFilter) ? (__a_emaVal[__index]) : (NaN)), "EMA Trend", __index)
    ;__pine.mark(markers, longBreakout, "Long Signal", "belowbar", __index)
    ;__pine.mark(markers, shortBreakout, "Short Signal", "abovebar", __index)
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
      forceClose: __forceClose,
    }
  }

  return { step, meta, plots, markers, barColor }
}
globalThis.__pineProgram = { create: __create }

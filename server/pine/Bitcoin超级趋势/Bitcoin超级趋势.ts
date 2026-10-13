// ===== 由 Pine 编译器生成，请勿手工修改 =====
// 源: Bitcoin超级趋势
function __create(__pine) {
  const C = __pine.candles
  const n = C.length
  let __index = 0
  let __ctx = { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: NaN, side: null }
  let color_preset = NaN
  let bullFlip = NaN
  let bearFlip = NaN
  let adxOK = NaN
  let longCondition = NaN
  let shortCondition = NaN
  let trend_color = NaN
  let st_up = NaN
  let st_dn = NaN
  let p_st_up = NaN
  let p_st_dn = NaN
  let p_price = NaN
  let step_up = NaN
  let grad1_up = NaN
  let grad2_up = NaN
  let grad3_up = NaN
  let step_dn = NaN
  let grad1_dn = NaN
  let grad2_dn = NaN
  let grad3_dn = NaN
  let p_g1u = NaN
  let p_g2u = NaN
  let p_g3u = NaN
  let p_g1d = NaN
  let p_g2d = NaN
  let p_g3d = NaN
  let bullish_color = NaN
  let bearish_color = NaN
  const g_strategy = "════════ Strategy Settings ════════"
  const g_adx = "════════ ADX Filter ════════"
  const g_visual = "════════ Visual Settings ════════"
  const atrPeriod = __pine.input.int("atrPeriod", 10, { title: "Supertrend ATR Length", group: g_strategy })
  const factor = __pine.input.float("factor", 1.8, { title: "Supertrend Factor", group: g_strategy, step: 0.1 })
  const emaLen = __pine.input.int("emaLen", 200, { title: "EMA Trend Filter Length", group: g_strategy })
  const enableSL = __pine.input.bool("enableSL", false, { title: "Enable Stop Loss", group: g_strategy })
  const enableTP = __pine.input.bool("enableTP", false, { title: "Enable Take Profit", group: g_strategy })
  const slPct = (__pine.input.float("slPct", 4, { title: "Stop Loss %", group: g_strategy, step: 0.1 }) / 100)
  const tpPct = (__pine.input.float("tpPct", 8, { title: "Take Profit %", group: g_strategy, step: 0.1 }) / 100)
  const enableADX = __pine.input.bool("enableADX", false, { title: "Enable ADX Filter", group: g_adx })
  const adxLen = __pine.input.int("adxLen", 14, { title: "ADX Length", group: g_adx, minval: 1 })
  const adxSmooth = __pine.input.int("adxSmooth", 14, { title: "ADX Smoothing", group: g_adx, minval: 1 })
  const adxThresh = __pine.input.float("adxThresh", 20, { title: "ADX Threshold", group: g_adx, step: 1 })
  const show_fill = __pine.input.bool("show_fill", true, { title: "Show Gradient Fill", group: g_visual })
  const show_markers = __pine.input.bool("show_markers", true, { title: "Show Flip Markers", group: g_visual })
  const bullish_input = __pine.input.color("bullish_input", "#00ffaa", { title: "Bullish Color", group: g_visual })
  const bearish_input = __pine.input.color("bearish_input", "#ff0000", { title: "Bearish Color", group: g_visual })
  const show_candles = __pine.input.bool("show_candles", false, { title: "Enable Bar Coloring", group: g_visual })
  const bar_trans = __pine.input.int("bar_trans", 0, { title: "Bar Color Transparency", group: g_visual, minval: 0, maxval: 100 })
  const show_bgcolor = __pine.input.bool("show_bgcolor", false, { title: "Enable Background Coloring", group: g_visual })
  const bg_trans = __pine.input.int("bg_trans", 90, { title: "Background Color Transparency", group: g_visual, minval: 0, maxval: 100 })
  const [__a_supertrend, __a_direction] = __pine.ta.supertrend(C.high, C.low, C.close, factor, atrPeriod)
  const __a_trendEMA = __pine.ta.ema(C.close, emaLen)
  const [__a_diplus, __a_diminus, __a_adx] = __pine.ta.dmi(C.high, C.low, C.close, adxLen, adxSmooth)
  const meta = {"kind":"strategy","config":{"title":"BTCUSD Supertrend + EMA Trend Filter (1H)","overlay":true,"initial_capital":10000,"default_qty_type":"percent_of_equity","default_qty_value":25,"commission_type":"percent","commission_value":0.075,"slippage":1},"inputs":[{"name":"atrPeriod","type":"int","title":"Supertrend ATR Length","default":10},{"name":"factor","type":"float","title":"Supertrend Factor","step":0.1,"default":1.8},{"name":"emaLen","type":"int","title":"EMA Trend Filter Length","default":200},{"name":"enableSL","type":"bool","title":"Enable Stop Loss","default":false},{"name":"enableTP","type":"bool","title":"Enable Take Profit","default":false},{"name":"slPct","type":"float","title":"Stop Loss %","step":0.1,"default":4},{"name":"tpPct","type":"float","title":"Take Profit %","step":0.1,"default":8},{"name":"enableADX","type":"bool","title":"Enable ADX Filter","default":false},{"name":"adxLen","type":"int","title":"ADX Length","minval":1,"default":14},{"name":"adxSmooth","type":"int","title":"ADX Smoothing","minval":1,"default":14},{"name":"adxThresh","type":"float","title":"ADX Threshold","step":1,"default":20},{"name":"show_fill","type":"bool","title":"Show Gradient Fill","default":true},{"name":"show_markers","type":"bool","title":"Show Flip Markers","default":true},{"name":"bullish_input","type":"color","title":"Bullish Color","default":"#00ffaa"},{"name":"bearish_input","type":"color","title":"Bearish Color","default":"#ff0000"},{"name":"show_candles","type":"bool","title":"Enable Bar Coloring","default":false},{"name":"bar_trans","type":"int","title":"Bar Color Transparency","minval":0,"maxval":100,"default":0},{"name":"show_bgcolor","type":"bool","title":"Enable Background Coloring","default":false},{"name":"bg_trans","type":"int","title":"Background Color Transparency","minval":0,"maxval":100,"default":90}],"plotTitles":[],"alerts":[]}
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
    color_preset = __pine.input.string("input_19", "Custom", { title: "Color Preset", group: g_visual })
    const __tup0 = (("Classic" === color_preset) ? (["#00ff00", "#ff0000"]) : ((("Aqua" === color_preset) ? (["#00d4ff", "#ff8c00"]) : ((("Cosmic" === color_preset) ? (["#49ffce", "#9932cc"]) : ((("Cyber" === color_preset) ? (["#00cccc", "#ff6600"]) : ((("Neon" === color_preset) ? (["#ffff00", "#ff00ff"]) : ((("Custom" === color_preset) ? ([bullish_input, bearish_input]) : (NaN))))))))))))
    bullish_color = __tup0[0]
    bearish_color = __tup0[1]
    bullFlip = __pine.lt(__pine.ta.changeAt(__a_direction, __index), 0)
    bearFlip = __pine.gt(__pine.ta.changeAt(__a_direction, __index), 0)
    adxOK = ((!enableADX) || __pine.gt(__a_adx[__index], adxThresh))
    longCondition = ((bullFlip && __pine.gt(C.close[__index], __a_trendEMA[__index])) && adxOK)
    shortCondition = ((bearFlip && __pine.lt(C.close[__index], __a_trendEMA[__index])) && adxOK)
    trend_color = ((__pine.lt(__a_direction[__index], 0)) ? (bullish_color) : (bearish_color))
    if (longCondition) {
      ;__entryDir = 'long'; __entryId = "Long"; __entryQty = NaN; __exitStop = NaN; __exitLimit = NaN
    }
    if (shortCondition) {
      ;__entryDir = 'short'; __entryId = "Short"; __entryQty = NaN; __exitStop = NaN; __exitLimit = NaN
    }
    if (bearFlip) {
      ;__forceClose = true
    }
    if (bullFlip) {
      ;__forceClose = true
    }
    if (__pine.gt(__ctx.positionSize, 0)) {
      let entryPrice = __ctx.avgPrice
      if (enableSL) {
        ;__exitStop = (entryPrice * (1 - slPct)); __exitLimit = ((enableTP) ? ((entryPrice * (1 + tpPct))) : (NaN))
      }
    }
    if (__pine.lt(__ctx.positionSize, 0)) {
      let entryPrice = __ctx.avgPrice
      if (enableSL) {
        ;__exitStop = (entryPrice * (1 + slPct)); __exitLimit = ((enableTP) ? ((entryPrice * (1 - tpPct))) : (NaN))
      }
    }
    st_up = ((__pine.lt(__a_direction[__index], 0)) ? (__a_supertrend[__index]) : (NaN))
    st_dn = ((__pine.gt(__a_direction[__index], 0)) ? (__a_supertrend[__index]) : (NaN))
    ;__pine.plot(plots, st_up, "Glow Up", __index)
    ;__pine.plot(plots, st_dn, "Glow Down", __index)
    p_st_up = __pine.plot(plots, st_up, "Bullish Supertrend", __index)
    p_st_dn = __pine.plot(plots, st_dn, "Bearish Supertrend", __index)
    ;__pine.plot(plots, __a_trendEMA[__index], "EMA Trend Filter", __index)
    p_price = __pine.plot(plots, C.close[__index], "Price Anchor", __index)
    step_up = (((!__pine.isNa(st_up))) ? (((C.close[__index] - st_up) / 4)) : (NaN))
    grad1_up = (((!__pine.isNa(step_up))) ? ((st_up + (step_up * 1))) : (NaN))
    grad2_up = (((!__pine.isNa(step_up))) ? ((st_up + (step_up * 2))) : (NaN))
    grad3_up = (((!__pine.isNa(step_up))) ? ((st_up + (step_up * 3))) : (NaN))
    step_dn = (((!__pine.isNa(st_dn))) ? (((C.close[__index] - st_dn) / 4)) : (NaN))
    grad1_dn = (((!__pine.isNa(step_dn))) ? ((st_dn + (step_dn * 1))) : (NaN))
    grad2_dn = (((!__pine.isNa(step_dn))) ? ((st_dn + (step_dn * 2))) : (NaN))
    grad3_dn = (((!__pine.isNa(step_dn))) ? ((st_dn + (step_dn * 3))) : (NaN))
    p_g1u = __pine.plot(plots, ((show_fill) ? (grad1_up) : (NaN)), "plot_6", __index)
    p_g2u = __pine.plot(plots, ((show_fill) ? (grad2_up) : (NaN)), "plot_7", __index)
    p_g3u = __pine.plot(plots, ((show_fill) ? (grad3_up) : (NaN)), "plot_8", __index)
    p_g1d = __pine.plot(plots, ((show_fill) ? (grad1_dn) : (NaN)), "plot_9", __index)
    p_g2d = __pine.plot(plots, ((show_fill) ? (grad2_dn) : (NaN)), "plot_10", __index)
    p_g3d = __pine.plot(plots, ((show_fill) ? (grad3_dn) : (NaN)), "plot_11", __index)
    ;__pine.mark(markers, (((show_markers && bullFlip)) ? (__a_supertrend[__index]) : (NaN)), "Bullish Flip", "belowbar", __index)
    ;__pine.mark(markers, (((show_markers && bearFlip)) ? (__a_supertrend[__index]) : (NaN)), "Bearish Flip", "abovebar", __index)
    ;__pine.mark(markers, longCondition, "Long Entry", "belowbar", __index)
    ;__pine.mark(markers, shortCondition, "Short Entry", "abovebar", __index)
    ;__pine.barColor(barColor, ((show_candles) ? (__pine.color.new(trend_color, bar_trans)) : (NaN)), __index)
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

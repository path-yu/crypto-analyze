// ===== 由 Pine 编译器生成，请勿手工修改 =====
// 源: 加密货币山寨币做空策略
function __create(__pine) {
  const C = __pine.candles
  const n = C.length
  let __index = 0
  let __ctx = { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: NaN, side: null }
  const __hm_strategy_position_size = __pine.makeRing(2)
  let donchianLow = NaN
  let atrPct = NaN
  let bearishStack = NaN
  let trendOk = NaN
  let hadOverbought = NaN
  let rsiTurningDown = NaN
  let structureBreak = NaN
  let volumeOk = NaN
  let volFloorOk = NaN
  let inSession = NaN
  let cooldownOk = NaN
  let shortEntryCond = NaN
  let bullishStack = NaN
  let rsiRebound = NaN
  let shortExitCond = NaN
  let longEntryCond = NaN
  let orderQty = NaN
  const grpTrend = "① 趋势过滤 (Trend Filter)"
  const emaFastLen = __pine.input.int("emaFastLen", 12, { title: "快线 EMA 周期", group: grpTrend, minval: 2 })
  const emaSlowLen = __pine.input.int("emaSlowLen", 26, { title: "中线 EMA 周期", group: grpTrend, minval: 3 })
  const emaTrendLen = __pine.input.int("emaTrendLen", 100, { title: "慢线 EMA 周期", group: grpTrend, minval: 10 })
  const useTrendFilter = __pine.input.bool("useTrendFilter", true, { title: "启用长期趋势过滤", group: grpTrend })
  const grpMom = "② 动量触发 (Momentum Trigger)"
  const rsiLen = __pine.input.int("rsiLen", 14, { title: "RSI 周期", group: grpMom, minval: 2 })
  const rsiOverbought = __pine.input.int("rsiOverbought", 70, { title: "RSI 超买阈值", group: grpMom, minval: 50, maxval: 100 })
  const rsiFallLevel = __pine.input.int("rsiFallLevel", 55, { title: "RSI 回落触发线", group: grpMom, minval: 30, maxval: 90 })
  const rsiLookback = __pine.input.int("rsiLookback", 10, { title: "超买回溯窗口 (根)", group: grpMom, minval: 1 })
  const grpStruct = "③ 结构破位 (Structure Break)"
  const useDonchian = __pine.input.bool("useDonchian", true, { title: "启用前低破位确认", group: grpStruct })
  const donchianLen = __pine.input.int("donchianLen", 20, { title: "Donchian 通道周期", group: grpStruct, minval: 2 })
  const useVolumeFilter = __pine.input.bool("useVolumeFilter", false, { title: "启用成交量过滤", group: grpStruct })
  const volumeMaLen = __pine.input.int("volumeMaLen", 20, { title: "成交量均线周期", group: grpStruct, minval: 2 })
  const volumeMult = __pine.input.float("volumeMult", 1.2, { title: "放量倍数", group: grpStruct, minval: 0.1, step: 0.1 })
  const grpRisk = "④ 风控 (Risk Control)"
  const atrLen = __pine.input.int("atrLen", 14, { title: "ATR 周期", group: grpRisk, minval: 2 })
  const atrStopMult = __pine.input.float("atrStopMult", 2, { title: "止损 ATR 倍数", group: grpRisk, minval: 0.5, step: 0.1 })
  const atrProfitMult = __pine.input.float("atrProfitMult", 3, { title: "止盈 ATR 倍数", group: grpRisk, minval: 0.5, step: 0.1 })
  const useTrailing = __pine.input.bool("useTrailing", true, { title: "启用移动止损", group: grpRisk })
  const trailStartMult = __pine.input.float("trailStartMult", 1, { title: "移动止损启动 ATR 倍数", group: grpRisk, minval: 0.1, step: 0.1 })
  const trailOffsetMult = __pine.input.float("trailOffsetMult", 1.2, { title: "移动止损回撤 ATR 倍数", group: grpRisk, minval: 0.1, step: 0.1 })
  const grpFilter = "⑤ 环境过滤 (Regime Filter)"
  const useVolFloor = __pine.input.bool("useVolFloor", true, { title: "启用最低波动率过滤", group: grpFilter })
  const minAtrPct = __pine.input.float("minAtrPct", 1, { title: "最低 ATR 占价格比例 (%)", group: grpFilter, minval: 0, step: 0.1 })
  const cooldownBars = __pine.input.int("cooldownBars", 5, { title: "信号冷却期 (根)", group: grpFilter, minval: 0 })
  const allowLong = __pine.input.bool("allowLong", false, { title: "允许做多", group: grpFilter })
  const grpTime = "⑥ 时间过滤 (Session)"
  const useTimeFilter = __pine.input.bool("useTimeFilter", false, { title: "启用交易时段过滤", group: grpTime })
  const tradeSession = __pine.input.string("tradeSession", "0000-2400", { title: "允许开仓时段", group: grpTime })
  const __a_emaFast = __pine.ta.ema(C.close, emaFastLen)
  const __a_emaSlow = __pine.ta.ema(C.close, emaSlowLen)
  const __a_emaTrend = __pine.ta.ema(C.close, emaTrendLen)
  const __a_rsi = __pine.ta.rsi(C.close, rsiLen)
  const __a_atr = __pine.ta.atr(C.high, C.low, C.close, atrLen, 'RMA')
  const __a_volMa = __pine.ta.sma(C.volume, volumeMaLen)
  let barsSinceExit = 100000
  const equityPct = __pine.input.float("equityPct", 100, { title: "单次开仓占权益比例 (%)", group: "⑦ 仓位 (Position)", minval: 1, maxval: 100 })
  let lowestSinceEntry = NaN
  let infoTable = __pine.table.new('top_right', 2, 8, { border_width: 1, border_color: __pine.color.new(__pine.color.gray, 50) })
  const meta = {"kind":"strategy","config":{"title":"Altcoin Short Strategy (v6)","overlay":true,"default_qty_type":"percent_of_equity","default_qty_value":100,"initial_capital":10000,"pyramiding":0,"commission_type":"percent","commission_value":0.05,"slippage":5,"calc_on_every_tick":false,"process_orders_on_close":false,"margin_long":100,"margin_short":100},"inputs":[{"name":"emaFastLen","type":"int","title":"快线 EMA 周期","minval":2,"default":12},{"name":"emaSlowLen","type":"int","title":"中线 EMA 周期","minval":3,"default":26},{"name":"emaTrendLen","type":"int","title":"慢线 EMA 周期","minval":10,"default":100},{"name":"useTrendFilter","type":"bool","title":"启用长期趋势过滤","default":true},{"name":"rsiLen","type":"int","title":"RSI 周期","minval":2,"default":14},{"name":"rsiOverbought","type":"int","title":"RSI 超买阈值","minval":50,"maxval":100,"default":70},{"name":"rsiFallLevel","type":"int","title":"RSI 回落触发线","minval":30,"maxval":90,"default":55},{"name":"rsiLookback","type":"int","title":"超买回溯窗口 (根)","minval":1,"default":10},{"name":"useDonchian","type":"bool","title":"启用前低破位确认","default":true},{"name":"donchianLen","type":"int","title":"Donchian 通道周期","minval":2,"default":20},{"name":"useVolumeFilter","type":"bool","title":"启用成交量过滤","default":false},{"name":"volumeMaLen","type":"int","title":"成交量均线周期","minval":2,"default":20},{"name":"volumeMult","type":"float","title":"放量倍数","minval":0.1,"step":0.1,"default":1.2},{"name":"atrLen","type":"int","title":"ATR 周期","minval":2,"default":14},{"name":"atrStopMult","type":"float","title":"止损 ATR 倍数","minval":0.5,"step":0.1,"default":2},{"name":"atrProfitMult","type":"float","title":"止盈 ATR 倍数","minval":0.5,"step":0.1,"default":3},{"name":"useTrailing","type":"bool","title":"启用移动止损","default":true},{"name":"trailStartMult","type":"float","title":"移动止损启动 ATR 倍数","minval":0.1,"step":0.1,"default":1},{"name":"trailOffsetMult","type":"float","title":"移动止损回撤 ATR 倍数","minval":0.1,"step":0.1,"default":1.2},{"name":"useVolFloor","type":"bool","title":"启用最低波动率过滤","default":true},{"name":"minAtrPct","type":"float","title":"最低 ATR 占价格比例 (%)","minval":0,"step":0.1,"default":1},{"name":"cooldownBars","type":"int","title":"信号冷却期 (根)","minval":0,"default":5},{"name":"allowLong","type":"bool","title":"允许做多","default":false},{"name":"useTimeFilter","type":"bool","title":"启用交易时段过滤","default":false},{"name":"tradeSession","type":"float","title":"允许开仓时段","default":"0000-2400"},{"name":"equityPct","type":"float","title":"单次开仓占权益比例 (%)","group":"⑦ 仓位 (Position)","minval":1,"maxval":100,"default":100}],"plotTitles":[],"alerts":[]}
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
    donchianLow = __pine.at(__pine.ta.lowest(C.low, donchianLen), __index, 1)
    atrPct = ((__a_atr[__index] / C.close[__index]) * 100)
    bearishStack = __pine.lt(__a_emaFast[__index], __a_emaSlow[__index])
    trendOk = ((useTrendFilter) ? ((__pine.lt(C.close[__index], __a_emaTrend[__index]) && __pine.lt(__a_emaSlow[__index], __a_emaTrend[__index]))) : (true))
    hadOverbought = __pine.gt(__pine.ta.highestAt(__a_rsi, __index, rsiLookback), rsiOverbought)
    rsiTurningDown = ((hadOverbought && __pine.lt(__a_rsi[__index], rsiFallLevel)) && __pine.lt(__a_rsi[__index], __pine.at(__a_rsi, __index, 1)))
    structureBreak = ((useDonchian) ? (__pine.lt(C.close[__index], donchianLow)) : (true))
    volumeOk = ((useVolumeFilter) ? (__pine.gt(C.volume[__index], (__a_volMa[__index] * volumeMult))) : (true))
    volFloorOk = ((useVolFloor) ? (__pine.ge(atrPct, minAtrPct)) : (true))
    inSession = ((!useTimeFilter) || (!__pine.isNa(C.timestamp[__index])))
    if ((__pine.eq(__ctx.positionSize, 0) && __pine.neq(__pine.hist(__hm_strategy_position_size, 1), 0))) {
      barsSinceExit = 0
    }
    else if (__pine.eq(__ctx.positionSize, 0)) {
      barsSinceExit = (barsSinceExit + 1)
    }
    cooldownOk = __pine.ge(barsSinceExit, cooldownBars)
    shortEntryCond = (((((((bearishStack && trendOk) && rsiTurningDown) && structureBreak) && volumeOk) && volFloorOk) && inSession) && cooldownOk)
    bullishStack = __pine.gt(__a_emaFast[__index], __a_emaSlow[__index])
    rsiRebound = ((__pine.gt(__a_rsi[__index], 45) && __pine.le(__pine.at(__a_rsi, __index, 1), 45)) && __pine.lt(__pine.at(__pine.ta.lowest(__a_rsi, rsiLookback), __index, 0), 35))
    shortExitCond = ((bullishStack && ((useTrendFilter) ? (__pine.gt(C.close[__index], __a_emaTrend[__index])) : (true))) && rsiRebound)
    longEntryCond = ((((allowLong && bullishStack) && ((useTrendFilter) ? (__pine.gt(C.close[__index], __a_emaTrend[__index])) : (true))) && __pine.gt(__a_rsi[__index], 55)) && __pine.le(__pine.at(__a_rsi, __index, 1), 55))
    orderQty = (((NaN * equityPct) / 100) / C.close[__index])
    if ((shortEntryCond && __pine.eq(__ctx.positionSize, 0))) {
      ;__entryDir = 'short'; __exitStop = NaN; __exitLimit = NaN
    }
    if ((shortExitCond && __pine.lt(__ctx.positionSize, 0))) {
      ;__forceClose = true
    }
    if ((longEntryCond && __pine.eq(__ctx.positionSize, 0))) {
      ;__entryDir = 'long'; __exitStop = NaN; __exitLimit = NaN
    }
    if ((__pine.lt(__ctx.positionSize, 0) && __pine.ge(__pine.hist(__hm_strategy_position_size, 1), 0))) {
      lowestSinceEntry = C.low[__index]
    }
    else if (__pine.lt(__ctx.positionSize, 0)) {
      lowestSinceEntry = Math.min(__pine.nz(lowestSinceEntry, C.low[__index]), C.low[__index])
    } else {
      lowestSinceEntry = NaN
    }
    if (__pine.lt(__ctx.positionSize, 0)) {
      let realEntry = __ctx.avgPrice
      let stopDist = (__a_atr[__index] * atrStopMult)
      let profitDist = (__a_atr[__index] * atrProfitMult)
      let trailArmed = (useTrailing && __pine.ge((realEntry - lowestSinceEntry), (__a_atr[__index] * trailStartMult)))
      let trailStopPrice = (lowestSinceEntry + (__a_atr[__index] * trailOffsetMult))
      let fixedStopPrice = (realEntry + stopDist)
      let finalStopPrice = ((trailArmed) ? (Math.min(fixedStopPrice, trailStopPrice)) : (fixedStopPrice))
      ;__exitStop = finalStopPrice; __exitLimit = (realEntry - profitDist)
    }
    ;__pine.plot(plots, __a_emaFast[__index], "EMA Fast", __index)
    ;__pine.plot(plots, __a_emaSlow[__index], "EMA Slow", __index)
    ;__pine.plot(plots, __a_emaTrend[__index], "EMA Trend", __index)
    ;__pine.plot(plots, ((useDonchian) ? (donchianLow) : (NaN)), "Donchian Low", __index)
    ;__pine.mark(markers, (shortEntryCond && __pine.eq(__ctx.positionSize, 0)), "做空信号", "abovebar", __index)
    ;__pine.mark(markers, (shortExitCond && __pine.lt(__ctx.positionSize, 0)), "平空信号", "belowbar", __index)
    if ((__index === n - 1)) {
      let atrDisplay = __pine.str.tostring(__a_atr[__index], __pine.format.mintick)
      let atrPctDisplay = (__pine.str.tostring(atrPct, "#.##") + "%")
      let posText = ((__pine.lt(__ctx.positionSize, 0)) ? ("空单持有中") : (((__pine.gt(__ctx.positionSize, 0)) ? ("多单持有中") : ("空仓"))))
      let posColor = ((__pine.lt(__ctx.positionSize, 0)) ? (__pine.color.red) : (((__pine.gt(__ctx.positionSize, 0)) ? (__pine.color.green) : (__pine.color.gray))))
      ;__pine.table.cell(infoTable, 0, 0, "状态", { text_color: __pine.color.white, bgcolor: __pine.color.new(__pine.color.blue, 30), text_size: 'small' })
      ;__pine.table.cell(infoTable, 1, 0, posText, { text_color: __pine.color.white, bgcolor: __pine.color.new(posColor, 30), text_size: 'small' })
      ;__pine.table.cell(infoTable, 0, 1, "ATR", { text_color: __pine.color.white, bgcolor: __pine.color.new(__pine.color.blue, 30), text_size: 'small' })
      ;__pine.table.cell(infoTable, 1, 1, atrDisplay, { text_color: __pine.color.white, bgcolor: __pine.color.new(__pine.color.blue, 60), text_size: 'small' })
      ;__pine.table.cell(infoTable, 0, 2, "ATR%", { text_color: __pine.color.white, bgcolor: __pine.color.new(__pine.color.blue, 30), text_size: 'small' })
      ;__pine.table.cell(infoTable, 1, 2, atrPctDisplay, { text_color: __pine.color.white, bgcolor: __pine.color.new(__pine.color.blue, 60), text_size: 'small' })
      ;__pine.table.cell(infoTable, 0, 3, "RSI", { text_color: __pine.color.white, bgcolor: __pine.color.new(__pine.color.blue, 30), text_size: 'small' })
      ;__pine.table.cell(infoTable, 1, 3, __pine.str.tostring(__a_rsi[__index], "#.##"), { text_color: __pine.color.white, bgcolor: __pine.color.new(__pine.color.blue, 60), text_size: 'small' })
      ;__pine.table.cell(infoTable, 0, 4, "净盈亏", { text_color: __pine.color.white, bgcolor: __pine.color.new(__pine.color.blue, 30), text_size: 'small' })
      ;__pine.table.cell(infoTable, 1, 4, __pine.str.tostring(NaN, "#.##"), { text_color: __pine.color.white, bgcolor: __pine.color.new(__pine.color.blue, 60), text_size: 'small' })
      ;__pine.table.cell(infoTable, 0, 5, "胜率", { text_color: __pine.color.white, bgcolor: __pine.color.new(__pine.color.blue, 30), text_size: 'small' })
      ;__pine.table.cell(infoTable, 1, 5, (__pine.str.tostring(((NaN / Math.max(NaN, 1)) * 100), "#.##") + "%"), { text_color: __pine.color.white, bgcolor: __pine.color.new(__pine.color.blue, 60), text_size: 'small' })
      ;__pine.table.cell(infoTable, 0, 6, "总交易", { text_color: __pine.color.white, bgcolor: __pine.color.new(__pine.color.blue, 30), text_size: 'small' })
      ;__pine.table.cell(infoTable, 1, 6, __pine.str.tostring(NaN), { text_color: __pine.color.white, bgcolor: __pine.color.new(__pine.color.blue, 60), text_size: 'small' })
      ;__pine.table.cell(infoTable, 0, 7, "冷却剩余", { text_color: __pine.color.white, bgcolor: __pine.color.new(__pine.color.blue, 30), text_size: 'small' })
      ;__pine.table.cell(infoTable, 1, 7, (__pine.str.tostring(Math.max((cooldownBars - barsSinceExit), 0)) + " 根"), { text_color: __pine.color.white, bgcolor: __pine.color.new(__pine.color.blue, 60), text_size: 'small' })
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
      forceClose: __forceClose,
    }
  }

  return { step, meta, plots, markers, barColor }
}
globalThis.__pineProgram = { create: __create }

// ===== 由 Pine 编译器生成，请勿手工修改 =====
// 源: BTC Candle Correlation Strategy
function __create(__pine) {
  const C = __pine.candles
  const n = C.length
  let __index = 0
  let __ctx = { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: NaN, side: null }
  const __a_tr = __pine.ta.trueRange(C.high, C.low, C.close)
  let src_c = NaN
  let src1_c = NaN
  let src2_c = NaN
  let src3_c = NaN
  let src4_c = NaN
  let src5_c = NaN
  let src6_c = NaN
  let src7_c = NaN
  let src_h = NaN
  let src1_h = NaN
  let src2_h = NaN
  let src3_h = NaN
  let src4_h = NaN
  let src5_h = NaN
  let src6_h = NaN
  let src7_h = NaN
  let src_l = NaN
  let src1_l = NaN
  let src2_l = NaN
  let src3_l = NaN
  let src4_l = NaN
  let src5_l = NaN
  let src6_l = NaN
  let src7_l = NaN
  let src_o = NaN
  let src1_o = NaN
  let src2_o = NaN
  let src3_o = NaN
  let src4_o = NaN
  let src5_o = NaN
  let src6_o = NaN
  let src7_o = NaN
  let candle_open = NaN
  let candle_high = NaN
  let candle_low = NaN
  let candle_close = NaN
  let h = NaN
  let l = NaN
  let o = NaN
  let c = NaN
  let x = NaN
  let y = NaN
  let source = NaN
  let ma = NaN
  let range = NaN
  let rangema = NaN
  let upper = NaN
  let lower = NaN
  let crossUpper = NaN
  let crossLower = NaN
  let bprice = NaN
  let sprice = NaN
  let crossBcond = NaN
  let crossScond = NaN
  let cancelBcond = NaN
  let cancelScond = NaN
  let time_cond = NaN
  const __s_source = []
  const __s_range = []
  const __s_upper = []
  const __s_lower = []
  const __s_bprice = []
  const __s_sprice = []
  const __s_crossBcond = []
  const __s_crossScond = []
  const useTrueRange = false
  const length = __pine.input.float("length", 9, { minval: 1 })
  const mult = __pine.input.float("mult", 0.9, { step: 0.1 })
  const longOnly = __pine.input.bool("longOnly", true, {  })
  const fromDay = __pine.input.float("fromDay", 1, { title: "From Day", minval: 1, maxval: 31 })
  const fromMonth = __pine.input.float("fromMonth", 1, { title: "From Month", minval: 1, maxval: 12 })
  const fromYear = __pine.input.float("fromYear", 2000, { title: "From Year", minval: 1970 })
  const toDay = __pine.input.float("toDay", 31, { title: "To Day", minval: 1, maxval: 31 })
  const toMonth = __pine.input.float("toMonth", 12, { title: "To Month", minval: 1, maxval: 12 })
  const toYear = __pine.input.float("toYear", 2021, { title: "To Year", minval: 1970 })
  const startDate = __pine.timestamp(fromYear, fromMonth, fromDay, 0, 0)
  const finishDate = __pine.timestamp(toYear, toMonth, toDay, 0, 0)
  const meta = {"kind":"strategy","config":{"title":"BTC Candle Correlation Strategy","overlay":true,"initial_capital":1000,"default_qty_type":"percent_of_equity","default_qty_value":100,"commission_type":"percent","commission_value":0.1,"pyramiding":1},"inputs":[{"name":"length","type":"float","title":"length","minval":1,"default":9},{"name":"mult","type":"float","title":"mult","step":0.1,"default":0.9},{"name":"longOnly","type":"bool","title":"longOnly","default":true},{"name":"fromDay","type":"float","title":"From Day","minval":1,"maxval":31,"default":1},{"name":"fromMonth","type":"float","title":"From Month","minval":1,"maxval":12,"default":1},{"name":"fromYear","type":"float","title":"From Year","minval":1970,"default":2000},{"name":"toDay","type":"float","title":"To Day","minval":1,"maxval":31,"default":31},{"name":"toMonth","type":"float","title":"To Month","minval":1,"maxval":12,"default":12},{"name":"toYear","type":"float","title":"To Year","minval":1970,"default":2021}],"plotTitles":[],"alerts":[]}
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
    src_c = C.close[__index]
    src1_c = src_c
    src2_c = src_c
    src3_c = src_c
    src4_c = src_c
    src5_c = src_c
    src6_c = src_c
    src7_c = src_c
    src_h = C.high[__index]
    src1_h = src_h
    src2_h = src_h
    src3_h = src_h
    src4_h = src_h
    src5_h = src_h
    src6_h = src_h
    src7_h = src_h
    src_l = C.low[__index]
    src1_l = src_l
    src2_l = src_l
    src3_l = src_l
    src4_l = src_l
    src5_l = src_l
    src6_l = src_l
    src7_l = src_l
    src_o = C.open[__index]
    src1_o = src_o
    src2_o = src_o
    src3_o = src_o
    src4_o = src_o
    src5_o = src_o
    src6_o = src_o
    src7_o = src_o
    candle_open = __pine.math.avg(src1_o, src2_o, src3_o, src4_o, src5_o, src6_o, src7_o)
    candle_high = __pine.math.avg(src1_h, src2_h, src3_h, src4_h, src5_h, src6_h, src7_h)
    candle_low = __pine.math.avg(src1_l, src2_l, src3_l, src4_l, src5_l, src6_l, src7_l)
    candle_close = __pine.math.avg(src1_c, src2_c, src3_c, src4_c, src5_c, src6_c, src7_c)
    h = (Math.pow(candle_high, 2) / 2)
    l = (Math.pow(candle_low, 2) / 2)
    o = (Math.pow(candle_open, 2) / 2)
    c = (Math.pow(candle_close, 2) / 2)
    x = ((((h + l) + o) + c) / 4)
    y = Math.sqrt(x)
    source = y; __pine.serSet(__s_source, __index, source)
    ma = __pine.ta.smaAt(__s_source, __index, length)
    range = ((useTrueRange) ? (__a_tr[__index]) : ((candle_high - candle_low))); __pine.serSet(__s_range, __index, range)
    rangema = __pine.ta.smaAt(__s_range, __index, length)
    upper = (ma + (rangema * mult)); __pine.serSet(__s_upper, __index, upper)
    lower = (ma - (rangema * mult)); __pine.serSet(__s_lower, __index, lower)
    crossUpper = __pine.ta.crossoverAt(__s_source, __s_upper, __index, 0, 0)
    crossLower = __pine.ta.crossunderAt(__s_source, __s_lower, __index, 0, 0)
    bprice = 0; __pine.serSet(__s_bprice, __index, bprice)
    bprice = ((crossUpper) ? (candle_high) : (__pine.nz(__pine.at(__s_bprice, __index, 1)))); __pine.serSet(__s_bprice, __index, bprice)
    sprice = 0; __pine.serSet(__s_sprice, __index, sprice)
    sprice = ((crossLower) ? (candle_low) : (__pine.nz(__pine.at(__s_sprice, __index, 1)))); __pine.serSet(__s_sprice, __index, sprice)
    crossBcond = false; __pine.serSet(__s_crossBcond, __index, crossBcond)
    crossBcond = ((crossUpper) ? (true) : (((__pine.isNa(__pine.at(__s_crossBcond, __index, 1))) ? (false) : (__pine.at(__s_crossBcond, __index, 1))))); __pine.serSet(__s_crossBcond, __index, crossBcond)
    crossScond = false; __pine.serSet(__s_crossScond, __index, crossScond)
    crossScond = ((crossLower) ? (true) : (((__pine.isNa(__pine.at(__s_crossScond, __index, 1))) ? (false) : (__pine.at(__s_crossScond, __index, 1))))); __pine.serSet(__s_crossScond, __index, crossScond)
    cancelBcond = (crossBcond && (__pine.lt(source, ma) || __pine.ge(candle_high, bprice)))
    cancelScond = (crossScond && (__pine.gt(source, ma) || __pine.le(candle_low, sprice)))
    time_cond = (__pine.ge(C.timestamp[__index], startDate) && __pine.le(C.timestamp[__index], finishDate))
    if ((__pine.eq(longOnly, false) && time_cond)) {
      if (crossLower) {
      }
      if (crossUpper) {
        ;__entryDir = 'long'; __entryId = "long"; __entryQty = NaN; __exitStop = NaN; __exitLimit = NaN
      }
      if (cancelScond) {
      }
      if (crossLower) {
        ;__entryDir = 'short'; __entryId = "short"; __entryQty = NaN; __exitStop = NaN; __exitLimit = NaN
      }
    }
    if ((longOnly && time_cond)) {
      if (crossLower) {
        ;__forceClose = true
      }
      if ((crossUpper && __pine.gt(candle_close, candle_open))) {
        ;__entryDir = 'long'; __entryId = "long"; __entryQty = NaN; __exitStop = NaN; __exitLimit = NaN
      }
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

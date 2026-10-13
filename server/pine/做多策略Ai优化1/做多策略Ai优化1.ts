// ===== 由 Pine 编译器生成，请勿手工修改 =====
// 源: 做多策略Ai优化1
function __create(__pine) {
  const C = __pine.candles
  const n = C.length
  let __index = 0
  let __ctx = { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: NaN, side: null }
  const __h_data = __pine.makeRing(2)
  let currentPrice = NaN
  let entryPrice = NaN
  let stopLossPrice = NaN
  let highestCloseSinceEntry = NaN
  let bPositionOpened = NaN
  let bBreakEvenArmed = NaN
  let atrValue = NaN
  let atrPct = NaN
  let bEMAIsRising = NaN
  let bSMAIsRising = NaN
  let bMACDIsRising = NaN
  let bMACDHistIsRising = NaN
  let bSMASlowIsRising = NaN
  let bMACDSignalIsRising = NaN
  let bEMAIsRisingTrue = NaN
  let bSMAIsRisingTrue = NaN
  let bMACDIsRisingTrue = NaN
  let bSMASlowIsRisingTrue = NaN
  let bMomentumOriginal = NaN
  let bMomentumTrueRise = NaN
  let bMomentumUse = NaN
  const __s_stopLossPrice = []
  const __s_entryPrice = []
  const __s_highestCloseSinceEntry = []
  const __s_bPositionOpened = []
  const __s_bBreakEvenArmed = []
  const [__a_macdLine, __a_macdSignalLine, __a_macdHist] = __pine.ta.macd(C.close, 12, 26, 7)
  const leverage = 1
  const positionSize = 1000
  const stopLossPct = __pine.input.float("stopLossPct", 5, { title: "StopLoss in %" })
  const beAtrMult = __pine.input.float("beAtrMult", 1, { title: "BreakEven trigger (xATR%) 0=off" })
  const trailAtrMult = __pine.input.float("trailAtrMult", 0, { title: "Trailing stop (xATR%) 0=off" })
  const trailAfterBE = __pine.input.float("trailAfterBE", 1, { title: "Trail only after BreakEven armed (1/0)" })
  const useCrossExit = __pine.input.float("useCrossExit", 1, { title: "Cross exit: 0=off 1=always 2=only-if-losing" })
  const useTrendFilter = __pine.input.float("useTrendFilter", 0, { title: "True-rising momentum filter (1/0)" })
  const FromDay = 1
  const FromMonth = 1
  const FromYear = 2020
  const ToDay = 14
  const ToMonth = 5
  const ToYear = 2029
  const start = __pine.timestamp(FromYear, FromMonth, FromDay, 0, 0)
  const finish = __pine.timestamp(ToYear, ToMonth, ToDay, 23, 59)
  function window() {
    return (__pine.ge(C.timestamp[__index], start) && __pine.le(C.timestamp[__index], finish))
  }
  function IsRising(data, loopBack, __hr_data) {
    let bIsRising = true
    {
      const __from = 1
      const __to = loopBack
      if (__from <= __to) {
        for (let n = __from; n <= __to; n++) {
          if (__pine.gt(__pine.histOf(__hr_data, __index, n), __pine.histOf(__hr_data, __index, (n - 1)))) {
            bIsRising = false
          }
          continue
        }
      } else {
        for (let n = __from; n >= __to; n--) {
          if (__pine.gt(__pine.histOf(__hr_data, __index, n), __pine.histOf(__hr_data, __index, (n - 1)))) {
            bIsRising = false
          }
          continue
        }
      }
    }
    return bIsRising
  }
  const __a_ema = __pine.ta.ema(C.close, 20)
  const __a_sma = __pine.ta.sma(C.close, 100)
  const __a_smaSlow = __pine.ta.sma(C.close, 200)
  const __a_atrValue = __pine.ta.atr(C.high, C.low, C.close, 14, 'RMA')
  const meta = {"kind":"strategy","config":{"title":"BTC_Long_Only_TV01_opt","overlay":true,"max_bars_back":3000,"initial_capital":1000,"commission_value":0.1},"inputs":[{"name":"stopLossPct","type":"float","title":"StopLoss in %","default":5},{"name":"beAtrMult","type":"float","title":"BreakEven trigger (xATR%) 0=off","default":1},{"name":"trailAtrMult","type":"float","title":"Trailing stop (xATR%) 0=off","default":0},{"name":"trailAfterBE","type":"float","title":"Trail only after BreakEven armed (1/0)","default":1},{"name":"useCrossExit","type":"float","title":"Cross exit: 0=off 1=always 2=only-if-losing","default":1},{"name":"useTrendFilter","type":"float","title":"True-rising momentum filter (1/0)","default":0}],"plotTitles":[],"alerts":[]}
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
    currentPrice = C.close[__index]
    entryPrice = 0; __pine.serSet(__s_entryPrice, __index, entryPrice)
    stopLossPrice = 0; __pine.serSet(__s_stopLossPrice, __index, stopLossPrice)
    highestCloseSinceEntry = 0; __pine.serSet(__s_highestCloseSinceEntry, __index, highestCloseSinceEntry)
    bPositionOpened = false; __pine.serSet(__s_bPositionOpened, __index, bPositionOpened)
    bBreakEvenArmed = false; __pine.serSet(__s_bBreakEvenArmed, __index, bBreakEvenArmed)
    atrPct = 0
    ;__pine.plot(plots, __a_sma[__index], "plot_0", __index)
    ;__pine.plot(plots, __a_smaSlow[__index], "plot_1", __index)
    ;__pine.plot(plots, __a_ema[__index], "plot_2", __index)
    stopLossPrice = ((__pine.isNa(__pine.at(__s_stopLossPrice, __index, 1))) ? (0) : (__pine.at(__s_stopLossPrice, __index, 1))); __pine.serSet(__s_stopLossPrice, __index, stopLossPrice)
    entryPrice = ((__pine.isNa(__pine.at(__s_entryPrice, __index, 1))) ? (0) : (__pine.at(__s_entryPrice, __index, 1))); __pine.serSet(__s_entryPrice, __index, entryPrice)
    highestCloseSinceEntry = ((__pine.isNa(__pine.at(__s_highestCloseSinceEntry, __index, 1))) ? (0) : (__pine.at(__s_highestCloseSinceEntry, __index, 1))); __pine.serSet(__s_highestCloseSinceEntry, __index, highestCloseSinceEntry)
    bPositionOpened = ((__pine.isNa(__pine.at(__s_bPositionOpened, __index, 1))) ? (false) : (__pine.at(__s_bPositionOpened, __index, 1))); __pine.serSet(__s_bPositionOpened, __index, bPositionOpened)
    bBreakEvenArmed = ((__pine.isNa(__pine.at(__s_bBreakEvenArmed, __index, 1))) ? (false) : (__pine.at(__s_bBreakEvenArmed, __index, 1))); __pine.serSet(__s_bBreakEvenArmed, __index, bBreakEvenArmed)
    bEMAIsRising = IsRising(__a_ema[__index], 2, __a_ema)
    bSMAIsRising = IsRising(__a_sma[__index], 3, __a_sma)
    bMACDIsRising = IsRising(__a_macdLine[__index], 3, __a_macdLine)
    bMACDHistIsRising = IsRising(__a_macdHist[__index], 1, __a_macdHist)
    bSMASlowIsRising = IsRising(__a_smaSlow[__index], 10, __a_smaSlow)
    bMACDSignalIsRising = IsRising(__a_macdSignalLine[__index], 3, __a_macdSignalLine)
    bEMAIsRisingTrue = __pine.gt(__pine.at(__a_ema, __index, 0), __pine.at(__a_ema, __index, 2))
    bSMAIsRisingTrue = __pine.gt(__pine.at(__a_sma, __index, 0), __pine.at(__a_sma, __index, 3))
    bMACDIsRisingTrue = __pine.gt(__pine.at(__a_macdLine, __index, 0), __pine.at(__a_macdLine, __index, 3))
    bSMASlowIsRisingTrue = __pine.gt(__pine.at(__a_smaSlow, __index, 0), __pine.at(__a_smaSlow, __index, 10))
    bMomentumOriginal = (((bSMASlowIsRising && bMACDIsRising) && bEMAIsRising) && bSMAIsRising)
    bMomentumTrueRise = (((bSMASlowIsRisingTrue && bMACDIsRisingTrue) && bEMAIsRisingTrue) && bSMAIsRisingTrue)
    bMomentumUse = ((__pine.ge(useTrendFilter, 0.5)) ? (bMomentumTrueRise) : (bMomentumOriginal))
    atrPct = ((__a_atrValue[__index] / currentPrice) * 100)
    if (window()) {
      if ((((__pine.eq(bPositionOpened, false) && __pine.eq(bMomentumUse, true)) && __pine.gt(__pine.at(__a_ema, __index, 0), __pine.at(__a_sma, __index, 0))) && __pine.lt(__pine.at(__a_sma, __index, 0), currentPrice))) {
        let stockPositionSize = ((positionSize * leverage) / currentPrice)
        entryPrice = currentPrice; __pine.serSet(__s_entryPrice, __index, entryPrice)
        stopLossPrice = (currentPrice * (1 - (stopLossPct / 100))); __pine.serSet(__s_stopLossPrice, __index, stopLossPrice)
        highestCloseSinceEntry = currentPrice; __pine.serSet(__s_highestCloseSinceEntry, __index, highestCloseSinceEntry)
        bBreakEvenArmed = false; __pine.serSet(__s_bBreakEvenArmed, __index, bBreakEvenArmed)
        bPositionOpened = true; __pine.serSet(__s_bPositionOpened, __index, bPositionOpened)
        ;__entryDir = 'long'; __entryId = "myPosition"; __entryQty = stockPositionSize; __exitStop = NaN; __exitLimit = NaN
      }
      if (__pine.eq(bPositionOpened, true)) {
        highestCloseSinceEntry = Math.max(highestCloseSinceEntry, currentPrice); __pine.serSet(__s_highestCloseSinceEntry, __index, highestCloseSinceEntry)
        if (((__pine.gt(beAtrMult, 0) && __pine.eq(bBreakEvenArmed, false)) && __pine.ge(currentPrice, (entryPrice * (1 + ((beAtrMult * atrPct) / 100)))))) {
          bBreakEvenArmed = true; __pine.serSet(__s_bBreakEvenArmed, __index, bBreakEvenArmed)
        }
        if (__pine.gt(trailAtrMult, 0)) {
          stopLossPrice = Math.max(stopLossPrice, (highestCloseSinceEntry * (1 - ((trailAtrMult * atrPct) / 100)))); __pine.serSet(__s_stopLossPrice, __index, stopLossPrice)
        }
        if (__pine.eq(bBreakEvenArmed, true)) {
          stopLossPrice = Math.max(stopLossPrice, entryPrice); __pine.serSet(__s_stopLossPrice, __index, stopLossPrice)
        }
      }
      if ((__pine.eq(bPositionOpened, true) && __pine.le(currentPrice, stopLossPrice))) {
        ;__forceClose = true
        bPositionOpened = false; __pine.serSet(__s_bPositionOpened, __index, bPositionOpened)
        entryPrice = 0; __pine.serSet(__s_entryPrice, __index, entryPrice)
        stopLossPrice = 0; __pine.serSet(__s_stopLossPrice, __index, stopLossPrice)
        bBreakEvenArmed = false; __pine.serSet(__s_bBreakEvenArmed, __index, bBreakEvenArmed)
        highestCloseSinceEntry = 0; __pine.serSet(__s_highestCloseSinceEntry, __index, highestCloseSinceEntry)
      }
      if ((((__pine.eq(bPositionOpened, true) && __pine.gt(useCrossExit, 0.5)) && __pine.lt(useCrossExit, 1.5)) && __pine.ta.crossunderAt(__a_ema, __a_sma, __index, 1, 1))) {
        ;__forceClose = true
        bPositionOpened = false; __pine.serSet(__s_bPositionOpened, __index, bPositionOpened)
        entryPrice = 0; __pine.serSet(__s_entryPrice, __index, entryPrice)
        stopLossPrice = 0; __pine.serSet(__s_stopLossPrice, __index, stopLossPrice)
        bBreakEvenArmed = false; __pine.serSet(__s_bBreakEvenArmed, __index, bBreakEvenArmed)
        highestCloseSinceEntry = 0; __pine.serSet(__s_highestCloseSinceEntry, __index, highestCloseSinceEntry)
      }
      if ((((__pine.eq(bPositionOpened, true) && __pine.ge(useCrossExit, 1.5)) && __pine.le(currentPrice, entryPrice)) && __pine.ta.crossunderAt(__a_ema, __a_sma, __index, 1, 1))) {
        ;__forceClose = true
        bPositionOpened = false; __pine.serSet(__s_bPositionOpened, __index, bPositionOpened)
        entryPrice = 0; __pine.serSet(__s_entryPrice, __index, entryPrice)
        stopLossPrice = 0; __pine.serSet(__s_stopLossPrice, __index, stopLossPrice)
        bBreakEvenArmed = false; __pine.serSet(__s_bBreakEvenArmed, __index, bBreakEvenArmed)
        highestCloseSinceEntry = 0; __pine.serSet(__s_highestCloseSinceEntry, __index, highestCloseSinceEntry)
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

// ===== 由 Pine 编译器生成，请勿手工修改 =====
// 源: BTC_Long_Only_TV01_200507
function __create(__pine) {
  const C = __pine.candles
  const n = C.length
  let __index = 0
  let __ctx = { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: NaN, side: null }
  const __h_stopLossPrice = __pine.makeRing(2)
  const __h_entryPrice = __pine.makeRing(2)
  const __h_bPositionOpened = __pine.makeRing(2)
  const __h_positionSize = __pine.makeRing(2)
  const __h_stockPositionSize = __pine.makeRing(2)
  let atrValue = NaN
  let bPositionOpened = NaN
  let stockPositionSize = NaN
  let volatilityPercentage = NaN
  let bDisplayArrow = NaN
  let bEMAIsRising = NaN
  let bSMAIsRising = NaN
  let bSMASlowIsRising = NaN
  let bMACDIsRising = NaN
  let bMACDHistIsRising = NaN
  let bMACDSignalIsRising = NaN
  let positionSize = NaN
  let currentPrice = NaN
  let stopLossPrice = NaN
  let entryPrice = NaN
  const [__a_macdLine, __a_macdSignalLine, __a_macdHist] = __pine.ta.macd(C.close, 12, 26, 7)
  const _rsi_len = 14
  const NewValue = 0
  const PreviousValue = 0
  const leverage = 1
  const smaPercentageIncrease = 0
  const SMA_PERCENT_INCREASE = 0
  const stopLoss = __pine.input.float("stopLoss", 1.5, { title: "StopLoss in %" })
  const FromDay = 1
  const FromMonth = 1
  const FromYear = 2019
  const ToDay = 31
  const ToMonth = 12
  const ToYear = 2099
  const start = __pine.timestamp(FromYear, FromMonth, FromDay, 0, 0)
  const finish = __pine.timestamp(ToYear, ToMonth, ToDay, 23, 59)
  function window() {
    return (((__pine.ge(C.timestamp[__index], start) && __pine.le(C.timestamp[__index], finish))) ? (true) : (false))
  }
  const emaLength = 20
  const smaLength = 100
  const smaSlowLength = 200
  const __a_ema = __pine.ta.ema(C.close, emaLength)
  const __a_sma = __pine.ta.sma(C.close, smaLength)
  const __a_smaSlow = __pine.ta.sma(C.close, smaSlowLength)
  const __a_atrValue = __pine.ta.atr(C.high, C.low, C.close, 14, 'RMA')
  const meta = {"kind":"strategy","config":{"title":"BTC Long strategy","overlay":true,"max_bars_back":3000,"initial_capital":1000,"commission_value":0.075},"inputs":[{"name":"stopLoss","type":"float","title":"StopLoss in %","default":1.5}],"plotTitles":[],"alerts":[]}
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
    bPositionOpened = false; __pine.push(__h_bPositionOpened, bPositionOpened)
    stockPositionSize = 0; __pine.push(__h_stockPositionSize, stockPositionSize)
    volatilityPercentage = 0
    bDisplayArrow = false
    bEMAIsRising = false
    bSMAIsRising = false
    bSMASlowIsRising = false
    bMACDIsRising = false
    bMACDHistIsRising = false
    bMACDSignalIsRising = false
    positionSize = 1000; __pine.push(__h_positionSize, positionSize)
    currentPrice = C.close[__index]
    stopLossPrice = 0; __pine.push(__h_stopLossPrice, stopLossPrice)
    entryPrice = 0; __pine.push(__h_entryPrice, entryPrice)
    ;__pine.plot(plots, __a_sma[__index], "plot_0", __index)
    ;__pine.plot(plots, __a_smaSlow[__index], "plot_1", __index)
    ;__pine.plot(plots, __a_ema[__index], "plot_2", __index)
    stopLossPrice = ((__pine.isNa(__pine.hist(__h_stopLossPrice, 1))) ? (0) : (__pine.hist(__h_stopLossPrice, 1))); __pine.push(__h_stopLossPrice, stopLossPrice)
    entryPrice = ((__pine.isNa(__pine.hist(__h_entryPrice, 1))) ? (0) : (__pine.hist(__h_entryPrice, 1))); __pine.push(__h_entryPrice, entryPrice)
    bPositionOpened = ((__pine.isNa(__pine.hist(__h_bPositionOpened, 1))) ? (false) : (__pine.hist(__h_bPositionOpened, 1))); __pine.push(__h_bPositionOpened, bPositionOpened)
    positionSize = ((__pine.isNa(__pine.hist(__h_positionSize, 1))) ? (1000) : (__pine.hist(__h_positionSize, 1))); __pine.push(__h_positionSize, positionSize)
    stockPositionSize = ((__pine.isNa(__pine.hist(__h_stockPositionSize, 1))) ? (0) : (__pine.hist(__h_stockPositionSize, 1))); __pine.push(__h_stockPositionSize, stockPositionSize)
    bEMAIsRising = __pine.ta.risingAt(__a_ema, __index, 2)
    bSMAIsRising = __pine.ta.risingAt(__a_sma, __index, 3)
    bMACDIsRising = __pine.ta.risingAt(__a_macdLine, __index, 3)
    bMACDHistIsRising = __pine.ta.risingAt(__a_macdHist, __index, 1)
    bSMASlowIsRising = __pine.ta.risingAt(__a_smaSlow, __index, 10)
    bMACDSignalIsRising = __pine.ta.risingAt(__a_macdSignalLine, __index, 3)
    volatilityPercentage = ((__a_atrValue[__index] / currentPrice) * 100)
    if (window()) {
      if ((((((((__pine.lt(volatilityPercentage, 2) && __pine.eq(bPositionOpened, false)) && __pine.eq(bSMASlowIsRising, true)) && __pine.eq(bMACDIsRising, true)) && __pine.eq(bEMAIsRising, true)) && __pine.eq(bSMAIsRising, true)) && __pine.gt(__pine.at(__a_ema, __index, 0), __pine.at(__a_sma, __index, 0))) && __pine.lt(__pine.at(__a_sma, __index, 0), currentPrice))) {
        stockPositionSize = ((positionSize * leverage) / currentPrice); __pine.push(__h_stockPositionSize, stockPositionSize)
        stopLossPrice = (currentPrice * (1 - (stopLoss / 100))); __pine.push(__h_stopLossPrice, stopLossPrice)
        ;__entryDir = 'long'; __entryId = "myPosition"; __entryQty = stockPositionSize; __exitStop = NaN; __exitLimit = NaN
        entryPrice = currentPrice; __pine.push(__h_entryPrice, entryPrice)
        bPositionOpened = true; __pine.push(__h_bPositionOpened, bPositionOpened)
        bDisplayArrow = true
      }
      if ((__pine.eq(bPositionOpened, true) && (__pine.le(currentPrice, stopLossPrice) || __pine.ta.crossunderAt(__a_ema, __a_sma, __index, 1, 1)))) {
        ;__forceClose = true
        bPositionOpened = false; __pine.push(__h_bPositionOpened, bPositionOpened)
        bDisplayArrow = true
        entryPrice = 0; __pine.push(__h_entryPrice, entryPrice)
      }
    }
    if (__entryId !== null) { if (__entryId === "myPosition") { __entryQty = stockPositionSize } }
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

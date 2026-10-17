/**
 * 回测引擎 —— 逐 bar 撮合，忠实复刻 Pine Script 的订单语义。
 *
 * 关键约定（与 Pine 的对应关系）：
 *  - `process_orders_on_close = true`：所有市价单（strategy.entry / strategy.close）
 *    以**信号 bar 的收盘价**成交，因此不存在前视偏差。
 *  - `strategy.exit` 的挂单（TP1/TP2/SL）从**下一根 bar** 开始才可能触发。
 *  - 同一根 bar 内既可能触及止损也可能触及止盈时，采用 TradingView 券商模拟器的
 *    方向假设：阳线按 O→L→H→C 走（先探低点），阴线按 O→H→L→C 走（先探高点）。
 *  - 合约按 U 本位线性合约建模：数量 = 名义价值 / 价格，盈亏 = 价差 × 数量。
 *    保证金 = 权益 × 仓位比例，名义价值 = 保证金 × 杠杆。
 */

import type {
  Candle,
  EquityPoint,
  ExitReason,
  StrategyParams,
  Trade,
  TradeFill,
  TradeSide,
} from '../../../shared/types'

/**
 * 引擎需要的最小信号形状 —— 与具体策略（fib-trend / supertrend）解耦。
 * 两个策略的 signals 数组里都包含 `canLong / canShort / atrLongStop / atrShortStop` 字段，
 * 因此这里用结构化类型即可同时接受两种 series。
 */
export interface StrategySignalCore {
  canLong: boolean
  canShort: boolean
  atrLongStop: number
  atrShortStop: number
  /* ---- 订单块策略（exitStrategy = 'Zone OCO'）---- */
  /** 区域止损价 */
  obStopLoss?: number
  /** 固定盈亏比目标价 */
  obTakeProfit?: number
  /** 信号风险（用于计算保本触发价） */
  obRisk?: number
  /**
   * Pine 的 `strategy.entry(..., qty=…)`：脚本显式指定的下单量（张数 / 币数）。
   *
   * 给了它就按固定数量下单（盈亏 = 数量 × 价差，不随权益复利放大），
   * 与 TradingView 的 qty 口径一致；杠杆只影响占用保证金。
   */
  entryQty?: number
  /** Pine 的 `strategy.close_all` → 本根收盘后排队、下一根开盘市价平仓 */
  forceClose?: boolean
}

export interface StrategySeriesCore {
  signals: ReadonlyArray<StrategySignalCore>
}

/**
 * 逐 bar 信号回调的上下文。
 *
 * `flat` 供订单块策略使用；其余字段供 Pine 脚本还原
 * `strategy.position_size` / `strategy.position_size[1]` / `strategy.position_avg_price`。
 */
export interface SignalProviderCtx {
  flat: boolean
  /** `strategy.position_size`：多 +1 / 空 -1 / 平 0 */
  positionSize: number
  /** 上一根收盘时的仓位方向（对应 `strategy.position_size[1]`） */
  prevPositionSize: number
  /** `strategy.position_avg_price`（空仓时为 NaN） */
  avgPrice: number
  side: TradeSide | null
}

export interface BacktestInput {
  candles: readonly Candle[]
  series: StrategySeriesCore
  params: StrategyParams
  /**
   * 从该下标开始才允许开仓。
   * 之前的数据只用于指标预热（对应使用者的「起始时间」），因此该点之前不会产生持仓，
   * 起始点的权益必然等于初始资金。
   */
  tradeFromIndex?: number
  /**
   * 位置相关的信号源（订单块策略）。
   *
   * fib / supertrend 的信号与持仓无关，可一次性算好；
   * 订单块策略的区域扫描带有 `strategy.position_size == 0` 条件，
   * 必须在每根 K 线**收盘、挂单撮合之后**才知道 flat 与否，
   * 因此由引擎逐 bar 回调，由调用方把结果写回 signals[index]。
   */
  signalProvider?: (index: number, ctx: SignalProviderCtx) => void
  /** 合约最小变动价位（syminfo.mintick），配合 slippageTicks 计算滑点 */
  tickSize?: number
}

export interface BacktestOutput {
  trades: Trade[]
  equityCurve: EquityPoint[]
}

interface OpenPosition {
  side: TradeSide
  entryIndex: number
  entryTime: number
  entryPrice: number
  initialQty: number
  /** 剩余仓位占初始仓位的比例 0~1 */
  remaining: number
  notional: number
  margin: number
  leverage: number
  /** 开仓时设定的初始止损价（不随后续移动而改变，用于展示） */
  initialStopLoss: number
  /** 当前生效的止损价 */
  stopLoss: number
  /** 触发强平的价格（NaN 表示未启用） */
  liquidationPrice: number
  takeProfit1: number
  takeProfit2: number
  breakEven: number
  tp1Hit: boolean
  entryFee: number
  /** 最大有利幅度（%） */
  mfePercent: number
  /** 最大不利幅度（%，正数表示浮亏） */
  maePercent: number
  fills: TradeFill[]
  grossPnl: number
}

/**
 * 金字塔加仓产生的一笔子订单。
 *
 * TradingView 会把每一次 strategy.entry 都记录成一笔独立交易，
 * 因此同一根 bar 上的 3 次同向开仓会显示为 3 笔。为了让本项目的
 * 交易列表与 TradingView 逐条对齐，这里同样按「子订单」拆分登记：
 * 每个子订单保留自己的开仓价、止损、止盈与成交量。
 */
interface SubOrder {
  side: TradeSide
  entryIndex: number
  entryTime: number
  entryPrice: number
  initialQty: number
  remaining: number
  notional: number
  margin: number
  leverage: number
  initialStopLoss: number
  stopLoss: number
  liquidationPrice: number
  takeProfit1: number
  takeProfit2: number
  breakEven: number
  tp1Hit: boolean
  entryFee: number
  mfePercent: number
  maePercent: number
  fills: TradeFill[]
  grossPnl: number
  /**
   * 订单块策略：保本触发价（价格为该值时把止损移动到开仓价）。
   * 与 fib 的 `breakEven`（触发第一目标后移动到保本）不同，这里由价格触发。
   */
  beTrigger: number
  /** 是否已经完成保本移动（用于交易记录里的离场原因展示） */
  beArmed: boolean
}

/** 持仓位：由 1~N 笔同向子订单组成，整体共享一个方向与账户资金 */
interface Position {
  side: TradeSide
  subs: SubOrder[]
}

/** 排队等待「下一根开盘成交」的市价开仓单 */
interface PendingEntry {
  side: TradeSide
  /** 展示用初始止损（SuperTrend 的上下轨），不参与挂单撮合 */
  displayStopLoss?: number
  /** 订单块：区域止损价（参与撮合） */
  stopLoss?: number
  /** 订单块：目标止盈价（作为单一 TP，整仓离场） */
  takeProfit?: number
  /** 订单块：信号风险（正数），用于按实际成交价推导保本触发价 */
  risk?: number
  /** Pine：脚本通过 `strategy.entry(qty=…)` 指定的固定下单量 */
  qty?: number
}

/** 说明性注释，尽量与 Pine 中 strategy.close 的注释文案对齐 */
export const EXIT_COMMENT: Record<ExitReason, string> = {
  TP1: 'TP 1',
  TP2: 'TP 2',
  StopLoss: 'SL',
  BreakEven: 'BE',
  Reverse: 'Reversing',
  TrendSwitch: 'Trend Switch Close',
  ScriptClose: 'Script Close',
  Liquidation: 'Liquidation',
  TimeStop: 'Time stop',
  EndOfData: 'Backtest End',
}

class BacktestEngine {
  private readonly candles: readonly Candle[]
  private readonly series: StrategySeriesCore
  private readonly params: StrategyParams

  private readonly feeRate: number
  private readonly leverage: number
  private readonly sizeFraction: number
  private readonly rr: number
  private readonly dir: StrategyParams['tradeDirection']
  private readonly tradeFromIndex: number
  /** 位置相关信号源（订单块策略），见 BacktestInput.signalProvider */
  private readonly signalProvider?: (index: number, ctx: SignalProviderCtx) => void

  private cash: number
  private position: Position | null = null
  /** 上一根收盘时的仓位方向（多 +1 / 空 -1 / 平 0），供 Pine 的 `strategy.position_size[1]` 使用 */
  private prevPositionSize = 0
  private tradeSeq = 0

  /**
   * 成交时点语义（按策略区分，对齐各自的 Pine 原版）：
   * - SuperTrend / Volume Order Block 原版的 `strategy()` 未设置
   *   process_orders_on_close，TradingView 默认在**信号 K 线的下一根开盘**成交；
   * - fib 原版显式设置了 process_orders_on_close = true，按信号 K 线**收盘**成交。
   */
  private readonly fillNextBarOpen: boolean

  /** 滑点的绝对价格偏移 = slippageTicks × tickSize（0 表示不模拟滑点） */
  private readonly slippageAbs: number

  /** 排队等待「下一根开盘成交」的市价开仓单 */
  private pendingEntry: PendingEntry | null = null

  /** 排队等待「下一根开盘成交」的市价平仓单（时间止损） */
  private pendingExit: ExitReason | null = null

  readonly trades: Trade[] = []
  readonly equityCurve: EquityPoint[]

  private peakEquity: number
  /** 金字塔式：同一方向允许并存的最大子订单数（0 = 无限） */
  private readonly maxPyramiding: number

  constructor(input: BacktestInput) {
    this.candles = input.candles
    this.series = input.series
    this.params = input.params

    this.feeRate = input.params.commissionPercent / 100
    this.leverage = Math.max(1, input.params.leverage)
    this.sizeFraction = Math.min(1, Math.max(0.0001, input.params.positionSizePercent / 100))
    this.rr = input.params.riskRewardRatio
    this.dir = input.params.tradeDirection
    this.tradeFromIndex = Math.max(0, input.tradeFromIndex ?? 0)
    // 0 表示不限；至少允许 1 笔（即基础开仓）
    this.maxPyramiding = Math.max(1, Math.trunc(input.params.pyramiding ?? 1))
    this.fillNextBarOpen =
      input.params.strategy === 'supertrend' ||
      input.params.strategy === 'order-block' ||
      input.params.strategy === 'pine'

    const tick = Number.isFinite(input.tickSize) ? (input.tickSize as number) : 0
    this.slippageAbs = tick > 0 ? tick * Math.max(0, input.params.slippageTicks ?? 0) : 0
    this.signalProvider = input.signalProvider

    this.cash = input.params.initialCapital
    this.peakEquity = input.params.initialCapital
    this.equityCurve = new Array<EquityPoint>(input.candles.length)

    this.run()
  }

  /* ------------------------------------------------------------------ */
  /* 持仓操作                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 开仓 / 加仓：向当前持仓追加一笔子订单。
   *
   * 与旧实现的区别：不再覆盖 this.position，而是 push 进 subs 数组。
   * 每笔子订单独立占用保证金（`cash × sizeFraction` × 杠杆），
   * 因此加仓会按比例放大总仓位，这正是 TradingView 的行为。
   */
  private addSubOrder(
    side: TradeSide,
    price: number,
    index: number,
    timestamp: number,
    stopLoss: number,
    tp1: number,
    tp2: number,
    breakEven: number,
    /**
     * 仅在交易记录里展示的「初始止损价」——与 `stopLoss`（活动止损）解耦。
     * 主要给 Trend Switch 模式使用：保留 SuperTrend 的上下轨作为信息展示，
     * 但不让它触发 checkExits 的止损检查，避免破坏「只由反向信号离场」的语义。
     */
    displayStopLoss?: number,
    /**
     * 订单块策略的保本触发价（价格到达该值时把止损移动到开仓价）。
     * 与 `breakEven`（第一目标成交后移动止损）是两套独立机制。
     */
    beTrigger?: number,
    /**
     * Pine 的 `strategy.entry(..., qty=…)`：固定下单量。
     * 给了它就用「数量 × 价格」作为名义价值，不再按权益比例复利放大。
     */
    fixedQty?: number,
  ): void {
    if (!Number.isFinite(price) || price <= 0) return
    const fixed = typeof fixedQty === 'number' && Number.isFinite(fixedQty) && fixedQty > 0
    const marginCap = this.cash * this.sizeFraction
    if (!fixed && marginCap <= 0) return
    const notional = fixed ? (fixedQty as number) * price : marginCap * this.leverage
    const qty = fixed ? (fixedQty as number) : notional / price
    /**
     * 资金门槛：固定数量（Pine 的 `strategy.entry(qty=…)`）时按
     * 「名义价值 / 引擎杠杆」估算所需保证金，不足则本轮不下单。
     *
     * 注意这只是**准入条件**，不代表实际占用 —— 它与下面的 `margin` 刻意解耦，
     * 否则本金被手续费削减一点之后（1000 → 998.9）就会把后续同额订单全部挡掉。
     */
    if (fixed && notional / this.leverage > this.cash) return
    /**
     * 占用保证金（= 报告口径里的「保证金」）= 这笔仓位实际占用的自有资金。
     *
     * - 引擎口径（脚本没给 qty）：`marginCap`（权益 × 仓位比例），
     *   名义价值 = marginCap × 杠杆，是一笔真正的杠杆仓；
     * - 脚本 qty 口径：下单量由脚本给定，引擎杠杆**没有**放大名义价值，
     *   所以这是一笔 1 倍仓，占用即全额名义价值。
     *
     * 记录成 1 倍之后，「收益率 = 净额 / 保证金」才等于「该笔对账户的实际收益率」。
     * 若仍按 `名义价值 / 杠杆` 记账，就会出现两套口径打架：
     * 名义价值按 1 倍计、收益率却按杠杆放大（表现为「价格变动 2.28%，
     * 收益率却显示 +21.68%」、「逐笔收益率加起来推不出账户总收益」）。
     */
    const margin = fixed ? notional : marginCap
    /** 该笔仓位真正的杠杆倍数：脚本 qty 仓位是 1 倍，只有引擎口径才带杠杆 */
    const positionLeverage = fixed ? 1 : this.leverage
    const entryFee = notional * this.feeRate
    if (this.cash - entryFee <= 0) return

    this.cash -= entryFee

    // Pine 脚本按 TradingView 的现货/无杠杆口径撮合：不引入强平。
    // （TradingView 的 strategy() 没有保证金模型，加进来只会制造差异，
    //   例如无止损的持仓被 1 倍杠杆公式在 2 倍价处"强平"。）
    const liquidationPrice =
      this.params.checkLiquidation && this.params.strategy !== 'pine'
        ? side === 'long'
          ? price * (1 - 1 / this.leverage)
          : price * (1 + 1 / this.leverage)
        : Number.NaN

    const sub: SubOrder = {
      side,
      entryIndex: index,
      entryTime: timestamp,
      entryPrice: price,
      initialQty: qty,
      remaining: 1,
      notional,
      margin,
      leverage: positionLeverage,
      initialStopLoss:
        typeof displayStopLoss === 'number' && Number.isFinite(displayStopLoss)
          ? displayStopLoss
          : stopLoss,
      stopLoss,
      liquidationPrice,
      takeProfit1: tp1,
      takeProfit2: tp2,
      breakEven,
      tp1Hit: false,
      entryFee,
      mfePercent: 0,
      maePercent: 0,
      fills: [],
      grossPnl: 0,
      beTrigger: typeof beTrigger === 'number' ? beTrigger : Number.NaN,
      beArmed: false,
    }

    if (this.position && this.position.side === side) {
      this.position.subs.push(sub)
    } else {
      this.position = { side, subs: [sub] }
    }
  }

  /**
   * 金字塔加仓前的守卫。
   *
   * 返回 true 表示当前**可以**再开/加一笔该方向的订单。规则：
   *   - 无持仓：可以（这是基础开仓）
   *   - 持仓方向相同且已有 N 笔：仅当 N < maxPyramiding 时可以（加仓）
   *   - 持仓方向相反：只有在 `allowReverse` 为 true 时才允许
   *     （调用方会先平掉反向仓位，再以该方向开新仓）
   */
  private canAddSameDirection(side: TradeSide, allowReverse = false): boolean {
    const pos = this.position
    if (!pos) return true
    if (pos.side !== side) return allowReverse
    return pos.subs.filter((s) => this.isAlive(s)).length < this.maxPyramiding
  }

  /** 该子订单是否仍然持有仓位 */
  private isAlive(s: SubOrder): boolean {
    return s.remaining > 1e-9
  }

  /** 平掉某笔子订单的一部分（portion 为占该子订单初始量的比例 0~1） */
  private reduceSubOrder(
    sub: SubOrder,
    portion: number,
    price: number,
    reason: ExitReason,
    timestamp: number,
  ): void {
    const f = Math.max(0, Math.min(sub.remaining, portion))
    if (f <= 0 || !Number.isFinite(price)) return

    const closeQty = sub.initialQty * f
    const sign = sub.side === 'long' ? 1 : -1
    let gross = (price - sub.entryPrice) * closeQty * sign
    const fee = price * closeQty * this.feeRate

    // 逐仓亏损上限：一笔仓位最多亏掉它为这笔仓位占用的保证金（现实中此时已被强平）。
    // 没有这道闸时，高杠杆 + 跳空会出现「权益为负」的结果（例如 5x 下单笔 -25% 亏损），
    // 那既不符合交易所行为，也会让收益率出现 -200%、回撤 -470% 这种不可能的数字。
    // 上限按「含手续费的总亏损」计算，保证账户余额不会被亏成负数。
    const maxLoss = sub.margin * f
    const entryFeePart = sub.entryFee * f
    if (gross - fee - entryFeePart < -maxLoss) gross = -maxLoss + fee + entryFeePart

    this.cash += gross - fee
    sub.grossPnl += gross
    sub.remaining -= f

    sub.fills.push({
      timestamp,
      price,
      portion: f,
      qty: closeQty,
      fee,
      realizedPnl: gross - fee,
      reason,
    })
  }

  /** 把一笔子订单登记为一笔独立的已完成交易（与 TradingView 逐笔对齐） */
  private finalizeSubOrder(sub: SubOrder, index: number, timestamp: number): void {
    const totalQty = sub.fills.reduce((a, x) => a + x.qty, 0)
    const exitPrice =
      totalQty > 0 ? sub.fills.reduce((a, x) => a + x.price * x.qty, 0) / totalQty : sub.entryPrice
    const fillFees = sub.fills.reduce((a, x) => a + x.fee, 0)
    const totalFee = fillFees + sub.entryFee
    const netPnl = sub.grossPnl - totalFee
    const sign = sub.side === 'long' ? 1 : -1
    const lastFill = sub.fills[sub.fills.length - 1]
    const reason: ExitReason = lastFill ? lastFill.reason : 'EndOfData'

    this.trades.push({
      id: ++this.tradeSeq,
      side: sub.side,
      entryIndex: sub.entryIndex,
      exitIndex: index,
      entryTime: sub.entryTime,
      exitTime: timestamp,
      entryPrice: sub.entryPrice,
      exitPrice,
      qty: sub.initialQty,
      notional: sub.notional,
      leverage: sub.leverage,
      margin: sub.margin,
      stopLoss: sub.initialStopLoss,
      finalStopLoss: sub.stopLoss,
      takeProfit1: sub.takeProfit1,
      takeProfit2: sub.takeProfit2,
      breakEven: sub.breakEven,
      exitReason: reason,
      barsHeld: index - sub.entryIndex,
      grossPnl: sub.grossPnl,
      fee: totalFee,
      netPnl,
      pnlPercent: sub.margin > 0 ? (netPnl / sub.margin) * 100 : 0,
      // 平仓成交已在 reduceSubOrder 里结算进 cash，此处即「本笔了结后的账户余额」
      balanceAfter: this.cash,
      priceChangePercent: ((exitPrice - sub.entryPrice) / sub.entryPrice) * 100 * sign,
      maxFavorableExcursion: sub.mfePercent,
      maxAdverseExcursion: sub.maePercent,
      fills: sub.fills.slice(),
      comment: `${EXIT_COMMENT[reason]} ${sub.side === 'long' ? 'Long' : 'Short'}`,
    })
  }

  /** 若所有子订单都已平掉，清空持仓位 */
  private prunePosition(): void {
    const pos = this.position
    if (!pos) return
    if (pos.subs.every((s) => !this.isAlive(s))) this.position = null
  }

  /** 逐个平掉指定子订单并登记交易 */
  private finalizeSubs(subs: SubOrder[], index: number, timestamp: number): void {
    for (const s of subs) this.finalizeSubOrder(s, index, timestamp)
    this.prunePosition()
  }

  /** 以市价（bar 收盘价）平掉全部剩余仓位，每笔子订单各记一笔交易 */
  private closeAll(reason: ExitReason, price: number, index: number, timestamp: number): void {
    const pos = this.position
    if (!pos) return
    const alive = pos.subs.filter((s) => this.isAlive(s))
    for (const s of alive) this.reduceSubOrder(s, s.remaining, price, reason, timestamp)
    this.finalizeSubs(alive, index, timestamp)
  }

  /**
   * 在本根 K 线开盘价执行排队的市价开仓单。
   *
   * 复刻 TradingView「信号在上一根收盘产生、订单在本根开盘成交」的行为：
   * SuperTrend 反手时旧仓的平仓与新仓的开仓发生在同一根开盘、同一个价格上，
   * 这也正是 TV 交易清单里「平仓价 = 下一笔开仓价」的由来。
   */
  private fillPendingEntry(bar: Candle, index: number): void {
    const pending = this.pendingEntry
    this.pendingEntry = null
    if (!pending) return

    const pos = this.position
    if (pos && pos.side !== pending.side) {
      this.closeAll('TrendSwitch', bar.open, index, bar.timestamp)
    }
    // 市价单按滑点取劣势价（TradingView 的 slippage 语义）
    const price = pending.side === 'long' ? bar.open + this.slippageAbs : bar.open - this.slippageAbs
    this.addSubOrder(
      pending.side,
      price,
      index,
      bar.timestamp,
      pending.stopLoss ?? NaN,
      NaN,
      pending.takeProfit ?? NaN,
      NaN,
      pending.displayStopLoss,
      // 保本触发价用「实际成交价 ± 风险×beAtR」计算（对齐 avg + longRisk*beAtR）
      this.resolveBeTrigger(pending, price),
      // Pine 脚本显式指定的固定下单量（若有）
      pending.qty,
    )
  }

  /** 计算保本触发价：成交价 ± 风险 × beAtR（多单在开仓价上方触发，空单在下方） */
  private resolveBeTrigger(pending: PendingEntry, fillPrice: number): number {
    // Pine 脚本的保本由脚本自己用 strategy.exit 更新止损实现，
    // 引擎不代为移动（否则等于给脚本外加了一套保本逻辑）。
    if (this.params.strategy === 'pine') return Number.NaN
    if (pending.risk === undefined || !Number.isFinite(pending.risk)) return Number.NaN
    const cfg = this.params.orderBlock
    if (!cfg.useBE || !(cfg.beAtR > 0)) return Number.NaN
    return pending.side === 'long'
      ? fillPrice + pending.risk * cfg.beAtR
      : fillPrice - pending.risk * cfg.beAtR
  }

  /** 在本根开盘价执行排队的时间止损（市价平仓，含滑点） */
  private fillPendingExit(bar: Candle, index: number): void {
    const reason = this.pendingExit
    this.pendingExit = null
    if (!reason) return
    const pos = this.position
    if (!pos) return
    const price = pos.side === 'long' ? bar.open - this.slippageAbs : bar.open + this.slippageAbs
    this.closeAll(reason, price, index, bar.timestamp)
  }

  /**
   * 订单块策略的保本移动（在每根 K 线收盘、挂单撮合之后执行）。
   *
   * 对应 Pine：
   *   if useBE and not na(longRisk) and high >= avg + longRisk*beAtR
   *       longStop := math.max(longStop, avg)
   *
   * 由于挂单在收盘才更新，新的止损从**下一根** K 线开始才可能触发 —— 与
   * strategy.exit 重新下单的时点一致。
   */
  private armBreakEven(bar: Candle): void {
    const pos = this.position
    if (!pos) return
    const isLong = pos.side === 'long'

    for (const sub of pos.subs) {
      if (!this.isAlive(sub) || !Number.isFinite(sub.beTrigger)) continue
      const hit = isLong ? bar.high >= sub.beTrigger : bar.low <= sub.beTrigger
      if (!hit) continue

      sub.stopLoss = isLong
        ? Number.isFinite(sub.stopLoss)
          ? Math.max(sub.stopLoss, sub.entryPrice)
          : sub.entryPrice
        : Number.isFinite(sub.stopLoss)
          ? Math.min(sub.stopLoss, sub.entryPrice)
          : sub.entryPrice
      sub.beArmed = true
    }
  }

  /** 检查一根 bar 上的止盈/止损/强平挂单（逐子订单独立撮合） */
  private checkExits(bar: Candle, index: number): void {
    const pos = this.position
    if (!pos) return
    const isLong = pos.side === 'long'

    // TradingView 券商模拟器的 intrabar 方向假设
    const walk: number[] = bar.close >= bar.open ? [bar.low, bar.high] : [bar.high, bar.low]

    const trendSwitch = this.params.exitStrategy === 'Trend Switch'
    const partial = this.params.partialTp && !trendSwitch

    // 每根 bar 上被平掉的子订单，最后统一登记为交易
    const closed: SubOrder[] = []

    for (const sub of pos.subs) {
      if (!this.isAlive(sub)) continue
      // 挂单从**开仓后的下一根**才生效：订单块策略在开盘成交，
      // 其 strategy.exit 挂单是在同一根 K 线的收盘才创建的（对应 TradingView）。
      if (sub.entryIndex >= index) continue

      // 更新 MFE / MAE
      const favo = isLong
        ? ((bar.high - sub.entryPrice) / sub.entryPrice) * 100
        : ((sub.entryPrice - bar.low) / sub.entryPrice) * 100
      const adve = isLong
        ? ((sub.entryPrice - bar.low) / sub.entryPrice) * 100
        : ((bar.high - sub.entryPrice) / sub.entryPrice) * 100
      if (favo > sub.mfePercent) sub.mfePercent = favo
      if (adve > sub.maePercent) sub.maePercent = adve

      // 止损位与强平价取「先被触及」的那一个
      let stopLevel = sub.stopLoss
      let stopReason: ExitReason = sub.tp1Hit || sub.beArmed ? 'BreakEven' : 'StopLoss'
      if (Number.isFinite(sub.liquidationPrice)) {
        const liqFirst = isLong
          ? sub.liquidationPrice > stopLevel
          : sub.liquidationPrice < stopLevel
        if (liqFirst || !Number.isFinite(stopLevel)) {
          stopLevel = sub.liquidationPrice
          stopReason = 'Liquidation'
        }
      }

      let done = false
      for (const p of walk) {
        if (done) break

        // 1) 止损 / 强平
        if (Number.isFinite(stopLevel)) {
          const hit = isLong ? p <= stopLevel : p >= stopLevel
          if (hit) {
            // 止损单同样吃滑点（劣势方向）；强平价由交易所撮合，不再加滑点
            const fillPrice =
              stopReason === 'Liquidation' || this.slippageAbs === 0
                ? stopLevel
                : isLong
                  ? stopLevel - this.slippageAbs
                  : stopLevel + this.slippageAbs
            this.reduceSubOrder(sub, sub.remaining, fillPrice, stopReason, bar.timestamp)
            closed.push(sub)
            done = true
            break
          }
        }

        if (trendSwitch) continue

        if (partial) {
          // 2) 第一目标（平 50%）→ 止损移动到保本
          if (!sub.tp1Hit && Number.isFinite(sub.takeProfit1)) {
            const hit = isLong ? p >= sub.takeProfit1 : p <= sub.takeProfit1
            if (hit) {
              this.reduceSubOrder(sub, 0.5, sub.takeProfit1, 'TP1', bar.timestamp)
              sub.tp1Hit = true
              sub.stopLoss = sub.breakEven
              stopLevel = sub.stopLoss
              stopReason = 'BreakEven'
              if (!this.isAlive(sub)) {
                closed.push(sub)
                done = true
                break
              }
            }
          }
          // 3) 第二目标（平剩余）
          if (sub.tp1Hit && Number.isFinite(sub.takeProfit2)) {
            const hit = isLong ? p >= sub.takeProfit2 : p <= sub.takeProfit2
            if (hit) {
              this.reduceSubOrder(sub, sub.remaining, sub.takeProfit2, 'TP2', bar.timestamp)
              closed.push(sub)
              done = true
              break
            }
          }
        } else if (Number.isFinite(sub.takeProfit2)) {
          // 未启用分批止盈：TP2 与 SL 二选一，全平
          const hit = isLong ? p >= sub.takeProfit2 : p <= sub.takeProfit2
          if (hit) {
            this.reduceSubOrder(sub, sub.remaining, sub.takeProfit2, 'TP2', bar.timestamp)
            closed.push(sub)
            done = true
            break
          }
        }
      }
    }

    if (closed.length > 0) this.finalizeSubs(closed, index, bar.timestamp)
  }

  /** 把当前 bar 的权益快照写入资金曲线 */
  private recordEquity(bar: Candle, i: number): void {
    let unrealized = 0
    if (this.position) {
      for (const s of this.position.subs) {
        if (!this.isAlive(s)) continue
        const sign = s.side === 'long' ? 1 : -1
        const pnl = (bar.close - s.entryPrice) * s.initialQty * s.remaining * sign
        // 逐仓口径：浮亏不会超过该仓位占用的保证金（现实中此时已被强平），
        // 否则高杠杆下的浮亏会把权益打成深度负数，回撤出现 -400% 这种不可能的数字
        unrealized += Math.max(pnl, -s.margin * s.remaining)
      }
    }
    const equity = this.cash + unrealized
    if (equity > this.peakEquity) this.peakEquity = equity
    const drawdownAbs = this.peakEquity - equity
    this.equityCurve[i] = {
      timestamp: bar.timestamp,
      equity,
      cash: this.cash,
      unrealized,
      drawdownPercent: this.peakEquity > 0 ? (-drawdownAbs / this.peakEquity) * 100 : 0,
      drawdownAbs,
      position: this.position?.side ?? 'flat',
    }
  }

  /* ------------------------------------------------------------------ */
  /* 主循环                                                              */
  /* ------------------------------------------------------------------ */

  private run(): void {
    const { candles, series, params } = this
    const n = candles.length

    if (n === 0) return

    for (let i = 0; i < n; i++) {
      const bar = candles[i]
      // Pine 的 `strategy.position_size[1]`：本根开盘前（= 上一根收盘时）的仓位方向
      this.prevPositionSize = this.position ? (this.position.side === 'long' ? 1 : -1) : 0

      // A0. 上一根 K 线排队的市价单：在本根开盘成交
      //     （时间止损的市价平仓、以及 supertrend / 订单块的下一根开盘开仓）
      if (this.pendingExit) this.fillPendingExit(bar, i)
      if (this.pendingEntry) this.fillPendingEntry(bar, i)

      // A. 已有仓位的挂单撮合（挂单从开仓后的下一根 bar 起生效）
      this.checkExits(bar, i)

      // A1. 位置相关信号（订单块策略）：在收盘、撮合完成之后计算，
      //     这样 flat 才等于原 Pine 中 `strategy.position_size == 0`
      if (this.signalProvider) {
        const pos = this.position
        const live = pos ? pos.subs.filter((s) => this.isAlive(s)) : []
        const totalQty = live.reduce((a, s) => a + s.initialQty * s.remaining, 0)
        const avgPrice =
          totalQty > 0
            ? live.reduce((a, s) => a + s.entryPrice * s.initialQty * s.remaining, 0) / totalQty
            : NaN
        this.signalProvider(i, {
          flat: pos === null,
          positionSize: pos ? (pos.side === 'long' ? 1 : -1) : 0,
          prevPositionSize: this.prevPositionSize,
          avgPrice,
          side: pos ? pos.side : null,
        })
      }
      const sig = series.signals[i]

      // Pine：strategy.close(id) / strategy.close_all() → 当根收盘判定，下一根开盘市价平仓
      if (params.strategy === 'pine' && sig.forceClose && this.position && !this.pendingExit) {
        this.pendingExit = 'ScriptClose'
      }

      // A2. 订单块：保本触发（等价于 Pine 在收盘时更新 longStop/shortStop）
      if (params.exitStrategy === 'Zone OCO' && this.position) this.armBreakEven(bar)

      const inLong = this.position?.side === 'long'
      const inShort = this.position?.side === 'short'

      // B. 反手逻辑（对应 Pine 中 exitStrategy != "Trend Switch" 的 reversal 块）
      if (
        this.position &&
        params.exitStrategy !== 'Trend Switch' &&
        params.exitStrategy !== 'Zone OCO' &&
        params.allowReversePosition
      ) {
        if (inLong && sig.canShort) {
          this.closeAll('Reverse', bar.close, i, bar.timestamp)
        } else if (inShort && sig.canLong) {
          this.closeAll('Reverse', bar.close, i, bar.timestamp)
        }
      }

      // C. 开仓（预热区间内不开仓，只推进指标状态）
      if (i < this.tradeFromIndex) {
        this.recordEquity(bar, i)
        continue
      }

      const wantLong = sig.canLong && (this.dir === 'Long Only' || this.dir === 'Both')
      const wantShort = sig.canShort && (this.dir === 'Short Only' || this.dir === 'Both')
      if (params.exitStrategy === 'ATR') {
        if (wantLong && this.canAddSameDirection('long', params.allowReversePosition) && Number.isFinite(sig.atrLongStop)) {
          const entry = bar.close
          const risk = entry - sig.atrLongStop
          if (risk > 0) {
            this.addSubOrder(
              'long',
              entry,
              i,
              bar.timestamp,
              sig.atrLongStop,
              entry + (this.rr * risk) / 2,
              entry + this.rr * risk,
              entry * 1.0005,
            )
          }
        }
        if (wantShort && this.canAddSameDirection('short', params.allowReversePosition) && Number.isFinite(sig.atrShortStop)) {
          const entry = bar.close
          const risk = sig.atrShortStop - entry
          if (risk > 0) {
            this.addSubOrder(
              'short',
              entry,
              i,
              bar.timestamp,
              sig.atrShortStop,
              entry - (this.rr * risk) / 2,
              entry - this.rr * risk,
              entry * 0.9995,
            )
          }
        }
      } else if (params.exitStrategy === 'Fixed Percent') {
        if (wantLong && this.canAddSameDirection('long', params.allowReversePosition)) {
          const entry = bar.close
          const sl = entry * (1 - params.slPercent / 100)
          const risk = entry - sl
          if (risk > 0) {
            this.addSubOrder(
              'long',
              entry,
              i,
              bar.timestamp,
              sl,
              entry + (this.rr * risk) / 2,
              entry + this.rr * risk,
              entry * 1.0005,
            )
          }
        }
        if (wantShort && this.canAddSameDirection('short', params.allowReversePosition)) {
          const entry = bar.close
          const sl = entry * (1 + params.slPercent / 100)
          const risk = sl - entry
          if (risk > 0) {
            this.addSubOrder(
              'short',
              entry,
              i,
              bar.timestamp,
              sl,
              entry - (this.rr * risk) / 2,
              entry - this.rr * risk,
              entry * 0.9995,
            )
          }
        }
      } else if (params.exitStrategy === 'Zone OCO') {
        // 订单块：区域回踩信号 → 下一根开盘市价进场，同时挂出
        // 区域止损（stop）与固定盈亏比目标（limit），二者构成 OCO；整仓离场。
        const inPos = this.position !== null
        // Pine 脚本可以用 strategy.entry(qty=…) 指定固定下单量（订单块策略不带该字段）
        const entryQty =
          Number.isFinite(sig.entryQty ?? NaN) && (sig.entryQty as number) > 0
            ? (sig.entryQty as number)
            : undefined
        /*
         * Pine 动态止损（盘中止损）：脚本 `plot(…, title="STOP")` 的逐 bar 止损价 →
         * 适配器的 obStopLoss → 这里在持仓期间**只收紧**地维护 sub.stopLoss。
         *
         * 引擎的止损判定本来就是盘中的（`p <= stopLevel` 时按止损价成交），
         * 所以瀑布行情不会再被「信号 → 下一根开盘」跳空穿透。
         * 只对 pine 策略生效，且脚本没有 STOP 通道时（NaN）完全不改变原有行为。
         */
        if (params.strategy === 'pine' && inPos && Number.isFinite(sig.obStopLoss ?? NaN)) {
          const next = sig.obStopLoss as number
          for (const sub of this.position!.subs) {
            if (!this.isAlive(sub)) continue
            const isLong = sub.side === 'long'
            const tighter = isLong ? next > sub.stopLoss : next < sub.stopLoss
            // 不允许把止损放到当前价的另一侧（那等于立刻成交）
            const okSide = isLong ? next < bar.close : next > bar.close
            if (okSide && (!Number.isFinite(sub.stopLoss) || tighter)) sub.stopLoss = next
          }
        }
        if (wantLong && !inPos && this.canAddSameDirection('long', true)) {
          const stopLoss = Number.isFinite(sig.obStopLoss ?? NaN) ? (sig.obStopLoss as number) : NaN
          const takeProfit = Number.isFinite(sig.obTakeProfit ?? NaN)
            ? (sig.obTakeProfit as number)
            : NaN
          const risk = Number.isFinite(sig.obRisk ?? NaN) ? (sig.obRisk as number) : undefined
          if (this.fillNextBarOpen) {
            this.pendingEntry = { side: 'long', stopLoss, takeProfit, risk, qty: entryQty }
          } else {
            this.addSubOrder(
              'long',
              bar.close,
              i,
              bar.timestamp,
              stopLoss,
              NaN,
              takeProfit,
              NaN,
              NaN,
              NaN,
              entryQty,
            )
          }
        } else if (wantShort && !inPos && this.canAddSameDirection('short', true)) {
          const stopLoss = Number.isFinite(sig.obStopLoss ?? NaN) ? (sig.obStopLoss as number) : NaN
          const takeProfit = Number.isFinite(sig.obTakeProfit ?? NaN)
            ? (sig.obTakeProfit as number)
            : NaN
          const risk = Number.isFinite(sig.obRisk ?? NaN) ? (sig.obRisk as number) : undefined
          if (this.fillNextBarOpen) {
            this.pendingEntry = { side: 'short', stopLoss, takeProfit, risk, qty: entryQty }
          } else {
            this.addSubOrder(
              'short',
              bar.close,
              i,
              bar.timestamp,
              stopLoss,
              NaN,
              takeProfit,
              NaN,
              NaN,
              NaN,
              entryQty,
            )
          }
        }
      } else {
        // Trend Switch：无固定止盈止损，靠反向信号离场
        const inLongNow = this.position?.side === 'long'
        const inShortNow = this.position?.side === 'short'
        // SuperTrend 模式下把 up/dn 线作为展示用初始止损；活动止损保持 NaN，
        // 这样 checkExits 不会真的去触发 SL，只会由反向信号离场。
        // Trend Switch 天然以反向信号离场，因此必须允许反手开仓。
        if (wantLong && !inLongNow && this.canAddSameDirection('long', true)) {
          const trail = Number.isFinite(sig.atrLongStop) ? sig.atrLongStop : NaN
          if (this.fillNextBarOpen) {
            // 排队到下一根开盘成交（对齐 TradingView 默认下单时点）
            this.pendingEntry = { side: 'long', displayStopLoss: trail }
          } else {
            if (inShortNow) this.closeAll('TrendSwitch', bar.close, i, bar.timestamp)
            this.addSubOrder('long', bar.close, i, bar.timestamp, NaN, NaN, NaN, NaN, trail)
          }
        } else if (wantShort && !inShortNow && this.canAddSameDirection('short', true)) {
          const trail = Number.isFinite(sig.atrShortStop) ? sig.atrShortStop : NaN
          if (this.fillNextBarOpen) {
            this.pendingEntry = { side: 'short', displayStopLoss: trail }
          } else {
            if (inLongNow) this.closeAll('TrendSwitch', bar.close, i, bar.timestamp)
            this.addSubOrder('short', bar.close, i, bar.timestamp, NaN, NaN, NaN, NaN, trail)
          }
        }
      }

      // C2. 订单块：时间止损（收盘判定 → 下一根开盘市价平仓）
      //     仅对原生订单块策略生效：Pine 脚本的离场完全由脚本自身决定
      //     （strategy.exit / close / close_all），引擎不再附加时间止损。
      if (
        params.exitStrategy === 'Zone OCO' &&
        params.strategy !== 'pine' &&
        this.position
      ) {
        const maxBars = params.orderBlock.maxBars
        if (maxBars > 0) {
          const alive = this.position.subs.find((s) => this.isAlive(s))
          if (alive && i - alive.entryIndex >= maxBars) this.pendingExit = 'TimeStop'
        }
      }

      // D. 记录资金曲线
      this.recordEquity(bar, i)
    }

    // 回测结束强制平仓
    if (this.position) {
      const last = candles[n - 1]
      this.closeAll('EndOfData', last.close, n - 1, last.timestamp)
      const equity = this.cash
      if (equity > this.peakEquity) this.peakEquity = equity
      this.equityCurve[n - 1] = {
        timestamp: last.timestamp,
        equity,
        cash: this.cash,
        unrealized: 0,
        drawdownPercent: this.peakEquity > 0 ? ((equity - this.peakEquity) / this.peakEquity) * 100 : 0,
        drawdownAbs: this.peakEquity - equity,
        position: 'flat',
      }
    }
  }
}

export function runBacktest(input: BacktestInput): BacktestOutput {
  const engine = new BacktestEngine(input)
  return { trades: engine.trades, equityCurve: engine.equityCurve }
}

/**
 * 前后端共享类型定义。
 * 放在 shared/ 下，server 与 web 都直接引用同一份定义，避免协议漂移。
 */

/** 一段 K 线（OHLCV）。timestamp 为毫秒 UTC 时间戳（开盘时间）。 */
export interface Candle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** 交易所标识 */
export type ExchangeId = 'binanceusdm' | 'okx' | 'bybit' | 'bitget' | 'gate'

export const EXCHANGES: { id: ExchangeId; label: string }[] = [
  { id: 'binanceusdm', label: 'Binance USDT-M 永续' },
  { id: 'okx', label: 'OKX 永续' },
  { id: 'bybit', label: 'Bybit USDT 永续' },
  { id: 'bitget', label: 'Bitget USDT 永续' },
  { id: 'gate', label: 'Gate.io USDT 永续' },
]

/** 支持的 K 线周期 */
export type Timeframe =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '6h' | '12h'
  | '1d' | '3d' | '1w'

export const TIMEFRAMES: Timeframe[] = [
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '12h',
  '1d', '3d', '1w',
]

/** 周期 -> 毫秒，用于分页与年化换算 */
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
}

/* ------------------------------------------------------------------ */
/* 策略参数                                                             */
/* ------------------------------------------------------------------ */

export type TradeDirection = 'Long Only' | 'Short Only' | 'Both'
export type ExitStrategy = 'ATR' | 'Fixed Percent' | 'Trend Switch'
export type AtrSmoothing = 'RMA' | 'SMA' | 'EMA' | 'WMA'

/** 支持的回测策略 */
export type StrategyKind = 'fib-trend' | 'supertrend'

/** SuperTrend 策略参数（KivancOzbilgic 原版 Pine 移植） */
export interface SupertrendConfig {
  /** ATR 周期（原 input "ATR Period"，默认 10） */
  atrPeriod: number
  /** ATR 乘数（原 input "ATR Multiplier"，默认 3.0） */
  multiplier: number
  /**
   * 是否使用 SMA 计算 ATR。
   *
   * 原脚本为 `atr = changeATR ? atr(Periods) : atr2`，其中 atr2 = sma(tr, Periods)：
   * - changeATR = true（原版默认值）→ `atr(Periods)`，即 **RMA**（Wilder）
   * - changeATR = false → SMA
   *
   * 因此这里 false = 原版默认的 RMA，true = 切换为 SMA。
   */
  useSmaAtr: boolean
  /** 价格源（原 input "Source"，默认 hl2） */
  source: 'hl2' | 'close' | 'open' | 'high' | 'low'
}

/** Pine Script 中所有 input.* 对应字段，另加回测/交易所需的资金参数 */
export interface StrategyParams {
  /** Fibonacci 敏感度（脚本内 ×10 后作为 highest/lowest 的窗口长度），默认 18 */
  sensitivity: number

  /* ---- ATR SL Finder ---- */
  atrLength: number
  atrSmoothing: AtrSmoothing
  atrMultiplier: number

  /* ---- Strategy Execution ---- */
  tradeDirection: TradeDirection
  exitStrategy: ExitStrategy
  slPercent: number
  riskRewardRatio: number
  partialTp: boolean
  allowReversePosition: boolean

  /**
   * 金字塔式加仓上限（对应 TradingView 策略属性里的「金字塔式 N 订单」）。
   *
   * 语义：持仓期间若再次出现**同向**的入场信号，允许继续加仓，
   * 总持仓订单数不超过该值（1 = 不加仓；0 = 不限制）。
   *
   * ⚠ 重要：本策略的 `can_long` / `can_short` 内部带有
   * `!is_long_trend` / `!is_short_trend` 条件，一旦进入某方向的趋势，
   * 同向信号在趋势被反向信号重置前**只会触发一次**。因此该参数
   * 对原版策略的默认配置基本无效 —— 它保留用于自定义信号源，
   * 或用于未来放宽信号层时的实验。
   *
   * TradingView 图表上同一根 K 线出现多笔同向开仓，并非来自多次信号，
   * 而是其 `process_orders_on_close = true` 下按 tick 逐笔重算订单的结果，
   * 属于成交流水口径差异，详见 scripts/probe-signals.ts 的诊断输出。
   */
  pyramiding: number

  /* ---- 回测/资金 ---- */
  /** 单边手续费，百分比。Pine 中 commission_value = 0.055 (%) */
  commissionPercent: number
  initialCapital: number
  /** 杠杆倍数 1~125 */
  leverage: number
  /** 每次开仓投入的保证金占当前权益的百分比，默认 100 */
  positionSizePercent: number
  /** 是否启用强平检查（按逐仓 1/leverage 价格波动估算） */
  checkLiquidation: boolean

  /* ---- 策略选择 ---- */
  /** 当前激活的策略 */
  strategy: StrategyKind
  /** SuperTrend 参数（仅在 strategy === 'supertrend' 时生效） */
  supertrend: SupertrendConfig
}

export const DEFAULT_STRATEGY_PARAMS: StrategyParams = {
  sensitivity: 18,
  atrLength: 14,
  atrSmoothing: 'RMA',
  atrMultiplier: 3.5,
  tradeDirection: 'Both',
  exitStrategy: 'ATR',
  slPercent: 1,
  riskRewardRatio: 2,
  partialTp: true,
  allowReversePosition: true,
  // 原版策略的信号在趋势重置前同向只触发一次，因此默认不加仓。
  // 该参数保留给自定义信号源/实验用途，详见字段注释。
  pyramiding: 1,
  commissionPercent: 0.055,
  initialCapital: 1000,
  leverage: 3,
  positionSizePercent: 100,
  checkLiquidation: true,
  strategy: 'fib-trend',
  supertrend: {
    atrPeriod: 10,
    multiplier: 3.0,
    // false = RMA，与 KivancOzbilgic 原版 changeATR=true 的默认行为一致
    useSmaAtr: false,
    source: 'hl2',
  },
}

/* ------------------------------------------------------------------ */
/* 模块一：Fibonacci + TSOT                                            */
/* ------------------------------------------------------------------ */

/** 每个 bar 上由指标层算出的、供回测引擎消费的信号快照 */
export interface SignalBar {
  /** 斐波那契 0.5 回撤位，即 imba_trend_line */
  imbaTrendLine: number
  /** 趋势线下方一格的开仓信号（脚本中的 can_long） */
  canLong: boolean
  /** 趋势线上方一格的开仓信号（脚本中的 can_short） */
  canShort: boolean
  /** TSOT 多头趋势强度为正 */
  tsotBullish: boolean
  /** TSOT 空头趋势强度为负 */
  tsotBearish: boolean
  /** 趋势强度原始值 bullStrength - bearStrength */
  tsotTrendValue: number
  /** ATR(tr, atrLength) */
  atr: number
  /** 空头止损位 x = high + ATR*multiplier */
  atrShortStop: number
  /** 多头止损位 x2 = low - ATR*multiplier */
  atrLongStop: number

  /* ---- SuperTrend 字段（仅在 strategy === 'supertrend' 时使用） ---- */
  /** SuperTrend 多头支撑线（trend==1 时为 up），其它为 NaN */
  supertrendUp: number
  /** SuperTrend 空头阻力线（trend==-1 时为 dn），其它为 NaN */
  supertrendDn: number
  /** SuperTrend 方向：1 = 多，-1 = 空，0 = 尚未形成 */
  supertrendDirection: number
}

/* ------------------------------------------------------------------ */
/* 交易与绩效                                                            */
/* ------------------------------------------------------------------ */

export type TradeSide = 'long' | 'short'

export type ExitReason =
  | 'TP1'          // 第一目标止盈（平 50%）
  | 'TP2'          // 第二目标止盈（平剩余）
  | 'StopLoss'     // 止损
  | 'BreakEven'    // 保本止损
  | 'Reverse'      // 反手平仓
  | 'TrendSwitch'  // 趋势反转平仓
  | 'Liquidation'  // 强平
  | 'EndOfData'    // 回测结束时强制平仓

/** 一次减仓（一笔成交） */
export interface TradeFill {
  /** 成交时间（毫秒） */
  timestamp: number
  price: number
  /** 平掉的数量占初始仓位的比例（0~1） */
  portion: number
  /** 数量（标的货币） */
  qty: number
  fee: number
  realizedPnl: number
  reason: ExitReason
}

/** 一次完整交易（从开仓到全部平仓） */
export interface Trade {
  id: number
  side: TradeSide
  /** 开仓信号所在 bar 的序号（相对于返回的 candles 数组） */
  entryIndex: number
  /** 全部平仓所在 bar 的序号 */
  exitIndex: number
  entryTime: number
  exitTime: number
  entryPrice: number
  exitPrice: number
  /** 平均平仓价（有分批时按数量加权） */
  qty: number
  notional: number
  leverage: number
  /** 开仓时使用的保证金 */
  margin: number
  /** 开仓时设定的初始止损价 */
  stopLoss: number
  /** 平仓时刻的止损价（若 TP1 已成交，则已上移到保本价） */
  finalStopLoss: number
  takeProfit1: number
  takeProfit2: number
  breakEven: number
  /** 平仓原因（取最后一笔减仓的原因） */
  exitReason: ExitReason
  /** 持仓 K 线数 */
  barsHeld: number
  /** 不含手续费的毛利润 */
  grossPnl: number
  /** 手续费合计 */
  fee: number
  /** 净利润（已扣手续费） */
  netPnl: number
  /** 相对保证金的收益率 */
  pnlPercent: number
  /** 相对开仓价的收益率 */
  priceChangePercent: number
  maxFavorableExcursion: number
  maxAdverseExcursion: number
  fills: TradeFill[]
  /** 结构化平仓原因文本，对应 Pine 里的 strategy.close 注释 */
  comment: string
}

/** 资金曲线上的一点 */
export interface EquityPoint {
  timestamp: number
  equity: number
  cash: number
  /** 当前持仓的浮动盈亏 */
  unrealized: number
  /** 相对历史峰值的回撤百分比（负数） */
  drawdownPercent: number
  drawdownAbs: number
  position: TradeSide | 'flat'
}

export interface TradeStats {
  totalTrades: number
  winningTrades: number
  losingTrades: number
  breakEvenTrades: number
  winRate: number
  longTrades: number
  longWinRate: number
  shortTrades: number
  shortWinRate: number
  grossProfit: number
  grossLoss: number
  netProfit: number
  avgTrade: number
  avgWin: number
  avgLoss: number
  payoffRatio: number
  profitFactor: number
  expectancy: number
  maxConsecutiveWins: number
  maxConsecutiveLosses: number
  avgBarsHeld: number
  maxBarsHeld: number
  largestWin: number
  largestLoss: number
  totalFees: number
  totalVolume: number
  /** 平仓原因分布 */
  exitReasonCounts: Record<string, number>
}

export interface PerformanceReport {
  symbol: string
  exchange: ExchangeId
  timeframe: Timeframe
  leverage: number
  startTime: number
  endTime: number
  bars: number
  /** 供展示的策略快照 */
  params: StrategyParams
  initialCapital: number
  finalEquity: number
  netProfit: number
  totalReturnPercent: number
  /** 年化收益率（按 365 天连续复利换算） */
  annualizedReturnPercent: number
  maxDrawdownPercent: number
  maxDrawdownAbs: number
  maxDrawdownStart: number
  maxDrawdownEnd: number
  maxDrawdownBars: number
  sharpeRatio: number
  sortinoRatio: number
  calmarRatio: number
  /** System Quality Number */
  sqn: number
  /** 权益曲线单 bar 收益年化波动率 */
  volatilityPercent: number
  /** 买入并持有基准 */
  buyHoldReturnPercent: number
  /** 每笔交易平均收益率的年化估计 */
  stats: TradeStats
  /** 盈亏按小时/星期的分布，用于交易分析 */
  hourlyPnl: { hour: number; pnl: number; trades: number }[]
  weekdayPnl: { weekday: number; pnl: number; trades: number }[]
  /** 月度收益（百分比） */
  monthlyReturns: { month: string; returnPercent: number }[]
  /** 按品种周期归一后的提示信息 */
  warnings: string[]
}

/** 回测接口的完整响应 */
export interface BacktestResult {
  report: PerformanceReport
  candles: Candle[]
  trades: Trade[]
  equityCurve: EquityPoint[]
  /** 逐 bar 的指标快照，用于在图上叠加趋势线 */
  signals: {
    timestamp: number
    imbaTrendLine: number
    tsotTrendValue: number
    atrLongStop: number
    atrShortStop: number
    canLong: boolean
    canShort: boolean
    /** SuperTrend 上轨（仅 supertrend 策略有值） */
    supertrendUp?: number
    /** SuperTrend 下轨（仅 supertrend 策略有值） */
    supertrendDn?: number
    /** SuperTrend 方向 1/-1（仅 supertrend 策略有值） */
    supertrendDirection?: number
  }[]
  meta: {
    exchange: ExchangeId
    fetchedAt: number
    dataFrom: number
    dataTo: number
    cached: boolean
    /** 本次回测使用的策略 */
    strategy: StrategyKind
  }
}

export interface Instrument {
  symbol: string
  /** 合约 ID，如 BTCUSDT / BTC-USDT-SWAP */
  id: string
  base: string
  quote: string
  /** 交易对展示名，如 BTC/USDT */
  label: string
  type: string
  /** 交易所给出的最大杠杆 */
  maxLeverage?: number
  pricePrecision?: number
  amountPrecision?: number
  /** 合约面值（OKX/Bybit 等有） */
  contractSize?: number
  linear?: boolean
}

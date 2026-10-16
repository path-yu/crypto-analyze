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
export type ExitStrategy =
  | 'ATR'
  | 'Fixed Percent'
  | 'Trend Switch'
  /** 订单块：区域止损 + 固定盈亏比目标 + 保本触发 + 时间止损（Volume Order Block 原版离场） */
  | 'Zone OCO'
export type AtrSmoothing = 'RMA' | 'SMA' | 'EMA' | 'WMA'

/** 支持的回测策略 */
export type StrategyKind = 'fib-trend' | 'supertrend' | 'order-block' | 'pine'

/** Pine 编译器返回的一条诊断（带行列号，供编辑器内联展示） */
export interface PineDiagnostic {
  /** 1 起的行号 */
  line: number
  /** 1 起的列号 */
  column: number
  severity: 'error' | 'warning'
  message: string
}

/** Pine 编译产物元信息（脚本声明、可覆盖输入项、绘图标题等） */
export interface PineCompileMeta {
  /** 脚本种类：strategy() / indicator() */
  kind: 'strategy' | 'indicator'
  /** strategy() 声明的原始具名实参（v1 仅记录，不覆盖 params） */
  config: Record<string, string | number | boolean>
  /** input.* 声明，供前端渲染可覆盖项 */
  inputs: {
    name: string
    type: 'int' | 'float' | 'bool' | 'color' | 'string'
    title: string
    group?: string
    minval?: number
    maxval?: number
    step?: number
    default: unknown
  }[]
  /** plot() 的 title 列表 */
  plotTitles: string[]
  /** alertcondition 收集 */
  alerts: { title: string; message: string }[]
}

/**
 * 已保存的 Pine 脚本。
 *
 * 每份脚本在 `server/pine/<目录>/` 下单独一个文件夹，源码与编译产物放在一起
 * （便于直接纳入 git 版本管理）：
 *
 * ```
 * server/pine/Signal Suite/
 *   Signal Suite.pine   原始 Pine 源码
 *   Signal Suite.ts     编译器生成的 TypeScript
 * ```
 *
 * 索引另存于 `.cache/pine-scripts.json`（记录 id / 名称 / 时间 / 目录名）；
 * 索引丢失时会扫描 `server/pine/` 下的各脚本目录自动重建列表。
 */
export interface SavedPineScript {
  id: string
  /** 脚本名：下拉菜单展示用，同名保存视为更新 */
  name: string
  /** 原始 Pine 源码 */
  source: string
  /** 落盘目录名（`server/pine/<dir>/`）；仅存在于索引中的历史数据可能缺省 */
  dir?: string
  /** 源码文件相对项目根的路径，例如 `server/pine/Signal Suite/Signal Suite.pine` */
  pinePath?: string
  /** 编译产物相对项目根的路径；编译失败时缺省 */
  tsPath?: string
  /** 编译产物字节数 */
  tsBytes?: number
  createdAt: number
  updatedAt: number
}

/** Volume Order Block Retest 策略参数（Pine v6 原版一一对应） */
export interface OrderBlockConfig {
  /* ---- Order Block Detection ---- */
  /** ATR 周期（原 "ATR length"，默认 14） */
  atrLen: number
  /** 脉冲实体 ≥ ATR × 该值（原 "Displacement body ≥ ATR ×"，默认 0.8） */
  dispMult: number
  /** 成交量 SMA 周期（原 "Volume SMA length"，默认 20） */
  volLen: number
  /** 脉冲成交量 ≥ SMA × 该值（原 "Impulse volume ≥ SMA ×"，默认 1.0） */
  impVolMult: number
  /** 是否要求脉冲前一根为反向颜色（原 "Require opposite-colour candle before impulse"，默认 false） */
  needOpp: boolean
  /** 是否要求脉冲收盘突破前一根区间（原 "Require impulse close beyond prior candle range"，默认 false） */
  needBreak: boolean
  /** 区域取实体（否则取最高/最低）（原 "Use candle body only for zone"，默认 false） */
  bodyZone: boolean
  /** 最大同时存在区域数（原 "Max active zones"，默认 15） */
  maxZones: number
  /** 区域最大存活 K 线数（原 "Max zone age (bars)"，默认 300） */
  maxAge: number

  /* ---- Entry Filters ---- */
  /** 每个区域只成交一次（原 "Each zone trades once"，默认 true） */
  firstTouch: boolean
  /** 要求 K 线方向与交易方向一致（原 "Require candle in trade direction"，默认 true） */
  needCandle: boolean
  /** 要求拒绝影线（原 "Require rejection wick"，默认 false） */
  useRejection: boolean
  /** 影线占振幅的最小百分比（原 "Min wick % of range"，默认 25） */
  wickPct: number
  /** 要求回踩缩量（原 "Require volume dry-up on retest"，默认 false） */
  useRetestVol: boolean
  /** 回踩成交量 ≤ 脉冲成交量 × 该值（原 "Retest volume ≤ impulse volume ×"，默认 1.0） */
  retestVolMax: number
  /** EMA 趋势过滤（原 "EMA trend filter"，默认 false） */
  useTrend: boolean
  /** EMA 周期（原 "EMA length"，默认 100） */
  emaLen: number
  /** 允许做多（原 "Allow longs"，默认 true） */
  allowLong: boolean
  /** 允许做空（原 "Allow shorts"，默认 true） */
  allowShort: boolean

  /* ---- Risk Management ---- */
  /** 止损缓冲（区域外侧 ATR × 该值，原 "SL buffer beyond zone"，默认 0.2） */
  slBuf: number
  /** 止盈 R 倍数（原 "Take profit (R multiple)"，默认 1.5） */
  rrTarget: number
  /** 是否移动止损到保本（原 "Move stop to break-even"，默认 true） */
  useBE: boolean
  /** 保本触发 R 倍数（原 "Break-even trigger (R)"，默认 1.0） */
  beAtR: number
  /** 时间止损（K 线数，0 = 关闭；原 "Time stop (bars)"，默认 60） */
  maxBars: number
}

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
  /**
   * Pine 脚本用 `strategy.entry(qty=…)` 显式指定下单量时，是否让它决定仓位。
   *
   * - `true`：遵循 TradingView 语义，`qty × 价格` 即名义价值，
   *   此时 `leverage` / `positionSizePercent` **不参与**定仓位
   *   （`leverage` 仅用于反推占用保证金与「收益率」列的分母）。默认值。
   * - `false`：忽略脚本的 `qty`，改按 UI 的
   *   `名义价值 = 权益 × positionSizePercent × leverage` 定仓位
   *   （与 fib / supertrend / order-block 三个策略一致），
   *   例如 1000 本金 / 仓位 100% / 杠杆 10 → 名义价值 10000。
   *
   * 两者产出的逐笔盈亏相差一个 `leverage` 倍数，因此切换后必须重新回测。
   */
  useScriptPositionSize: boolean
  /** 是否启用强平检查（按逐仓 1/leverage 价格波动估算） */
  checkLiquidation: boolean
  /**
   * 滑点（tick 数）。对应 TradingView 策略属性里的 `slippage`：
   * 市价单与止损单按 `slippageTicks × tickSize` 的劣势价格成交，
   * 限价单（止盈）不受影响。tickSize 由前端按所选合约的下单精度传入，
   * 未提供时按 0 处理（即不模拟滑点）。
   */
  slippageTicks: number

  /* ---- 策略选择 ---- */
  /** 当前激活的策略 */
  strategy: StrategyKind
  /** SuperTrend 参数（仅在 strategy === 'supertrend' 时生效） */
  supertrend: SupertrendConfig
  /** 订单块参数（仅在 strategy === 'order-block' 时生效） */
  orderBlock: OrderBlockConfig
}

/** Volume Order Block Retest 默认参数（与 Pine 原版 input 默认值一一对应） */
export const DEFAULT_ORDER_BLOCK: OrderBlockConfig = {
  atrLen: 14,
  dispMult: 0.8,
  volLen: 20,
  impVolMult: 1.0,
  needOpp: false,
  needBreak: false,
  bodyZone: false,
  maxZones: 15,
  maxAge: 300,

  firstTouch: true,
  needCandle: true,
  useRejection: false,
  wickPct: 25,
  useRetestVol: false,
  retestVolMax: 1.0,
  useTrend: false,
  emaLen: 100,
  allowLong: true,
  allowShort: true,

  slBuf: 0.2,
  rrTarget: 1.5,
  useBE: true,
  beAtR: 1.0,
  maxBars: 60,
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
  // 默认遵循 TradingView 语义：脚本给了 qty 就按它定仓位
  useScriptPositionSize: true,
  checkLiquidation: true,
  // fib / supertrend 原版均未设置 slippage，默认不模拟
  slippageTicks: 0,
  strategy: 'fib-trend',
  supertrend: {
    atrPeriod: 10,
    multiplier: 3.0,
    // false = RMA，与 KivancOzbilgic 原版 changeATR=true 的默认行为一致
    useSmaAtr: false,
    source: 'hl2',
  },
  orderBlock: DEFAULT_ORDER_BLOCK,
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
  | 'ScriptClose'  // Pine 脚本主动平仓（strategy.close / close_all）
  | 'Liquidation'  // 强平
  | 'TimeStop'     // 时间止损（持仓超过 N 根 K 线，市价平仓）
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
  /**
   * 该笔交易全部平仓后的账户余额（= 初始资金 + 截至该笔为止的累计净盈亏）。
   *
   * 注意这是「已实现」口径：同时持有多笔子订单（金字塔加仓）时，
   * 其他未平仓部分的浮盈浮亏不计入。
   */
  balanceAfter: number
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
    /** 订单块策略：该信号对应的区域止损价（仅 order-block 策略有值） */
    obStopLoss?: number
    /** 订单块策略：该信号对应的目标止盈价（仅 order-block 策略有值） */
    obTakeProfit?: number
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
  /**
   * Pine 脚本回测时附带的执行产物（未使用 pine 策略时为 undefined）。
   *
   * 注：改用 PineTS 后不再产出「编译出的 TypeScript 源码」这一中间产物
   * （`ts` 字段已移除）；诊断来自 PineTS 的转译/运行期错误，告警来自其运行期。
   */
  pine?: {
    /** 原始 Pine 源码 */
    source: string
    /** 执行诊断（语法 / 版本 / 运行期错误） */
    diagnostics: PineDiagnostic[]
    /** 脚本元信息（声明、input、plot 标题） */
    meta: PineCompileMeta
    /** PineTS 运行期告警 */
    warnings: string[]
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

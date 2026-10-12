/**
 * Pine Script → TypeScript 代码生成器。
 *
 * 输入：`Program` AST；输出：可被 Node 内置类型擦除（`mode: 'strip'`）执行、
 * 且零 `import`（只依赖注入的 `__pine` 运行时）的 TS 源码 + `PineCompileMeta`。
 *
 * 顶层声明的三类处理（方案 §5.3）：
 *   A. `ta.*` 预计算 —— 初始化时算整条数组，读 `__a_x[index]`、`[k]` 走 `__pine.at`
 *   B. 常量配置   —— `input.*` / 纯字符串常量 / `type` / `strategy()` 声明，初始化时求值一次
 *   C. 其余非 var —— 放进 `step(index, ctx)` 内按源码顺序逐 bar 求值
 *
 * `var` 状态：`let` 声明在 `step` 外，初始化一次；`:=` 重新赋值。
 */

import type { PineCompileMeta, PineDiagnostic } from '../../../shared/types'
import type {
  AssignStmt,
  CallArg,
  CallExpr,
  Expr,
  ForInStmt,
  ForStmt,
  FuncDeclStmt,
  IfExpr,
  IfStmt,
  IndexExpr,
  MemberExpr,
  Program,
  Stmt,
  TupleAssignStmt,
  TypeDeclStmt,
  WhileStmt,
} from './ast'

/* ------------------------------------------------------------------ */
/* 常量表                                                              */
/* ------------------------------------------------------------------ */

const BUILTIN_SERIES = new Set([
  'open', 'high', 'low', 'close', 'volume', 'time', 'hl2', 'hlc3', 'ohlc4',
  // v4 遗留：以开盘时间近似收盘 / 交易日时间
  'time_close', 'time_tradingday',
])
/** 结果随 bar 演进的命名空间（不可在初始化阶段求值） */
const BAR_VARYING_ROOTS = new Set([
  'ta', 'session', 'syminfo', 'strategy', 'barstate', 'timeframe', 'request', 'chart', 'ticker',
  'timeframe', 'dayofweek', 'currency', 'time',
])
/** 允许在初始化阶段求值的调用根（要求所有实参也是初始化期可求值） */
const CONST_CALL_ROOTS = new Set(['input', 'color', 'math', 'str', 'format', 'size', 'display', 'timestamp'])

/** 编译期常量成员（`size.tiny`、`plot.style_linebr`、`strategy.long`…） */
const CONST_MEMBERS: Record<string, string> = {}
function addMembers(prefix: string, names: string[]): void {
  for (const n of names) CONST_MEMBERS[`${prefix}.${n}`] = `'${n}'`
}
addMembers('size', ['auto', 'tiny', 'small', 'normal', 'large', 'huge'])
addMembers('location', ['abovebar', 'belowbar', 'top', 'bottom', 'absolute'])
addMembers('shape', [
  'xcross', 'cross', 'triangleup', 'triangledown', 'flag', 'circle', 'arrowup', 'arrowdown',
  'labelup', 'labeldown', 'square', 'diamond',
])
addMembers('plot', [
  'style_line', 'style_linebr', 'style_stepline', 'style_stepline_diamond', 'style_area',
  'style_areabr', 'style_columns', 'style_circles', 'style_cross', 'style_histogram',
])
addMembers('label', [
  'style_none', 'style_label_center', 'style_label_left', 'style_label_right', 'style_label_upper_left',
  'style_label_upper_right', 'style_label_lower_left', 'style_label_lower_right', 'style_label_up',
  'style_label_down', 'style_circle', 'style_square', 'style_diamond', 'style_triangleup',
  'style_triangledown', 'style_xcross', 'style_cross', 'style_arrowup', 'style_arrowdown',
  'style_flag',
])
addMembers('text', ['align_left', 'align_center', 'align_right', 'align_top', 'align_bottom'])
addMembers('display', ['none', 'all', 'pane', 'data_window', 'price_scale', 'status_line'])
/** v4 的 `type=input.float` 等类型枚举（作为值出现在具名实参里） */
addMembers('input', ['float', 'int', 'bool', 'string', 'color', 'source', 'time', 'symbol', 'price', 'session'])
addMembers('extend', ['none', 'left', 'right', 'both'])
addMembers('xloc', ['bar_index', 'bar_time'])
addMembers('yloc', ['price', 'abovebar', 'belowbar'])
addMembers('barmerge', ['gaps_on', 'gaps_off', 'lookahead_on', 'lookahead_off'])
CONST_MEMBERS['strategy.long'] = "'long'"
CONST_MEMBERS['strategy.short'] = "'short'"
CONST_MEMBERS['strategy.percent_of_equity'] = "'percent_of_equity'"
CONST_MEMBERS['strategy.cash'] = "'cash'"
CONST_MEMBERS['strategy.fixed'] = "'fixed'"
CONST_MEMBERS['strategy.commission.percent'] = "'percent'"
CONST_MEMBERS['strategy.commission.cash_per_contract'] = "'cash_per_contract'"
CONST_MEMBERS['strategy.commission.cash_per_order'] = "'cash_per_order'"
CONST_MEMBERS['strategy.direction.long'] = "'long'"
CONST_MEMBERS['strategy.direction.short'] = "'short'"
CONST_MEMBERS['strategy.direction.all'] = "'all'"
CONST_MEMBERS['strategy.oca.none'] = "'none'"
CONST_MEMBERS['strategy.oca.cancel'] = "'cancel'"
CONST_MEMBERS['strategy.oca.reduce'] = "'reduce'"
CONST_MEMBERS['math.pi'] = 'Math.PI'
CONST_MEMBERS['math.e'] = 'Math.E'
CONST_MEMBERS['format.mintick'] = '__pine.format.mintick'
CONST_MEMBERS['format.price'] = '__pine.format.price'
CONST_MEMBERS['format.percent'] = '__pine.format.percent'
CONST_MEMBERS['format.volume'] = '__pine.format.volume'
CONST_MEMBERS['chart.fg_color'] = '__pine.chart.fg_color'
CONST_MEMBERS['chart.bg_color'] = '__pine.chart.bg_color'
// v6 常用枚举：面板位置 / 排序方向 / 货币 / 缩放 / 字体 / 线型
addMembers('position', [
  'top_left', 'top_center', 'top_right',
  'middle_left', 'middle_center', 'middle_right',
  'bottom_left', 'bottom_center', 'bottom_right',
])
addMembers('text', ['align_left', 'align_center', 'align_right', 'align_top', 'align_bottom', 'wrap', 'nowrap'])
addMembers('order', ['ascending', 'descending'])
addMembers('scale', ['right', 'left', 'none'])
addMembers('font', ['family_default', 'family_monospace'])
addMembers('currency', ['USD', 'EUR', 'GBP', 'JPY', 'USDT', 'AUD', 'CAD', 'CHF', 'NZD'])
addMembers('hline', ['style_solid', 'style_dashed', 'style_dotted'])
addMembers('line', [
  'style_solid', 'style_dashed', 'style_dotted',
  'style_arrow_left', 'style_arrow_right', 'style_arrow_both',
])
addMembers('plot', ['style_linebr', 'style_steplinebr', 'style_area'])
addMembers('table', [
  'position_top_left', 'position_top_center', 'position_top_right',
  'position_middle_left', 'position_middle_center', 'position_middle_right',
  'position_bottom_left', 'position_bottom_center', 'position_bottom_right',
])

/** `strategy.position_size` 等随 bar 演进的成员 → 每 bar 由 step 写入的 __ctx 取值 */
const CTX_MEMBERS: Record<string, string> = {
  'strategy.position_size': '__ctx.positionSize',
  'strategy.position_avg_price': '__ctx.avgPrice',
  'strategy.opentrades': '(__ctx.positionSize === 0 ? 0 : 1)',
  // 回测引擎不向脚本暴露的账户量：按 na 降级（编译期给出警告，已记入文档）
  'strategy.equity': 'NaN',
  'strategy.initial_capital': 'NaN',
  'strategy.netprofit': 'NaN',
  'strategy.grossprofit': 'NaN',
  'strategy.grossloss': 'NaN',
  'strategy.openprofit': 'NaN',
  'strategy.max_drawdown': 'NaN',
  'strategy.closedtrades': 'NaN',
  'strategy.wintrades': 'NaN',
  'strategy.losstrades': 'NaN',
  'strategy.eventrades': 'NaN',
}

/** 成员名 → 合法的变量名片段（`strategy.position_size` → `strategy_position_size`） */
function memberRingName(path: string): string {
  return path.replace(/[^\w]/g, '_')
}

/** 函数局部序列：模块级提升名与环形缓冲名 */
function fnLocalName(fnName: string, local: string): string {
  return `__fl_${fnName}_${local}`
}

function fnLocalRing(fnName: string, local: string): string {
  return `__hf_${fnName}_${local}`
}

/** 已知命名空间根（用于把「无法映射的成员」报成诊断，而不是静默生成错误代码） */
const NAMESPACE_ROOTS = new Set([
  'ta', 'math', 'str', 'session', 'input', 'strategy', 'syminfo', 'color', 'size', 'location',
  'shape', 'plot', 'label', 'box', 'array', 'matrix', 'map', 'table', 'chart', 'text', 'format',
  'request', 'line', 'polyline', 'linefill', 'timeframe', 'currency', 'dayofweek', 'display',
  'alert', 'barstate', 'runtime', 'log', 'ticker', 'time',
])

/** `input.*` 的形参顺序（用于把位置实参与具名实参统一成一份映射） */
const INPUT_PARAMS = ['defval', 'title', 'minval', 'maxval', 'step', 'tooltip', 'inline', 'group', 'display', 'confirm']
/** v4 裸 `input(defval, title, type, minval, maxval, step, options, …)`：type 在第 3 位 */
const INPUT_PARAMS_V4 = ['defval', 'title', 'type', 'minval', 'maxval', 'step', 'options', 'tooltip', 'inline', 'group', 'display', 'confirm']
/** `plot` 的形参顺序 */
const PLOT_PARAMS = ['series', 'title', 'color', 'offset', 'style', 'linewidth', 'trackprice', 'histbase', 'join', 'editable', 'show_last', 'display', 'format', 'precision', 'force_overlay']
/** `plotshape` 的形参顺序 */
const PLOTSHAPE_PARAMS = ['series', 'title', 'style', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size', 'show_last', 'display', 'format', 'precision', 'force_overlay']
/** `barcolor` 的形参顺序 */
const BARCOLOR_PARAMS = ['color', 'offset', 'editable', 'show_last', 'title', 'display', 'force_overlay']
/** `alertcondition` 的形参顺序 */
const ALERT_PARAMS = ['condition', 'title', 'message']
/** `plotcandle` / `plotbar` 的形参顺序（title 在第 5 位） */
const PLOTOHLC_PARAMS = [
  'open', 'high', 'low', 'close', 'title', 'color', 'wickcolor', 'bordercolor',
  'editable', 'show_last', 'display', 'format', 'precision', 'force_overlay',
]
/** `plotchar` / `plotarrow` 的形参顺序（title 在第 2 位） */
const PLOTCHAR_PARAMS = [
  'series', 'title', 'char', 'location', 'color', 'offset', 'text', 'textcolor',
  'editable', 'size', 'show_last', 'display', 'format', 'precision', 'force_overlay',
]

/** 类型转换函数（既是类型名也是函数名） */
const CAST_FNS = new Set(['float', 'int', 'bool', 'string', 'color'])
/** 绘图命名空间：执行但不出图 */
const DRAWING_NS = new Set(['box', 'label', 'line', 'table', 'polyline', 'linefill'])
/**
 * 方法式数组调用的识别集合（`arr.get(i)` —— Pine 无此写法，保留兼容旧产物）。
 * 命名空间式 `array.get(arr, i)` 在 call() 里已被更早拦截，不会走到这里。
 */
const ARRAY_METHODS = new Set([
  'size', 'get', 'set', 'push', 'pop', 'shift', 'unshift', 'remove', 'clear',
  'includes', 'indexof', 'lastindexof', 'reverse', 'slice', 'concat', 'sum', 'avg', 'min', 'max',
])
/** v4/v5 遗留的数组构造器 → v6 的 array.new */
const LEGACY_ARRAY_CTORS: Record<string, string> = {
  new_float: 'new',
  new_int: 'new',
  new_bool: 'new',
  new_string: 'new',
  new_color: 'new',
  new_label: 'new',
  new_line: 'new',
  new_box: 'new',
  new_table: 'new',
  new_polyline: 'new',
  new_linefill: 'new',
}

/* ------------------------------------------------------------------ */
/* v4 兼容层（裸内置函数 / 元组型 ta 函数 / 逐 bar 序列跟踪）              */
/* ------------------------------------------------------------------ */

/**
 * v4 的 `ta.*` 系列函数（无命名空间前缀），运行时同名实现可直接复用。
 * 仅收录运行时确实提供实现的函数 —— 其余裸名仍旧按「无法映射的标识符」报诊断，
 * 避免生成必然在运行期崩掉的代码。
 */
const V4_TA_FUNCS = new Set([
  'sma', 'ema', 'rma', 'wma', 'hma', 'alma', 'atr', 'tr', 'highest', 'lowest',
  'pivothigh', 'pivotlow', 'crossover', 'crossunder', 'cross',
  'change', 'mom', 'roc', 'stdev', 'variance', 'dev', 'rsi',
  'rising', 'falling', 'stoch', 'linreg', 'barssince', 'valuewhen', 'sar',
])
/** 返回「与输入等长数组」的 ta 函数（可作为 A 类预计算；其余如 macd 返回元组） */
const TA_SERIES_FNS = new Set([
  'sma', 'ema', 'rma', 'wma', 'hma', 'alma', 'atr', 'tr', 'highest', 'lowest',
  'pivothigh', 'pivotlow', 'change', 'mom', 'roc', 'stdev', 'variance', 'dev', 'rsi',
  'rising', 'falling', 'stoch', 'linreg', 'barssince', 'valuewhen', 'sar',
])
/** 源序列固定为内置 OHLC(V) 的 ta 函数（实参里不含序列） */
const TA_OHLC_FNS = new Set(['dmi', 'mfi'])
/** 返回元组的 ta 函数 → 元素个数（`[a, b, c] = macd(...)` 的解构） */
const TA_TUPLE_FNS: Record<string, number> = { macd: 3, supertrend: 2, dmi: 3 }
/** v4 裸名 → `math.*`（运行时 mathNs 已实现的子集） */
const V4_MATH_FUNCS = new Set([
  'abs', 'max', 'min', 'round', 'floor', 'ceil', 'pow', 'sqrt', 'sign',
  'log', 'log10', 'exp', 'avg', 'sum', 'todegrees', 'toradians',
])
/** v4 裸名 → `str.*` */
const V4_STR_FUNCS = new Set(['tostring', 'tonumber', 'toint', 'tochar'])
/** 交叉函数（v4 裸名与 v6 `ta.*` 共用一条通路） */
const CROSS_FUNCS = new Set(['crossover', 'crossunder', 'cross'])
/** 支持「首参为序列 + 当前 bar 下标」变体（`smaAt` / `emaAt` …）的 ta 函数 */
const SERIES_AT_FNS = new Set([
  'sma', 'ema', 'rma', 'wma', 'hma', 'alma', 'highest', 'lowest',
  'change', 'mom', 'roc', 'stdev', 'variance', 'dev', 'rsi',
  'rising', 'falling', 'linreg', 'barssince',
])
/** v3/v4 的裸颜色常量（`plot(x, color=lime)`） */
const BARE_COLORS = new Set([
  'red', 'green', 'blue', 'white', 'black', 'gray', 'grey', 'yellow', 'orange',
  'purple', 'lime', 'aqua', 'fuchsia', 'maroon', 'navy', 'olive', 'silver', 'teal',
])
/** 运行时确实提供的 input 通道 */
const RUNTIME_INPUT_TYPES = new Set(['int', 'float', 'bool', 'color', 'string', 'source', 'time'])

/** `dayofweek.monday` … `dayofweek.sunday`（枚举值 = 2..7 / 1） */
const DAYOFWEEK_MEMBERS: Record<string, number> = {
  sunday: 1, monday: 2, tuesday: 3, wednesday: 4, thursday: 5, friday: 6, saturday: 7,
}

/** 时间分量调用（`year(time)` / `month(time)` / `hour(time)` …，缺省用当前 bar 时间） */
const TIME_PART_FNS = new Set(['year', 'month', 'dayofmonth', 'hour', 'minute', 'second', 'weekofyear'])

/** `text.format_*` 等绘图枚举（回测不消费，按 0 占位） */
function isTextEnumMember(path: string): boolean {
  return path.startsWith('text.format_') || path.startsWith('text.style_')
}

/** JS 保留字：Pine 里允许当变量名（如 v3 的 `var = input(close)`），生成物里必须改名 */
const JS_RESERVED = new Set([
  'var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'break', 'continue', 'new', 'delete', 'in', 'instanceof', 'typeof', 'void', 'this',
  'class', 'extends', 'super', 'import', 'export', 'default', 'try', 'catch', 'finally',
  'throw', 'yield', 'await', 'enum', 'with', 'debugger', 'null', 'true', 'false',
  'arguments', 'eval',
])

export interface CodegenOptions {
  /** 源码文件名，仅用于生成物头部的注释 */
  sourceName?: string
}

export interface CodegenResult {
  ts: string
  meta: PineCompileMeta
  diagnostics: PineDiagnostic[]
}

export function generate(program: Program, opts: CodegenOptions = {}): CodegenResult {
  return new Codegen(program, opts).run()
}

/* ------------------------------------------------------------------ */

class Codegen {
  private readonly program: Program
  private readonly sourceName: string
  private readonly diags: PineDiagnostic[] = []

  /** A 类：`ta.*` 预计算数组（名字 → 调用表达式） */
  private readonly precalc = new Map<string, CallExpr>()
  /** A 类预计算的「归属语句」——同名多次赋值时只有注册它的那条语句产出声明 */
  private readonly precalcOwner = new Map<string, Stmt>()
  /** B 类：初始化期求值的常量 */
  private readonly createConsts = new Set<string>()
  /** C 类：`step` 内逐 bar 求值的顶层标量 */
  private readonly stepScalars = new Set<string>()
  /** `var` 声明的状态变量 */
  private readonly vars = new Set<string>()
  /** 出现过 `:=` 重赋值的名字（用于把「字面量但会变」的顶层变量降级为 C 类） */
  private readonly reassigned = new Set<string>()
  /** `type` 声明名 */
  private readonly typeNames = new Set<string>()
  /** 用户函数 */
  private readonly userFuncs = new Map<string, FuncDeclStmt>()
  /** 需要环形缓冲的 C 类标量（名字 → 最大引用深度） */
  private readonly histNeed = new Map<string, number>()
  /** 被 `[k]` 引用的 ctx 成员路径（`strategy.position_size` → 最大深度） */
  private readonly memberHist = new Map<string, number>()
  /** `strategy.entry` 的 id → `strategy.exit` 的 stop/limit 表达式 */
  private readonly exitMap = new Map<string, { stop?: Expr; limit?: Expr }>()
  /** 顶层元组解构（`[a, b, c] = macd(...)`）：整体作为 A 类预计算元组 */
  private readonly precalcTuples: { names: string[]; call: CallExpr }[] = []
  /** 预计算元组的元素名（按单条数组引用） */
  private readonly precalcTupleNames = new Set<string>()
  /** 需要逐 bar 序列跟踪的顶层标量（`__s_<name>` 数组，供 ta `*At` 变体使用） */
  private readonly serTrack = new Set<string>()
  /** 用户函数中「被 [k] 引用的形参」→ 隐藏历史参数（调用点透传序列容器） */
  private readonly fnHistParams = new Map<string, string[]>()
  /** 用户函数中「被 [k] 引用的局部变量」：函数名 → (局部名 → 最大引用深度) */
  private readonly fnLocalSeries = new Map<string, Map<string, number>>()
  /** 正在生成函数体时的形参历史引用上下文 */
  private histParamsInFn: Set<string> | null = null
  /** 正在生成函数体时的函数局部序列上下文（局部名 → 提升名 + 环形缓冲名） */
  private fnLocalCtx: Map<string, { name: string; ring: string }> | null = null
  /** 脚本是否引用裸 `tr` / `ta.tr`（需要预计算 __a_tr） */
  private wantsTr = false
  /** 正在做初始化期代码生成（此时 ta 调用按整条数组求值，不生成 *At） */
  private initPhase = false
  /** 已发出过的警告（去重） */
  private readonly warned = new Set<string>()

  private readonly meta: PineCompileMeta

  /** indicator 模式下是否已经捕获过止损 / 止盈 plot */
  private indSlCaptured = false
  private indTpCaptured = false
  /** 正在处理的顶层赋值名（供 `input.*` 推断可覆盖的输入项名） */
  private currentAssignName: string | undefined
  /** 块级作用域栈 —— 记录 if/for/函数体内声明的局部变量名 */
  private readonly localScopes: Set<string>[] = []
  /** 元组解构的临时变量序号（保证同一块内多次解构不重名） */
  private tupleSeq = 0

  constructor(program: Program, opts: CodegenOptions) {
    this.program = program
    this.sourceName = opts.sourceName ?? 'pine'
    this.meta = {
      kind: program.kind === 'strategy' ? 'strategy' : 'indicator',
      config: {},
      inputs: [],
      plotTitles: [],
      alerts: [],
    }
  }

  /* ---------------------------------------------------------------- */
  /* 块级作用域                                                        */
  /* ---------------------------------------------------------------- */

  private pushScope(names: readonly string[] = []): void {
    this.localScopes.push(new Set(names))
  }

  private popScope(): void {
    this.localScopes.pop()
  }

  /** 在当前块作用域内声明一个局部变量 */
  private declareLocal(name: string): void {
    const top = this.localScopes[this.localScopes.length - 1]
    if (top) top.add(name)
  }

  /** 局部变量名是否已在某个外层块作用域内声明 */
  private isLocal(name: string): boolean {
    for (let i = this.localScopes.length - 1; i >= 0; i--) {
      if (this.localScopes[i].has(name)) return true
    }
    return false
  }

  run(): CodegenResult {
    this.collect()
    const lines: string[] = []
    lines.push('// ===== 由 Pine 编译器生成，请勿手工修改 =====')
    lines.push(`// 源: ${this.sourceName}`)
    lines.push('function __create(__pine) {')
    lines.push('  const C = __pine.candles')
    lines.push('  const n = C.length')
    lines.push('  let __index = 0')
    // 逐 bar 上下文（用户函数体内也要能读 strategy.*，故用模块级变量而非 step 形参）。
    // 初始值给一份「空仓」快照，保证初始化阶段求值 `strategy.*` 常量不会抛错。
    lines.push(
      '  let __ctx = { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: NaN, side: null }',
    )
    // 环形缓冲（历史引用）
    for (const [name, k] of this.histNeed) {
      lines.push(`  const __h_${name} = __pine.makeRing(${k + 1})`)
    }
    // ctx 成员的历史引用（`strategy.position_size[1]` 等）
    for (const [path, k] of this.memberHist) {
      lines.push(`  const __hm_${memberRingName(path)} = __pine.makeRing(${k + 1})`)
    }
    // v4 裸 `tr`：按内置 OHLC 预计算整条真实波幅序列
    if (this.wantsTr) {
      lines.push('  const __a_tr = __pine.ta.trueRange(C.high, C.low, C.close)')
    }
    // 顶层逐 bar 标量：声明在 __create 作用域（与 step、用户函数同级）。
    // Pine 的顶层变量本就是全局的 —— 用户函数会读到它们，若只声明在 step 内会 ReferenceError。
    for (const name of this.stepScalars) {
      lines.push(`  let ${this.jsVar(name)} = NaN`)
    }
    // 逐 bar 序列跟踪数组：让「派生序列」（如 sma(source) 中的 source）能作为
    // 整条序列喂给 ta 的 *At 变体，而不是退化成标量。
    for (const name of this.serTrack) {
      lines.push(`  const __s_${name} = []`)
    }
    // 函数局部序列：提升为模块级状态（`__fl_<fn>_<name>`）并配环形缓冲
    for (const [fnName, locals] of this.fnLocalSeries) {
      for (const [local, k] of locals) {
        lines.push(`  let ${fnLocalName(fnName, local)} = NaN`)
        lines.push(`  const ${fnLocalRing(fnName, local)} = __pine.makeRing(${k + 1})`)
      }
    }
    // 初始化期声明（保持源码顺序，保证「先声明后引用」）
    this.initPhase = true
    try {
      for (const stmt of this.program.body) {
        for (const l of this.emitInitStmt(stmt)) lines.push(`  ${l}`)
      }
    } finally {
      this.initPhase = false
    }
    // 元信息与图元容器
    lines.push(`  const meta = ${JSON.stringify(this.meta)}`)
    lines.push('  const plots = {}')
    lines.push('  const markers = []')
    lines.push('  const barColor = []')
    lines.push('')
    lines.push('  function step(index, ctx) {')
    lines.push('    __index = index')
    for (const l of this.stepPrologue()) lines.push(`    ${l}`)
    for (const stmt of this.program.body) {
      for (const l of this.emitStepStmt(stmt)) lines.push(`    ${l}`)
    }
    for (const l of this.stepEpilogue()) lines.push(`    ${l}`)
    lines.push('  }')
    lines.push('')
    lines.push('  return { step, meta, plots, markers, barColor }')
    lines.push('}')
    lines.push('globalThis.__pineProgram = { create: __create }')
    return { ts: lines.join('\n') + '\n', meta: this.meta, diagnostics: this.diags }
  }

  /* ---------------------------------------------------------------- */
  /* 收集 / 分类                                                       */
  /* ---------------------------------------------------------------- */

  private collect(): void {
    for (const stmt of this.program.body) {
      if (stmt.kind === 'typeDecl') this.typeNames.add(stmt.name)
      else if (stmt.kind === 'funcDecl') this.userFuncs.set(stmt.name, stmt)
    }
    // 先收集所有 `:=` 目标，再按源码顺序分类（B 类集合在分类过程中逐步增长）
    this.collectReassigned(this.program.body)

    for (const stmt of this.program.body) {
      if (stmt.kind !== 'assign') continue
      const name = this.targetName(stmt)
      if (!name) continue
      if (stmt.isVar) {
        this.vars.add(name)
        continue
      }
      // `var` 状态的后续 `:=` 改写：不再重复分类（否则会同时声明 var 与逐 bar 标量）
      if (this.vars.has(name)) continue
      if (this.isTaPrecalc(stmt.value)) {
        this.precalc.set(name, stmt.value as CallExpr)
        this.precalcOwner.set(name, stmt)
        continue
      }
      if (!this.reassigned.has(name) && this.isCreateTime(stmt.value)) {
        this.createConsts.add(name)
        continue
      }
      this.stepScalars.add(name)
    }

    // 顶层元组解构：`[a, b, c] = macd(...)` 整体作为预计算元组；
    // 其余顶层元组解构的名字与普通顶层赋值同级（用户函数会读到 → 进入 stepScalars）。
    for (const stmt of this.program.body) {
      if (stmt.kind !== 'tupleAssign') continue
      const arity = this.tupleFnArity(stmt.value)
      if (arity !== null && arity === stmt.names.length && stmt.op === '=') {
        this.precalcTuples.push({ names: stmt.names, call: stmt.value as CallExpr })
        for (const n of stmt.names) this.precalcTupleNames.add(n)
        continue
      }
      for (const n of stmt.names) {
        if (n !== '_' && !this.vars.has(n)) this.stepScalars.add(n)
      }
    }

    // 顶层逐 bar 标量：仅对「会作为整条序列使用」的标量建立跟踪数组，
    // 使派生序列可作为整体喂给 ta 的 *At 变体（避免无谓的逐 bar 记录开销）
    this.collectSerTrack()

    // 用户函数形参的历史引用（`data[n]`）→ 调用点透传序列容器
    for (const [name, fn] of this.userFuncs) {
      const hist = this.scanHistParams(fn)
      if (hist.length) this.fnHistParams.set(name, hist)
    }
    // 用户函数局部变量的历史引用（`atr[1]`）→ 提升为模块级状态 + 环形缓冲
    for (const [name, fn] of this.userFuncs) {
      const locals = this.scanFnLocalSeries(fn)
      if (locals.size) this.fnLocalSeries.set(name, locals)
    }
    this.wantsTr = this.detectTr()

    // 分类完成后再统计历史引用：此时才分得清 A 类数组 / var 状态 / C 类标量
    this.collectHistRefs(this.program.body)
    this.collectExits(this.program.body)
  }

  /** `[a, b, c] = ta.macd(...)` 这类元组型 ta 调用的元素个数；非元组调用返回 null */
  private tupleFnArity(e: Expr): number | null {
    if (e.kind !== 'call') return null
    const path = this.calleePath(e.callee)
    if (!path) return null
    const fn = path.length === 2 && path[0] === 'ta' ? path[1] : path.length === 1 ? path[0] : null
    if (!fn || TA_TUPLE_FNS[fn] === undefined) return null
    if (!e.args.every((a) => this.isPureTaArg(a.value))) return null
    return TA_TUPLE_FNS[fn]
  }

  /** 扫描函数体，找出被 `[k]` 历史引用的形参名 */
  private scanHistParams(fn: FuncDeclStmt): string[] {
    const params = new Set(fn.params.map((p) => p.name))
    const found = new Set<string>()
    this.walkExprs(fn.body, (e) => {
      if (e.kind === 'index' && e.object.kind === 'ident' && params.has(e.object.name)) {
        found.add(e.object.name)
      }
    })
    return [...found]
  }

  /**
   * 扫描函数体，找出「在函数内被赋值、又被 `[k]` 引用」的局部变量 →
   * 这些需要提升为模块级状态并配环形缓冲（Pine 的函数局部同样是序列）。
   */
  private scanFnLocalSeries(fn: FuncDeclStmt): Map<string, number> {
    const params = new Set(fn.params.map((p) => p.name))
    const assigned = new Set<string>()
    this.walkExprs(
      fn.body,
      () => {},
      (s) => {
        if (s.kind === 'assign' && s.target.kind === 'ident' && !params.has(s.target.name)) {
          assigned.add(s.target.name)
        }
        if (s.kind === 'tupleAssign' && s.op === '=') {
          for (const n of s.names) if (!params.has(n)) assigned.add(n)
        }
      },
    )
    const out = new Map<string, number>()
    this.walkExprs(fn.body, (e) => {
      if (e.kind === 'index' && e.object.kind === 'ident' && assigned.has(e.object.name)) {
        const k = e.index.kind === 'number' ? e.index.value : 1
        out.set(e.object.name, Math.max(out.get(e.object.name) ?? 0, k))
      }
    })
    return out
  }

  /**
   * 收集需要逐 bar 记录序列的顶层标量：
   * 出现在 ta `*At` 变体 / 交叉族 / 带历史形参的用户函数实参位置上的顶层标量。
   */
  private collectSerTrack(): void {
    const atFns = new Set([...SERIES_AT_FNS, ...CROSS_FUNCS, 'atr', 'tr', 'pivothigh', 'pivotlow'])
    this.walkExprs(this.program.body, (e) => {
      if (e.kind !== 'call') return
      const path = this.calleePath(e.callee)
      if (!path) return
      const fn = path.length === 2 && path[0] === 'ta' ? path[1] : path.length === 1 ? path[0] : null
      if (!fn) return
      if (!atFns.has(fn) && !this.userFuncs.has(fn)) return
      for (const a of e.args) {
        const name = this.seriesRefName(a.value)
        if (name) this.serTrack.add(name)
      }
    })
  }

  /** 该表达式是否为「只能靠逐 bar 跟踪数组整体引用」的顶层标量（或其 `[k]` 形式） */
  private seriesRefName(e: Expr): string | null {
    if (e.kind === 'ident') {
      const n = e.name
      if (BUILTIN_SERIES.has(n) || this.precalc.has(n) || this.precalcTupleNames.has(n)) return null
      return this.stepScalars.has(n) ? n : null
    }
    if (e.kind === 'index' && e.object.kind === 'ident') return this.seriesRefName(e.object)
    return null
  }

  /** 脚本里是否引用了裸 `tr` / `ta.tr`（且没有被同名变量遮蔽） */
  private detectTr(): boolean {
    if (
      this.stepScalars.has('tr') || this.precalc.has('tr') ||
      this.createConsts.has('tr') || this.vars.has('tr')
    ) {
      return false
    }
    let used = false
    this.walkExprs(this.program.body, (e) => {
      if (used) return
      if (e.kind === 'ident' && e.name === 'tr') used = true
      else if (e.kind === 'member' && this.dottedPath(e) === 'ta.tr') used = true
    })
    return used
  }

  /** 递归遍历一组语句中的所有表达式（含嵌套块、函数体与 if 表达式分支） */
  private walkExprs(
    stmts: Stmt[],
    visit: (e: Expr) => void,
    onStmt?: (s: Stmt) => void,
  ): void {
    const go = (e: Expr): void => {
      visit(e)
      switch (e.kind) {
        case 'call':
          go(e.callee)
          for (const a of e.args) go(a.value)
          return
        case 'member':
          go(e.object)
          return
        case 'index':
          go(e.object)
          go(e.index)
          return
        case 'unary':
          go(e.operand)
          return
        case 'binary':
          go(e.left)
          go(e.right)
          return
        case 'ternary':
          go(e.cond)
          go(e.then)
          go(e.else)
          return
        case 'array':
          for (const it of e.items) go(it)
          return
        case 'switch':
          go(e.subject)
          for (const a of e.arms) {
            if (a.cond) go(a.cond)
            go(a.value)
          }
          return
        case 'ifExpr':
          for (const br of e.branches) {
            go(br.cond)
            walk(br.body)
          }
          if (e.elseBody) walk(e.elseBody)
          return
        default:
          return
      }
    }
    const walk = (list: Stmt[]): void => {
      for (const s of list) {
        onStmt?.(s)
        switch (s.kind) {
          case 'assign':
            go(s.value)
            if (s.target.kind === 'member' || s.target.kind === 'index') go(s.target)
            break
          case 'tupleAssign':
            go(s.value)
            break
          case 'expr':
            go(s.expr)
            break
          case 'if':
            for (const br of s.branches) {
              go(br.cond)
              walk(br.body)
            }
            if (s.elseBody) walk(s.elseBody)
            break
          case 'for':
            go(s.from)
            go(s.to)
            walk(s.body)
            break
          case 'while':
            go(s.cond)
            walk(s.body)
            break
          case 'forIn':
            go(s.iterable)
            walk(s.body)
            break
          case 'funcDecl':
            walk(s.body)
            break
          default:
            break
        }
      }
    }
    walk(stmts)
  }

  /** 收集所有 `:=` 目标（须先于分类执行；含嵌套块与 if 表达式分支内的赋值） */
  private collectReassigned(stmts: Stmt[]): void {
    this.walkExprs(
      stmts,
      () => {},
      (s) => {
        if (s.kind === 'assign' && s.op === ':=' && s.target.kind === 'ident') {
          this.reassigned.add(s.target.name)
        }
      },
    )
  }

  /** 记录历史引用深度：C 类标量（环形缓冲）与 ctx 成员（成员环形缓冲） */
  private collectHistRefs(stmts: Stmt[]): void {
    this.walkExprs(stmts, (e) => {
      if (e.kind !== 'index') return
      const k = e.index.kind === 'number' ? e.index.value : 1
      if (e.object.kind === 'ident') {
        const name = e.object.name
        if (
          !BUILTIN_SERIES.has(name) &&
          !this.precalc.has(name) &&
          !this.precalcTupleNames.has(name) &&
          !(name === 'tr' && this.wantsTr) &&
          this.typeNames.has(name) === false
        ) {
          this.histNeed.set(name, Math.max(this.histNeed.get(name) ?? 0, k))
        }
      } else if (e.object.kind === 'member') {
        // `strategy.position_size[1]` / `strategy.opentrades[k]`：成员环形缓冲
        const path = this.dottedPath(e.object)
        if (path && (path in CTX_MEMBERS || path.startsWith('strategy.'))) {
          this.memberHist.set(path, Math.max(this.memberHist.get(path) ?? 0, k))
        }
      }
    })
  }

  /** `strategy.exit(..., from_entry="Long", stop=…, limit=…)` → entry id → 出场价 */
  private collectExits(stmts: Stmt[]): void {
    const visit = (list: Stmt[]): void => {
      for (const s of list) {
        if (s.kind === 'expr' && s.expr.kind === 'call') {
          const path = this.calleePath(s.expr.callee)
          if (path && path.join('.') === 'strategy.exit') {
            const m = this.normalizeArgs(s.expr, ['id', 'from_entry', 'qty', 'qty_percent', 'profit', 'limit', 'loss', 'stop', 'comment'])
            const fromEntry = m.get('from_entry')
            const id = fromEntry && fromEntry.kind === 'string' ? fromEntry.value : undefined
            if (id) this.exitMap.set(id, { stop: m.get('stop'), limit: m.get('limit') })
          }
        } else if (s.kind === 'if') {
          for (const br of s.branches) visit(br.body)
          if (s.elseBody) visit(s.elseBody)
        } else if (s.kind === 'for') visit(s.body)
        else if (s.kind === 'funcDecl') visit(s.body)
      }
    }
    visit(stmts)
  }

  /* ---------------------------------------------------------------- */
  /* 分类判定                                                          */
  /* ---------------------------------------------------------------- */

  private targetName(stmt: AssignStmt): string | null {
    return stmt.target.kind === 'ident' ? stmt.target.name : null
  }

  private isTaPrecalc(e: Expr): boolean {
    if (e.kind !== 'call') return false
    const path = this.calleePath(e.callee)
    if (!path) return false
    // v6 命名空间调用：`ta.sma(close, 20)`（保持既有行为，任何 ta.* 均按整数组预计算）
    if (path.length === 2 && path[0] === 'ta') return e.args.every((a) => this.isPureTaArg(a.value))
    // v4 裸名调用：仅限“返回等长数组”的 ta 函数
    if (path.length === 1 && TA_SERIES_FNS.has(path[0])) {
      return e.args.every((a) => this.isPureTaArg(a.value))
    }
    return false
  }

  private isPureTaArg(e: Expr): boolean {
    if (e.kind === 'ident') return BUILTIN_SERIES.has(e.name) || this.createConsts.has(e.name)
    if (e.kind === 'number' || e.kind === 'string' || e.kind === 'bool') return true
    return false
  }

  /** 表达式能否在初始化阶段（`step` 之外）求值 */
  private isCreateTime(e: Expr): boolean {
    switch (e.kind) {
      case 'number':
      case 'string':
      case 'color':
      case 'bool':
      case 'na':
        return true
      case 'ident':
        return this.createConsts.has(e.name)
      case 'member': {
        const path = this.dottedPath(e)
        if (!path) return false
        if (path in CONST_MEMBERS || path in CTX_MEMBERS) return path in CONST_MEMBERS
        if (path.startsWith('color.')) return true
        return false
      }
      case 'call': {
        const path = this.calleePath(e.callee)
        if (!path) return false
        if (BAR_VARYING_ROOTS.has(path[0])) return false
        if (!CONST_CALL_ROOTS.has(path[0])) return false
        return e.args.every((a) => this.isCreateTime(a.value))
      }
      case 'unary':
        return this.isCreateTime(e.operand)
      case 'binary':
        return this.isCreateTime(e.left) && this.isCreateTime(e.right)
      case 'ternary':
        return this.isCreateTime(e.cond) && this.isCreateTime(e.then) && this.isCreateTime(e.else)
      default:
        return false
    }
  }

  /* ---------------------------------------------------------------- */
  /* 初始化期（`step` 之外）                                            */
  /* ---------------------------------------------------------------- */

  private emitInitStmt(stmt: Stmt): string[] {
    switch (stmt.kind) {
      case 'assign': {
        const name = this.targetName(stmt)
        if (!name) return []
        if (stmt.isVar) {
          return [`let ${this.jsVar(name)} = ${this.expr(stmt.value)}`]
        }
        if (this.precalc.has(name)) {
          // 同名变量可能既有 `=` 初始化又有 `:=` 重赋值：只有注册归属的那条产出声明
          if (this.precalcOwner.get(name) !== stmt) return []
          return [`const __a_${name} = ${this.taCall(this.precalc.get(name)!)}`]
        }
        if (this.createConsts.has(name)) {
          this.currentAssignName = name
          const code = this.expr(stmt.value)
          this.currentAssignName = undefined
          // 后续还会被 `:=` 改写的话不能是 const（否则逐 bar 赋值会抛 TypeError）
          const kw = this.reassigned.has(name) ? 'let' : 'const'
          return [`${kw} ${this.jsVar(name)} = ${code}`]
        }
        return []
      }
      case 'tupleAssign': {
        // 预计算元组：`const [__a_a, __a_b, __a_c] = __pine.ta.macd(...)`
        const tuple = this.precalcTuples.find((t) => t.call === stmt.value)
        if (!tuple) return []
        const refs = stmt.names.map((n) => `__a_${n}`)
        return [`const [${refs.join(', ')}] = ${this.taCall(tuple.call)}`]
      }
      case 'typeDecl':
        return this.typeClass(stmt)
      case 'funcDecl':
        return this.userFunc(stmt)
      case 'expr': {
        // `strategy(...)` / `indicator(...)` 声明 —— 只解析元信息
        if (stmt.expr.kind === 'call') {
          const path = this.calleePath(stmt.expr.callee)
          if (path && (path[0] === 'strategy' || path[0] === 'indicator') && path.length === 1) {
            this.recordDeclaration(stmt.expr)
          }
        }
        return []
      }
      default:
        return []
    }
  }

  private typeClass(stmt: TypeDeclStmt): string[] {
    const fields = stmt.fields.map((f) => f.name)
    const out: string[] = []
    out.push(`class ${stmt.name} {`)
    out.push(`  constructor(${fields.join(', ')}) {`)
    for (const f of fields) out.push(`    this.${f} = ${f}`)
    out.push('  }')
    out.push('}')
    return out
  }

  private userFunc(stmt: FuncDeclStmt): string[] {
    const params = stmt.params.map((p) => this.jsVar(p.name))
    // 形参被 [k] 历史引用时追加隐藏参数（调用点透传整条序列容器）
    const hist = this.fnHistParams.get(stmt.name) ?? []
    const hidden = hist.map((p) => `__hr_${p}`)
    const body = stmt.body.slice()
    const last = body[body.length - 1]
    // 隐式返回值：最后一条表达式；或最后一条 `if` 语句（Pine 里它就是 if 表达式）
    const implicitReturn = last && last.kind === 'expr' ? last : null
    const implicitIf = !implicitReturn && last && last.kind === 'if' ? last : null
    const out: string[] = []
    out.push(`function ${stmt.name}(${[...params, ...hidden].join(', ')}) {`)
    this.pushScope([...params, ...hidden])
    const prevHist = this.histParamsInFn
    this.histParamsInFn = new Set(hist)
    const prevLocals = this.fnLocalCtx
    const localSeries = this.fnLocalSeries.get(stmt.name)
    this.fnLocalCtx = localSeries
      ? new Map(
          [...localSeries.keys()].map((n) => [
            n,
            { name: fnLocalName(stmt.name, n), ring: fnLocalRing(stmt.name, n) },
          ]),
        )
      : null
    for (const s of body) {
      if (s === implicitReturn || s === implicitIf) break
      for (const l of this.emitBlockStmt(s)) out.push(`  ${l}`)
    }
    if (implicitReturn) out.push(`  return ${this.expr(implicitReturn.expr)}`)
    if (implicitIf && implicitIf.kind === 'if') {
      const asExpr: IfExpr = {
        kind: 'ifExpr',
        branches: implicitIf.branches,
        elseBody: implicitIf.elseBody,
        line: implicitIf.line,
        col: implicitIf.col,
      }
      out.push(`  return ${this.ifExprCode(asExpr)}`)
    }
    this.fnLocalCtx = prevLocals
    this.histParamsInFn = prevHist
    this.popScope()
    out.push('}')
    return out
  }

  /** `strategy()/indicator()` 声明 → meta.config / plotTitles 之外的元信息 */
  private recordDeclaration(call: CallExpr): void {
    const config: Record<string, string | number | boolean> = {}
    call.args.forEach((a, i) => {
      const key = a.name ?? (i === 0 ? 'title' : `arg${i}`)
      const lit = this.literalOf(a.value)
      if (lit !== undefined) config[key] = lit
    })
    this.meta.config = config
  }

  private literalOf(e: Expr): string | number | boolean | undefined {
    switch (e.kind) {
      case 'number':
        return e.value
      case 'string':
        return e.value
      case 'bool':
        return e.value
      case 'color':
        return e.value
      case 'member': {
        const path = this.dottedPath(e)
        if (path && path in CONST_MEMBERS) {
          const v = CONST_MEMBERS[path]
          return v.startsWith("'") ? v.slice(1, -1) : v
        }
        return undefined
      }
      default:
        return undefined
    }
  }

  /* ---------------------------------------------------------------- */
  /* `step` 内                                                        */
  /* ---------------------------------------------------------------- */

  private stepPrologue(): string[] {
    const out: string[] = ['__ctx = ctx']
    // 历史序列在第 i 根 bar **开始时**推入当根值：
    //   ring[0] = 当前 bar，ring[k] = 前第 k 根；第 0 根时 `[1]` 自然为 na（无上一根）。
    for (const path of this.memberHist.keys()) {
      out.push(`__pine.push(__hm_${memberRingName(path)}, ${this.memberValueOf(path)})`)
    }
    for (const name of this.histNeed.keys()) {
      if (this.vars.has(name)) out.push(`__pine.push(__h_${name}, ${this.jsVar(name)})`)
    }
    if (this.meta.kind === 'strategy') {
      out.push('let __entryDir = null')
      out.push('let __exitStop = NaN')
      out.push('let __exitLimit = NaN')
      out.push('let __forceClose = false')
    } else {
      out.push('let __ind_buy = NaN')
      out.push('let __ind_sell = NaN')
      out.push('let __ind_sl = NaN')
      out.push('let __ind_tp = NaN')
    }
    return out
  }

  private stepEpilogue(): string[] {
    const pushes: string[] = []
    if (this.meta.kind === 'strategy') {
      return [
        ...pushes,
        'const __obStop = __exitStop',
        'const __obTp = __exitLimit',
        'return {',
        '  imbaTrendLine: NaN,',
        '  tsotTrendValue: NaN,',
        '  canLong: __entryDir === \'long\',',
        '  canShort: __entryDir === \'short\',',
        '  atrLongStop: NaN,',
        '  atrShortStop: NaN,',
        '  obStopLoss: __obStop,',
        '  obTakeProfit: __obTp,',
        '  obRisk: Number.isFinite(__obStop) ? Math.abs(C.close[__index] - __obStop) : NaN,',
        '  forceClose: __forceClose,',
        '}',
      ]
    }
    return [
      ...pushes,
      'return {',
      '  imbaTrendLine: NaN,',
      '  tsotTrendValue: NaN,',
      '  canLong: !__pine.isNa(__ind_buy),',
      '  canShort: !__pine.isNa(__ind_sell),',
      '  atrLongStop: NaN,',
      '  atrShortStop: NaN,',
      '  obStopLoss: __ind_sl,',
      '  obTakeProfit: __ind_tp,',
      '  obRisk: (!__pine.isNa(__ind_sl) && !__pine.isNa(__ind_buy)) ? Math.abs(C.close[__index] - __ind_sl) : NaN,',
      '}',
    ]
  }

  /** 顶层语句在 `step` 内的落位（跳过已在初始化期处理的声明） */
  private emitStepStmt(stmt: Stmt): string[] {
    switch (stmt.kind) {
      case 'assign': {
        const name = this.targetName(stmt)
        if (name) {
          if (stmt.op === '=') {
            if (this.vars.has(name) || this.createConsts.has(name) || this.precalc.has(name)) return []
          } else if (this.createConsts.has(name) || this.precalc.has(name)) {
            return []
          }
        }
        return this.emitBlockStmt(stmt)
      }
      case 'expr': {
        if (stmt.expr.kind === 'call') {
          const path = this.calleePath(stmt.expr.callee)
          if (path && path.length === 1 && (path[0] === 'strategy' || path[0] === 'indicator')) return []
        }
        return this.emitBlockStmt(stmt)
      }
      case 'typeDecl':
      case 'funcDecl':
        return []
      default:
        return this.emitBlockStmt(stmt)
    }
  }

  /** 块内语句（含局部变量声明） */
  private emitBlockStmt(stmt: Stmt, depth = 0): string[] {
    const pad = '  '.repeat(depth)
    switch (stmt.kind) {
      case 'assign': {
        const code = this.assignCode(stmt)
        if (!code) return []
        return [`${pad}${code}`]
      }
      case 'expr': {
        const code = this.exprStatement(stmt.expr)
        if (!code) return []
        // 前置分号：表达式以 `(` / `[` 开头时，避免与上一行发生 ASI 粘连
        // （如 `let x = 3` 后跟 `(a + b)` 会被解析成 `3(a + b)`）
        return [`${pad};${code}`]
      }
      case 'if':
        return this.ifCode(stmt, depth)
      case 'for':
        return this.forCode(stmt, depth)
      case 'while':
        return this.whileCode(stmt, depth)
      case 'forIn':
        return this.forInCode(stmt, depth)
      case 'tupleAssign':
        return this.tupleAssignCode(stmt, depth)
      case 'break':
        return [`${pad}break`]
      case 'continue':
        return [`${pad}continue`]
      default:
        return []
    }
  }

  private assignCode(stmt: AssignStmt): string | null {
    const rhs = this.expr(stmt.value)
    if (stmt.target.kind === 'ident') {
      const name = stmt.target.name
      if (name === '_') return null
      // 函数局部序列（提升为模块级状态 + 环形缓冲）
      const hoisted = this.fnLocalCtx?.get(name)
      if (hoisted) {
        return `${hoisted.name} = ${rhs}; __pine.push(${hoisted.ring}, ${hoisted.name})`
      }
      const js = this.jsVar(name)
      const lines: string[] = []
      if (stmt.op === '=') {
        if (this.stepScalars.has(name)) {
          // 顶层逐 bar 标量已在 __create 作用域声明，这里只做赋值
          lines.push(`${js} = ${rhs}`)
        } else {
          lines.push(`let ${js} = ${rhs}`)
          this.declareLocal(name)
        }
      } else {
        lines.push(`${js} = ${rhs}`)
      }
      if (this.histNeed.has(name) && !this.vars.has(name)) {
        lines.push(`__pine.push(__h_${name}, ${js})`)
      }
      if (this.serTrack.has(name)) {
        lines.push(`__pine.serSet(__s_${name}, __index, ${js})`)
      }
      return lines.join('; ')
    }
    // 成员赋值：`z.used := true`
    return `${this.expr(stmt.target)} = ${rhs}`
  }

  /**
   * 元组解构：`[a, b] = f()` → 先取一次返回值再按位置落到各个名字。
   * `=` 形式按 Pine 语义就地引入新名字；顶层（depth 0）的名字与普通顶层赋值同级，
   * 已在 `__create` 作用域声明（用户函数可见），这里只做赋值 + 序列跟踪。
   * `:=` 形式写给已存在的名字。
   */
  private tupleAssignCode(stmt: TupleAssignStmt, depth: number): string[] {
    // 预计算元组（`[a, b, c] = macd(...)`）已在初始化期整体算好
    if (stmt.names.every((n) => this.precalcTupleNames.has(n))) return []
    const pad = '  '.repeat(depth)
    const tmp = `__tup${this.tupleSeq++}`
    const out: string[] = [`${pad}const ${tmp} = ${this.expr(stmt.value)}`]
    stmt.names.forEach((name, i) => {
      if (name === '_') return
      const hoistedLocal = this.fnLocalCtx?.get(name)
      if (hoistedLocal) {
        out.push(`${pad}${hoistedLocal.name} = ${tmp}[${i}]`)
        out.push(`${pad}__pine.push(${hoistedLocal.ring}, ${hoistedLocal.name})`)
        return
      }
      const js = this.jsVar(name)
      if (stmt.op !== '=') {
        out.push(`${pad}${js} = ${tmp}[${i}]`)
      } else if (depth === 0 && this.stepScalars.has(name)) {
        out.push(`${pad}${js} = ${tmp}[${i}]`)
      } else {
        out.push(`${pad}let ${js} = ${tmp}[${i}]`)
        this.declareLocal(name)
      }
      if (this.histNeed.has(name) && !this.vars.has(name)) {
        out.push(`${pad}__pine.push(__h_${name}, ${js})`)
      }
      if (this.serTrack.has(name)) {
        out.push(`${pad}__pine.serSet(__s_${name}, __index, ${js})`)
      }
    })
    return out
  }

  private ifCode(stmt: IfStmt, depth: number): string[] {
    const pad = '  '.repeat(depth)
    const out: string[] = []
    stmt.branches.forEach((br, i) => {
      const head = i === 0 ? 'if' : 'else if'
      out.push(`${pad}${head} (${this.expr(br.cond)}) {`)
      this.pushScope()
      for (const s of br.body) out.push(...this.emitBlockStmt(s, depth + 1))
      this.popScope()
      out.push(`${pad}}`)
    })
    if (stmt.elseBody) {
      // 上式结尾被改写为 `} else {`
      out[out.length - 1] = `${pad}} else {`
      this.pushScope()
      for (const s of stmt.elseBody) out.push(...this.emitBlockStmt(s, depth + 1))
      this.popScope()
      out.push(`${pad}}`)
    }
    return out
  }

  private forCode(stmt: ForStmt, depth: number): string[] {
    const pad = '  '.repeat(depth)
    const from = this.expr(stmt.from)
    const to = this.expr(stmt.to)
    const v = stmt.varName
    const out: string[] = []
    this.pushScope([v])
    out.push(`${pad}{`)
    out.push(`${pad}  const __from = ${from}`)
    out.push(`${pad}  const __to = ${to}`)
    out.push(`${pad}  if (__from <= __to) {`)
    out.push(`${pad}    for (let ${v} = __from; ${v} <= __to; ${v}++) {`)
    for (const s of stmt.body) out.push(...this.emitBlockStmt(s, depth + 3))
    out.push(`${pad}    }`)
    out.push(`${pad}  } else {`)
    out.push(`${pad}    for (let ${v} = __from; ${v} >= __to; ${v}--) {`)
    for (const s of stmt.body) out.push(...this.emitBlockStmt(s, depth + 3))
    out.push(`${pad}    }`)
    out.push(`${pad}  }`)
    out.push(`${pad}}`)
    this.popScope()
    return out
  }

  private whileCode(stmt: WhileStmt, depth: number): string[] {
    const pad = '  '.repeat(depth)
    const out: string[] = [`${pad}while (${this.expr(stmt.cond)}) {`]
    for (const s of stmt.body) out.push(...this.emitBlockStmt(s, depth + 1))
    out.push(`${pad}}`)
    return out
  }

  private forInCode(stmt: ForInStmt, depth: number): string[] {
    const pad = '  '.repeat(depth)
    const out: string[] = [`${pad}{`]
    this.pushScope([stmt.varName])
    // Pine 的数组在运行时就是 JS 数组，直接 of 遍历；map 遍历由运行时给出可迭代值
    out.push(`${pad}  for (const ${stmt.varName} of ${this.expr(stmt.iterable)}) {`)
    for (const s of stmt.body) out.push(...this.emitBlockStmt(s, depth + 2))
    out.push(`${pad}  }`)
    out.push(`${pad}}`)
    this.popScope()
    return out
  }

  /* ---------------------------------------------------------------- */
  /* 表达式语句                                                        */
  /* ---------------------------------------------------------------- */

  private exprStatement(e: Expr): string | null {
    if (e.kind !== 'call') return this.expr(e)

    // `na(x)` 被解析成 callee=NaLit
    if (e.callee.kind === 'na') return `${this.expr(e)}`

    const path = this.calleePath(e.callee)
    const name = path ? path.join('.') : ''

    if (name === 'alertcondition' || name === 'alert') {
      if (name === 'alertcondition') this.recordAlert(e)
      return null
    }
    if (name === 'bgcolor' || name === 'hline' || name === 'fill' || name === 'plotchar' || name === 'plotarrow') {
      return null
    }
    if (name === 'plot') return this.plotStatement(e)
    if (name === 'plotshape') return this.plotshapeStatement(e)
    if (name === 'barcolor') return this.barcolorStatement(e)
    if (name === 'strategy.entry') return this.entryStatement(e)
    if (name === 'strategy.exit') return this.exitStatement(e)
    if (name === 'strategy.close' || name === 'strategy.close_all') {
      return '__forceClose = true'
    }
    if (name === 'strategy.cancel' || name === 'strategy.cancel_all') return null

    return this.expr(e)
  }

  private recordAlert(call: CallExpr): void {
    const m = this.normalizeArgs(call, ALERT_PARAMS)
    const title = this.literalOf(m.get('title')!)
    const message = this.literalOf(m.get('message')!)
    this.meta.alerts.push({
      title: typeof title === 'string' ? title : '',
      message: typeof message === 'string' ? message : '',
    })
  }

  private plotStatement(call: CallExpr): string {
    const m = this.normalizeArgs(call, PLOT_PARAMS)
    const series = m.get('series') ?? { kind: 'na', line: 0, col: 0 }
    const titleExpr = m.get('title')
    const title = titleExpr && titleExpr.kind === 'string' ? titleExpr.value : `plot_${this.meta.plotTitles.length}`
    this.meta.plotTitles.push(title)
    const seriesCode = this.expr(series)
    const lines = [`__pine.plot(plots, ${seriesCode}, ${JSON.stringify(title)}, __index)`]

    // indicator 模式：第一个 title 命中 sl|stop / tp|target 的 plot 作为离场价
    if (this.meta.kind === 'indicator') {
      if (!this.indSlCaptured && /\b(sl|stop)\b/i.test(title)) {
        this.indSlCaptured = true
        lines.push(`__ind_sl = ${seriesCode}`)
      } else if (!this.indTpCaptured && /\b(tp|target)\b/i.test(title)) {
        this.indTpCaptured = true
        lines.push(`__ind_tp = ${seriesCode}`)
      }
    }
    return lines.join('; ')
  }

  private plotshapeStatement(call: CallExpr): string {
    const m = this.normalizeArgs(call, PLOTSHAPE_PARAMS)
    const series = m.get('series') ?? { kind: 'na', line: 0, col: 0 }
    const titleExpr = m.get('title')
    const title = titleExpr && titleExpr.kind === 'string' ? titleExpr.value : ''
    const locExpr = m.get('location')
    const loc = locExpr ? this.literalOf(locExpr) : 'abovebar'
    const location = typeof loc === 'string' ? loc : 'abovebar'
    const seriesCode = this.expr(series)
    const lines = [`__pine.mark(markers, ${seriesCode}, ${JSON.stringify(title)}, ${JSON.stringify(location)}, __index)`]
    if (this.meta.kind === 'indicator') {
      if (location.includes('below')) lines.push(`__ind_buy = ${seriesCode}`)
      else lines.push(`__ind_sell = ${seriesCode}`)
    }
    return lines.join('; ')
  }

  private barcolorStatement(call: CallExpr): string {
    const m = this.normalizeArgs(call, BARCOLOR_PARAMS)
    const color = m.get('color') ?? { kind: 'na', line: 0, col: 0 }
    return `__pine.barColor(barColor, ${this.expr(color)}, __index)`
  }

  /**
   * plotcandle / plotbar / plotchar / plotarrow。
   *
   * 回测只消费信号，图元与盈亏无关，因此这里不生成绘制代码（与 box/label 存根同一策略），
   * 只把标题登记进 meta.plotTitles，让编辑器仍能显示「N 条 plot」。
   */
  private plotFamilyNoop(call: CallExpr, params: string[]): string {
    const title = this.normalizeArgs(call, params).get('title')
    if (title && title.kind === 'string') this.meta.plotTitles.push(title.value)
    return 'void 0'
  }

  private entryStatement(call: CallExpr): string {
    const m = this.normalizeArgs(call, ['id', 'direction', 'qty', 'limit', 'stop', 'oca_name', 'oca_type', 'comment'])
    const idExpr = m.get('id')
    const id = idExpr && idExpr.kind === 'string' ? idExpr.value : undefined
    const dirExpr = m.get('direction')
    const dir = dirExpr ? this.literalOf(dirExpr) : undefined
    const direction = dir === 'short' ? 'short' : 'long'
    // 关键：entry 当根 `strategy.exit` 所在的 if 分支不会执行，
    // 必须在 entry 处把止损 / 止盈快照下来，引擎才拿得到 obStopLoss / obTakeProfit。
    // 但 exit 的表达式可能引用 entry 处不可见的局部变量（如 if 块内的 entryPrice），
    // 此时按「尽力而为」处理：跳过内联（用 na），由 exit 分支自己执行时赋值。
    const exits = id ? this.exitMap.get(id) : undefined
    const stop = exits?.stop ? this.tryInline(exits.stop) : null
    const limit = exits?.limit ? this.tryInline(exits.limit) : null
    return `__entryDir = '${direction}'; __exitStop = ${stop ?? 'NaN'}; __exitLimit = ${limit ?? 'NaN'}`
  }

  /**
   * 在「当前作用域之外」的位置尽力求值一段表达式：
   * 若产生新的 error 诊断（引用了不可见的名字），回滚诊断并返回 null。
   */
  private tryInline(e: Expr): string | null {
    const before = this.diags.length
    const code = this.expr(e)
    const added = this.diags.splice(before)
    if (added.some((d) => d.severity === 'error')) return null
    this.diags.push(...added)
    return code
  }

  private exitStatement(call: CallExpr): string {
    const m = this.normalizeArgs(call, ['id', 'from_entry', 'qty', 'qty_percent', 'profit', 'limit', 'loss', 'stop', 'comment'])
    const parts: string[] = []
    const stop = m.get('stop')
    const limit = m.get('limit')
    if (stop) parts.push(`__exitStop = ${this.expr(stop)}`)
    if (limit) parts.push(`__exitLimit = ${this.expr(limit)}`)
    return parts.length ? parts.join('; ') : 'void 0'
  }

  /* ---------------------------------------------------------------- */
  /* 表达式                                                            */
  /* ---------------------------------------------------------------- */

  private expr(e: Expr): string {
    switch (e.kind) {
      case 'number':
        return formatNumber(e.value)
      case 'string':
        return JSON.stringify(e.value)
      case 'color':
        return JSON.stringify(e.value)
      case 'bool':
        return e.value ? 'true' : 'false'
      case 'na':
        return 'NaN'
      case 'ident':
        return this.ident(e.name, e)
      case 'member':
        return this.member(e)
      case 'index':
        return this.index(e)
      case 'call':
        return this.call(e)
      case 'unary':
        if (e.op === 'not') return `(!${this.expr(e.operand)})`
        return `(${e.op}${this.expr(e.operand)})`
      case 'binary':
        return this.binary(e.op, this.expr(e.left), this.expr(e.right))
      case 'ternary':
        return `((${this.expr(e.cond)}) ? (${this.expr(e.then)}) : (${this.expr(e.else)}))`
      case 'array':
        return `[${e.items.map((it) => this.expr(it)).join(', ')}]`
      case 'switch': {
        // switch 表达式 → 嵌套三目；Pine 的分支匹配就是相等比较，默认分支兜底
        const def = e.arms.find((a) => a.cond === null)
        let out = def ? this.expr(def.value) : 'NaN'
        for (let i = e.arms.length - 1; i >= 0; i--) {
          const arm = e.arms[i]
          if (!arm.cond) continue
          out = `((${this.expr(arm.cond)} === ${this.expr(e.subject)}) ? (${this.expr(arm.value)}) : (${out}))`
        }
        return out
      }
      case 'ifExpr':
        return this.ifExprCode(e)
      default:
        return 'NaN'
    }
  }

  /** 用户变量名 → 合法 JS 名（保留字加前缀） */
  private jsVar(name: string): string {
    return JS_RESERVED.has(name) ? `__v_${name}` : name
  }

  private ident(name: string, node: Expr): string {
    switch (name) {
      case 'open':
        return 'C.open[__index]'
      case 'high':
        return 'C.high[__index]'
      case 'low':
        return 'C.low[__index]'
      case 'close':
        return 'C.close[__index]'
      case 'volume':
        return 'C.volume[__index]'
      case 'time':
        return 'C.timestamp[__index]'
      case 'hl2':
        return '((C.high[__index] + C.low[__index]) / 2)'
      case 'hlc3':
        return '((C.high[__index] + C.low[__index] + C.close[__index]) / 3)'
      case 'ohlc4':
        return '((C.open[__index] + C.high[__index] + C.low[__index] + C.close[__index]) / 4)'
      case 'bar_index':
        return '__index'
      case 'last_bar_index':
        return '(n - 1)'
      case 'last_bar_time':
        return 'C.timestamp[n - 1]'
      // `timenow`：回测以最后一根 bar 的时间近似
      case 'timenow':
        return 'C.timestamp[n - 1]'
      // v4 遗留：time_close / time_tradingday 以开盘时间近似（无逐 bar 收盘时间）
      case 'time_close':
      case 'time_tradingday':
        return 'C.timestamp[__index]'
      // v4 遗留：hlcc4 = (high + low + close * 2) / 4
      case 'hlcc4':
        return '((C.high[__index] + C.low[__index] + C.close[__index] * 2) / 4)'
      default:
        break
    }
    if (this.precalc.has(name) || this.precalcTupleNames.has(name)) return `__a_${name}[__index]`
    // 函数局部序列（已提升为模块级状态）：局部遮蔽同名全局
    const hoisted = this.fnLocalCtx?.get(name)
    if (hoisted) return hoisted.name
    if (this.vars.has(name) || this.createConsts.has(name) || this.stepScalars.has(name)) {
      return this.jsVar(name)
    }
    if (this.userFuncs.has(name) || this.typeNames.has(name)) return name
    if (this.isLocal(name)) return this.jsVar(name)
    // v4 裸 `tr`：整条真实波幅序列在当前 bar 的值
    if (name === 'tr' && this.wantsTr) return '__a_tr[__index]'
    // v3/v4 遗留：裸周期字符串（未被子用户声明遮蔽时）
    if (name === 'period' || name === 'resolution') return '__pine.timeframe.period'
    // v5 变化：裸 `year` / `month` / `hour` … 取当前 bar 的时间分量
    if (TIME_PART_FNS.has(name)) return `__pine.timePart(${JSON.stringify(name)}, C.timestamp[__index])`
    if (name === 'dayofweek') return `__pine.dayofweek(C.timestamp[__index])`
    // v3/v4 遗留：裸标的 id
    if (name === 'tickerid' || name === 'ticker') return "''"
    // v3/v4 裸颜色常量（`plot(close, color=lime)`）
    if (BARE_COLORS.has(name)) return `__pine.color.${name}`
    this.diags.push({
      line: node.line,
      column: node.col,
      severity: 'error',
      message: `代码生成阶段遇到无法映射的标识符 "${name}"`,
    })
    return 'NaN'
  }

  private member(e: MemberExpr): string {
    const path = this.dottedPath(e)
    if (path) {
      if (path in CTX_MEMBERS) {
        if (CTX_MEMBERS[path] === 'NaN') {
          this.warn(`回测引擎不提供的策略成员 "${path}" 已按 na 降级`, e)
        }
        return CTX_MEMBERS[path]
      }
      // 其余 `strategy.*` 成员（如 strategy.closedtrades.entry_price）：一律按 na 降级
      if (path.startsWith('strategy.')) {
        this.warn(`回测引擎不支持的策略成员 "${path}" 已按 na 降级`, e)
        return 'NaN'
      }
      if (path in CONST_MEMBERS) return CONST_MEMBERS[path]
      // v5 `dayofweek.friday` 等枚举
      if (path.startsWith('dayofweek.') && DAYOFWEEK_MEMBERS[e.property] !== undefined) {
        return String(DAYOFWEEK_MEMBERS[e.property])
      }
      // `text.format_bold` / `text.style_*` 等绘图枚举：按 0 占位
      if (isTextEnumMember(path)) return '0'
      // v4 裸 `tr` 的命名空间写法：`ta.tr`
      if (path === 'ta.tr' && this.wantsTr) return '__a_tr[__index]'
      // 图表可见区间：回测里就是全部 K 线的首尾
      if (path === 'chart.left_visible_bar_time') return 'C.timestamp[0]'
      if (path === 'chart.right_visible_bar_time') return 'C.timestamp[n - 1]'
      // `chart.point.*`：绘图坐标对象（回测不消费，给个同形状占位）
      if (path.startsWith('chart.point.')) return `({ __pt: ${JSON.stringify(path)} })`
      if (path === 'session.isfirstbar') return '(__index === 0)'
      if (path === 'session.islastbar') return '(__index === n - 1)'
      if (path === 'syminfo.mintick') return '__pine.ctx.mintick'
      if (path === 'syminfo.ticker' || path === 'syminfo.tickerid') return "''"
      // barstate：逐 bar 回测里「历史 K 线」恒为已确认，只有最后一根是 islast
      if (path === 'barstate.islast' || path === 'barstate.islastconfirmedhistory') return '(__index === n - 1)'
      if (path === 'barstate.isfirst') return '(__index === 0)'
      if (path === 'barstate.isconfirmed' || path === 'barstate.ishistory') return 'true'
      if (path === 'barstate.isnew' || path === 'barstate.isrealtime') return 'false'
      // 其余 syminfo.* 一律取运行时里的同名字段（pointvalue / root / type / session …）
      if (path.startsWith('syminfo.') && NAMESPACE_ROOTS.has('syminfo')) {
        return `__pine.syminfo.${e.property}`
      }
      // timeframe.*（period / multiplier / isintraday …）同理由运行时提供
      if (path.startsWith('timeframe.')) return `__pine.timeframe.${e.property}`
      if (path === 'timenow') return 'NaN'
      if (path.startsWith('color.')) return `__pine.color.${e.property}`
      const root = path.split('.')[0]
      if (NAMESPACE_ROOTS.has(root)) {
        this.diags.push({
          line: e.line,
          column: e.col,
          severity: 'error',
          message: `v1 尚不支持的内置成员 "${path}"`,
        })
        return 'NaN'
      }
    }
    // 用户对象字段：z.isBull / box.bx
    return `${this.expr(e.object)}.${e.property}`
  }

  private index(e: IndexExpr): string {
    const base = e.object
    const k = this.expr(e.index)
    if (base.kind === 'ident' || base.kind === 'index' || base.kind === 'call') {
      if (base.kind === 'ident') {
        const name = base.name
        // 用户函数形参的历史引用：容器由调用点透传（形参遮蔽同名全局）
        if (this.histParamsInFn?.has(name)) return `__pine.histOf(__hr_${name}, __index, ${k})`
        // 函数局部序列：提升后的环形缓冲
        const hoisted = this.fnLocalCtx?.get(name)
        if (hoisted) return `__pine.hist(${hoisted.ring}, ${k})`
        // 逐 bar 标量的环形缓冲（不能被跟踪数组替代：条件赋值时环形缓冲更保守）
        if (this.histNeed.has(name)) return `__pine.hist(__h_${name}, ${k})`
      }
      // 内置序列 / 预计算数组 / 跟踪标量 / 嵌套 ta 调用：整条数组 + 下标回看
      const ref = this.seriesRef(base)
      if (ref) {
        const idx = ref.offset === 0 ? '__index' : `(__index - ${ref.offset})`
        return `__pine.at(${ref.arr}, ${idx}, ${k})`
      }
    }
    if (base.kind === 'member') {
      const path = this.dottedPath(base)
      if (path && this.memberHist.has(path)) return `__pine.hist(__hm_${memberRingName(path)}, ${k})`
      if (path === 'ta.tr' && this.wantsTr) return `__pine.at(__a_tr, __index, ${k})`
    }
    this.diags.push({
      line: e.line,
      column: e.col,
      severity: 'error',
      message: '[k] 历史引用仅支持内置变量、预计算数组与顶层无条件赋值变量',
    })
    return 'NaN'
  }

  private seriesArrayOf(name: string): string {
    switch (name) {
      case 'time':
      case 'time_close':
      case 'time_tradingday':
        return 'C.timestamp'
      case 'hl2':
      case 'hlc3':
      case 'ohlc4':
        return 'C.close'
      default:
        return `C.${name}`
    }
  }

  private ifExprCode(e: IfExpr): string {
    const parts: string[] = ['(() => {']
    e.branches.forEach((br, i) => {
      parts.push(`${i === 0 ? 'if' : 'else if'} (${this.expr(br.cond)}) {`)
      parts.push(this.branchReturn(br.body, e))
      parts.push('}')
    })
    parts.push('else {')
    parts.push(e.elseBody ? this.branchReturn(e.elseBody, e) : 'return NaN;')
    parts.push('}')
    parts.push('})()')
    return parts.join(' ')
  }

  /** if 表达式分支块：前面的语句照常生成，最后一条表达式作为返回值 */
  private branchReturn(body: Stmt[], node: IfExpr): string {
    const lines: string[] = []
    this.pushScope()
    const last = body[body.length - 1]
    const value = last && last.kind === 'expr' ? last : null
    if (!value) this.warn('if 表达式分支的最后一条语句不是表达式，已按 na 处理', node)
    for (const s of body) {
      if (s === value) break
      // 同一行内拼接，必须显式补分号（ASI 不生效）
      for (const l of this.emitBlockStmt(s, 1)) lines.push(`${l};`)
    }
    lines.push(`  return ${value ? this.expr(value.expr) : 'NaN'};`)
    this.popScope()
    return lines.join(' ')
  }

  private binary(op: string, l: string, r: string): string {
    switch (op) {
      case 'and':
        return `(${l} && ${r})`
      case 'or':
        return `(${l} || ${r})`
      case '==':
        return `__pine.eq(${l}, ${r})`
      case '!=':
        return `__pine.neq(${l}, ${r})`
      case '<':
        return `__pine.lt(${l}, ${r})`
      case '<=':
        return `__pine.le(${l}, ${r})`
      case '>':
        return `__pine.gt(${l}, ${r})`
      case '>=':
        return `__pine.ge(${l}, ${r})`
      default:
        return `(${l} ${op} ${r})`
    }
  }

  /* ---------------------------------------------------------------- */
  /* 调用                                                              */
  /* ---------------------------------------------------------------- */

  private call(e: CallExpr): string {
    // `na(x)` → isNa(x)
    if (e.callee.kind === 'na') {
      const arg = e.args[0]
      return `__pine.isNa(${arg ? this.expr(arg.value) : 'NaN'})`
    }

    const path = this.calleePath(e.callee)
    const name = path ? path.join('.') : ''

    if (name === 'nz') return this.nzCall(e)
    // v3 `time(resolution)` / v5 `dayofweek(time[, tz])` 等时间函数
    if (path && path.length === 1 && path[0] === 'time') return 'C.timestamp[__index]'
    if (path && path.length === 1 && path[0] === 'dayofweek') {
      const args = this.positionalArgs(e).map((a) => this.expr(a.value))
      return `__pine.dayofweek(${args.join(', ')})`
    }
    // v5 `year(time)` / `month(time)` / `hour(time)` …（缺省取当前 bar 时间）
    if (path && path.length === 1 && TIME_PART_FNS.has(path[0])) {
      const args = this.positionalArgs(e).map((a) => this.expr(a.value))
      const src = args.length ? args.join(', ') : 'C.timestamp[__index]'
      return `__pine.timePart(${JSON.stringify(path[0])}, ${src})`
    }
    // 绘图语句作为值使用（`p = hline(...)` / `f = fill(...)`）：na 占位
    if (path && path.length === 1 && (path[0] === 'hline' || path[0] === 'fill' || path[0] === 'bgcolor')) {
      return 'NaN'
    }
    // 类型转换：float(x) / int(x) / bool(x) / string(x) / color(x)
    if (path && path.length === 1 && CAST_FNS.has(path[0])) {
      return `__pine.cast.${path[0]}(${e.args[0] ? this.expr(e.args[0].value) : 'NaN'})`
    }
    // 交叉族（v6 `ta.crossover` 与 v4 裸 `crossover` 共用）：需要整条序列才能判定穿越
    if (path && path.length === 2 && path[0] === 'ta' && CROSS_FUNCS.has(path[1])) {
      return this.crossCall(e, path[1])
    }
    if (path && path.length === 1 && CROSS_FUNCS.has(path[0])) return this.crossCall(e, path[0])
    if (path && path[0] === 'ta') return this.taCall(e)
    if (path && path[0] === 'math') return this.mathCall(e)
    if (path && path[0] === 'str') return this.strCall(e)
    if (path && path[0] === 'input') return this.inputCall(e)
    if (path && path[0] === 'color') return this.colorCall(e)
    // 数组命名空间：array.push(arr, v) → __pine.array.push(arr, v)
    if (path && path[0] === 'array' && path[1]) {
      const fn = LEGACY_ARRAY_CTORS[path[1]] ?? path[1]
      return `__pine.array.${fn}(${this.callArgs(e).join(', ')})`
    }
    // matrix.* ：运行时实现常见矩阵运算（回测用不到的重型算子按 na 降级）
    if (path && path[0] === 'matrix' && path[1]) {
      return `__pine.matrix.${path[1]}(${this.callArgs(e).join(', ')})`
    }
    // `chart.point.from_time/from_index/new(...)`：绘图坐标对象（回测不消费）
    if (path && path[0] === 'chart' && path[1] === 'point') {
      const args = e.args.map((a) => this.expr(a.value)).join(', ')
      return `({ __pt: ${JSON.stringify(path.join('.'))}, args: [${args}] })`
    }
    // 绘图命名空间（line / table / polyline / linefill / box / label）：执行但不出图
    if (path && DRAWING_NS.has(path[0])) {
      return `__pine.${path[0]}.${path[1] ?? 'new'}(${this.callArgs(e).join(', ')})`
    }
    // plotcandle / plotbar / plotchar / plotarrow 与 plotshape 同族：回测不消费图元，只登记标题
    if (path && path.length === 1) {
      if (path[0] === 'plotcandle' || path[0] === 'plotbar') return this.plotFamilyNoop(e, PLOTOHLC_PARAMS)
      if (path[0] === 'plotchar' || path[0] === 'plotarrow') return this.plotFamilyNoop(e, PLOTCHAR_PARAMS)
    }
    if (path && path[0] === 'syminfo' && path[1] === 'currency') return "''"
    // request.currency_rate：单币种回测按 1 处理（不涉及跨币种换算）
    if (path && path[0] === 'request' && path[1] === 'currency_rate') return '1'
    if (path && path[0] === 'timeframe' && path[1] === 'in_seconds') return '__pine.timeframe.in_seconds()'

    // 用户函数 / 方法调用（形参含 [k] 历史引用时追加隐藏的序列容器实参）
    if (path && path.length === 1 && this.userFuncs.has(path[0])) {
      const fn = this.userFuncs.get(path[0])!
      const params = fn.params.map((p) => p.name)
      const args = this.namedToPositional(e, params)
      const hidden = this.hiddenHistArgs(e, params, path[0])
      return `${path[0]}(${[args, ...hidden].filter(Boolean).join(', ')})`
    }

    // `Type.new(...)` → `new Type(...)`
    if (path && path.length === 2 && this.typeNames.has(path[0]) && path[1] === 'new') {
      return `new ${path[0]}(${this.callArgs(e).join(', ')})`
    }

    // 数组方法
    const arrMethod = this.arrayMethod(e)
    if (arrMethod) return arrMethod

    if (path && path.length === 1 && (path[0] === 'strategy' || path[0] === 'indicator')) {
      return 'void 0'
    }

    if (path && path.length === 1 && path[0] === 'plot') return this.plotStatement(e)
    if (path && path.length === 1 && path[0] === 'plotshape') return this.plotshapeStatement(e)
    if (path && path.length === 1 && path[0] === 'barcolor') return this.barcolorStatement(e)

    // ---- v4 兼容层：裸内置函数（无命名空间前缀，运行时提供同名实现） ----
    if (path && path.length === 1) {
      const bare = path[0]
      if (bare === 'security') return this.securityCall(e)
      if (bare === 'timestamp') return this.timestampCall(e)
      // v3/v4 的 Heikin-Ashi 数据包装：单标的回测下等价于原标的
      if (bare === 'heikinashi' || bare === 'heikenashi') {
        const first = this.positionalArgs(e)[0]
        return first ? this.expr(first.value) : "''"
      }
      if (V4_TA_FUNCS.has(bare)) return this.taCall(e)
      if (V4_MATH_FUNCS.has(bare)) return this.mathCall(e)
      if (V4_STR_FUNCS.has(bare)) return this.strCall(e)
    }
    // `request.security(...)` 与 v4 `security()` 同口径降级
    if (path && path.length === 2 && path[0] === 'request' && path[1] === 'security') {
      return this.securityCall(e)
    }
    // v4 `macd(...)` / v6 `ta.macd(...)` 作为值（非元组解构）时返回元组数组
    if (path && TA_TUPLE_FNS[path[path.length - 1]] && (path.length === 1 || path[0] === 'ta')) {
      const fn = path[path.length - 1]
      const args = this.positionalArgs(e).map((a) => this.taArg(a.value)).join(', ')
      return `__pine.ta.${fn}(${args})`
    }

    // 其余未知调用：直译
    const callee = e.callee.kind === 'member' ? this.member(e.callee) : this.expr(e.callee)
    return `${callee}(${this.callArgs(e).join(', ')})`
  }

  private nzCall(e: CallExpr): string {
    const args = e.args.map((a) => this.expr(a.value))
    return `__pine.nz(${args.join(', ')})`
  }

  /** ta 调用：初始化期按整条数组求值；`step` 内优先用 `*At` 变体取当前 bar 标量 */
  private taCall(e: CallExpr): string {
    const path = this.calleePath(e.callee)!
    const fn = path[1] ?? path[0]
    if (!this.initPhase) {
      const at = this.taAtCall(e, fn)
      if (at) return at
    }
    return this.taArrayCall(e, fn)
  }

  /** ta 调用的「整条数组」形式（初始化期 / 作为其它 ta 函数的序列实参时使用） */
  private taArrayCall(e: CallExpr, fn?: string): string {
    const name = fn ?? this.calleePath(e.callee)![1] ?? this.calleePath(e.callee)![0]
    const args = this.positionalArgs(e).map((a) => this.taArg(a.value))
    if (name === 'atr') {
      if (args.length === 1) return `__pine.ta.atr(C.high, C.low, C.close, ${args[0]}, 'RMA')`
      if (args.length === 3) return `__pine.ta.atr(${args[0]}, ${args[1]}, ${args[2]}, 14, 'RMA')`
      return `__pine.ta.atr(${args.join(', ')})`
    }
    if (name === 'supertrend') {
      // `ta.supertrend(factor, atrPeriod)`：源序列固定为内置 OHLC（hl2 在实现内取）
      if (args.length === 2) {
        return `__pine.ta.supertrend(C.high, C.low, C.close, ${args[0]}, ${args[1]})`
      }
      return `__pine.ta.supertrend(C.high, C.low, C.close, ${args[args.length - 2]}, ${args[args.length - 1]})`
    }
    if (name === 'sar') {
      // `ta.sar(start, inc, max)`：高低价固定为内置序列
      return `__pine.ta.sar(C.high, C.low, ${args.join(', ')})`
    }
    if (name === 'dmi') {
      // `ta.dmi(diLength, adxSmoothing)`：OHLC 固定为内置序列
      return `__pine.ta.dmi(C.high, C.low, C.close, ${args.join(', ')})`
    }
    if (name === 'mfi') {
      // `ta.mfi(series, length)`：OHLCV 固定为内置序列，series 仅占位
      return `__pine.ta.mfi(C.high, C.low, C.close, C.volume, ${args[args.length - 1]})`
    }
    if (name === 'valuewhen') {
      // Pine 顺序 `(condition, source, occurrence)` → 运行时的 `(src, cond, occ)`
      return `__pine.ta.valuewhen(${args[1] ?? 'NaN'}, ${args[0] ?? 'NaN'}, ${args[2] ?? '0'})`
    }
    if (name === 'tr') {
      if (args.length >= 3) return `__pine.ta.trueRange(${args.slice(0, 3).join(', ')})`
      return '__pine.ta.trueRange(C.high, C.low, C.close)'
    }
    // `ta.pivothigh(leftbars, rightbars)` 两参形式默认以 high / low 为源
    if (name === 'pivothigh' || name === 'pivotlow') {
      if (args.length === 2) {
        const src = name === 'pivothigh' ? 'C.high' : 'C.low'
        return `__pine.ta.${name}(${src}, ${args[0]}, ${args[1]})`
      }
      return `__pine.ta.${name}(${args.join(', ')})`
    }
    return `__pine.ta.${name}(${args.join(', ')})`
  }

  /**
   * `step` 内的 ta 调用：把序列实参解析成整条数组，用 `*At` 变体取当前 bar 值。
   * 返回 null 表示无法映射（调用方回退到整数组形式）。
   */
  private taAtCall(e: CallExpr, fn: string): string | null {
    const pos = this.positionalArgs(e)
    if (fn === 'atr') {
      // v4 `atr(len)` / v6 `ta.atr(len)`：以内置 OHLC 为源
      if (pos.length <= 1) {
        const len = pos[0] ? this.expr(pos[0].value) : '14'
        return `__pine.ta.atrAt(C.high, C.low, C.close, __index, ${len}, 'RMA')`
      }
      // v6 `ta.atr(high, low, close, len)`
      if (pos.length >= 4) {
        const hs = this.seriesRef(pos[0].value)
        const ls = this.seriesRef(pos[1].value)
        const cs = this.seriesRef(pos[2].value)
        if (hs && ls && cs) {
          return `__pine.ta.atrAt(${hs.arr}, ${ls.arr}, ${cs.arr}, __index, ${this.expr(pos[3].value)}, 'RMA')`
        }
      }
      return null
    }
    if (fn === 'tr') return '__pine.ta.trAt(C.high, C.low, C.close, __index)'
    // 源序列固定为内置 OHLC(V)：直接走整数组形式（结果再按下标取）
    if (TA_OHLC_FNS.has(fn)) {
      const extra = pos.map((p) => this.expr(p.value))
      return `__pine.ta.${fn}At(C.high, C.low, C.close, __index, ${extra.join(', ')})`
    }
    // `ta.sar(start, inc, max)`：高低价固定为内置序列
    if (fn === 'sar') {
      if (pos.length < 3) return null
      const a = pos.map((p) => this.expr(p.value))
      return `__pine.ta.sarAt(C.high, C.low, __index, ${a[0]}, ${a[1]}, ${a[2]})`
    }
    // `ta.valuewhen(condition, source, occurrence)` → `valuewhenAt(src, i, cond, occ)`
    if (fn === 'valuewhen') {
      const condRef = pos[0] ? this.seriesRef(pos[0].value) : null
      const srcRef = pos[1] ? this.seriesRef(pos[1].value) : null
      if (condRef && srcRef && condRef.offset === 0 && srcRef.offset === 0) {
        const occ = pos[2] ? this.expr(pos[2].value) : '0'
        return `__pine.ta.valuewhenAt(${srcRef.arr}, __index, ${condRef.arr}, ${occ})`
      }
      return null
    }
    // v3/v4 `stoch(series, high, low, length)`：三个序列实参
    if (fn === 'stoch') {
      const srcRef = pos[0] ? this.seriesRef(pos[0].value) : null
      const hiRef = pos[1] ? this.seriesRef(pos[1].value) : null
      const loRef = pos[2] ? this.seriesRef(pos[2].value) : null
      if (srcRef && hiRef && loRef && pos[3]) {
        return `__pine.ta.stochAt(${srcRef.arr}, __index, ${hiRef.arr}, ${loRef.arr}, ${this.expr(pos[3].value)})`
      }
      return null
    }
    if (fn === 'pivothigh' || fn === 'pivotlow') {
      const two = pos.length === 2
      const srcRef = two
        ? fn === 'pivothigh' ? 'C.high' : 'C.low'
        : pos[0]
          ? this.seriesRef(pos[0].value)?.arr ?? null
          : null
      const left = pos[two ? 0 : 1]
      const right = pos[two ? 1 : 2]
      if (srcRef && left && right) {
        return `__pine.ta.${fn}At(${srcRef}, __index, ${this.expr(left.value)}, ${this.expr(right.value)})`
      }
      return null
    }
    if (!SERIES_AT_FNS.has(fn)) return null
    const first = pos[0] ? this.seriesRef(pos[0].value) : null
    if (!first) return null
    const idx = first.offset === 0 ? '__index' : `(__index - ${first.offset})`
    const rest = pos.slice(1).map((a) => this.expr(a.value))
    const tail = rest.length ? `, ${rest.join(', ')}` : ''
    return `__pine.ta.${fn}At(${first.arr}, ${idx}${tail})`
  }

  /**
   * 交叉族：`crossover(a, b)` 需要 a / b 各自的整条序列与偏移才能判定穿越。
   * 参数无法映射为序列时退化为当前 bar 的数值比较（并给出一次警告）。
   */
  private crossCall(e: CallExpr, fn: string): string {
    const pos = this.positionalArgs(e)
    if (this.initPhase) {
      const args = pos.map((a) => this.taArg(a.value))
      return `__pine.ta.${fn}(${args.join(', ')})`
    }
    const ra = pos[0] ? this.seriesRef(pos[0].value) : null
    const rb = pos[1] ? this.seriesRef(pos[1].value) : null
    if (ra && rb) {
      return `__pine.ta.${fn}At(${ra.arr}, ${rb.arr}, __index, ${ra.offset}, ${rb.offset})`
    }
    const a = pos[0] ? this.expr(pos[0].value) : 'NaN'
    const b = pos[1] ? this.expr(pos[1].value) : 'NaN'
    this.warn(`${fn}() 的参数无法映射为序列，已按当前 bar 的数值比较近似`, e)
    if (fn === 'crossover') return `__pine.gt(${a}, ${b})`
    if (fn === 'crossunder') return `__pine.lt(${a}, ${b})`
    return `(__pine.gt(${a}, ${b}) || __pine.lt(${a}, ${b}))`
  }

  /** v4 `security()` / `request.security()`：多标的取值未实现，降级为「取当前序列」 */
  private securityCall(e: CallExpr): string {
    const pos = this.positionalArgs(e)
    const src = pos[2] ?? pos[1]
    this.warn('security()/request.security() 已降级为当前序列取值（忽略 symbol 与 timeframe 参数）', e)
    return src ? this.expr(src.value) : 'NaN'
  }

  /** Pine 的 `timestamp()`：v4 位置参数形式与字符串形式均交由运行时处理 */
  private timestampCall(e: CallExpr): string {
    const args = this.positionalArgs(e).map((a) => this.expr(a.value))
    return `__pine.timestamp(${args.join(', ')})`
  }

  /** 用户函数的隐藏历史参数实参：按调用点实参解析出的序列容器 */
  private hiddenHistArgs(e: CallExpr, params: string[], fnName: string): string[] {
    const hist = this.fnHistParams.get(fnName)
    if (!hist || hist.length === 0) return []
    const m = this.normalizeArgs(e, params)
    return hist.map((p) => {
      const arg = m.get(p)
      const ref = arg ? this.seriesRef(arg) : null
      if (ref && ref.offset === 0) return ref.arr
      this.warn(
        `函数 "${fnName}" 的形参 "${p}" 使用了 [k] 历史引用，但调用点实参无法映射为序列，已按 na 处理`,
        e,
      )
      return 'null'
    })
  }

  /**
   * 把表达式解析成「整条序列数组 + 偏移」引用：
   * 内置序列 / 预计算数组 / 预计算元组元素 / 逐 bar 跟踪标量，以及它们的 `[k]` 形式。
   */
  private seriesRef(e: Expr): { arr: string; offset: number } | null {
    if (e.kind === 'ident') {
      const n = e.name
      if (BUILTIN_SERIES.has(n)) return { arr: this.seriesArrayOf(n), offset: 0 }
      if (this.precalc.has(n) || this.precalcTupleNames.has(n)) return { arr: `__a_${n}`, offset: 0 }
      if (n === 'tr' && this.wantsTr) return { arr: '__a_tr', offset: 0 }
      if (this.serTrack.has(n)) return { arr: `__s_${n}`, offset: 0 }
      return null
    }
    if (e.kind === 'index') {
      // 形如 `x[1]` / `ta.change(x)[1]` / `x[1][2]`：偏移可叠加
      const k = e.index.kind === 'number' ? e.index.value : null
      if (k === null || !Number.isInteger(k) || k < 0) return null
      const base = this.seriesRef(e.object)
      return base ? { arr: base.arr, offset: base.offset + k } : null
    }
    // 嵌套的 ta 调用：整体按整条数组引用（偏移 0）
    if (e.kind === 'call') {
      const path = this.calleePath(e.callee)
      const fn = path
        ? path.length === 2 && path[0] === 'ta'
          ? path[1]
          : path.length === 1
            ? path[0]
            : null
        : null
      if (fn && TA_SERIES_FNS.has(fn)) return { arr: this.taArrayCall(e, fn), offset: 0 }
      return null
    }
    return null
  }

  /** 同一类警告每个编译单元只报一次 */
  private warn(message: string, node: { line: number; col: number }): void {
    if (this.warned.has(message)) return
    this.warned.add(message)
    this.diags.push({ line: node.line, column: node.col, severity: 'warning', message })
  }

  /** ctx 成员的取值表达式（未知的 `strategy.*` 成员一律按 na 降级） */
  private memberValueOf(path: string): string {
    return CTX_MEMBERS[path] ?? 'NaN'
  }

  /**
   * `ta.*` 的序列实参须传**整条数组**（`C.close`）而非当前 bar 标量
   * （`C.close[__index]`）；否则 `ta.sma` 之类的实现拿到长度 1 的标量数组。
   */
  private taArg(e: Expr): string {
    if (e.kind === 'ident') {
      if (BUILTIN_SERIES.has(e.name)) return this.seriesArrayOf(e.name)
      if (this.precalc.has(e.name)) return `__a_${e.name}`
      // 逐 bar 标量：整条跟踪数组（供派生序列参与窗口函数计算）
      if (this.serTrack.has(e.name)) return `__s_${e.name}`
    }
    // 嵌套的 ta 调用（如 `sma(stoch(close, high, low, len), k)`）：必须按整条数组求值
    if (e.kind === 'call') {
      const path = this.calleePath(e.callee)
      const fn = path
        ? path.length === 2 && path[0] === 'ta'
          ? path[1]
          : path.length === 1
            ? path[0]
            : null
        : null
      if (fn && TA_SERIES_FNS.has(fn)) return this.taArrayCall(e, fn)
    }
    return this.expr(e)
  }

  private mathCall(e: CallExpr): string {
    const path = this.calleePath(e.callee)!
    const fn = path[1] ?? path[0]
    const args = this.positionalArgs(e).map((a) => this.expr(a.value))
    const direct = new Set(['abs', 'max', 'min', 'round', 'floor', 'ceil', 'pow', 'sqrt', 'sign', 'log', 'log10', 'exp'])
    if (direct.has(fn)) {
      if (fn === 'round' && args.length === 2) return `__pine.math.round(${args.join(', ')})`
      return `Math.${fn}(${args.join(', ')})`
    }
    return `__pine.math.${fn}(${args.join(', ')})`
  }

  private strCall(e: CallExpr): string {
    const path = this.calleePath(e.callee)!
    const fn = path[1] ?? path[0]
    const args = this.positionalArgs(e).map((a) => this.expr(a.value))
    if (fn === 'tostring') return `__pine.str.tostring(${args.join(', ')})`
    return `__pine.str.${fn}(${args.join(', ')})`
  }

  /** `input.*`：把默认值 / 标题 / 分组等收集进 meta，并生成可由请求覆盖的初始化调用 */
  private inputCall(e: CallExpr): string {
    const path = this.calleePath(e.callee)!
    // v4 的裸 `input()` 形参顺序与 v5/v6 的 `input.*` 不同（type 在第 3 位）
    const bare = path.length === 1
    const m = this.normalizeArgs(e, bare ? INPUT_PARAMS_V4 : INPUT_PARAMS)
    const type = this.inputTypeOf(path, m)
    const def = m.get('defval')
    const defaultCode = def ? this.expr(def) : 'NaN'
    const opts: string[] = []
    const title = m.get('title')
    const group = m.get('group')
    const minval = m.get('minval')
    const maxval = m.get('maxval')
    const step = m.get('step')
    if (title) opts.push(`title: ${this.expr(title)}`)
    if (group) opts.push(`group: ${this.expr(group)}`)
    if (minval) opts.push(`minval: ${this.expr(minval)}`)
    if (maxval) opts.push(`maxval: ${this.expr(maxval)}`)
    if (step) opts.push(`step: ${this.expr(step)}`)

    const name = this.inputNameFor(e)
    const titleLit = title ? this.literalOf(title) : undefined
    this.meta.inputs.push({
      name,
      type: (['int', 'float', 'bool', 'color', 'string'].includes(type) ? type : 'float') as
        | 'int'
        | 'float'
        | 'bool'
        | 'color'
        | 'string',
      title: typeof titleLit === 'string' ? titleLit : name,
      group: group ? (this.literalOf(group) as string | undefined) : undefined,
      minval: minval ? (this.literalOf(minval) as number | undefined) : undefined,
      maxval: maxval ? (this.literalOf(maxval) as number | undefined) : undefined,
      step: step ? (this.literalOf(step) as number | undefined) : undefined,
      default: def ? this.literalOf(def) : undefined,
    })
    return `__pine.input.${RUNTIME_INPUT_TYPES.has(type) ? type : this.runtimeInputFallback(type)}(${JSON.stringify(name)}, ${defaultCode}, { ${opts.join(', ')} })`
  }

  /** 运行时没有对应通道的 input 类型（resolution / symbol / session …）按字符串处理 */
  private runtimeInputFallback(type: string): string {
    if (type === 'resolution' || type === 'symbol' || type === 'session' || type === 'timeframe') {
      return 'string'
    }
    return 'float'
  }

  /**
   * input 的类型：显式 `type=input.float` > 命名空间（`input.int`）> 由默认值推断。
   * v4 的 `input(true)` / `input(9, minval=1)` 都靠这一层落到正确的运行时通道。
   */
  private inputTypeOf(path: string[], m: Map<string, Expr>): string {
    const typeArg = m.get('type')
    if (typeArg) {
      if (typeArg.kind === 'ident') {
        // v4：`input(14, "len", integer)` —— 类型名直接作为实参
        return typeArg.name === 'integer' ? 'int' : typeArg.name
      }
      const p = this.dottedPath(typeArg)
      if (p && p.startsWith('input.')) return p.slice('input.'.length)
    }
    if (path.length > 1 && path[1]) return path[1]
    const def = m.get('defval')
    if (def) {
      if (def.kind === 'bool') return 'bool'
      if (def.kind === 'string') return 'string'
      if (def.kind === 'color') return 'color'
    }
    return 'float'
  }

  private colorCall(e: CallExpr): string {
    const path = this.calleePath(e.callee)!
    const fn = path[1] ?? 'new'
    const args = this.positionalArgs(e).map((a) => this.expr(a.value))
    return `__pine.color.${fn}(${args.join(', ')})`
  }

  /** `x.size()` / `.get(i)` / `.remove(i)` … → JS 原生数组操作 */
  private arrayMethod(e: CallExpr): string | null {
    if (e.callee.kind !== 'member') return null
    const prop = e.callee.property
    // 先确认属性名确实是数组方法，再求值接收者 ——
    // 否则任何成员调用（如 request.currency_rate）都会提前评估接收者，产生假报错
    if (!ARRAY_METHODS.has(prop)) return null
    const recv = this.expr(e.callee.object)
    const args = this.positionalArgs(e).map((a) => this.expr(a.value))
    switch (prop) {
      case 'size':
        return `${recv}.length`
      case 'get':
        return `${recv}[${args[0] ?? 0}]`
      case 'set':
        return `(${recv}[${args[0] ?? 0}] = ${args[1] ?? 'NaN'})`
      case 'push':
        return `(${recv}.push(${args.join(', ')}), ${recv}.length - 1)`
      case 'pop':
        return `${recv}.pop()`
      case 'shift':
        return `${recv}.shift()`
      case 'unshift':
        return `(${recv}.unshift(${args.join(', ')}), 0)`
      case 'remove':
        return `__pine.arrRemove(${recv}, ${args[0] ?? 0})`
      case 'clear':
        return `__pine.arrClear(${recv})`
      case 'includes':
        return `${recv}.includes(${args[0] ?? 'NaN'})`
      case 'indexof':
        return `${recv}.indexOf(${args[0] ?? 'NaN'})`
      case 'lastindexof':
        return `${recv}.lastIndexOf(${args[0] ?? 'NaN'})`
      case 'reverse':
        return `${recv}.reverse()`
      case 'slice':
        return `${recv}.slice(${args.join(', ')})`
      case 'concat':
        return `${recv}.concat(${args.join(', ')})`
      case 'sum':
        return `${recv}.reduce((a, b) => a + b, 0)`
      case 'avg':
        return `(${recv}.length ? ${recv}.reduce((a, b) => a + b, 0) / ${recv}.length : NaN)`
      case 'min':
        return `(${recv}.length ? Math.min(...${recv}) : NaN)`
      case 'max':
        return `(${recv}.length ? Math.max(...${recv}) : NaN)`
      default:
        return null
    }
  }

  /* ---------------------------------------------------------------- */
  /* 实参整理                                                          */
  /* ---------------------------------------------------------------- */

  /** 位置实参（丢弃具名实参） */
  private positionalArgs(e: CallExpr): CallArg[] {
    return e.args.filter((a) => a.name === undefined)
  }

  /** 全部实参：位置实参按原顺序，具名实参收进一个对象字面量 */
  private callArgs(e: CallExpr): string[] {
    const out: string[] = []
    const named: string[] = []
    for (const a of e.args) {
      if (a.name === undefined) out.push(this.expr(a.value))
      else named.push(`${a.name}: ${this.expr(a.value)}`)
    }
    if (named.length) out.push(`{ ${named.join(', ')} }`)
    return out
  }

  /** 把位置 + 具名实参统一映射到形参名 → 表达式 */
  private normalizeArgs(e: CallExpr, params: string[]): Map<string, Expr> {
    const m = new Map<string, Expr>()
    let pos = 0
    for (const a of e.args) {
      if (a.name === undefined) {
        const key = params[pos] ?? `arg${pos}`
        m.set(key, a.value)
        pos++
      } else {
        m.set(a.name, a.value)
      }
    }
    return m
  }

  /** 用户函数：按形参名把具名实参补成位置实参 */
  private namedToPositional(e: CallExpr, params: string[]): string {
    const m = this.normalizeArgs(e, params)
    return params.map((p) => (m.has(p) ? this.expr(m.get(p)!) : 'NaN')).join(', ')
  }

  /* ---------------------------------------------------------------- */
  /* 路径                                                              */
  /* ---------------------------------------------------------------- */

  /** `ta.atr` → ['ta','atr']，非成员链返回 null */
  private calleePath(e: Expr): string[] | null {
    if (e.kind === 'ident') return [e.name]
    if (e.kind === 'member') {
      const base = this.calleePath(e.object)
      if (!base) return null
      return [...base, e.property]
    }
    return null
  }

  private dottedPath(e: Expr): string | null {
    const p = this.calleePath(e)
    return p ? p.join('.') : null
  }

  /** 依据赋值目标名推断当前 `input.*` 的名字（供请求覆盖） */
  private inputNameFor(_e: CallExpr): string {
    return this.currentAssignName ?? `input_${this.meta.inputs.length}`
  }
}

/* ------------------------------------------------------------------ */

/** 数字字面量化简：避免 0.1+0.2 之类的浮点噪声进入产物文本 */
function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return 'NaN'
  return String(v)
}
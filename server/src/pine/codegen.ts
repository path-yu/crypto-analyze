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
  IfStmt,
  IndexExpr,
  MemberExpr,
  Program,
  Stmt,
  TypeDeclStmt,
  WhileStmt,
} from './ast'

/* ------------------------------------------------------------------ */
/* 常量表                                                              */
/* ------------------------------------------------------------------ */

const BUILTIN_SERIES = new Set(['open', 'high', 'low', 'close', 'volume', 'time', 'hl2', 'hlc3', 'ohlc4'])
/** 结果随 bar 演进的命名空间（不可在初始化阶段求值） */
const BAR_VARYING_ROOTS = new Set([
  'ta', 'session', 'syminfo', 'strategy', 'barstate', 'timeframe', 'request', 'chart', 'ticker',
  'timeframe', 'dayofweek', 'currency', 'time',
])
/** 允许在初始化阶段求值的调用根（要求所有实参也是初始化期可求值） */
const CONST_CALL_ROOTS = new Set(['input', 'color', 'math', 'str', 'format', 'size', 'display'])

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

/** `strategy.position_size` 等随 bar 演进的成员 */
const CTX_MEMBERS: Record<string, string> = {
  'strategy.position_size': 'ctx.positionSize',
  'strategy.position_avg_price': 'ctx.avgPrice',
  'strategy.opentrades': '(ctx.positionSize === 0 ? 0 : 1)',
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
/** `plot` 的形参顺序 */
const PLOT_PARAMS = ['series', 'title', 'color', 'offset', 'style', 'linewidth', 'trackprice', 'histbase', 'join', 'editable', 'show_last', 'display', 'format', 'precision', 'force_overlay']
/** `plotshape` 的形参顺序 */
const PLOTSHAPE_PARAMS = ['series', 'title', 'style', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size', 'show_last', 'display', 'format', 'precision', 'force_overlay']
/** `barcolor` 的形参顺序 */
const BARCOLOR_PARAMS = ['color', 'offset', 'editable', 'show_last', 'title', 'display', 'force_overlay']
/** `alertcondition` 的形参顺序 */
const ALERT_PARAMS = ['condition', 'title', 'message']

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
  /** `strategy.entry` 的 id → `strategy.exit` 的 stop/limit 表达式 */
  private readonly exitMap = new Map<string, { stop?: Expr; limit?: Expr }>()

  private readonly meta: PineCompileMeta

  /** indicator 模式下是否已经捕获过止损 / 止盈 plot */
  private indSlCaptured = false
  private indTpCaptured = false
  /** 正在处理的顶层赋值名（供 `input.*` 推断可覆盖的输入项名） */
  private currentAssignName: string | undefined
  /** 块级作用域栈 —— 记录 if/for/函数体内声明的局部变量名 */
  private readonly localScopes: Set<string>[] = []

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
    // 环形缓冲（历史引用）
    for (const [name, k] of this.histNeed) {
      lines.push(`  const __h_${name} = __pine.makeRing(${k + 1})`)
    }
    // 初始化期声明（保持源码顺序，保证「先声明后引用」）
    for (const stmt of this.program.body) {
      for (const l of this.emitInitStmt(stmt)) lines.push(`  ${l}`)
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
      if (this.isTaPrecalc(stmt.value)) {
        this.precalc.set(name, stmt.value as CallExpr)
        continue
      }
      if (!this.reassigned.has(name) && this.isCreateTime(stmt.value)) {
        this.createConsts.add(name)
        continue
      }
      this.stepScalars.add(name)
    }

    // 分类完成后再统计历史引用：此时才分得清 A 类数组 / var 状态 / C 类标量
    this.collectHistRefs(this.program.body)
    this.collectExits(this.program.body)
  }

  private collectReassigned(stmts: Stmt[]): void {
    for (const s of stmts) {
      switch (s.kind) {
        case 'assign':
          if (s.op === ':=' && s.target.kind === 'ident') this.reassigned.add(s.target.name)
          break
        case 'if':
          for (const br of s.branches) this.collectReassigned(br.body)
          if (s.elseBody) this.collectReassigned(s.elseBody)
          break
        case 'for':
          this.collectReassigned(s.body)
          break
        case 'funcDecl':
          this.collectReassigned(s.body)
          break
        default:
          break
      }
    }
  }

  /** 记录 C 类标量的历史引用深度（内置变量与 A 类数组不需要环形缓冲） */
  private collectHistRefs(stmts: Stmt[]): void {
    const visitExpr = (e: Expr): void => {
      switch (e.kind) {
        case 'index': {
          visitExpr(e.index)
          if (e.object.kind === 'ident') {
            const name = e.object.name
            if (
              !BUILTIN_SERIES.has(name) &&
              !this.precalc.has(name) &&
              !this.vars.has(name) &&
              this.typeNames.has(name) === false
            ) {
              const k = e.index.kind === 'number' ? e.index.value : 1
              this.histNeed.set(name, Math.max(this.histNeed.get(name) ?? 0, k))
            }
          }
          visitExpr(e.object)
          return
        }
        case 'member':
          visitExpr(e.object)
          return
        case 'call':
          visitExpr(e.callee)
          for (const a of e.args) visitExpr(a.value)
          return
        case 'unary':
          visitExpr(e.operand)
          return
        case 'binary':
          visitExpr(e.left)
          visitExpr(e.right)
          return
        case 'ternary':
          visitExpr(e.cond)
          visitExpr(e.then)
          visitExpr(e.else)
          return
        case 'array':
          for (const it of e.items) visitExpr(it)
          return
        case 'switch':
          visitExpr(e.subject)
          for (const arm of e.arms) {
            if (arm.cond) visitExpr(arm.cond)
            visitExpr(arm.value)
          }
          return
        default:
          return
      }
    }
    const visitStmts = (list: Stmt[]): void => {
      for (const s of list) {
        if (s.kind === 'assign') {
          visitExpr(s.target)
          visitExpr(s.value)
        } else if (s.kind === 'expr') visitExpr(s.expr)
        else if (s.kind === 'if') {
          for (const br of s.branches) {
            visitExpr(br.cond)
            visitStmts(br.body)
          }
          if (s.elseBody) visitStmts(s.elseBody)
        } else if (s.kind === 'for') {
          visitExpr(s.from)
          visitExpr(s.to)
          visitStmts(s.body)
        } else if (s.kind === 'funcDecl') visitStmts(s.body)
      }
    }
    visitStmts(stmts)
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
    if (!path || path.length !== 2 || path[0] !== 'ta') return false
    return e.args.every((a) => this.isPureTaArg(a.value))
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
          return [`let ${name} = ${this.expr(stmt.value)}`]
        }
        if (this.precalc.has(name)) {
          return [`const __a_${name} = ${this.taCall(this.precalc.get(name)!)}`]
        }
        if (this.createConsts.has(name)) {
          this.currentAssignName = name
          const code = this.expr(stmt.value)
          this.currentAssignName = undefined
          return [`const ${name} = ${code}`]
        }
        return []
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
    const params = stmt.params.map((p) => p.name)
    const body = stmt.body.slice()
    const last = body[body.length - 1]
    const implicitReturn = last && last.kind === 'expr' ? last : null
    const out: string[] = []
    out.push(`function ${stmt.name}(${params.join(', ')}) {`)
    this.pushScope(params)
    for (const s of body) {
      if (s === implicitReturn) break
      for (const l of this.emitBlockStmt(s)) out.push(`  ${l}`)
    }
    if (implicitReturn) out.push(`  return ${this.expr(implicitReturn.expr)}`)
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
    const out: string[] = []
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
    if (this.meta.kind === 'strategy') {
      return [
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
        return [`${pad}${code}`]
      }
      case 'if':
        return this.ifCode(stmt, depth)
      case 'for':
        return this.forCode(stmt, depth)
      case 'while':
        return this.whileCode(stmt, depth)
      case 'forIn':
        return this.forInCode(stmt, depth)
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
      const lines: string[] = []
      if (stmt.op === '=') {
        lines.push(`let ${name} = ${rhs}`)
        this.declareLocal(name)
      } else {
        lines.push(`${name} = ${rhs}`)
      }
      if (this.histNeed.has(name)) {
        lines.push(`__pine.push(__h_${name}, ${name})`)
      }
      return lines.join('; ')
    }
    // 成员赋值：`z.used := true`
    return `${this.expr(stmt.target)} = ${rhs}`
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

  private entryStatement(call: CallExpr): string {
    const m = this.normalizeArgs(call, ['id', 'direction', 'qty', 'limit', 'stop', 'oca_name', 'oca_type', 'comment'])
    const idExpr = m.get('id')
    const id = idExpr && idExpr.kind === 'string' ? idExpr.value : undefined
    const dirExpr = m.get('direction')
    const dir = dirExpr ? this.literalOf(dirExpr) : undefined
    const direction = dir === 'short' ? 'short' : 'long'
    // 关键：entry 当根 `strategy.exit` 所在的 if 分支不会执行，
    // 必须在 entry 处把止损 / 止盈快照下来，引擎才拿得到 obStopLoss / obTakeProfit。
    const exits = id ? this.exitMap.get(id) : undefined
    const stop = exits?.stop ? this.expr(exits.stop) : 'NaN'
    const limit = exits?.limit ? this.expr(exits.limit) : 'NaN'
    return `__entryDir = '${direction}'; __exitStop = ${stop}; __exitLimit = ${limit}`
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
      default:
        return 'NaN'
    }
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
      default:
        break
    }
    if (this.precalc.has(name)) return `__a_${name}[__index]`
    if (this.vars.has(name) || this.createConsts.has(name) || this.stepScalars.has(name)) return name
    if (this.userFuncs.has(name) || this.typeNames.has(name)) return name
    if (this.isLocal(name)) return name
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
      if (path in CTX_MEMBERS) return CTX_MEMBERS[path]
      if (path in CONST_MEMBERS) return CONST_MEMBERS[path]
      if (path === 'session.isfirstbar') return '(__index === 0)'
      if (path === 'session.islastbar') return '(__index === n - 1)'
      if (path === 'syminfo.mintick') return '__pine.ctx.mintick'
      if (path === 'syminfo.ticker' || path === 'syminfo.tickerid') return "''"
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
    if (base.kind === 'ident') {
      const name = base.name
      if (BUILTIN_SERIES.has(name)) return `__pine.at(${this.seriesArrayOf(name)}, __index, ${k})`
      if (this.precalc.has(name)) return `__pine.at(__a_${name}, __index, ${k})`
      if (this.histNeed.has(name)) return `__pine.hist(__h_${name}, ${k})`
    }
    if (base.kind === 'member') {
      const path = this.dottedPath(base)
      if (path === 'strategy.position_size') return `(__index === 0 ? 0 : ctx.prevPositionSize)`
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
        return 'C.timestamp'
      case 'hl2':
      case 'hlc3':
      case 'ohlc4':
        return 'C.close'
      default:
        return `C.${name}`
    }
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
    if (path && path[0] === 'ta') return this.taCall(e)
    if (path && path[0] === 'math') return this.mathCall(e)
    if (path && path[0] === 'str') return this.strCall(e)
    if (path && path[0] === 'input') return this.inputCall(e)
    if (path && path[0] === 'color') return this.colorCall(e)
    if (path && (path[0] === 'box' || path[0] === 'label')) {
      return `__pine.${path[0]}.${path[1] ?? 'new'}(${this.callArgs(e).join(', ')})`
    }
    if (path && path[0] === 'array' && path[1] === 'new') return '[]'
    if (path && path[0] === 'syminfo' && path[1] === 'currency') return "''"

    // 用户函数 / 方法调用
    if (path && path.length === 1 && this.userFuncs.has(path[0])) {
      const fn = this.userFuncs.get(path[0])!
      return `${path[0]}(${this.namedToPositional(e, fn.params.map((p) => p.name))})`
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

    // 其余未知调用：直译
    const callee = e.callee.kind === 'member' ? this.member(e.callee) : this.expr(e.callee)
    return `${callee}(${this.callArgs(e).join(', ')})`
  }

  private nzCall(e: CallExpr): string {
    const args = e.args.map((a) => this.expr(a.value))
    return `__pine.nz(${args.join(', ')})`
  }

  /** A 类数组：`ta.atr(atrLen)` → `__pine.ta.atr(C.high, C.low, C.close, atrLen, 'RMA')` */
  private taCall(e: CallExpr): string {
    const path = this.calleePath(e.callee)!
    const fn = path[1] ?? path[0]
    const args = this.positionalArgs(e).map((a) => this.taArg(a.value))
    if (fn === 'atr') {
      if (args.length === 1) return `__pine.ta.atr(C.high, C.low, C.close, ${args[0]}, 'RMA')`
      if (args.length === 3) return `__pine.ta.atr(${args[0]}, ${args[1]}, ${args[2]}, 14, 'RMA')`
      return `__pine.ta.atr(${args.join(', ')})`
    }
    if (fn === 'tr') {
      if (args.length === 0) return '__pine.ta.trueRange(C.high, C.low, C.close)'
      return `__pine.ta.trueRange(${args.join(', ')})`
    }
    return `__pine.ta.${fn}(${args.join(', ')})`
  }

  /**
   * `ta.*` 的序列实参须传**整条数组**（`C.close`）而非当前 bar 标量
   * （`C.close[__index]`）；否则 `ta.sma` 之类的实现拿到长度 1 的标量数组。
   */
  private taArg(e: Expr): string {
    if (e.kind === 'ident') {
      if (BUILTIN_SERIES.has(e.name)) return this.seriesArrayOf(e.name)
      if (this.precalc.has(e.name)) return `__a_${e.name}`
    }
    return this.expr(e)
  }

  private mathCall(e: CallExpr): string {
    const path = this.calleePath(e.callee)!
    const fn = path[1] ?? ''
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
    const fn = path[1] ?? ''
    const args = this.positionalArgs(e).map((a) => this.expr(a.value))
    if (fn === 'tostring') return `__pine.str.tostring(${args.join(', ')})`
    return `__pine.str.${fn}(${args.join(', ')})`
  }

  /** `input.*`：把默认值 / 标题 / 分组等收集进 meta，并生成可由请求覆盖的初始化调用 */
  private inputCall(e: CallExpr): string {
    const path = this.calleePath(e.callee)!
    const type = path[1] ?? 'float'
    const m = this.normalizeArgs(e, INPUT_PARAMS)
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
    return `__pine.input.${type}(${JSON.stringify(name)}, ${defaultCode}, { ${opts.join(', ')} })`
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
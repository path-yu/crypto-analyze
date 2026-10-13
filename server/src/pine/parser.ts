/**
 * Pine Script 语法分析器（递归下降 + Pratt 优先级）。
 *
 * 输入：词法层的逻辑行 token 流（含 INDENT/DEDENT/NEWLINE）。
 * 输出：`Program` AST；过程中把**可恢复**的问题写入 `diagnostics`，
 *       遇到无法恢复的语法错误则抛出 `PineError`（由 compile 兜底）。
 *
 * 运算符优先级（低 → 高）：
 *   三元 `?:` < `or` < `and` < 一元 `not` < 比较 < `+ -` < `* / %` < 一元 `- +` < 后缀
 */

import type { PineDiagnostic } from '../../../shared/types'
import type {
  AssignStmt,
  CallArg,
  CallExpr,
  Expr,
  ForInStmt,
  ForStmt,
  FuncDeclStmt,
  FuncParam,
  IfBranch,
  IfExpr,
  IfStmt,
  Program,
  Stmt,
  SwitchArm,
  SwitchExpr,
  TupleAssignStmt,
  TypeDeclStmt,
  TypeField,
  WhileStmt,
} from './ast'
import { isIdent, isOp, PineError, type Token } from './tokens'

/**
 * Pine v6 类型限定符：写在类型之前，例如 `series float data`、`simple int n`。
 * 解析时把它们与后面的类型一起当作「类型前缀」消费掉。
 */
const TYPE_QUALS = new Set(['series', 'simple', 'const', 'input'])

/** 判断 token 是否为复合赋值运算符（`+=` 等） */
function isCompoundOp(t: Token | undefined): boolean {
  return t?.kind === 'op' && COMPOUND_ASSIGN[t.text] !== undefined
}

/** Pine v6 复合赋值：语法层脱糖成 `x := x <op> v` */
const COMPOUND_ASSIGN: Record<string, string> = {
  '+=': '+',
  '-=': '-',
  '*=': '*',
  '/=': '/',
  '%=': '%',
}

interface BinaryInfo {
  op: string
  prec: number
}

const CMP_OPS = new Set(['==', '!=', '<', '<=', '>', '>='])

function binaryInfo(t: Token | undefined): BinaryInfo | null {
  if (!t) return null
  if (t.kind === 'ident') {
    if (t.text === 'or') return { op: 'or', prec: 2 }
    if (t.text === 'and') return { op: 'and', prec: 3 }
    return null
  }
  if (t.kind !== 'op') return null
  if (CMP_OPS.has(t.text)) return { op: t.text, prec: 5 }
  if (t.text === '+' || t.text === '-') return { op: t.text, prec: 6 }
  if (t.text === '*' || t.text === '/' || t.text === '%') return { op: t.text, prec: 7 }
  return null
}

export interface ParseResult {
  program: Program
  diagnostics: PineDiagnostic[]
}

export function parse(tokens: Token[], version?: string): ParseResult {
  return new Parser(tokens, version).run()
}

class Parser {
  private readonly tokens: Token[]
  private pos = 0
  private readonly diagnostics: PineDiagnostic[] = []
  private readonly version?: string
  /** 刚刚消费掉一个块结束的 DEDENT：阻止紧跟其后的 `[` 被误当成下标 */
  private blockEnded = false

  constructor(tokens: Token[], version?: string) {
    this.tokens = tokens
    this.version = version
  }

  run(): ParseResult {
    const body = this.parseStatements()
    const decl = body.find(
      (s): s is Stmt & { kind: 'expr' } =>
        s.kind === 'expr' &&
        s.expr.kind === 'call' &&
        s.expr.callee.kind === 'ident' &&
        (s.expr.callee.name === 'strategy' || s.expr.callee.name === 'indicator'),
    )
    let kind: Program['kind'] = 'unknown'
    if (decl && decl.expr.kind === 'call' && decl.expr.callee.kind === 'ident') {
      kind = decl.expr.callee.name === 'strategy' ? 'strategy' : 'indicator'
    }
    return { program: { kind, body, version: this.version }, diagnostics: this.diagnostics }
  }

  /* ------------------------------------------------------------------ */
  /* token 游标                                                          */
  /* ------------------------------------------------------------------ */

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset]
  }

  private next(): Token {
    const t = this.tokens[this.pos]
    if (t) this.pos++
    return t
  }

  private error(message: string, tok: Token | undefined): PineError {
    const t = tok ?? this.tokens[this.tokens.length - 1]
    return new PineError({
      line: t?.line ?? 0,
      column: t?.col ?? 1,
      severity: 'error',
      message,
    })
  }

  private warn(message: string, tok: Token | undefined): void {
    if (!tok) return
    this.diagnostics.push({ line: tok.line, column: tok.col, severity: 'warning', message })
  }

  private expectOp(text: string): Token {
    const t = this.peek()
    if (!isOp(t, text)) throw this.error(`期望 "${text}"，实际是 "${t?.text ?? 'EOF'}"`, t)
    return this.next()
  }

  private expectIdent(): Token {
    const t = this.peek()
    if (!t || t.kind !== 'ident') {
      throw this.error(`期望标识符，实际是 "${t?.text ?? 'EOF'}"`, t)
    }
    return this.next()
  }

  private atKind(kind: Token['kind']): boolean {
    return this.peek()?.kind === kind
  }

  /* ------------------------------------------------------------------ */
  /* 语句块                                                              */
  /* ------------------------------------------------------------------ */

  /** 解析一个语句列表，直到 DEDENT / EOF */
  private parseStatements(): Stmt[] {
    const out: Stmt[] = []
    for (;;) {
      const t = this.peek()
      if (!t || t.kind === 'dedent' || t.kind === 'eof') break
      if (t.kind === 'newline') {
        this.next()
        continue
      }
      // v4 允许一行内用逗号分隔多条语句（含行尾悬挂逗号）：
      //   src1 = a, src2 = b, src3 = c,
      // 表达式解析天然止步于逗号，这里把它当作语句分隔符消费即可。
      if (isOp(t, ',')) {
        this.next()
        continue
      }
      out.push(this.parseStatement())
    }
    return out
  }

  /** 解析 `=>` / `if` / `for` / `else` 之后必须存在的缩进块 */
  private parseIndentedBlock(): Stmt[] {
    // 头部逻辑行以 NEWLINE 结尾
    if (this.atKind('newline')) this.next()
    if (!this.atKind('indent')) {
      throw this.error('期望缩进块（4 个空格），但下一行没有缩进', this.peek())
    }
    this.next() // INDENT
    const body = this.parseStatements()
    if (this.atKind('dedent')) this.next()
    return body
  }

  /* ------------------------------------------------------------------ */
  /* 语句                                                                */
  /* ------------------------------------------------------------------ */

  private parseStatement(): Stmt {
    const t = this.peek()
    if (!t) throw this.error('意外的结束', t)
    // 新语句开始：上一次的「块刚结束」标记失效
    this.blockEnded = false

    if (t.kind === 'ident') {
      switch (t.text) {
        case 'var':
          // `var` 只在后面紧跟变量名时才是关键字（v3 里允许 `var = input(close)` 当普通变量名）
          if (this.peek(1)?.kind === 'ident') return this.parseAssign()
          break
        case 'type':
          if (this.peek(1)?.kind === 'ident') return this.parseTypeDecl()
          break
        case 'if':
          return this.parseIf()
        case 'for':
          return this.parseFor()
        case 'while':
          return this.parseWhile()
        case 'break':
          this.next()
          return { kind: 'break', line: t.line, col: t.col }
        case 'continue':
          this.next()
          return { kind: 'continue', line: t.line, col: t.col }
        case 'import':
        case 'export':
        case 'method':
          throw this.error(`v1 暂不支持 "${t.text}" 语句`, t)
        default:
          break
      }
    }

    if (this.isFuncDecl()) return this.parseFuncDecl()
    if (this.lookaheadAssign()) return this.parseAssign()
    return this.parseExprStmt()
  }

  /** 判断当前位置是否是 `name(params) =>` 形式的函数声明 */
  private isFuncDecl(): boolean {
    const t0 = this.peek()
    if (!t0 || t0.kind !== 'ident') return false
    if (!isOp(this.peek(1), '(')) return false
    let depth = 0
    for (let k = this.pos + 1; k < this.tokens.length; k++) {
      const t = this.tokens[k]
      if (t.kind === 'op' && t.text === '(') depth++
      else if (t.kind === 'op' && t.text === ')') {
        depth--
        if (depth === 0) return isOp(this.tokens[k + 1], '=>')
      } else if (t.kind === 'newline' || t.kind === 'eof') {
        return false
      }
    }
    return false
  }

  /** 在逻辑行内、括号深度 0 上查找赋值运算符 */
  private lookaheadAssign(): boolean {
    let depth = 0
    for (let k = this.pos; k < this.tokens.length; k++) {
      const t = this.tokens[k]
      if (t.kind === 'newline' || t.kind === 'eof' || t.kind === 'dedent') break
      if (t.kind === 'op') {
        if (t.text === '(' || t.text === '[' || t.text === '{') depth++
        else if (t.text === ')' || t.text === ']' || t.text === '}') depth--
        else if (depth === 0 && COMPOUND_ASSIGN[t.text] !== undefined) return true
        else if (depth === 0 && (t.text === '=' || t.text === ':=')) return true
      }
    }
    return false
  }

  /**
   * 尝试消费泛型类型前缀：`array<float>` / `map<string, float>` / `matrix<int>`。
   * 只有在「`>` 之后紧跟变量名、再接 `=` / `:=` / 复合赋值」时才认定是类型声明，
   * 因此不会把 `a < b > c` 这类比较表达式误判成泛型。成功返回类型文本并推进游标。
   */
  private tryGenericType(): string | null {
    const isAssignOp = (t: Token | undefined): boolean =>
      isOp(t, '=') || isOp(t, ':=') || (t?.kind === 'op' && COMPOUND_ASSIGN[t.text] !== undefined)
    // v4/v5 的数组类型后缀：`line[] x = ...` / `float[] ys = ...`
    if (this.peek()?.kind === 'ident' && isOp(this.peek(1), '[') && isOp(this.peek(2), ']')) {
      const nameTok = this.tokens[this.pos + 3]
      if (nameTok?.kind !== 'ident' || !isAssignOp(this.tokens[this.pos + 4])) return null
      const text = `${this.tokens[this.pos].text}[]`
      this.pos += 3
      return text
    }
    if (this.peek()?.kind !== 'ident' || !isOp(this.peek(1), '<')) return null
    let depth = 0
    let end = -1
    for (let i = this.pos + 1; i < this.tokens.length; i++) {
      const t = this.tokens[i]
      if (t.kind === 'newline' || t.kind === 'eof' || t.kind === 'indent' || t.kind === 'dedent') break
      if (t.kind !== 'op') continue
      if (t.text === '<') depth++
      else if (t.text === '>') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end < 0) return null
    const nameTok = this.tokens[end + 1]
    const opTok = this.tokens[end + 2]
    if (nameTok?.kind !== 'ident') return null
    if (!isAssignOp(opTok)) return null
    const typeText = this.tokens
      .slice(this.pos, end + 1)
      .map((t) => t.text)
      .join('')
    this.pos = end + 1
    return typeText
  }

  private parseAssign(): AssignStmt | TupleAssignStmt {
    const start = this.peek()!
    let isVar = false
    let typeName: string | undefined
    let target: Expr

    if (isIdent(this.peek(), 'var') && this.peek(1)?.kind === 'ident') {
      isVar = true
      this.next()
      const t0 = this.peek()
      const generic = this.tryGenericType()
      if (generic) {
        // var array<line> lvLine = array.new<line>()
        typeName = generic
        const name = this.expectIdent()
        target = { kind: 'ident', name: name.text, line: name.line, col: name.col }
      } else if (t0?.kind === 'ident' && this.peek(1)?.kind === 'ident') {
        typeName = t0.text
        this.next()
        const name = this.expectIdent()
        target = { kind: 'ident', name: name.text, line: name.line, col: name.col }
      } else if (t0?.kind === 'ident') {
        const name = this.expectIdent()
        target = { kind: 'ident', name: name.text, line: name.line, col: name.col }
      } else {
        throw this.error('var 之后期望变量声明', t0)
      }
    } else {
      const t0 = this.peek()
      const t1 = this.peek(1)
      const t2 = this.peek(2)
      const generic = this.tryGenericType()
      if (generic) {
        // 泛型类型化声明：array<float> lvPx = array.new<float>()
        typeName = generic
        const name = this.expectIdent()
        target = { kind: 'ident', name: name.text, line: name.line, col: name.col }
      } else if (
        t0?.kind === 'ident' &&
        TYPE_QUALS.has(t0.text) &&
        t1?.kind === 'ident' &&
        t2?.kind === 'ident' &&
        (isOp(this.peek(3), '=') || isOp(this.peek(3), ':=') || isCompoundOp(this.peek(3)))
      ) {
        // 带限定符的类型化声明：series float atr = ... / simple int n := ...
        typeName = `${t0.text} ${t1.text}`
        this.next() // 限定符
        this.next() // 类型
        const name = this.expectIdent()
        target = { kind: 'ident', name: name.text, line: name.line, col: name.col }
      } else if (
        t0?.kind === 'ident' &&
        t1?.kind === 'ident' &&
        (isOp(t2, '=') || isOp(t2, ':='))
      ) {
        // 类型化声明：float atr = ...
        typeName = t0.text
        this.next()
        const name = this.expectIdent()
        target = { kind: 'ident', name: name.text, line: name.line, col: name.col }
      } else {
        target = this.parsePostfixExpr()
      }
    }

    const opTok = this.peek()
    // Pine v6 复合赋值：`x += v` 等价于 `x := x + v`，在语法层直接脱糖，
    // AST 与 codegen 都不需要新增形态。
    const compound = opTok?.kind === 'op' ? COMPOUND_ASSIGN[opTok.text] : undefined
    if (!isOp(opTok, '=') && !isOp(opTok, ':=') && !compound) {
      throw this.error(`赋值语句缺少 "=" 或 ":="，实际是 "${opTok?.text ?? 'EOF'}"`, opTok)
    }
    this.next()
    const rhs = this.parseTernary()
    // 元组解构：`[a, b] = f()`。左侧被 parsePrimary 解析成了数组字面量，
    // 若元素全是标识符就改写为元组赋值语句。
    if (!compound && target.kind === 'array') {
      const names: string[] = []
      for (const it of target.items) {
        if (it.kind !== 'ident') {
          names.length = 0
          break
        }
        names.push(it.name)
      }
      if (names.length > 0) {
        return {
          kind: 'tupleAssign',
          names,
          op: isOp(opTok, ':=') ? ':=' : '=',
          value: rhs,
          line: start.line,
          col: start.col,
        }
      }
    }
    const value: Expr = compound
      ? { kind: 'binary', op: compound, left: target, right: rhs, line: target.line, col: target.col }
      : rhs
    return {
      kind: 'assign',
      isVar,
      typeName,
      target,
      op: opTok!.text as '=' | ':=',
      value,
      line: start.line,
      col: start.col,
    }
  }

  private parseTypeDecl(): TypeDeclStmt {
    const start = this.next() // type
    const name = this.expectIdent()
    this.parseIndentedBlockFields()
    const fields = this.lastFields
    this.lastFields = []
    return { kind: 'typeDecl', name: name.text, fields, line: start.line, col: start.col }
  }

  private lastFields: TypeField[] = []

  /** `type Name` 之后的字段块：每行 `类型 字段名` */
  private parseIndentedBlockFields(): void {
    if (this.atKind('newline')) this.next()
    if (!this.atKind('indent')) {
      throw this.error('type 声明之后期望字段缩进块', this.peek())
    }
    this.next()
    while (!this.atKind('dedent') && !this.atKind('eof')) {
      if (this.atKind('newline')) {
        this.next()
        continue
      }
      const typeTok = this.expectIdent()
      const fieldTok = this.expectIdent()
      this.lastFields.push({ typeName: typeTok.text, name: fieldTok.text })
      if (this.atKind('newline')) this.next()
    }
    if (this.atKind('dedent')) this.next()
  }

  /**
   * 读取类型前缀。支持两种写法：
   *   - 裸类型：`float v` / `array<float> H` / `line[] xs`
   *   - v6 类型限定符 + 类型：`series float data` / `simple int n` / `const string s`
   */
  private readTypePrefix(): { text: string; len: number } | null {
    const t0 = this.peek()
    if (t0?.kind !== 'ident') return null

    if (TYPE_QUALS.has(t0.text)) {
      const inner = this.readTypeAt(this.pos + 1)
      if (!inner) return null
      return { text: `${t0.text} ${inner.text}`, len: 1 + inner.len }
    }
    return this.readTypeAt(this.pos)
  }

  /** 从 tokens[pos] 处读取一个类型（含泛型与 `[]` 后缀） */
  private readTypeAt(pos: number): { text: string; len: number } | null {
    const t0 = this.tokens[pos]
    if (t0?.kind !== 'ident') return null
    if (isOp(this.tokens[pos + 1], '<')) {
      let depth = 0
      for (let i = pos + 1; i < this.tokens.length; i++) {
        const t = this.tokens[i]
        if (t.kind === 'newline' || t.kind === 'eof') break
        if (t.kind !== 'op') continue
        if (t.text === '<') depth++
        else if (t.text === '>') {
          depth--
          if (depth === 0) {
            const text = this.tokens
              .slice(pos, i + 1)
              .map((x) => x.text)
              .join('')
            return { text, len: i + 1 - pos }
          }
        }
      }
      return null
    }
    if (isOp(this.tokens[pos + 1], '[') && isOp(this.tokens[pos + 2], ']')) {
      return { text: `${t0.text}[]`, len: 3 }
    }
    return { text: t0.text, len: 1 }
  }

  private parseFuncDecl(): FuncDeclStmt {
    const start = this.peek()!
    const name = this.expectIdent()
    this.expectOp('(')
    const params: FuncParam[] = []
    if (!isOp(this.peek(), ')')) {
      for (;;) {
        const a = this.peek()
        // 形参类型前缀：`float v` / `array<float> H` / `line[] xs`
        const type = this.readTypePrefix()
        const nameAfter = type ? this.tokens[this.pos + type.len] : undefined
        if (type && nameAfter?.kind === 'ident') {
          this.pos += type.len
          const name = this.expectIdent()
          params.push({ typeName: type.text, name: name.text })
        } else if (a?.kind === 'ident') {
          params.push({ name: a.text })
          this.next()
        } else {
          throw this.error('函数参数格式不正确', a)
        }
        if (isOp(this.peek(), ',')) {
          this.next()
          continue
        }
        break
      }
    }
    this.expectOp(')')
    this.expectOp('=>')
    // Pine 允许单行函数体：`f(x) => expr`；下一行缩进时才走语句块。
    // 单表达式体包成一个 expr 语句即可 —— codegen 已把函数体最后一个表达式当返回值。
    const body: Stmt[] = this.atKind('newline')
      ? this.parseIndentedBlock()
      : [{ kind: 'expr', expr: this.parseTernary(), line: start.line, col: start.col }]
    return { kind: 'funcDecl', name: name.text, params, body, line: start.line, col: start.col }
  }

  private parseIf(): IfStmt {
    const start = this.next() // if
    const cond = this.parseTernary()
    const body = this.parseIndentedBlock()
    const branches: IfBranch[] = [{ cond, body }]
    let elseBody: Stmt[] | undefined

    while (isIdent(this.peek(), 'else')) {
      this.next()
      if (isIdent(this.peek(), 'if')) {
        this.next()
        const c = this.parseTernary()
        const b = this.parseIndentedBlock()
        branches.push({ cond: c, body: b })
        continue
      }
      elseBody = this.parseIndentedBlock()
      break
    }
    return { kind: 'if', branches, elseBody, line: start.line, col: start.col }
  }

  private parseFor(): ForStmt | ForInStmt {
    const start = this.next() // for
    // `for x in coll`：遍历数组 / map。`for [k, v] in map` 的元组解构暂不支持。
    const first = this.peek()
    if (first?.kind === 'ident' && isIdent(this.peek(1), 'in')) {
      this.next()
      this.next()
      const iterable = this.parseTernary()
      const body = this.parseIndentedBlock()
      return { kind: 'forIn', varName: first.text, iterable, body, line: start.line, col: start.col }
    }
    if (isOp(first, '[')) {
      throw this.error('暂不支持 `for [k, v] in` 形式的元组解构遍历', first)
    }
    const varTok = this.expectIdent()
    this.expectOp('=')
    const from = this.parseExpr(0)
    if (!isIdent(this.peek(), 'to')) {
      throw this.error('for 语句缺少 "to"', this.peek())
    }
    this.next()
    const to = this.parseExpr(0)
    // 可选 by step（v1 支持该语法，codegen 仅处理 ±1 方向）
    if (isIdent(this.peek(), 'by')) {
      this.next()
      this.parseExpr(0)
    }
    const body = this.parseIndentedBlock()
    return { kind: 'for', varName: varTok.text, from, to, body, line: start.line, col: start.col }
  }

  private parseWhile(): WhileStmt {
    const start = this.next() // while
    const cond = this.parseTernary()
    const body = this.parseIndentedBlock()
    return { kind: 'while', cond, body, line: start.line, col: start.col }
  }

  private parseExprStmt(): Stmt {
    const start = this.peek()!
    const expr = this.parseTernary()
    return { kind: 'expr', expr, line: start.line, col: start.col }
  }

  /* ------------------------------------------------------------------ */
  /* 表达式                                                              */
  /* ------------------------------------------------------------------ */

  /** 三元（最低优先级，右结合） */
  private parseTernary(): Expr {
    const cond = this.parseExpr(0)
    if (isOp(this.peek(), '?')) {
      const q = this.next()
      const then = this.parseTernary()
      this.expectOp(':')
      const els = this.parseTernary()
      return { kind: 'ternary', cond, then, else: els, line: q.line, col: q.col }
    }
    return cond
  }

  private parseExpr(minPrec: number): Expr {
    let left = this.parseUnary()
    for (;;) {
      const t = this.peek()
      const info = binaryInfo(t)
      if (!info || info.prec < minPrec) break
      this.next()
      const right = this.parseExpr(info.prec + 1)
      if (t!.kind === 'op' && CMP_OPS.has(t!.text)) {
        if (left.kind === 'na' || right.kind === 'na') {
          this.warn('na 参与比较恒为 false（Pine 语义）', t)
        }
      }
      left = { kind: 'binary', op: info.op, left, right, line: t!.line, col: t!.col }
    }
    return left
  }

  private parseUnary(): Expr {
    const t = this.peek()
    if (isIdent(t, 'not')) {
      this.next()
      const operand = this.parseExpr(4)
      return { kind: 'unary', op: 'not', operand, line: t!.line, col: t!.col }
    }
    if (isOp(t, '-') || isOp(t, '+')) {
      this.next()
      const operand = this.parseUnary()
      return { kind: 'unary', op: t!.text as '-' | '+', operand, line: t!.line, col: t!.col }
    }
    return this.parsePostfixExpr()
  }

  private parsePostfixExpr(): Expr {
    let e = this.parsePrimary()
    for (;;) {
      const t = this.peek()
      // 上一行刚结束一个块（switch / if 表达式）：紧随的 `[` 是新数组/元组，不是下标
      const endedWithBlock = this.blockEnded
      this.blockEnded = false
      if (isOp(t, '.')) {
        this.next()
        const prop = this.expectIdent()
        e = { kind: 'member', object: e, property: prop.text, line: prop.line, col: prop.col }
        continue
      }
      if (isOp(t, '[') && !endedWithBlock) {
        this.next()
        const idx = this.parseTernary()
        const close = this.expectOp(']')
        e = { kind: 'index', object: e, index: idx, line: close.line, col: close.col }
        continue
      }
      if (endedWithBlock) break
      if (isOp(t, '(')) {
        e = this.parseCallArgs(e)
        continue
      }
      // 泛型调用 `array.new<OB>()` / `map.new<string, float>()` / `array.new<chart.point>()`
      if (isOp(t, '<') && this.isGenericCall()) {
        this.next() // '<'
        const args: string[] = []
        for (;;) {
          let arg = this.expectIdent().text
          while (isOp(this.peek(), '.') && this.peek(1)?.kind === 'ident') {
            this.next()
            arg += `.${this.expectIdent().text}`
          }
          args.push(arg)
          if (isOp(this.peek(), ',')) {
            this.next()
            continue
          }
          break
        }
        this.next() // '>'
        e = this.parseCallArgs(e, args.join(', '))
        continue
      }
      break
    }
    return e
  }

  /** 形如 `<Ident(, Ident)*>(` 的泛型调用前缀（`map.new<string, float>()`） */
  private isGenericCall(): boolean {
    if (!isOp(this.peek(), '<') || this.peek(1)?.kind !== 'ident') return false
    let k = this.pos + 1
    for (;;) {
      // 一个类型实参：标识符 + 可选的 `.` 点分后缀（如 chart.point）
      if (this.tokens[k]?.kind !== 'ident') return false
      k++
      while (isOp(this.tokens[k], '.') && this.tokens[k + 1]?.kind === 'ident') k += 2
      if (isOp(this.tokens[k], ',')) {
        k++
        continue
      }
      break
    }
    return isOp(this.tokens[k], '>') && isOp(this.tokens[k + 1], '(')
  }

  private parsePrimary(): Expr {
    const t = this.peek()
    if (!t) throw this.error('表达式意外结束', t)
    if (t.kind === 'number') {
      this.next()
      return { kind: 'number', value: t.value as number, line: t.line, col: t.col }
    }
    if (t.kind === 'string') {
      this.next()
      return { kind: 'string', value: t.value as string, line: t.line, col: t.col }
    }
    if (t.kind === 'color') {
      this.next()
      return { kind: 'color', value: t.value as string, line: t.line, col: t.col }
    }
    if (t.kind === 'ident' && t.text === 'switch') return this.parseSwitch()
    // `if` 表达式：`x = if cond` + 缩进分支块（不是语句级 if —— 那些已在 parseStatement 分流）
    if (t.kind === 'ident' && t.text === 'if') return this.parseIfExpr()
    if (t.kind === 'ident') {
      this.next()
      if (t.text === 'true') return { kind: 'bool', value: true, line: t.line, col: t.col }
      if (t.text === 'false') return { kind: 'bool', value: false, line: t.line, col: t.col }
      if (t.text === 'na') return { kind: 'na', line: t.line, col: t.col }
      return { kind: 'ident', name: t.text, line: t.line, col: t.col }
    }
    if (isOp(t, '(')) {
      this.next()
      const e = this.parseTernary()
      this.expectOp(')')
      return e
    }
    // 数组字面量：前缀位置的 `[` 一定是数组（后缀位置才是历史引用 x[k]）
    if (isOp(t, '[')) {
      this.next()
      const items: Expr[] = []
      if (!isOp(this.peek(), ']')) {
        for (;;) {
          items.push(this.parseTernary())
          if (isOp(this.peek(), ',')) {
            this.next()
            continue
          }
          break
        }
      }
      this.expectOp(']')
      return { kind: 'array', items, line: t.line, col: t.col }
    }
    throw this.error(`无法解析的表达式起始符 "${t.text}"`, t)
  }

  /**
   * switch 表达式：主题之后必须跟一个缩进分支块，
   * 每行是 `条件 => 值` 或默认分支 `=> 值`。
   */
  private parseSwitch(): SwitchExpr {
    const start = this.next() // switch
    const subject = this.parseTernary()
    if (this.atKind('newline')) this.next()
    if (!this.atKind('indent')) {
      throw this.error('switch 之后期望缩进的分支块', this.peek())
    }
    this.next()
    const arms: SwitchArm[] = []
    while (!this.atKind('dedent') && !this.atKind('eof')) {
      if (this.atKind('newline')) {
        this.next()
        continue
      }
      const cond: Expr | null = isOp(this.peek(), '=>') ? null : this.parseTernary()
      this.expectOp('=>')
      const value = this.parseTernary()
      arms.push({ cond, value })
      if (this.atKind('newline')) this.next()
    }
    if (this.atKind('dedent')) {
      this.next()
      this.blockEnded = true
    }
    return { kind: 'switch', subject, arms, line: start.line, col: start.col }
  }

  /**
   * `if` 表达式：与语句级 if 同构，但整体是一个值 ——
   * 每个分支块的最后一条表达式即分支值。codegen 会把整个表达式落成 IIFE。
   */
  private parseIfExpr(): IfExpr {
    const start = this.next() // if
    const branches: IfBranch[] = []
    let elseBody: Stmt[] | undefined
    for (;;) {
      const cond = this.parseTernary()
      const body = this.parseIndentedBlock()
      branches.push({ cond, body })
      if (!isIdent(this.peek(), 'else')) break
      this.next() // else
      if (isIdent(this.peek(), 'if')) {
        this.next() // if
        continue
      }
      elseBody = this.parseIndentedBlock()
      break
    }
    this.blockEnded = true
    return { kind: 'ifExpr', branches, elseBody, line: start.line, col: start.col }
  }

  private parseCallArgs(callee: Expr, generic?: string): CallExpr {
    const open = this.expectOp('(')
    const args: CallArg[] = []
    if (!isOp(this.peek(), ')')) {
      for (;;) {
        const a = this.peek()
        const b = this.peek(1)
        if (a?.kind === 'ident' && isOp(b, '=')) {
          this.next()
          this.next()
          args.push({ name: a.text, value: this.parseTernary() })
        } else {
          args.push({ value: this.parseTernary() })
        }
        if (isOp(this.peek(), ',')) {
          this.next()
          continue
        }
        break
      }
    }
    this.expectOp(')')
    return { kind: 'call', callee, generic, args, line: open.line, col: open.col }
  }
}
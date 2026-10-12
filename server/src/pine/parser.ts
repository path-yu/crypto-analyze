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
  IfStmt,
  Program,
  Stmt,
  SwitchArm,
  SwitchExpr,
  TypeDeclStmt,
  TypeField,
  WhileStmt,
} from './ast'
import { isIdent, isOp, PineError, type Token } from './tokens'

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

    if (t.kind === 'ident') {
      switch (t.text) {
        case 'var':
          return this.parseAssign()
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

  private parseAssign(): AssignStmt {
    const start = this.peek()!
    let isVar = false
    let typeName: string | undefined
    let target: Expr

    if (isIdent(this.peek(), 'var')) {
      isVar = true
      this.next()
      const t0 = this.peek()
      if (t0?.kind === 'ident' && isOp(this.peek(1), '<')) {
        // var array<OB> zones = ...
        this.next()
        this.next()
        const arg = this.expectIdent()
        typeName = `${t0.text}<${arg.text}>`
        this.expectOp('>')
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
      if (
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

  private parseFuncDecl(): FuncDeclStmt {
    const start = this.peek()!
    const name = this.expectIdent()
    this.expectOp('(')
    const params: FuncParam[] = []
    if (!isOp(this.peek(), ')')) {
      for (;;) {
        const a = this.peek()
        const b = this.peek(1)
        if (a?.kind === 'ident' && b?.kind === 'ident') {
          params.push({ typeName: a.text, name: b.text })
          this.next()
          this.next()
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
      if (isOp(t, '.')) {
        this.next()
        const prop = this.expectIdent()
        e = { kind: 'member', object: e, property: prop.text, line: prop.line, col: prop.col }
        continue
      }
      if (isOp(t, '[')) {
        this.next()
        const idx = this.parseTernary()
        const close = this.expectOp(']')
        e = { kind: 'index', object: e, index: idx, line: close.line, col: close.col }
        continue
      }
      if (isOp(t, '(')) {
        e = this.parseCallArgs(e)
        continue
      }
      // 泛型调用 `array.new<OB>()`
      if (isOp(t, '<') && this.isGenericCall()) {
        const arg = this.peek(1)!.text
        this.next()
        this.next()
        this.next() // '<' ident '>'
        e = this.parseCallArgs(e, arg)
        continue
      }
      break
    }
    return e
  }

  /** 形如 `<Ident>(` 的泛型调用前缀 */
  private isGenericCall(): boolean {
    return (
      isOp(this.peek(), '<') &&
      this.peek(1)?.kind === 'ident' &&
      isOp(this.peek(2), '>') &&
      isOp(this.peek(3), '(')
    )
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
    if (this.atKind('dedent')) this.next()
    return { kind: 'switch', subject, arms, line: start.line, col: start.col }
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
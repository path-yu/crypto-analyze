/**
 * Pine Script AST 节点定义。
 *
 * 覆盖 v1 语法范围（两份验收脚本用到的全部语法）：
 * 类型化声明 / `var` / `type` 字段块 / 函数声明 / if-elseif-else / for /
 * break-continue / 调用（位置与具名实参混排）/ 后缀 `[k]` 与 `.field`。
 */

/* ------------------------------------------------------------------ */
/* 表达式                                                               */
/* ------------------------------------------------------------------ */

export type Expr =
  | NumberLit
  | StringLit
  | ColorLit
  | BoolLit
  | NaLit
  | Identifier
  | MemberExpr
  | IndexExpr
  | CallExpr
  | UnaryExpr
  | BinaryExpr
  | TernaryExpr
  | ArrayLit
  | SwitchExpr

export interface NumberLit {
  kind: 'number'
  value: number
  line: number
  col: number
}

export interface StringLit {
  kind: 'string'
  value: string
  line: number
  col: number
}

export interface ColorLit {
  kind: 'color'
  value: string
  line: number
  col: number
}

export interface BoolLit {
  kind: 'bool'
  value: boolean
  line: number
  col: number
}

export interface NaLit {
  kind: 'na'
  line: number
  col: number
}

export interface Identifier {
  kind: 'ident'
  name: string
  line: number
  col: number
}

export interface MemberExpr {
  kind: 'member'
  object: Expr
  property: string
  line: number
  col: number
}

/** 历史引用 `expr[k]` */
export interface IndexExpr {
  kind: 'index'
  object: Expr
  index: Expr
  line: number
  col: number
}

export interface CallArg {
  /** 具名实参名（`stop=longStop` 中的 `stop`）；位置实参为 undefined */
  name?: string
  value: Expr
}

export interface CallExpr {
  kind: 'call'
  callee: Expr
  /** 泛型实参（`array.new<OB>()` 中的 `OB`） */
  generic?: string
  args: CallArg[]
  line: number
  col: number
}

export interface UnaryExpr {
  kind: 'unary'
  op: '-' | '+' | 'not'
  operand: Expr
  line: number
  col: number
}

export interface BinaryExpr {
  kind: 'binary'
  op: string
  left: Expr
  right: Expr
  line: number
  col: number
}

export interface TernaryExpr {
  kind: 'ternary'
  cond: Expr
  then: Expr
  else: Expr
  line: number
  col: number
}

/** 数组字面量 `[a, b, c]`（Pine 里主要出现在 input 的 options 实参中） */
export interface ArrayLit {
  kind: 'array'
  items: Expr[]
  line: number
  col: number
}

/** switch 的一个分支：`cond => value`，cond 为 null 即默认分支 `=> value` */
export interface SwitchArm {
  cond: Expr | null
  value: Expr
}

/**
 * switch 表达式，如
 *   x = switch s
 *       "a" => 1
 *       => 0
 * v1 只支持「单表达式分支」，带语句块的分支会给出明确诊断。
 */
export interface SwitchExpr {
  kind: 'switch'
  subject: Expr
  arms: SwitchArm[]
  line: number
  col: number
}

/* ------------------------------------------------------------------ */
/* 语句                                                                 */
/* ------------------------------------------------------------------ */

export type Stmt =
  | AssignStmt
  | TypeDeclStmt
  | FuncDeclStmt
  | IfStmt
  | ForStmt
  | WhileStmt
  | ForInStmt
  | ExprStmt
  | BreakStmt
  | ContinueStmt

export interface AssignStmt {
  kind: 'assign'
  /** 是否带 `var` 前缀 */
  isVar: boolean
  /** 类型注解名（`float x = ...` 中的 `float`） */
  typeName?: string
  /** 赋值目标：简单标识符或成员访问 `z.used` */
  target: Expr
  op: '=' | ':='
  value: Expr
  line: number
  col: number
}

export interface TypeField {
  typeName: string
  name: string
}

export interface TypeDeclStmt {
  kind: 'typeDecl'
  name: string
  fields: TypeField[]
  line: number
  col: number
}

export interface FuncParam {
  typeName?: string
  name: string
}

export interface FuncDeclStmt {
  kind: 'funcDecl'
  name: string
  params: FuncParam[]
  body: Stmt[]
  line: number
  col: number
}

export interface IfBranch {
  cond: Expr
  body: Stmt[]
}

export interface IfStmt {
  kind: 'if'
  branches: IfBranch[]
  elseBody?: Stmt[]
  line: number
  col: number
}

export interface ForStmt {
  kind: 'for'
  varName: string
  from: Expr
  to: Expr
  body: Stmt[]
  line: number
  col: number
}

export interface WhileStmt {
  kind: 'while'
  cond: Expr
  body: Stmt[]
  line: number
  col: number
}

/** `for x in coll`：遍历数组 / map */
export interface ForInStmt {
  kind: 'forIn'
  varName: string
  iterable: Expr
  body: Stmt[]
  line: number
  col: number
}

export interface ExprStmt {
  kind: 'expr'
  expr: Expr
  line: number
  col: number
}

export interface BreakStmt {
  kind: 'break'
  line: number
  col: number
}

export interface ContinueStmt {
  kind: 'continue'
  line: number
  col: number
}

/* ------------------------------------------------------------------ */
/* 程序                                                                 */
/* ------------------------------------------------------------------ */

export interface Program {
  /** 顶层战略/指标声明决定信号的出口语义 */
  kind: 'strategy' | 'indicator' | 'unknown'
  body: Stmt[]
  version?: string
}
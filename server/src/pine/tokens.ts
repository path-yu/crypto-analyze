/**
 * Pine Script 词法单元（token）定义。
 *
 * 词法层最终输出的是**逻辑行**级别的 token 流：
 * 每个逻辑行以可选的 INDENT/DEDENT 开头，行尾跟一个 NEWLINE，
 * 文件末尾补齐 DEDENT 与 EOF。解析器只需按 INDENT/DEDENT 建块即可。
 */

import type { PineDiagnostic } from '../../../shared/types'

export type TokenKind =
  | 'number'
  | 'string'
  | 'color'
  | 'ident'
  | 'op'
  | 'newline'
  | 'indent'
  | 'dedent'
  | 'eof'

export interface Token {
  kind: TokenKind
  /** 原始文本（字符串保留引号、颜色保留 `#`，其余为字面） */
  text: string
  /** 1 起的物理行号；续行合并后各 token 仍保留自己所在的行 */
  line: number
  /** 1 起的列号 */
  col: number
  /** 所属逻辑行的缩进（空格数） */
  indent: number
  /** 数字/字符串字面量的解析值 */
  value?: number | string
}

export function makeToken(
  kind: TokenKind,
  text: string,
  line: number,
  col: number,
  indent: number,
  value?: number | string,
): Token {
  const t: Token = { kind, text, line, col, indent }
  if (value !== undefined) t.value = value
  return t
}

export function isOp(t: Token | undefined, text: string): boolean {
  return !!t && t.kind === 'op' && t.text === text
}

export function isIdent(t: Token | undefined, name: string): boolean {
  return !!t && t.kind === 'ident' && t.text === name
}

/** Pine 关键字（作为 ident 识别，解析器按文本判断） */
export const KEYWORDS = new Set([
  'var',
  'if',
  'else',
  'for',
  'to',
  'by',
  'and',
  'or',
  'not',
  'na',
  'true',
  'false',
  'break',
  'continue',
  'type',
  'while',
  'switch',
  'import',
  'export',
  'method',
])

/**
 * 编译期致命错误：携带一条诊断。
 *
 * 解析器遇到无法恢复的语法错误（缺少 `)`、缺少缩进块等）时抛出，
 * 由 `compile()` 兜底转换成返回给前端的诊断列表。
 */
export class PineError extends Error {
  readonly diagnostic: PineDiagnostic
  constructor(diagnostic: PineDiagnostic) {
    super(diagnostic.message)
    this.name = 'PineError'
    this.diagnostic = diagnostic
  }
}
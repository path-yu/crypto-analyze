/**
 * Pine Script 词法分析器。
 *
 * 处理流程（对应方案 §5.1）：
 *   1. 逐物理行剥离 `//` 注释（保留列号），并顺带捕获 `//@version=6`；
 *   2. 逐物理行扫描 token（字符串 / 数字 / 颜色 / 标识符 / 运算符）；
 *   3. 依据 R1/R2/R3 三条规则把续行合并成逻辑行；
 *   4. 按逻辑行缩进插入 INDENT/DEDENT，行尾插入 NEWLINE。
 */

import type { PineDiagnostic } from '../../../shared/types'
import { isOp, makeToken, type Token } from './tokens'

export interface LexResult {
  tokens: Token[]
  diagnostics: PineDiagnostic[]
  version?: string
}

interface PhysLine {
  line: number
  indent: number
  tokens: Token[]
}

/** R2：出现在行尾即触发续行的运算符 */
const BINARY_OPS = new Set(['+', '-', '*', '/', '%', '==', '!=', '<', '<=', '>', '>='])
/**
 * R2 的完整行尾触发集。
 *
 * 末尾的 `?` / `:` 是三目运算符没写完的标记，TradingView 里跨行的
 * `cond ? a :` 链（下一行继续写 `cond2 ? b : c`）就是靠它续行的；
 * 语句本身不可能以 `?` / `:` 结尾，因此这里不会误吞新语句。
 */
const TRAILING_OPS = new Set([...BINARY_OPS, ',', '?', ':'])
/** R3：出现在下一行行首即触发续行的运算符 */
const CONT_START_OPS = new Set([...BINARY_OPS, '?', ':', ','])
const CONT_START_WORDS = new Set(['and', 'or'])
/** 需要优先匹配的多字符运算符（含 Pine v6 的复合赋值） */
const MULTI_OPS = ['=>', ':=', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=']
const SINGLE_OPS = '+-*/%<>=()[]{},.:?'

export function tokenize(source: string): LexResult {
  const diagnostics: PineDiagnostic[] = []
  let version: string | undefined
  const phys: PhysLine[] = []
  const rawLines = source.split(/\r?\n/)

  for (let idx = 0; idx < rawLines.length; idx++) {
    const lineNo = idx + 1
    const { text, comment } = stripComment(rawLines[idx])
    if (comment) {
      const m = /^\/\/\s*@version\s*=\s*(\S+)/.exec(comment.trim())
      if (m) version = m[1]
    }
    if (text.trim() === '') continue

    const indent = countIndent(text)
    const tokens = scanLine(text, lineNo, indent, diagnostics)
    if (tokens.length === 0) continue
    phys.push({ line: lineNo, indent, tokens })
  }

  // ---- 合并续行（R1 / R2 / R3）----
  const logical: PhysLine[] = []
  let i = 0
  while (i < phys.length) {
    const first = phys[i]
    const tokens = first.tokens.slice()
    let depth = bracketDepth(first.tokens)
    let j = i
    while (j + 1 < phys.length && needsContinuation(tokens, depth, phys[j + 1], first.indent)) {
      j++
      depth += bracketDepth(phys[j].tokens)
      for (const t of phys[j].tokens) tokens.push(t)
    }
    logical.push({ line: first.line, indent: first.indent, tokens })
    i = j + 1
  }

  // ---- INDENT / DEDENT 插桩 ----
  const out: Token[] = []
  const stack: number[] = [0]
  for (const ll of logical) {
    const firstTok = ll.tokens[0]
    if (ll.indent % 4 !== 0) {
      diagnostics.push({
        line: ll.line,
        column: 1,
        severity: 'error',
        message: `缩进必须为 4 个空格的倍数，当前为 ${ll.indent} 个空格`,
      })
    }
    if (ll.indent > stack[stack.length - 1]) {
      stack.push(ll.indent)
      out.push(makeToken('indent', '<INDENT>', ll.line, firstTok.col, ll.indent))
    } else {
      while (stack.length > 1 && ll.indent < stack[stack.length - 1]) {
        stack.pop()
        out.push(makeToken('dedent', '<DEDENT>', ll.line, firstTok.col, ll.indent))
      }
      if (ll.indent !== stack[stack.length - 1]) {
        diagnostics.push({
          line: ll.line,
          column: 1,
          severity: 'error',
          message: `缩进不匹配：当前 ${ll.indent} 个空格，找不到对应的上层缩进块`,
        })
      }
    }
    for (const t of ll.tokens) out.push(t)
    const last = ll.tokens[ll.tokens.length - 1]
    out.push(makeToken('newline', '<NEWLINE>', ll.line, last.col + last.text.length, ll.indent))
  }
  const lastLine = phys.length ? phys[phys.length - 1].line : 0
  while (stack.length > 1) {
    stack.pop()
    out.push(makeToken('dedent', '<DEDENT>', lastLine, 1, 0))
  }
  out.push(makeToken('eof', '<EOF>', lastLine, 1, 0))

  return { tokens: out, diagnostics, version }
}

/* ------------------------------------------------------------------ */
/* 单行扫描                                                            */
/* ------------------------------------------------------------------ */

/** 剥离一行中的 `//` 注释；字符串内的 `//` 会被忽略 */
function stripComment(raw: string): { text: string; comment: string | null } {
  let inStr: string | null = null
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inStr = ch
      continue
    }
    if (ch === '/' && raw[i + 1] === '/') {
      return { text: raw.slice(0, i), comment: raw.slice(i) }
    }
  }
  return { text: raw, comment: null }
}

function scanLine(
  text: string,
  line: number,
  indent: number,
  diags: PineDiagnostic[],
): Token[] {
  const tokens: Token[] = []
  const n = text.length
  let i = 0
  while (i < n) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }
    const col = i + 1

    if (ch === '"' || ch === "'") {
      const { value, end, ok } = scanString(text, i)
      if (!ok) {
        diags.push({ line, column: col, severity: 'error', message: '字符串缺少结束引号' })
      }
      tokens.push(makeToken('string', text.slice(i, end), line, col, indent, value))
      i = end
      continue
    }

    if (isDigit(ch) || (ch === '.' && isDigit(text[i + 1]))) {
      const { text: numText, end } = scanNumber(text, i)
      tokens.push(makeToken('number', numText, line, col, indent, Number(numText)))
      i = end
      continue
    }

    if (ch === '#' && /^[0-9a-fA-F]{6}$/.test(text.slice(i + 1, i + 7))) {
      const hex = text.slice(i, i + 7)
      tokens.push(makeToken('color', hex, line, col, indent, hex))
      i += 7
      continue
    }

    if (isIdentStart(ch)) {
      let j = i + 1
      while (j < n && isIdentPart(text[j])) j++
      tokens.push(makeToken('ident', text.slice(i, j), line, col, indent))
      i = j
      continue
    }

    let matched = false
    for (const op of MULTI_OPS) {
      if (text.startsWith(op, i)) {
        tokens.push(makeToken('op', op, line, col, indent))
        i += op.length
        matched = true
        break
      }
    }
    if (matched) continue

    if (SINGLE_OPS.includes(ch)) {
      tokens.push(makeToken('op', ch, line, col, indent))
      i++
      continue
    }

    diags.push({ line, column: col, severity: 'error', message: `无法识别的字符 "${ch}"` })
    i++
  }
  return tokens
}

function scanString(
  text: string,
  start: number,
): { value: string; end: number; ok: boolean } {
  const quote = text[start]
  let i = start + 1
  let out = ''
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      const nx = text[i + 1]
      if (nx === 'n') out += '\n'
      else if (nx === 't') out += '\t'
      else if (nx === 'r') out += '\r'
      else if (nx === '\\') out += '\\'
      else if (nx === '"') out += '"'
      else if (nx === "'") out += "'"
      else out += nx ?? ''
      i += 2
      continue
    }
    if (ch === quote) return { value: out, end: i + 1, ok: true }
    out += ch
    i++
  }
  return { value: out, end: i, ok: false }
}

function scanNumber(text: string, start: number): { text: string; end: number } {
  let i = start
  while (i < text.length && isDigit(text[i])) i++
  if (text[i] === '.') {
    i++
    while (i < text.length && isDigit(text[i])) i++
  }
  if (text[i] === 'e' || text[i] === 'E') {
    let j = i + 1
    if (text[j] === '+' || text[j] === '-') j++
    if (isDigit(text[j])) {
      j++
      while (j < text.length && isDigit(text[j])) j++
      i = j
    }
  }
  return { text: text.slice(start, i), end: i }
}

/** 统计行首缩进：Tab 按 4 空格折算（TradingView 编辑器允许 Tab 缩进） */
function countIndent(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === ' ') n++
    else if (ch === '\t') n += 4
    else break
  }
  return n
}

/* ------------------------------------------------------------------ */
/* 续行规则                                                            */
/* ------------------------------------------------------------------ */

function bracketDepth(tokens: Token[]): number {
  let d = 0
  for (const t of tokens) {
    if (t.kind !== 'op') continue
    if (t.text === '(' || t.text === '[' || t.text === '{') d++
    else if (t.text === ')' || t.text === ']' || t.text === '}') d--
  }
  return d
}

function needsContinuation(
  acc: Token[],
  depth: number,
  next: PhysLine,
  baseIndent: number,
): boolean {
  // R1：括号未闭合
  if (depth > 0) return true

  // R2：行尾为逗号 / 二元运算符 / 三目运算符 / and / or
  const last = acc[acc.length - 1]
  if (last) {
    if (last.kind === 'op' && TRAILING_OPS.has(last.text)) return true
    if (last.kind === 'ident' && CONT_START_WORDS.has(last.text)) return true
  }

  // R3：下一行缩进更深且以续行符号开头
  if (next.indent > baseIndent) {
    const f = next.tokens[0]
    if (f.kind === 'op' && CONT_START_OPS.has(f.text)) return true
    if (f.kind === 'ident' && CONT_START_WORDS.has(f.text)) return true
  }
  return false
}

/* ------------------------------------------------------------------ */
/* 字符判定                                                            */
/* ------------------------------------------------------------------ */

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9'
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch)
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch)
}

/** 供解析器复用：判断某个 token 是否是注释起始（内部使用，仅导出用于测试） */
export { isOp }
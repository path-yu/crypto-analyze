/**
 * Pine 编译编排：lexer → parser → check → codegen。
 *
 * 与 `execute.ts` 分离，是为了让「实时编译」（编辑器里只要 TS 文本与诊断）
 * 不必付出 vm 执行的代价。
 */

import type { PineCompileMeta, PineDiagnostic } from '../../../shared/types'
import { tokenize } from './lexer'
import { parse } from './parser'
import { check } from './check'
import { generate } from './codegen'
import { PineError } from './tokens'

export interface CompileResult {
  /** 编译产物（TypeScript 源码） */
  ts: string
  meta: PineCompileMeta
  diagnostics: PineDiagnostic[]
  /** 是否没有任何 error 级诊断 */
  ok: boolean
}

const EMPTY_META: PineCompileMeta = {
  kind: 'indicator',
  config: {},
  inputs: [],
  plotTitles: [],
  alerts: [],
}

export function compilePine(source: string, opts: { sourceName?: string } = {}): CompileResult {
  const diagnostics: PineDiagnostic[] = []
  const lex = tokenize(source)
  diagnostics.push(...lex.diagnostics)

  let ts = ''
  let meta: PineCompileMeta = EMPTY_META

  try {
    const parsed = parse(lex.tokens, lex.version)
    diagnostics.push(...parsed.diagnostics)
    diagnostics.push(...check(parsed.program))
    const gen = generate(parsed.program, opts)
    ts = gen.ts
    meta = gen.meta
    diagnostics.push(...gen.diagnostics)
  } catch (e) {
    if (e instanceof PineError) diagnostics.push(e.diagnostic)
    else throw e
  }

  return {
    ts,
    meta,
    diagnostics,
    ok: !diagnostics.some((d) => d.severity === 'error'),
  }
}
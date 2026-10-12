/**
 * Pine Script 语义检查。
 *
 * v1 覆盖的检查项（对应方案 §5.3）：
 *   1. 未定义标识符；
 *   2. `[k]` 历史引用的可用性 —— 仅支持内置变量、顶层预计算数组、
 *      顶层无条件赋值变量与 `strategy.position_size`；对局部变量报错；
 *   3. 用户函数实参个数；
 *   4. `na` 参与比较的提示（在 parser 中已产出，这里不重复）。
 */

import type { PineDiagnostic } from '../../../shared/types'
import type { Expr, Program, Stmt } from './ast'

/** 具备历史序列的内置变量（`close[1]` 合法） */
const BUILTIN_HIST = new Set(['open', 'high', 'low', 'close', 'volume', 'time', 'hl2', 'hlc3', 'ohlc4'])
/** 可用作裸标识符的内置量 */
const BUILTIN_IDENTS = new Set([
  ...BUILTIN_HIST,
  'bar_index',
  'timenow',
  'last_bar_index',
  'last_bar_time',
  'last_bar_time_close',
  'time_close',
  'time_tradingday',
  'hlcc4',
  'na',
  'true',
  'false',
])
/** 命名空间根（`ta.* / math.* / strategy.* …`），无需事先声明 */
const NAMESPACE_ROOTS = new Set([
  'ta', 'math', 'str', 'session', 'input', 'strategy', 'syminfo', 'color', 'size',
  'location', 'shape', 'plot', 'label', 'box', 'array', 'matrix', 'map', 'table',
  'chart', 'text', 'format', 'request', 'line', 'polyline', 'linefill', 'timeframe',
  'currency', 'dayofweek', 'display', 'alert', 'barstate', 'runtime',
  // 枚举命名空间（`position.top_right` / `yloc.belowbar` / `order.ascending` …）
  'position', 'order', 'scale', 'font', 'hline', 'yloc', 'xloc', 'extend', 'barmerge',
  'adjustment', 'backadjustment', 'settlement_as_close', 'earnings', 'dividends', 'splits',
  'dayofmonth', 'month', 'weekofyear', 'hour', 'minute', 'second', 'year',
  'log', 'ticker', 'time',
])
/** 顶层内置函数（直接调用，无命名空间前缀） */
const BUILTIN_FUNCS = new Set([
  'indicator', 'strategy', 'library', 'nz', 'plot', 'plotshape', 'plotchar', 'plotarrow',
  'plotcandle', 'plotbar', 'barcolor', 'bgcolor', 'fill', 'hline', 'alertcondition', 'alert',
  'timestamp', 'ticker', 'timeframe', 'input', 'request', 'color',
  // 类型转换函数与类型名本身
  'float', 'int', 'bool', 'string',
])

export function check(program: Program): PineDiagnostic[] {
  const diags: PineDiagnostic[] = []

  const topLevelScalars = new Set<string>()
  const topLevelPrecalc = new Set<string>()
  const globals = new Set<string>()
  const funcArity = new Map<string, number>()

  // ---- 第一遍：收集顶层声明 ----
  for (const stmt of program.body) {
    if (stmt.kind === 'assign') {
      const name = targetName(stmt)
      if (!name) continue
      globals.add(name)
      if (!stmt.isVar) {
        topLevelScalars.add(name)
        if (isTaCall(stmt.value)) topLevelPrecalc.add(name)
      }
    } else if (stmt.kind === 'typeDecl') {
      globals.add(stmt.name)
    } else if (stmt.kind === 'funcDecl') {
      globals.add(stmt.name)
      funcArity.set(stmt.name, stmt.params.length)
    }
  }

  const scope = new Set<string>(globals)
  const locals = new Set<string>()

  const err = (e: { line: number; col: number }, message: string) => {
    diags.push({ line: e.line, column: e.col, severity: 'error', message })
  }

  const checkExpr = (e: Expr): void => {
    switch (e.kind) {
      case 'ident':
        if (
          !scope.has(e.name) &&
          !BUILTIN_IDENTS.has(e.name) &&
          !NAMESPACE_ROOTS.has(e.name) &&
          !BUILTIN_FUNCS.has(e.name)
        ) {
          err(e, `未定义的标识符 "${e.name}"`)
        }
        return
      case 'member':
        checkExpr(e.object)
        return
      case 'index': {
        checkExpr(e.index)
        const base = e.object
        if (base.kind === 'ident') {
          if (BUILTIN_HIST.has(base.name) || topLevelPrecalc.has(base.name)) return
          if (topLevelScalars.has(base.name)) return
          if (locals.has(base.name)) {
            err(
              e,
              `v1 暂不支持对局部变量 "${base.name}" 的 [k] 历史引用（仅支持内置变量、顶层预计算数组与顶层无条件赋值变量）`,
            )
            return
          }
          err(e, `无法对 "${base.name}" 进行 [k] 历史引用`)
          return
        }
        if (isStrategyPosition(base)) return
        err(e, '[k] 历史引用的目标必须是变量或 strategy.position_size')
        return
      }
      case 'call': {
        checkExpr(e.callee)
        if (e.callee.kind === 'ident' && funcArity.has(e.callee.name)) {
          const expected = funcArity.get(e.callee.name)!
          if (e.args.length !== expected) {
            err(e, `函数 "${e.callee.name}" 需要 ${expected} 个参数，实际传入 ${e.args.length} 个`)
          }
        }
        for (const a of e.args) checkExpr(a.value)
        return
      }
      case 'unary':
        checkExpr(e.operand)
        return
      case 'binary':
        checkExpr(e.left)
        checkExpr(e.right)
        return
      case 'ternary':
        checkExpr(e.cond)
        checkExpr(e.then)
        checkExpr(e.else)
        return
      case 'array':
        for (const it of e.items) checkExpr(it)
        return
      case 'switch':
        checkExpr(e.subject)
        for (const arm of e.arms) {
          if (arm.cond) checkExpr(arm.cond)
          checkExpr(arm.value)
        }
        return
      default:
        return
    }
  }

  const walk = (stmts: Stmt[], nested: boolean): void => {
    for (const s of stmts) {
      switch (s.kind) {
        case 'assign': {
          checkExpr(s.value)
          if (s.op === ':=') {
            if (s.target.kind === 'member') checkExpr(s.target.object)
            else if (s.target.kind === 'ident' && !scope.has(s.target.name)) {
              err(s.target, `赋值目标 "${s.target.name}" 尚未声明`)
            }
          } else {
            const name = targetName(s)
            if (name) {
              scope.add(name)
              if (nested) locals.add(name)
            }
          }
          break
        }
        case 'expr':
          checkExpr(s.expr)
          break
        case 'if':
          for (const br of s.branches) {
            checkExpr(br.cond)
            walk(br.body, true)
          }
          if (s.elseBody) walk(s.elseBody, true)
          break
        case 'for':
          checkExpr(s.from)
          checkExpr(s.to)
          scope.add(s.varName)
          locals.add(s.varName)
          walk(s.body, true)
          break
        case 'while':
          checkExpr(s.cond)
          walk(s.body, true)
          break
        case 'forIn':
          checkExpr(s.iterable)
          scope.add(s.varName)
          locals.add(s.varName)
          walk(s.body, true)
          break
        case 'tupleAssign':
          checkExpr(s.value)
          // `=` 形式就地引入新名字（Pine 的元组解构）；`:=` 形式写给已存在的名字
          if (s.op === '=') {
            for (const n of s.names) {
              scope.add(n)
              locals.add(n)
            }
          }
          break
        case 'funcDecl':
          for (const p of s.params) {
            scope.add(p.name)
            locals.add(p.name)
          }
          walk(s.body, true)
          break
        case 'typeDecl':
        case 'break':
        case 'continue':
          break
        default:
          break
      }
    }
  }

  walk(program.body, false)
  return diags
}

/* ------------------------------------------------------------------ */

function targetName(stmt: Stmt): string | null {
  if (stmt.kind !== 'assign') return null
  return stmt.target.kind === 'ident' ? stmt.target.name : null
}

function isTaCall(e: Expr): boolean {
  return (
    e.kind === 'call' &&
    e.callee.kind === 'member' &&
    e.callee.object.kind === 'ident' &&
    e.callee.object.name === 'ta'
  )
}

function isStrategyPosition(e: Expr): boolean {
  return (
    e.kind === 'member' &&
    e.property === 'position_size' &&
    e.object.kind === 'ident' &&
    e.object.name === 'strategy'
  )
}
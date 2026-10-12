/**
 * Pine 解析引擎测试。
 *
 * 里程碑对应：
 *   M1 词法：注释剥离、续行合并、INDENT/DEDENT、行列号
 *   M2 语法：AST 完整性与诊断
 *   M3 求值：表达式与 ta.* 通路的数值一致性
 *   M4 状态机：type/array/for/var/函数
 *   M5 回测：与手写 OrderBlockTracker 逐笔一致
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Candle, StrategyParams } from '../../../shared/types'
import { DEFAULT_ORDER_BLOCK, DEFAULT_STRATEGY_PARAMS } from '../../../shared/types'
import type { Token } from '../pine/tokens'
import { PineError } from '../pine/tokens'
import { tokenize } from '../pine/lexer'
import { parse } from '../pine/parser'
import { check } from '../pine/check'
import type { Program } from '../pine/ast'
import { compilePine } from '../pine/compile'
import { emptyPineSignal, runPineProgram } from '../pine/execute'
import * as taLib from '../indicators/ta'
import { emptyOrderBlockSignal, OrderBlockTracker } from '../indicators/orderBlock'
import { runBacktest } from '../backtest/engine'
import { at, makeRing, push, hist, isNa } from '../pine/runtime'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PINE_DIR = path.resolve(__dirname, '../../pine')

function readPine(name: string): string {
  return fs.readFileSync(path.join(PINE_DIR, name), 'utf8')
}

/** 把 token 流还原成逻辑行（忽略 INDENT/DEDENT/NEWLINE/EOF） */
function logicalLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = []
  let cur: Token[] = []
  for (const t of tokens) {
    if (t.kind === 'indent' || t.kind === 'dedent') continue
    if (t.kind === 'newline' || t.kind === 'eof') {
      if (cur.length) lines.push(cur)
      cur = []
      continue
    }
    cur.push(t)
  }
  return lines
}

function texts(line: Token[]): string[] {
  return line.map((t) => t.text)
}

/* ================================================================== */
/* M1 词法                                                             */
/* ================================================================== */

test('M1: 两份脚本零词法错误并捕获 @version', () => {
  for (const name of ['test.pine', 'test1.pine']) {
    const res = tokenize(readPine(name))
    const errors = res.diagnostics.filter((d) => d.severity === 'error')
    assert.deepEqual(errors, [], `${name} 不应有词法错误`)
    assert.equal(res.version, '6', `${name} 应识别 @version=6`)
  }
})

test('M1: test.pine 的 strategy() 声明合并为 1 个逻辑行（L6-L8）', () => {
  const res = tokenize(readPine('test.pine'))
  const lines = logicalLines(res.tokens)
  const decl = lines.find((l) => l[0].text === 'strategy')
  assert.ok(decl, '应存在以 strategy 开头的逻辑行')
  const tx = texts(decl)
  assert.equal(tx[0], 'strategy')
  assert.ok(tx.includes('slippage'), '合并后的逻辑行应包含 slippage')
  assert.equal(tx[tx.length - 1], ')', '逻辑行应以 ) 结束')
  // 合并后首行行号应为 6
  assert.equal(decl[0].line, 6)
})

test('M1: test.pine 的 bullImpulse 跨 3 行合并（L71-L73）', () => {
  const res = tokenize(readPine('test.pine'))
  const lines = logicalLines(res.tokens)
  const line = lines.find((l) => l[0].text === 'bool' && l[1]?.text === 'bullImpulse')
  assert.ok(line, '应存在 bullImpulse 声明')
  const tx = texts(line)
  assert.ok(tx.includes('needBreak') && tx.includes('needOpp'), '两段 and 续行都应合并进来')
  assert.equal(line[0].line, 71)
})

test('M1: 缩进块产生正确的 INDENT/DEDENT 配对', () => {
  const res = tokenize(readPine('test.pine'))
  let depth = 0
  let minDepth = 0
  for (const t of res.tokens) {
    if (t.kind === 'indent') depth++
    if (t.kind === 'dedent') depth--
    if (depth < minDepth) minDepth = depth
  }
  assert.equal(depth, 0, 'INDENT 与 DEDENT 应严格配对')
  assert.equal(minDepth, 0, '不应出现负深度')
})

test('M1: 颜色字面量与转义字符串被正确扫描', () => {
  const res = tokenize(readPine('test1.pine'))
  const colors = res.tokens.filter((t) => t.kind === 'color').map((t) => t.text)
  assert.ok(colors.includes('#089981') && colors.includes('#f23645'), '应识别六位十六进制颜色')
  const escaped = res.tokens.find((t) => t.kind === 'string' && typeof t.value === 'string' && t.value.includes('\n'))
  assert.ok(escaped, '应把 \\n 反转义为换行符')
})

test('M1: 缩进非 4 的倍数时报错并带行列号', () => {
  const res = tokenize('x = 1\n  y = 2\n')
  const err = res.diagnostics.find((d) => d.message.includes('4 个空格'))
  assert.ok(err, '应报告缩进错误')
  assert.equal(err?.line, 2)
})

/* ================================================================== */
/* M2 语法 + 语义                                                       */
/* ================================================================== */

interface FrontResult {
  program: Program | null
  diagnostics: { line: number; column: number; severity: string; message: string }[]
}

/** tokenize → parse → check 的组合（compile 的前半段） */
function frontEnd(source: string): FrontResult {
  const lex = tokenize(source)
  const diagnostics = [...lex.diagnostics]
  try {
    const { program, diagnostics: parseDiags } = parse(lex.tokens, lex.version)
    diagnostics.push(...parseDiags)
    diagnostics.push(...check(program))
    return { program, diagnostics }
  } catch (e) {
    if (e instanceof PineError) {
      diagnostics.push(e.diagnostic)
      return { program: null, diagnostics }
    }
    throw e
  }
}

test('M2: 两份脚本解析 + 语义检查零 error', () => {
  for (const name of ['test.pine', 'test1.pine']) {
    const { program, diagnostics } = frontEnd(readPine(name))
    const errors = diagnostics.filter((d) => d.severity === 'error')
    assert.deepEqual(errors, [], `${name} 不应有 error：${JSON.stringify(errors)}`)
    assert.ok(program, `${name} 应解析出 AST`)
  }
})

test('M2: test.pine 识别 strategy 种类 / type OB(7 字段) / 2 个函数', () => {
  const { program } = frontEnd(readPine('test.pine'))
  assert.equal(program?.kind, 'strategy')
  const typeDecl = program?.body.find((s) => s.kind === 'typeDecl')
  assert.ok(typeDecl && typeDecl.kind === 'typeDecl')
  assert.equal(typeDecl.name, 'OB')
  assert.equal(typeDecl.fields.length, 7)
  assert.deepEqual(
    typeDecl.fields.map((f) => f.name),
    ['top', 'bottom', 'impVol', 'bornBar', 'isBull', 'used', 'bx'],
  )
  const funcs = program?.body.filter((s) => s.kind === 'funcDecl') ?? []
  assert.deepEqual(funcs.map((f) => (f.kind === 'funcDecl' ? f.name : '')), ['f_overlaps', 'f_addZone'])
})

test('M2: test1.pine 识别 indicator 种类且 if/else 嵌套正确', () => {
  const { program } = frontEnd(readPine('test1.pine'))
  assert.equal(program?.kind, 'indicator')
  // 顶层应存在包含 else 分支的 if（止损阻断逻辑）
  const withElse = program?.body.find((s) => s.kind === 'if' && s.elseBody !== undefined)
  assert.ok(withElse, '应存在带 else 的 if 语句')
})

test('M2: 语法错误时给出正确的行列号', () => {
  const src = ['//@version=6', 'x = 1', 'y = (1 + 2'].join('\n')
  const { program, diagnostics } = frontEnd(src)
  assert.equal(program, null)
  const err = diagnostics.find((d) => d.severity === 'error')
  assert.ok(err, '应产出语法错误诊断')
  assert.equal(err?.line, 3, '错误行号应为 3')
})

test('M2: 局部变量的 [k] 历史引用被拒绝并给出清晰提示', () => {
  const src = [
    '//@version=6',
    'indicator("t")',
    'if close > open',
    '    float local = close',
    '    float bad = local[1]',
  ].join('\n')
  const { diagnostics } = frontEnd(src)
  const err = diagnostics.find((d) => d.severity === 'error' && d.message.includes('局部变量'))
  assert.ok(err, '应对局部变量 [k] 报错')
  assert.equal(err?.line, 5)
})

/* ================================================================== */
/* M3 求值：表达式与 ta.* 通路                                          */
/* ================================================================== */

/** 与 runtime.ts 一致的 na-safe 比较助手（任一操作数为 na 恒为 false） */
const pEq = (a: unknown, b: unknown): boolean => (isNa(a) || isNa(b) ? false : a === b)
const pNeq = (a: unknown, b: unknown): boolean => (isNa(a) || isNa(b) ? false : a !== b)
const pLt = (a: unknown, b: unknown): boolean =>
  isNa(a) || isNa(b) ? false : (a as number) < (b as number)
const pLe = (a: unknown, b: unknown): boolean =>
  isNa(a) || isNa(b) ? false : (a as number) <= (b as number)
const pGt = (a: unknown, b: unknown): boolean =>
  isNa(a) || isNa(b) ? false : (a as number) > (b as number)
const pGe = (a: unknown, b: unknown): boolean =>
  isNa(a) || isNa(b) ? false : (a as number) >= (b as number)

/** 确定性序列：保证既出现连续阳线突破（raw_buy）又出现连续阴线破位（raw_sell） */
const M3_SEQ = [0, 1, 2, 4, 3, 2, 1, -1, -2, -3, -4, -2]

/** 合成确定性 K 线（重复 M3_SEQ 六轮） */
function synthCandles(): Candle[] {
  const out: Candle[] = []
  const total = M3_SEQ.length * 6
  for (let i = 0; i < total; i++) {
    const o = 100 + M3_SEQ[i % M3_SEQ.length]
    const c = 100 + M3_SEQ[(i + 1) % M3_SEQ.length]
    out.push({
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      open: o,
      high: Math.max(o, c) + 0.2,
      low: Math.min(o, c) - 0.2,
      close: c,
      volume: 1000 + (i % 7) * 10,
    })
  }
  return out
}

/** test1.pine 中被观测的顶层变量（逐 bar 探针） */
const PROBE_KEYS = [
  'is_green', 'is_red', 'prev_green', 'prev_red', 'prev_high', 'prev_low',
  'combo_low', 'combo_high', 'raw_buy', 'raw_sell',
  'signal_state', 'last_buy_price', 'last_sell_price', 'valid_buy', 'valid_sell',
  'mem_buy', 'mem_sell',
  'active_sl', 'sl_type', 'break_buy_sl', 'break_sell_sl', 'allow_plot',
  'final_buy', 'final_sell', 'static_sl', 'static_sl_type',
  'live_dir', 'live_entry', 'live_sl', 'live_tp1', 'live_tp2', 'live_tp3',
  'live_start', 'live_active', 'live_end_idx', 'trade_high', 'trade_low',
  'max_sl_heat', 'tp1_reached', 'is_new_buy', 'is_new_sell',
  'hitTP1', 'hitTP2', 'hitTP3',
  'visual_state', 'plot_buy', 'plot_sell', 'is_gray', 'paint_green', 'paint_red',
  'en_slope_filter', 'en_sl_blocking',
] as const

/** 追加到 test1.pine 末尾的探针（都排在原 plot 之后，不会抢占 __ind_sl 捕获） */
const M3_PROBES = PROBE_KEYS.map((k) => `plot(${k}, title="probe_${k}")`).join('\n')

/**
 * test1.pine 的**独立参考实现** —— 用与 codegen 产物逐字节对齐的表达式结构
 * （na-safe 比较、`&&`/`||` 短路、`Math.min/max` 顺序）复刻脚本语义，
 * 从而可用 `Object.is`（含 NaN）逐 bar 精确比对。
 */
function referenceSnapshots(
  candles: readonly Candle[],
  opts: { enScalping: boolean; tickSize: number },
): Record<string, unknown>[] {
  const en_scalping = opts.enScalping
  const en_slope_filter = en_scalping
  const en_sl_blocking = !en_scalping
  const en_static_sl = true
  const rr1 = 1.0
  const rr2 = 2.0
  const rr3 = 3.0
  const mintick = opts.tickSize

  const O = candles.map((c) => c.open)
  const H = candles.map((c) => c.high)
  const L = candles.map((c) => c.low)
  const Cl = candles.map((c) => c.close)

  // var 状态
  let signal_state = 0
  let last_buy_price: number = NaN
  let last_sell_price: number = NaN
  let active_sl: number = NaN
  let sl_type = 0
  let static_sl: number = NaN
  let static_sl_type = 0
  let live_entry: number = NaN
  let live_sl: number = NaN
  let live_tp1: number = NaN
  let live_tp2: number = NaN
  let live_tp3: number = NaN
  let live_dir = 0
  let live_start: number = NaN
  let live_active = false
  let live_end_idx: number = NaN
  let trade_high: number = NaN
  let trade_low: number = NaN
  let max_sl_heat: number = NaN
  let tp1_reached = false
  let visual_state = 0

  const ringGreen = makeRing(2)
  const ringRed = makeRing(2)

  const snaps: Record<string, unknown>[] = []

  for (let i = 0; i < candles.length; i++) {
    const open = O[i]
    const high = H[i]
    const low = L[i]
    const close = Cl[i]

    const same_session = !(i === 0)

    const is_green = pGt(close, open)
    const is_red = pLt(close, open)
    push(ringGreen, is_green)
    push(ringRed, is_red)
    const prev_green = hist(ringGreen, 1)
    const prev_red = hist(ringRed, 1)
    const prev_high = at(H, i, 1)
    const prev_low = at(L, i, 1)

    const combo_low = Math.min(low, prev_low as number)
    const combo_high = Math.max(high, prev_high as number)

    const raw_buy = (same_session && prev_green) && is_green && pGt(close, prev_high)
    const raw_sell = (same_session && prev_red) && is_red && pLt(close, prev_low)

    if (i === 0) {
      signal_state = 0
      last_buy_price = NaN
      last_sell_price = NaN
    }

    const valid_buy = raw_buy && pNeq(signal_state, 1)
    const valid_sell = raw_sell && pNeq(signal_state, -1)

    let mem_buy = valid_buy
    if (en_slope_filter && !isNa(last_buy_price)) {
      mem_buy = valid_buy && pGt(close, last_buy_price)
    }
    let mem_sell = valid_sell
    if (en_slope_filter && !isNa(last_sell_price)) {
      mem_sell = valid_sell && pLt(close, last_sell_price)
    }

    if (valid_buy) {
      signal_state = 1
      last_buy_price = close
    } else if (valid_sell) {
      signal_state = -1
      last_sell_price = close
    }

    if (i === 0) {
      active_sl = NaN
      sl_type = 0
    }

    const break_buy_sl = pEq(sl_type, 1) && pLt(close, active_sl)
    const break_sell_sl = pEq(sl_type, -1) && pGt(close, active_sl)

    if (break_buy_sl) {
      active_sl = NaN
      sl_type = 0
    } else if (break_sell_sl) {
      active_sl = NaN
      sl_type = 0
    }

    const allow_plot = !en_sl_blocking || isNa(active_sl)
    const final_buy = mem_buy && allow_plot
    const final_sell = mem_sell && allow_plot

    if (final_buy && en_sl_blocking) {
      active_sl = combo_low
      sl_type = 1
    } else if (final_sell && en_sl_blocking) {
      active_sl = combo_high
      sl_type = -1
    }

    if (i === 0) {
      static_sl = NaN
      static_sl_type = 0
    }
    if (!en_sl_blocking) {
      if (final_buy && pNeq(static_sl_type, 1)) {
        static_sl = combo_low
        static_sl_type = 1
      } else if (final_sell && pNeq(static_sl_type, -1)) {
        static_sl = combo_high
        static_sl_type = -1
      }
    } else {
      static_sl = NaN
      static_sl_type = 0
    }

    const is_new_buy = final_buy && pNeq(live_dir, 1)
    const is_new_sell = final_sell && pNeq(live_dir, -1)

    if (i === 0) {
      live_active = false
      live_dir = 0
      tp1_reached = false
    }

    if (is_new_buy && !en_sl_blocking) {
      live_dir = 1
      live_entry = close
      live_sl = combo_low
      const risk = Math.max(Math.abs(close - live_sl), mintick)
      const tp1_base = risk * rr1
      const tp2_base = tp1_base + risk * (rr2 - rr1)
      const tp3_base = tp1_base + risk * (rr3 - rr1)
      live_tp1 = close + tp1_base
      live_tp2 = close + tp2_base
      live_tp3 = close + tp3_base
      live_start = i
      live_active = true
      live_end_idx = i + 4
      trade_high = close
      trade_low = close
      max_sl_heat = -Math.max(Math.abs(close - live_sl), mintick)
      tp1_reached = false
    }

    if (is_new_sell && !en_sl_blocking) {
      live_dir = -1
      live_entry = close
      live_sl = combo_high
      const risk = Math.max(Math.abs(close - live_sl), mintick)
      const tp1_base = risk * rr1
      const tp2_base = tp1_base + risk * (rr2 - rr1)
      const tp3_base = tp1_base + risk * (rr3 - rr1)
      live_tp1 = close - tp1_base
      live_tp2 = close - tp2_base
      live_tp3 = close - tp3_base
      live_start = i
      live_active = true
      live_end_idx = i + 4
      trade_high = close
      trade_low = close
      max_sl_heat = -Math.max(Math.abs(close - live_sl), mintick)
      tp1_reached = false
    }

    if (live_active && !en_sl_blocking) {
      trade_high = Math.max(trade_high, high)
      trade_low = Math.min(trade_low, low)
      if (i > live_start && !tp1_reached) {
        const sl_dist = pEq(live_dir, 1) ? live_sl - low : high - live_sl
        max_sl_heat = Math.max(max_sl_heat, sl_dist)
      }
      if ((pEq(live_dir, 1) && final_sell) || (pEq(live_dir, -1) && final_buy)) {
        live_active = false
      }
    }

    let hitTP1 = false
    let hitTP2 = false
    let hitTP3 = false

    if (pNeq(live_dir, 0) && !(is_new_buy || is_new_sell) && !en_sl_blocking) {
      if (pEq(live_dir, 1)) {
        hitTP1 = pGe(trade_high, live_tp1)
        hitTP2 = pGe(trade_high, live_tp2)
        hitTP3 = pGe(trade_high, live_tp3)
      } else if (pEq(live_dir, -1)) {
        hitTP1 = pLe(trade_low, live_tp1)
        hitTP2 = pLe(trade_low, live_tp2)
        hitTP3 = pLe(trade_low, live_tp3)
      }
      if (hitTP1) tp1_reached = true
      if (live_active) live_end_idx = i + 4
    }

    if (i === 0) visual_state = 0

    let plot_buy = final_buy
    let plot_sell = final_sell
    if (en_scalping) {
      plot_buy = final_buy && pNeq(visual_state, 1)
      plot_sell = final_sell && pNeq(visual_state, -1)
    }
    if (final_buy) visual_state = 1
    else if (final_sell) visual_state = -1

    const paint_green = break_sell_sl && !final_buy
    const paint_red = break_buy_sl && !final_sell
    const is_gray =
      en_static_sl && !en_sl_blocking &&
      ((pEq(static_sl_type, 1) && pLt(close, static_sl)) ||
        (pEq(static_sl_type, -1) && pGt(close, static_sl)))

    snaps.push({
      is_green, is_red, prev_green, prev_red, prev_high, prev_low,
      combo_low, combo_high, raw_buy, raw_sell,
      signal_state, last_buy_price, last_sell_price, valid_buy, valid_sell,
      mem_buy, mem_sell,
      active_sl, sl_type, break_buy_sl, break_sell_sl, allow_plot,
      final_buy, final_sell, static_sl, static_sl_type,
      live_dir, live_entry, live_sl, live_tp1, live_tp2, live_tp3,
      live_start, live_active, live_end_idx, trade_high, trade_low,
      max_sl_heat, tp1_reached, is_new_buy, is_new_sell,
      hitTP1, hitTP2, hitTP3,
      visual_state, plot_buy, plot_sell, is_gray, paint_green, paint_red,
      en_slope_filter, en_sl_blocking,
    })
  }
  return snaps
}

test('M3: test1.pine 逐 bar 数值与参考实现完全一致（默认与 scalp 两种配置）', () => {
  const candles = synthCandles()
  const src = `${readPine('test1.pine')}\n${M3_PROBES}\n`
  const comp = compilePine(src, { sourceName: 'test1.pine' })
  assert.deepEqual(
    comp.diagnostics.filter((d) => d.severity === 'error'),
    [],
    `M3 编译不应有 error：${JSON.stringify(comp.diagnostics)}`,
  )
  assert.equal(comp.meta.kind, 'indicator')

  for (const enScalping of [false, true]) {
    const prog = runPineProgram(comp.ts, candles, {
      inputs: { en_scalping: enScalping },
      tickSize: 0.01,
    })
    const ref = referenceSnapshots(candles, { enScalping, tickSize: 0.01 })

    let buyCount = 0
    let sellCount = 0

    for (let i = 0; i < candles.length; i++) {
      const sig = prog.step(i, {
        flat: true,
        positionSize: 0,
        prevPositionSize: 0,
        avgPrice: NaN,
        side: null,
      })

      for (const key of PROBE_KEYS) {
        const actual = prog.plots[`probe_${key}`]?.[i]
        assert.ok(
          Object.is(actual, ref[i][key]),
          `enScalping=${enScalping} bar=${i} ${key}: 产物 ${String(actual)} ≠ 参考 ${String(ref[i][key])}`,
        )
      }

      const plotBuy = ref[i].plot_buy as boolean
      const plotSell = ref[i].plot_sell as boolean
      assert.equal(sig.canLong, !isNa(plotBuy ? candles[i].low : NaN), `bar=${i} canLong`)
      assert.equal(sig.canShort, !isNa(plotSell ? candles[i].high : NaN), `bar=${i} canShort`)
      assert.ok(Object.is(sig.obStopLoss, ref[i].active_sl), `bar=${i} obStopLoss`)
      assert.ok(Number.isNaN(sig.obTakeProfit), `bar=${i} obTakeProfit 应为 na`)

      if (plotBuy) buyCount++
      if (plotSell) sellCount++
    }

    assert.ok(buyCount > 0, `enScalping=${enScalping} 应至少出现一次 final_buy`)
    if (enScalping) {
      assert.ok(sellCount > 0, 'scalp 配置应至少出现一次 final_sell')
    }
  }
})

test('M3: ta.* 预计算数组与 [k] 引用和 ta.ts 实现完全一致', () => {
  const candles = synthCandles()
  const src = [
    '//@version=6',
    'indicator("M3 ta", overlay=true)',
    '',
    'int   len     = input.int(5, "len")',
    'float smaV    = ta.sma(close, len)',
    'float emaV    = ta.ema(close, len)',
    'float atrV    = ta.atr(len)',
    'float hiV     = ta.highest(high, len)',
    'float loV     = ta.lowest(low, len)',
    'float smaPrev = smaV[1]',
    '',
    'plot(smaV, title="sma")',
    'plot(emaV, title="ema")',
    'plot(atrV, title="atr")',
    'plot(hiV, title="hi")',
    'plot(loV, title="lo")',
    'plot(smaPrev, title="sma_prev")',
  ].join('\n')

  const comp = compilePine(src, { sourceName: 'm3-ta.pine' })
  assert.deepEqual(
    comp.diagnostics.filter((d) => d.severity === 'error'),
    [],
    `ta 编译不应有 error：${JSON.stringify(comp.diagnostics)}`,
  )

  const prog = runPineProgram(comp.ts, candles, { tickSize: 0.01 })

  const closes = candles.map((c) => c.close)
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)
  const len = 5
  const sma = taLib.sma(closes, len)
  const expected: Record<string, number[]> = {
    sma,
    ema: taLib.ema(closes, len),
    atr: taLib.atr(highs, lows, closes, len, 'RMA'),
    hi: taLib.highest(highs, len),
    lo: taLib.lowest(lows, len),
    sma_prev: sma.map((_, i) => at(sma, i, 1) as number),
  }

  for (let i = 0; i < candles.length; i++) {
    prog.step(i, { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: NaN, side: null })
    for (const [title, series] of Object.entries(expected)) {
      assert.ok(
        Object.is(prog.plots[title][i], series[i]),
        `bar=${i} ${title}: 产物 ${String(prog.plots[title][i])} ≠ 参考 ${String(series[i])}`,
      )
    }
  }
})

/* ================================================================== */
/* M4 状态机：test.pine 产物与手写 OrderBlockTracker 逐 bar 一致         */
/* ================================================================== */

/** M4 合成 K 线：铺垫 → 多头脉冲/回踩 → 空头脉冲/回踩 → 多头脉冲/回踩 */
function m4Candles(): Candle[] {
  const f = (): [number, number, number, number, number] => [100, 100.5, 99.5, 100, 10]
  const rows: Array<[number, number, number, number, number]> = [
    ...Array.from({ length: 8 }, f),
    [100, 106, 99.8, 105.5, 30], // 8：多头脉冲 → 区域 [99.5, 100.5]
    [103, 104, 100.2, 103.5, 12], // 9：回踩 → 多头信号
    [102, 102.5, 101.5, 102, 10],
    [102, 102.5, 101.5, 102, 10],
    [105, 105.2, 99, 99.5, 30], // 12：空头脉冲 → 区域 [101.5, 102.5]
    [102.4, 102.5, 101.4, 101.8, 12], // 13：回踩 → 空头信号
    [101, 102, 100.5, 101.5, 10],
    [101.5, 102, 101, 101.5, 10],
    [101.5, 108.5, 101.4, 108, 30], // 16：多头脉冲 → 区域 [101, 102]
    [102, 102.5, 100.8, 102.3, 12], // 17：回踩 → 多头信号
    [104, 105, 103, 104.5, 10],
  ]
  return rows.map(([o, h, l, c, v], i) => ({
    timestamp: 1_700_000_000_000 + i * 3_600_000,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
  }))
}

/** M4 用到的配置（与手写 tracker 的 TRACKER_CFG 对齐） */
const M4_CFG = {
  atrLen: 3,
  volLen: 3,
  emaLen: 2,
  maxAge: 100,
  bodyZone: false,
  useTrend: false,
  useRejection: false,
  useRetestVol: false,
  needOpp: false,
  needBreak: false,
}

test('M4: test.pine 产物与手写 OrderBlockTracker 逐 bar 全字段一致', () => {
  const candles = m4Candles()
  const tickSize = 0.1

  const comp = compilePine(readPine('test.pine'), { sourceName: 'test.pine' })
  assert.deepEqual(
    comp.diagnostics.filter((d) => d.severity === 'error'),
    [],
    `M4 编译不应有 error：${JSON.stringify(comp.diagnostics)}`,
  )
  assert.equal(comp.meta.kind, 'strategy')

  const prog = runPineProgram(comp.ts, candles, { inputs: { ...M4_CFG }, tickSize })
  const tracker = new OrderBlockTracker(candles, { ...DEFAULT_ORDER_BLOCK, ...M4_CFG }, tickSize)

  let longCount = 0
  let shortCount = 0

  for (let i = 0; i < candles.length; i++) {
    // 两侧都以 flat=true 驱动：持仓分支（strategy.exit）不执行，
    // 于是 __exitStop / __exitLimit 只在开仓当根被快照，可直接与 tracker 比对。
    const sig = prog.step(i, {
      flat: true,
      positionSize: 0,
      prevPositionSize: 0,
      avgPrice: NaN,
      side: null,
    })
    const ref = tracker.step(i, true)

    assert.equal(sig.canLong, ref.canLong, `bar=${i} canLong`)
    assert.equal(sig.canShort, ref.canShort, `bar=${i} canShort`)
    assert.ok(
      Object.is(sig.obStopLoss, ref.obStopLoss),
      `bar=${i} obStopLoss: 产物 ${String(sig.obStopLoss)} ≠ 参考 ${String(ref.obStopLoss)}`,
    )
    assert.ok(
      Object.is(sig.obTakeProfit, ref.obTakeProfit),
      `bar=${i} obTakeProfit: 产物 ${String(sig.obTakeProfit)} ≠ 参考 ${String(ref.obTakeProfit)}`,
    )
    assert.ok(
      Object.is(sig.obRisk, ref.obRisk),
      `bar=${i} obRisk: 产物 ${String(sig.obRisk)} ≠ 参考 ${String(ref.obRisk)}`,
    )

    if (sig.canLong) longCount++
    if (sig.canShort) shortCount++
  }

  assert.ok(longCount > 0, '应至少出现一次多头信号')
  assert.ok(shortCount > 0, '应至少出现一次空头信号')
})

/* ================================================================== */
/* M5 回测：strategy='pine' 与 order-block 逐笔/逐点一致                 */
/* ================================================================== */

/** M5 合成 K 线：铺垫 → 多头脉冲/回踩/上冲止盈 → 空头脉冲/回踩/下冲止盈 */
function m5Candles(): Candle[] {
  const rows: Array<[number, number, number, number, number]> = []
  for (let i = 0; i < 8; i++) rows.push([100, 100.5, 99.5, 100, 10])
  rows.push(
    [100, 106, 99.8, 105.5, 30], // 多头脉冲 → 区域 [99.5, 100.5]
    [103, 104, 100.2, 103.5, 12], // 回踩 → 多头信号
    [103.5, 106, 103, 105.5, 15], // 下一根开盘入场
    [105, 109, 104.5, 108.5, 18],
    [108, 113, 107.5, 112, 20], // 上冲 → 触及止盈
    [112, 112.5, 109, 110, 10],
    [110, 110.5, 104, 105, 30], // 空头脉冲 → 区域 [109, 111.5]
    [109.5, 110, 107, 108, 12], // 回踩（阴线）→ 空头信号
    [108, 108.5, 104, 104.5, 15], // 下一根开盘入场
    [104.5, 105, 99, 100, 20], // 下冲 → 触及止盈
    [100, 101, 99, 100.5, 10],
    [100.5, 101, 99.5, 100, 10],
  )
  return rows.map(([o, h, l, c, v], i) => ({
    timestamp: 1_700_000_000_000 + i * 3_600_000,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
  }))
}

test('M5: strategy=pine 与 order-block 在同一批 K 线上逐笔一致', () => {
  const candles = m5Candles()
  const tickSize = 0.1

  const base: StrategyParams = {
    ...DEFAULT_STRATEGY_PARAMS,
    strategy: 'order-block',
    exitStrategy: 'Zone OCO',
    tradeDirection: 'Both',
    partialTp: false,
    pyramiding: 1,
    commissionPercent: 0.05,
    initialCapital: 1000,
    leverage: 1,
    positionSizePercent: 100,
    checkLiquidation: false,
    slippageTicks: 2,
    orderBlock: { ...DEFAULT_ORDER_BLOCK, ...M4_CFG, useBE: true, beAtR: 1, maxBars: 60 },
  }

  // ① order-block：手写 tracker 逐 bar 驱动
  const obSignals = candles.map(() => emptyOrderBlockSignal())
  const tracker = new OrderBlockTracker(candles, base.orderBlock, tickSize)
  const ob = runBacktest({
    candles,
    series: { signals: obSignals },
    params: base,
    signalProvider: (i, ctx) => {
      obSignals[i] = tracker.step(i, ctx.flat)
    },
    tickSize,
  })

  // ② pine：test.pine 编译产物逐 bar 驱动（同一份 params，仅 strategy 字段不同）
  const comp = compilePine(readPine('test.pine'), { sourceName: 'test.pine' })
  assert.deepEqual(
    comp.diagnostics.filter((d) => d.severity === 'error'),
    [],
    `M5 编译不应有 error：${JSON.stringify(comp.diagnostics)}`,
  )
  const program = runPineProgram(comp.ts, candles, {
    inputs: { ...M4_CFG, useBE: true, beAtR: 1, maxBars: 60 },
    tickSize,
  })
  const pineSignals = candles.map(() => emptyPineSignal())
  const pine = runBacktest({
    candles,
    series: { signals: pineSignals },
    params: { ...base, strategy: 'pine' },
    signalProvider: (i, ctx) => {
      pineSignals[i] = program.step(i, ctx)
    },
    tickSize,
  })

  assert.ok(ob.trades.length > 0, '应至少产生一笔交易')

  // 逐笔比对
  assert.equal(pine.trades.length, ob.trades.length, '交易笔数应一致')
  for (let k = 0; k < ob.trades.length; k++) {
    const a = ob.trades[k]
    const b = pine.trades[k]
    assert.equal(b.side, a.side, `#${k} side`)
    assert.equal(b.entryIndex, a.entryIndex, `#${k} entryIndex`)
    assert.equal(b.exitIndex, a.exitIndex, `#${k} exitIndex`)
    assert.equal(b.exitReason, a.exitReason, `#${k} exitReason`)
    assert.ok(Object.is(b.entryPrice, a.entryPrice), `#${k} entryPrice: ${b.entryPrice} ≠ ${a.entryPrice}`)
    assert.ok(Object.is(b.exitPrice, a.exitPrice), `#${k} exitPrice: ${b.exitPrice} ≠ ${a.exitPrice}`)
    assert.ok(Object.is(b.qty, a.qty), `#${k} qty`)
    assert.ok(Object.is(b.netPnl, a.netPnl), `#${k} netPnl: ${b.netPnl} ≠ ${a.netPnl}`)
    assert.equal(b.fills.length, a.fills.length, `#${k} fills 数`)
  }

  // 逐点比对资金曲线
  assert.equal(pine.equityCurve.length, ob.equityCurve.length, '资金曲线长度应一致')
  for (let i = 0; i < ob.equityCurve.length; i++) {
    assert.ok(
      Object.is(pine.equityCurve[i].equity, ob.equityCurve[i].equity),
      `equity bar=${i}: ${pine.equityCurve[i].equity} ≠ ${ob.equityCurve[i].equity}`,
    )
  }
})

/* ================================================================== */
/* M6 v6 语法补全（真实 TradingView 脚本用到的写法）                     */
/* ================================================================== */

/** 一段把 v6 常用写法集中的脚本：数组字面量 / switch / 单行函数 / while / for-in / 复合赋值 / 悬挂缩进续行 */
const M6_SRC = [
  '//@version=6',
  'indicator("v6 syntax", overlay=true)',
  '',
  'mode = input.string("a", "Mode", options = ["a", "b", "c"])',
  'w = input.float(1.0, "Weight")',
  '',
  'f_scale(float v) => v * w',
  '',
  'pick = switch mode',
  '    "a" => 1',
  '    "b" => 2',
  '    => 3',
  '',
  'total = 0.0',
  'i = 0',
  'while i < 3',
  '    total += f_scale(pick + i)',
  '    i += 1',
  '',
  'arr = [1, 2, 3]',
  'sum2 = 0.0',
  'for v in arr',
  '    sum2 := sum2 + v',
  '',
  'val = mode == "a" ? 1 :',
  '      mode == "b" ? 2 :',
  '      3',
  '',
  'plot(val + total + sum2, title="Out")',
].join('\n')

test('M6: v6 语法补全的脚本零 error 且生成可执行产物', () => {
  const comp = compilePine(M6_SRC, { sourceName: 'm6.pine' })
  const errors = comp.diagnostics.filter((d) => d.severity === 'error')
  assert.deepEqual(errors, [], `不应有 error：${JSON.stringify(errors)}`)
  // switch → 嵌套三目；数组字面量原样保留；while / for-in 各自成环
  assert.ok(comp.ts.includes('"b" ==='), 'switch 应脱糖成相等比较')
  assert.ok(comp.ts.includes('[1, 2, 3]'), '数组字面量应直译为 JS 数组')
  assert.ok(/while \(/.test(comp.ts), 'while 应生成 while 循环')
  assert.ok(/for \(const v of /.test(comp.ts), 'for-in 应生成 for-of 循环')
})

test('M6: 悬挂缩进（非 4 倍数）按续行合并为 1 个逻辑行', () => {
  const res = tokenize(M6_SRC)
  const errors = res.diagnostics.filter((d) => d.severity === 'error')
  assert.deepEqual(errors, [], '悬挂缩进不应再报缩进错误')
  const lines = logicalLines(res.tokens)
  const valLine = lines.find((l) => l[0].text === 'val')
  assert.ok(valLine, '应存在 val 赋值逻辑行')
  assert.equal(valLine[valLine.length - 1].text, '3', '三目链的续行应全部并入同一逻辑行')
})

test('M6: 复合赋值与单行函数体在产物中正确脱糖', () => {
  const comp = compilePine(M6_SRC, { sourceName: 'm6.pine' })
  assert.ok(comp.ts.includes('total = (total + '), '`+=` 应脱糖为 `x = x + v`')
  assert.ok(comp.ts.includes('function f_scale'), '单行函数体应生成函数声明')
  assert.ok(comp.ts.includes('return (v * '), '单行函数体的表达式应成为返回值')
})

/* ================================================================== */
/* M7 数组 / 元组解构 / 泛型声明 / 顶层标量在用户函数中可见            */
/* ================================================================== */

/** 覆盖 array.* 命名空间、泛型类型声明、元组解构与「用户函数读顶层逐 bar 标量」 */
const M7_SRC = [
  '//@version=6',
  'indicator("m7", overlay=true)',
  '',
  'var array<float> acc = array.new<float>()',
  '// 逐 bar 标量（不是初始化期常量），用户函数必须能读到它',
  'scale = close * 0 + 10.0',
  '',
  'plan(float x) =>',
  '    array.push(acc, x)',
  '    [x * 2, x * 3]',
  '',
  'f(int v) => v * scale',
  '',
  'total = 0.0',
  'if bar_index == 0',
  '    [a, b] = plan(2.0)',
  '    total := a + b + f(1)',
  '    total := total + array.size(acc) + array.last(acc)',
  'plot(total, title="Out")',
].join('\n')

test('M7: array.* / 泛型声明 / 元组解构 / 顶层标量捕获在运行期数值正确', () => {
  const comp = compilePine(M7_SRC, { sourceName: 'm7.pine' })
  const errors = comp.diagnostics.filter((d) => d.severity === 'error')
  assert.deepEqual(errors, [], `不应有 error：${JSON.stringify(errors)}`)

  const candles = synthCandles()
  const program = runPineProgram(comp.ts, candles, {})
  const FLAT = { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: Number.NaN, side: null }
  for (let i = 0; i < candles.length; i++) program.step(i, FLAT as never)
  // a=4 b=6 f(1)=10 → 20；再加 array.size(acc)=1 与 array.last(acc)=2 → 23
  assert.equal(Number(program.plots['Out']?.[0]), 23, `第 0 根 bar 的 Out 应为 23，实际 ${program.plots['Out']?.[0]}`)
})

test('M7: array.new(size, init) 按 init 填满，越界读返回 na', () => {
  const src = [
    '//@version=6',
    'indicator("m7b")',
    'var array<float> a = array.new<float>(3, 7.0)',
    'v = array.get(a, 1) + array.get(a, 99)',
    'plot(array.size(a) + (na(v) ? 100 : v), title="Out")',
  ].join('\n')
  const comp = compilePine(src, { sourceName: 'm7b.pine' })
  assert.deepEqual(comp.diagnostics.filter((d) => d.severity === 'error'), [])
  const candles = synthCandles()
  const program = runPineProgram(comp.ts, candles, {})
  const FLAT = { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: Number.NaN, side: null }
  for (let i = 0; i < candles.length; i++) program.step(i, FLAT as never)
  // size=3，get(1)=7，get(99)=na → v 为 na → 3 + 100 = 103
  assert.equal(Number(program.plots['Out']?.[0]), 103, `越界读应得 na（而非抛错），实际 ${program.plots['Out']?.[0]}`)
})

/* ================================================================== */
/* M8 v4 兼容层：逗号多语句 / 派生序列 / 裸内置函数 / 元组解构 + 形参历史   */
/* ================================================================== */

const FLAT_CTX = { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: Number.NaN, side: null }

test('M8: v4 一行内逗号分隔的多条语句被拆成独立语句', () => {
  const src = [
    '//@version=4',
    'strategy("comma")',
    'a = 1, b = 2,',
    'c = a + b',
  ].join('\n')
  const { program, diagnostics } = frontEnd(src)
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [])
  assert.ok(program)
  const names = program.body
    .filter((s) => s.kind === 'assign')
    .map((s) => (s.kind === 'assign' && s.target.kind === 'ident' ? s.target.name : '?'))
  assert.deepEqual(names, ['a', 'b', 'c'])
})

test('M8: 派生序列（窗口函数/交叉，含 [k] 偏移）与 ta.ts 参考实现逐 bar 一致', () => {
  const src = [
    '//@version=4',
    'strategy("derived")',
    'useRange = true',
    'mid = (high + low) / 2',
    'len = input(3, minval=1)',
    'ma = sma(mid, len)',
    'up = crossover(mid, ma)',
    'dn = crossunder(mid[1], ma[1])',
    'rng = useRange ? tr : high - low',
    'plot(mid, title="Mid")',
    'plot(ma, title="Ma")',
    'plot(up ? 1.0 : 0.0, title="Up")',
    'plot(dn ? 1.0 : 0.0, title="Dn")',
    'plot(rng, title="Rng")',
  ].join('\n')
  const comp = compilePine(src, { sourceName: 'm8-derived.pine' })
  assert.deepEqual(
    comp.diagnostics.filter((d) => d.severity === 'error'),
    [],
    `不应有 error：${JSON.stringify(comp.diagnostics)}`,
  )

  const candles = synthCandles()
  const program = runPineProgram(comp.ts, candles, {})
  for (let i = 0; i < candles.length; i++) program.step(i, FLAT_CTX as never)

  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)
  const closes = candles.map((c) => c.close)
  const midRef = highs.map((h, i) => (h + lows[i]) / 2)
  const maRef = taLib.sma(midRef, 3)
  const upRef = taLib.crossover(midRef, maRef)
  const dnRef = taLib.crossunder(midRef, maRef)
  const rngRef = taLib.trueRange(highs, lows, closes)

  for (let i = 0; i < candles.length; i++) {
    assert.ok(Object.is(program.plots['Mid'][i], midRef[i]), `bar=${i} Mid`)
    assert.ok(Object.is(program.plots['Ma'][i], maRef[i]), `bar=${i} Ma`)
    assert.equal(Number(program.plots['Up'][i]), upRef[i] ? 1 : 0, `bar=${i} Up`)
    // crossunder(x[1], y[1]) ≡ 参考实现中上一根 bar 的 crossunder
    assert.equal(Number(program.plots['Dn'][i]), i > 0 && dnRef[i - 1] ? 1 : 0, `bar=${i} Dn`)
    assert.ok(Object.is(program.plots['Rng'][i], rngRef[i]), `bar=${i} Rng`)
  }
})

test('M8: 顶层元组解构（macd）+ 形参 [k] 历史引用与 ta.ts 参考一致', () => {
  const src = [
    '//@version=4',
    'strategy("tuple-macd")',
    '[macdLine, macdSignalLine, macdHist] = macd(close, 12, 26, 7)',
    'rising(data, loopBack) =>',
    '    b = true',
    '    for n = 1 to loopBack',
    '        if data[n] > data[n-1]',
    '            b := false',
    '    b',
    'isUp = rising(macdLine, 3)',
    'plot(macdLine, title="Macd")',
    'plot(macdSignalLine, title="Signal")',
    'plot(macdHist, title="Hist")',
    'plot(isUp ? 1.0 : 0.0, title="Up")',
  ].join('\n')
  const comp = compilePine(src, { sourceName: 'm8-tuple.pine' })
  assert.deepEqual(
    comp.diagnostics.filter((d) => d.severity === 'error'),
    [],
    `不应有 error：${JSON.stringify(comp.diagnostics)}`,
  )

  const candles = synthCandles()
  const program = runPineProgram(comp.ts, candles, {})
  for (let i = 0; i < candles.length; i++) program.step(i, FLAT_CTX as never)

  const closes = candles.map((c) => c.close)
  const [macdRef, signalRef, histRef] = taLib.macd(closes, 12, 26, 7)
  const risingRef = (arr: number[], i: number, loopBack: number): boolean => {
    let b = true
    for (let n = 1; n <= loopBack; n++) {
      // Pine 的 data[n] / data[n-1] 分别是 arr[i-n] / arr[i-n+1]
      const a = arr[i - n]
      const c = arr[i - n + 1]
      // 与 runtime 的 na-safe 比较一致：na 参与比较恒为 false
      if (!isNa(a) && !isNa(c) && (a as number) > (c as number)) b = false
    }
    return b
  }

  for (let i = 0; i < candles.length; i++) {
    assert.ok(Object.is(program.plots['Macd'][i], macdRef[i]), `bar=${i} Macd`)
    assert.ok(Object.is(program.plots['Signal'][i], signalRef[i]), `bar=${i} Signal`)
    assert.ok(Object.is(program.plots['Hist'][i], histRef[i]), `bar=${i} Hist`)
    assert.equal(
      Number(program.plots['Up'][i]),
      risingRef(macdRef, i, 3) ? 1 : 0,
      `bar=${i} Up`,
    )
  }
})

/* ================================================================== */
/* M9 语料回归：if 表达式 / 函数局部序列 / ASI / v3-v4 遗留写法           */
/* ================================================================== */

test('M9: `if` 表达式（含前置语句）取值正确', () => {
  const src = [
    '//@version=6',
    'indicator("ifexpr")',
    'mode = "b"',
    'v = if mode == "a"',
    '    1.0',
    'else if mode == "b"',
    '    t = close * 0 + 2.0',
    '    t + 3.0',
    'else',
    '    9.0',
    'plot(v, title="V")',
  ].join('\n')
  const comp = compilePine(src, { sourceName: 'm9-if.pine' })
  assert.deepEqual(comp.diagnostics.filter((d) => d.severity === 'error'), [])
  const candles = synthCandles()
  const program = runPineProgram(comp.ts, candles, {})
  for (let i = 0; i < candles.length; i++) program.step(i, FLAT_CTX as never)
  assert.equal(Number(program.plots['V'][0]), 5, '分支内前置语句 + 尾表达式应得 5')
})

test('M9: 表达式语句与上一行不因 ASI 粘连（`let x = 3` 后接 `(a + b)`）', () => {
  const src = [
    '//@version=6',
    'indicator("asi")',
    'f(x) =>',
    '    if x > 0',
    '        a = 1',
    '        b = 2',
    '        c = 3',
    '        ((3 * a) - (3 * b)) + c',
    '    else',
    '        0',
    'v = f(5)',
    'plot(v, title="V")',
  ].join('\n')
  const comp = compilePine(src, { sourceName: 'm9-asi.pine' })
  assert.deepEqual(comp.diagnostics.filter((d) => d.severity === 'error'), [])
  const candles = synthCandles()
  const program = runPineProgram(comp.ts, candles, {})
  for (let i = 0; i < candles.length; i++) program.step(i, FLAT_CTX as never)
  // 3*1 - 3*2 + 3 = 0；不得抛 ReferenceError（TDZ）
  assert.equal(Number(program.plots['V'][0]), 0)
})

test('M9: 函数局部变量的 [k] 历史引用（提升为模块级序列）数值正确', () => {
  const src = [
    '//@version=6',
    'indicator("fnlocal")',
    'f(p) =>',
    '    a = 0.0',
    '    a := nz(a[1] + p, p)',
    '    a',
    'v = f(close)',
    'plot(v, title="V")',
  ].join('\n')
  const comp = compilePine(src, { sourceName: 'm9-fnlocal.pine' })
  assert.deepEqual(comp.diagnostics.filter((d) => d.severity === 'error'), [])
  const candles = synthCandles()
  const program = runPineProgram(comp.ts, candles, {})
  for (let i = 0; i < candles.length; i++) program.step(i, FLAT_CTX as never)
  const closes = candles.map((c) => c.close)
  // a 是 close 的累加（第一根 bar 时 a[1] 为 na → 取 p）
  let acc = 0
  for (let i = 0; i < Math.min(candles.length, 5); i++) {
    acc = i === 0 ? closes[0] : acc + closes[i]
    assert.ok(
      Math.abs(Number(program.plots['V'][i]) - acc) < 1e-9,
      `bar=${i}: ${program.plots['V'][i]} ≠ ${acc}`,
    )
  }
})

test('M9: switch 分支块之后紧跟元组解构不被误判为下标', () => {
  const src = [
    '//@version=6',
    'indicator("switch-tuple")',
    'preset = "a"',
    '[x, y] = switch preset',
    '    "a" => [1.0, 2.0]',
    '    => [3.0, 4.0]',
    'plot(x + y, title="V")',
  ].join('\n')
  const comp = compilePine(src, { sourceName: 'm9-switch.pine' })
  assert.deepEqual(
    comp.diagnostics.filter((d) => d.severity === 'error'),
    [],
    JSON.stringify(comp.diagnostics),
  )
  const candles = synthCandles()
  const program = runPineProgram(comp.ts, candles, {})
  for (let i = 0; i < candles.length; i++) program.step(i, FLAT_CTX as never)
  assert.equal(Number(program.plots['V'][0]), 3)
})

test('M9: Tab 缩进按 4 空格折算（TradingView 允许 Tab）', () => {
  const src = ['//@version=6', 'indicator("tab")', 'if close > open', '\tplot(close, title="V")'].join('\n')
  const { diagnostics, program } = frontEnd(src)
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), [])
  assert.ok(program)
})

test('M9: v3/v4 遗留写法（裸颜色 / period / 元组型 supertrend）编译零 error', () => {
  const src = [
    '//@version=4',
    'strategy("legacy")',
    'res = input(title="Resolution", type=resolution, defval="60")',
    '[st, dir] = supertrend(3.0, 10)',
    't = time("D")',
    'plot(st, color=lime)',
    'plot(dir, color=orange)',
    'plot(close > st ? 1.0 : 0.0, title="Above")',
  ].join('\n')
  const comp = compilePine(src, { sourceName: 'm9-legacy.pine' })
  assert.deepEqual(
    comp.diagnostics.filter((d) => d.severity === 'error'),
    [],
    JSON.stringify(comp.diagnostics),
  )
  const candles = synthCandles()
  const program = runPineProgram(comp.ts, candles, {})
  for (let i = 0; i < candles.length; i++) program.step(i, FLAT_CTX as never)
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)
  const closes = candles.map((c) => c.close)
  const [stRef] = taLib.supertrend(highs, lows, closes, 3.0, 10)
  for (let i = 0; i < 20; i++) {
    assert.ok(Object.is(program.plots[comp.meta.plotTitles[0]][i], stRef[i]), `bar=${i} supertrend`)
  }
})

test('M9: strategy.position_size[k] 与 strategy.opentrades 历史引用可用', () => {
  const src = [
    '//@version=6',
    'strategy("poshist")',
    'entered = strategy.position_size > 0 and strategy.position_size[1] == 0',
    'nt = strategy.opentrades + strategy.opentrades[1]',
    'plot(entered ? 1.0 : 0.0, title="Entered")',
    'plot(nt, title="Nt")',
  ].join('\n')
  const comp = compilePine(src, { sourceName: 'm9-pos.pine' })
  assert.deepEqual(
    comp.diagnostics.filter((d) => d.severity === 'error'),
    [],
    JSON.stringify(comp.diagnostics),
  )
  const candles = synthCandles()
  const program = runPineProgram(comp.ts, candles, {})
  for (let i = 0; i < candles.length; i++) {
    // bar0 空仓、此后持多仓 —— 用于验证 position_size[1] 的逐 bar 序列
    program.step(i, {
      flat: i === 0,
      positionSize: i === 0 ? 0 : 1,
      prevPositionSize: 0,
      avgPrice: 100,
      side: 'long',
    } as never)
  }
  assert.equal(Number(program.plots['Entered'][0]), 0, '首根 bar 无上一根 → na 参与比较恒为假')
  assert.equal(Number(program.plots['Entered'][1]), 1, 'bar1：持仓由 0 变 1')
  assert.equal(Number(program.plots['Entered'][2]), 0, 'bar2：上一根已持仓')
  assert.equal(Number(program.plots['Nt'][1]), 1, 'bar1：opentrades=1 + 上一根 0')
})

test('M9: 新增 ta 函数（rsi/hma/alma/linreg/barssince/valuewhen/mfi）数值合理', () => {
  const src = [
    '//@version=6',
    'indicator("ta9")',
    'r = rsi(close, 14)',
    'h = hma(close, 9)',
    'a = alma(close, 9)',
    'lr = linreg(close, 10, 0)',
    'up = close > open',
    'bs = barssince(up)',
    'vw = valuewhen(up, close, 0)',
    'mf = ta.mfi(hlc3, 14)',
    'plot(r, title="Rsi")',
    'plot(h, title="Hma")',
    'plot(a, title="Alma")',
    'plot(lr, title="Lr")',
    'plot(bs, title="Bs")',
    'plot(vw, title="Vw")',
    'plot(mf, title="Mf")',
  ].join('\n')
  const comp = compilePine(src, { sourceName: 'm9-ta.pine' })
  assert.deepEqual(
    comp.diagnostics.filter((d) => d.severity === 'error'),
    [],
    JSON.stringify(comp.diagnostics),
  )
  const candles = synthCandles()
  const program = runPineProgram(comp.ts, candles, {})
  for (let i = 0; i < candles.length; i++) program.step(i, FLAT_CTX as never)
  const closes = candles.map((c) => c.close)
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)
  const vol = candles.map((c) => c.volume)
  const upRef = candles.map((c) => c.close > c.open)
  const expected: Record<string, number[]> = {
    Rsi: taLib.rsi(closes, 14),
    Hma: taLib.hma(closes, 9),
    Alma: taLib.alma(closes, 9),
    Lr: taLib.linreg(closes, 10, 0),
    Bs: taLib.barssince(upRef),
    Vw: taLib.valuewhen(closes, upRef, 0),
    Mf: taLib.mfi(highs, lows, closes, vol, 14),
  }
  for (let i = 0; i < candles.length; i++) {
    for (const [title, series] of Object.entries(expected)) {
      assert.ok(
        Object.is(program.plots[title][i], series[i]) ||
          Math.abs(Number(program.plots[title][i]) - Number(series[i])) < 1e-9,
        `bar=${i} ${title}: ${program.plots[title][i]} ≠ ${series[i]}`,
      )
    }
  }
})

test('M8: v4 裸内置函数 / input / security / timestamp 编译零 error 且元信息正确', () => {
  const src = [
    '//@version=4',
    'strategy("v4-compat")',
    'stopPct = input(5, "Stop in %", type=input.float)',
    'longOnly = input(true)',
    'volK = input(0.9, step=0.1)',
    'start = timestamp(2020, 1, 1, 0, 0)',
    'src = security("BINANCE:BTCUSDT", timeframe.period, close)',
    'lv = highest(high, 5) - lowest(low, 5)',
    'atrV = atr(14)',
    'rng = tr',
    'hi = pow(lv, 2) / 2',
    'txt = tostring(atrV, "#.##")',
    'csUp = crossover(src, hi)',
    'plot(src + rng - hi + lv, title="Out")',
    'plot(start, title="Start")',
  ].join('\n')
  const comp = compilePine(src, { sourceName: 'm8-compat.pine' })
  assert.deepEqual(
    comp.diagnostics.filter((d) => d.severity === 'error'),
    [],
    `不应有 error：${JSON.stringify(comp.diagnostics)}`,
  )
  const inputTypes = new Map(comp.meta.inputs.map((it) => [it.name, it.type]))
  assert.equal(inputTypes.get('stopPct'), 'float', 'v4 显式 type=input.float 应被识别')
  assert.equal(inputTypes.get('longOnly'), 'bool', 'v4 input(true) 应推断为 bool')
  assert.equal(inputTypes.get('volK'), 'float')
  assert.ok(
    comp.diagnostics.some((d) => d.severity === 'warning' && d.message.includes('security')),
    'security() 降级应给出警告',
  )

  const candles = synthCandles()
  const program = runPineProgram(comp.ts, candles, {})
  for (let i = 0; i < candles.length; i++) program.step(i, FLAT_CTX as never)
  assert.equal(Number(program.plots['Start'][0]), Date.UTC(2020, 0, 1), 'timestamp() 应按 UTC 解析')

  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)
  const closes = candles.map((c) => c.close)
  const lvRef = taLib.highest(highs, 5).map((h, i) => h - (taLib.lowest(lows, 5)[i] as number))
  for (let i = 0; i < candles.length; i++) {
    const expected = closes[i] + (taLib.trueRange(highs, lows, closes)[i] as number) -
      Math.pow(lvRef[i], 2) / 2 + lvRef[i]
    assert.ok(
      Object.is(Number(program.plots['Out'][i]), expected) ||
        Math.abs(Number(program.plots['Out'][i]) - expected) < 1e-9,
      `bar=${i} Out: ${program.plots['Out'][i]} ≠ ${expected}`,
    )
  }
})
/**
 * 编译产物执行：TS → JS（Node 内置类型擦除）→ vm 沙箱 → `CompiledProgram`。
 *
 * 取舍（方案 §9.1）：不引入 esbuild（它不是本项目的直接依赖，从项目根
 * `import('esbuild')` 会 `ERR_MODULE_NOT_FOUND`），改用 Node v24 内置的
 * `module.stripTypeScriptTypes(code, { mode: 'strip' })` —— 零新增依赖、无需联网。
 *
 * 沙箱里只放 `__pine` 与 `console`，不暴露 `require` / `process` / 宿主全局。
 */

import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'

import type { Candle, PineCompileMeta } from '../../../shared/types'
import { createRuntime, type PineRuntimeOptions } from './runtime'

/** `step(index, ctx)` 收到的上下文（由回测引擎逐 bar 提供） */
export interface PineStepCtx {
  flat: boolean
  positionSize: number
  prevPositionSize: number
  avgPrice: number
  side: unknown
}

/** 每根 K 线一份的信号快照 —— 与 `StrategySignalCore` 对齐 */
export interface PineSignal {
  /** Pine 无对应概念，固定为 NaN（保持与 fib/supertrend/order-block 的信号形状兼容） */
  imbaTrendLine: number
  tsotTrendValue: number
  canLong: boolean
  canShort: boolean
  atrLongStop: number
  atrShortStop: number
  obStopLoss: number
  obTakeProfit: number
  obRisk: number
  /** `strategy.close_all()` → 引擎下一根开盘市价平仓 */
  forceClose?: boolean
}

export interface CompiledProgram {
  step: (index: number, ctx: PineStepCtx) => PineSignal
  meta: PineCompileMeta
  /** `plot(title=…)` 的逐 bar 序列 */
  plots: Record<string, unknown[]>
  /** `plotshape` 的非 na 标记 */
  markers: unknown[]
  /** `barcolor` 的逐 bar 颜色 */
  barColor: unknown[]
}

export interface RunPineOptions extends PineRuntimeOptions {
  /** vm 执行超时（毫秒） */
  timeoutMs?: number
}

/** 空的信号快照（供引擎在 `signalProvider` 之外的 K 线上占位） */
export function emptyPineSignal(): PineSignal {
  return {
    imbaTrendLine: Number.NaN,
    tsotTrendValue: Number.NaN,
    canLong: false,
    canShort: false,
    atrLongStop: Number.NaN,
    atrShortStop: Number.NaN,
    obStopLoss: Number.NaN,
    obTakeProfit: Number.NaN,
    obRisk: Number.NaN,
  }
}

/**
 * 执行编译产物，返回可直接逐 bar 调用的 `step`。
 *
 * @param ts       `compilePine()` 产出的 TypeScript 源码
 * @param candles  完整 K 线（脚本需在预热期累积 `var` 状态）
 */
export function runPineProgram(
  ts: string,
  candles: readonly Candle[],
  opts: RunPineOptions = {},
): CompiledProgram {
  const js = stripTypeScriptTypes(ts, { mode: 'strip' })
  const runtime = createRuntime(candles, { inputs: opts.inputs, tickSize: opts.tickSize })

  const sandbox: Record<string, unknown> = { __pine: runtime, console }
  vm.runInNewContext(js, sandbox, { timeout: opts.timeoutMs ?? 2000 })

  const factory = sandbox.__pineProgram as { create: (p: unknown) => CompiledProgram } | undefined
  if (!factory || typeof factory.create !== 'function') {
    throw new Error('Pine 编译产物没有导出 __pineProgram.create')
  }
  return factory.create(runtime)
}
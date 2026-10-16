/**
 * Pine 解析引擎对外出口。
 *
 * 实现基于 **PineTS**（`pinets`）：`runPineTsSignals()` 用 PineTS 批量跑完脚本，
 * 再把券商账本折算成引擎逐 bar 消费的 `PineSignal[]`。
 */

export {
  runPineTsSignals,
  analyzePine,
  emptyPineSignal,
  PINE_ENTRY_OFFSET,
  type PineSignal,
  type PineMarker,
  type PineAnalysis,
  type PineTsRunResult,
  type RunPineTsOptions,
} from './pinetsAdapter'
export { listPineScripts, savePineScript, deletePineScript, normalizeScriptName } from './store'
export type { PineCompileMeta, PineDiagnostic } from '../../../shared/types'

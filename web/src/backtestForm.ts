/**
 * 回测参数表单的本地持久化。
 *
 * 表单里的每一项（交易所 / 合约 / 周期 / 区间 / 结束日期 / 资金与杠杆 / 两个开关 /
 * 所选 Pine 脚本）在变更时即写入 localStorage，刷新页面原样恢复 —— 不必每次都把
 * 品种、周期、杠杆重新选一遍。
 *
 * 只存 `pineScriptId`，**不存脚本源码**：源码以磁盘为准。存快照会让编辑器拿着旧文本
 * 去编译（本地踩过这个坑：磁盘改了、编辑器还发旧版，回测直接解析报错）。
 *
 * 读取时逐字段校验 —— localStorage 里的值可能来自旧版本、或被手改过，坏值一律
 * 丢弃回落到默认，而不是让一个非法周期 / 交易所把首屏请求打崩。
 */

import type { ExchangeId, StrategyParams, Timeframe } from '@shared/types'
import { DEFAULT_STRATEGY_PARAMS, EXCHANGES, TIMEFRAMES } from '@shared/types'
import type { RangeKey } from './components/ControlPanel'

const LS_KEY = 'crypto-backtest-form'
/** 结构版本：字段增删时递增，读到不认识的版本直接当没存过 */
const VERSION = 1

export interface BacktestForm {
  exchange: ExchangeId
  symbol: string
  timeframe: Timeframe
  range: RangeKey
  /** 自定义起始日期（YYYY-MM-DD） */
  customSince: string
  /** 自定义结束日期（YYYY-MM-DD）；空串 = 回测到今天 */
  customUntil: string
  params: StrategyParams
  syncBacktest: boolean
  /** 当前载入的已保存脚本 id（源码由列表接口按 id 取回，不落本地） */
  pineScriptId: string | null
}

const RANGE_KEYS: RangeKey[] = ['1m', '3m', '6m', '1y', '2y', '3y', 'custom']
const DATE_RE = /^\d{4}-\d{1,2}-\d{1,2}$/

/**
 * 本应用只跑 Pine 脚本：这四项按服务端 `normalizeParams` 对 pine 的强制语义固定，
 * 不让恢复出来的值把应用带回「非 pine」的不一致状态。
 */
export function withPineSemantics(params: StrategyParams): StrategyParams {
  return { ...params, strategy: 'pine', exitStrategy: 'Zone OCO', partialTp: false, pyramiding: 1 }
}

/** 表单默认值，也是读不到 / 读坏时的回落 */
export function defaultBacktestForm(): BacktestForm {
  const since = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10)
  return {
    exchange: 'binanceusdm',
    symbol: 'BTC/USDT:USDT',
    timeframe: '1h',
    range: '1y',
    customSince: since,
    customUntil: '',
    params: withPineSemantics({ ...DEFAULT_STRATEGY_PARAMS }),
    syncBacktest: false,
    pineScriptId: null,
  }
}

/**
 * 参数按「与默认值同类型」逐字段收编：数字要是有限数、布尔要是布尔、字符串要非空。
 * 嵌套对象（`supertrend`）不在本表单里，保持默认；枚举字符串交服务端 `normalizeParams` 兜底。
 */
function sanitizeParams(raw: unknown): StrategyParams {
  const out = { ...DEFAULT_STRATEGY_PARAMS } as Record<string, unknown>
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  for (const [key, def] of Object.entries(DEFAULT_STRATEGY_PARAMS) as [string, unknown][]) {
    const v = rec[key]
    if (typeof def === 'number') {
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
    } else if (typeof def === 'boolean') {
      if (typeof v === 'boolean') out[key] = v
    } else if (typeof def === 'string') {
      if (typeof v === 'string' && v.length > 0) out[key] = v
    }
  }
  return withPineSemantics(out as unknown as StrategyParams)
}

export function loadBacktestForm(): BacktestForm {
  const def = defaultBacktestForm()
  let raw: unknown
  try {
    raw = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')
  } catch {
    return def
  }
  if (!raw || typeof raw !== 'object') return def
  const rec = raw as Record<string, unknown>
  if (rec.v !== VERSION) return def
  const s = (rec.form && typeof rec.form === 'object' ? rec.form : {}) as Record<string, unknown>

  return {
    exchange: EXCHANGES.some((e) => e.id === s.exchange) ? (s.exchange as ExchangeId) : def.exchange,
    symbol: typeof s.symbol === 'string' && s.symbol.trim() ? s.symbol.trim() : def.symbol,
    timeframe: TIMEFRAMES.includes(s.timeframe as Timeframe)
      ? (s.timeframe as Timeframe)
      : def.timeframe,
    range: RANGE_KEYS.includes(s.range as RangeKey) ? (s.range as RangeKey) : def.range,
    customSince:
      typeof s.customSince === 'string' && DATE_RE.test(s.customSince) ? s.customSince : def.customSince,
    customUntil:
      typeof s.customUntil === 'string' && DATE_RE.test(s.customUntil) ? s.customUntil : '',
    params: sanitizeParams(s.params),
    syncBacktest: typeof s.syncBacktest === 'boolean' ? s.syncBacktest : def.syncBacktest,
    pineScriptId: typeof s.pineScriptId === 'string' && s.pineScriptId ? s.pineScriptId : null,
  }
}

export function saveBacktestForm(form: BacktestForm): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ v: VERSION, form }))
  } catch {
    // 隐私模式 / 存储被禁用：存不下不影响使用，静默跳过
  }
}

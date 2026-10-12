import type {
  BacktestResult,
  ExchangeId,
  Instrument,
  PineCompileMeta,
  PineDiagnostic,
  SavedPineScript,
  StrategyParams,
  Timeframe,
} from '@shared/types'

export interface BacktestRequest {
  exchange: ExchangeId
  symbol: string
  timeframe: Timeframe
  since: number
  until: number
  bars?: number
  params: Partial<StrategyParams>
  useCache?: boolean
  /** 合约最小变动价位，用于把 slippageTicks 换算成价格 */
  tickSize?: number
  /** Pine 策略专用：源码 + 可覆盖的 input.* 取值 */
  pine?: { source: string; inputs?: Record<string, number | boolean | string>; name?: string }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const text = await res.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`服务返回了非 JSON 响应（HTTP ${res.status}）`)
  }
  const payload = json as { ok?: boolean; error?: string; data?: T }
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error ?? `请求失败（HTTP ${res.status}）`)
  }
  return payload.data as T
}

export interface InstrumentResponse {
  exchange: ExchangeId
  requested?: ExchangeId
  fallbackFrom?: ExchangeId
  total: number
  data: Instrument[]
}

export async function fetchInstruments(exchange: ExchangeId, q?: string): Promise<InstrumentResponse> {
  const params = new URLSearchParams({ exchange, limit: '500' })
  if (q) params.set('q', q)
  const res = await fetch(`/api/instruments?${params.toString()}`)
  const json = (await res.json()) as {
    ok: boolean
    error?: string
    exchange: ExchangeId
    requested?: ExchangeId
    fallbackFrom?: ExchangeId
    total: number
    data: Instrument[]
  }
  if (!json.ok) throw new Error(json.error ?? '获取合约列表失败')
  return {
    exchange: json.exchange,
    requested: json.requested ?? exchange,
    fallbackFrom: json.fallbackFrom,
    total: json.total ?? json.data?.length ?? 0,
    data: json.data ?? [],
  }
}

export async function fetchLastPrice(exchange: ExchangeId, symbol: string): Promise<number | null> {
  const params = new URLSearchParams({ exchange, symbol })
  const res = await fetch(`/api/price?${params.toString()}`)
  const json = (await res.json()) as { ok: boolean; price: number | null }
  return json.ok ? json.price : null
}

export async function runBacktest(body: BacktestRequest): Promise<BacktestResult> {
  const res = await fetch('/api/backtest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json: { ok: boolean; error?: string; data?: BacktestResult }
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`服务返回了非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  if (!res.ok || !json.ok || !json.data) {
    throw new Error(json.error ?? `回测失败（HTTP ${res.status}）`)
  }
  return json.data
}

export { request }

/* ------------------------------------------------------------------ */
/* Pine 实时编译                                                       */
/* ------------------------------------------------------------------ */

export interface PineCompileResult {
  /** 编译生成的 TypeScript 源码 */
  ts: string
  /** 编译诊断（语法 / 语义错误也走 200 + diagnostics） */
  diagnostics: PineDiagnostic[]
  /** 脚本声明、可覆盖 input、plot 标题等元信息 */
  meta: PineCompileMeta
  /** 是否无 error 级诊断 */
  ok: boolean
}

export interface PineExample {
  name: string
  file: string
  source: string
}

/** 实时编译 Pine 源码，返回 TS 产物、诊断与元信息 */
export async function compilePine(source: string, name?: string): Promise<PineCompileResult> {
  const res = await fetch('/api/pine/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, name }),
  })
  const text = await res.text()
  let json: { ok: boolean; error?: string; data?: PineCompileResult }
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`服务返回了非 JSON 响应（HTTP ${res.status}）`)
  }
  if (!res.ok || !json.ok || !json.data) {
    throw new Error(json.error ?? `编译失败（HTTP ${res.status}）`)
  }
  return json.data
}

/** Pine 回测：与 runBacktest 同构，额外携带源码 */
export async function runPineBacktest(
  body: BacktestRequest & { source: string; inputs?: Record<string, number | boolean | string> },
): Promise<BacktestResult> {
  const res = await fetch('/api/pine/backtest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json: { ok: boolean; error?: string; data?: BacktestResult }
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`服务返回了非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  if (!res.ok || !json.ok || !json.data) {
    throw new Error(json.error ?? `回测失败（HTTP ${res.status}）`)
  }
  return json.data
}

/** 内置示例脚本（server/pine/*.pine） */
export async function fetchPineExamples(): Promise<PineExample[]> {
  const res = await fetch('/api/pine/examples')
  const json = (await res.json()) as { ok: boolean; error?: string; data?: PineExample[] }
  if (!json.ok) throw new Error(json.error ?? '获取示例脚本失败')
  return json.data ?? []
}

/* ------------------------------------------------------------------ */
/* Pine 脚本本地保存                                                    */
/* ------------------------------------------------------------------ */

/** 已保存脚本列表（最近保存的在前） */
export async function fetchPineScripts(): Promise<SavedPineScript[]> {
  const res = await fetch('/api/pine/scripts')
  const json = (await res.json()) as { ok: boolean; error?: string; data?: SavedPineScript[] }
  if (!json.ok) throw new Error(json.error ?? '获取已保存脚本失败')
  return json.data ?? []
}

/** 保存脚本（同名即更新），立即落盘到服务端本地缓存 */
export async function savePineScript(name: string, source: string): Promise<SavedPineScript> {
  const res = await fetch('/api/pine/scripts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, source }),
  })
  const json = (await res.json()) as { ok: boolean; error?: string; data?: SavedPineScript }
  if (!res.ok || !json.ok || !json.data) {
    throw new Error(json.error ?? `保存失败（HTTP ${res.status}）`)
  }
  return json.data
}

/** 删除已保存脚本 */
export async function deletePineScript(id: string): Promise<void> {
  const res = await fetch(`/api/pine/scripts/${encodeURIComponent(id)}`, { method: 'DELETE' })
  const json = (await res.json()) as { ok: boolean; error?: string }
  if (!res.ok || !json.ok) throw new Error(json.error ?? `删除失败（HTTP ${res.status}）`)
}

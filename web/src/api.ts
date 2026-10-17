import type {
  AlertEvent,
  AlertMonitorStatus,
  AlertOverview,
  AlertSettings,
  BacktestResult,
  Candle,
  ExchangeId,
  Instrument,
  PineCompileMeta,
  PineDiagnostic,
  PriceAlert,
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
  const params = new URLSearchParams({ exchange, limit: '1000' })
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
/* 交易回放 / 图表用 K 线                                               */
/* ------------------------------------------------------------------ */

/** 返回的一次取数结果：K 线 + 服务端实际使用的窗口与命中缓存标记 */
export interface KlineDataset {
  candles: Candle[]
  cached: boolean
  /** 用户可见区间起点（服务端回显） */
  since: number
  /** 用户可见区间终点，已冻结到 bar 边界（服务端回显） */
  until: number
}

/**
 * 拉取一段 K 线。
 *
 * 与回测接口**共用同一套窗口换算**（服务端 `resolveWindow`，含固定预热根数），
 * 因此同一 `since/until` 组合会命中同一份缓存 —— 先取 K 线再点回测不会重复打交易所。
 * 传 `since` 时以它为准（`bars` 仅作兜底），否则按 `until - bars * 周期` 反推。
 */
export async function fetchKlines(opts: {
  exchange: ExchangeId
  symbol: string
  timeframe: Timeframe
  until?: number
  since?: number
  bars?: number
}): Promise<KlineDataset> {
  const params = new URLSearchParams({
    exchange: opts.exchange,
    symbol: opts.symbol,
    timeframe: opts.timeframe,
  })
  if (opts.until !== undefined) params.set('until', String(Math.round(opts.until)))
  if (opts.since !== undefined) params.set('since', String(Math.round(opts.since)))
  if (opts.bars !== undefined) params.set('bars', String(Math.round(opts.bars)))

  const res = await fetch(`/api/klines?${params.toString()}`)
  const text = await res.text()
  let json: {
    ok?: boolean
    error?: string
    cached?: boolean
    since?: number
    until?: number
    data?: Candle[]
  }
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`服务返回了非 JSON 响应（HTTP ${res.status}）`)
  }
  if (!res.ok || json.ok === false || !Array.isArray(json.data)) {
    throw new Error(json.error ?? `获取 K 线失败（HTTP ${res.status}）`)
  }
  return {
    candles: json.data,
    cached: Boolean(json.cached),
    since: json.since ?? opts.since ?? 0,
    until: json.until ?? opts.until ?? 0,
  }
}

/* ------------------------------------------------------------------ */
/* Pine 实时编译                                                       */
/* ------------------------------------------------------------------ */

export interface PineCompileResult {
  /** 校验诊断（语法 / 版本 / 运行期错误也走 200 + diagnostics） */
  diagnostics: PineDiagnostic[]
  /** 脚本声明、可覆盖 input、plot 标题等元信息 */
  meta: PineCompileMeta
  /** 是否无 error 级诊断 */
  ok: boolean
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

/* ------------------------------------------------------------------ */
/* 价格警报                                                            */
/* ------------------------------------------------------------------ */

/** 新建 / 更新警报的入参（服务端会做校验与规范化） */
export type AlertInput = Omit<
  PriceAlert,
  'id' | 'createdAt' | 'updatedAt' | 'lastTriggeredAt' | 'triggerCount' | 'state'
>

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  const text = await res.text()
  let json: { ok?: boolean; error?: string; data?: T }
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`服务返回了非 JSON 响应（HTTP ${res.status}）`)
  }
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `请求失败（HTTP ${res.status}）`)
  return json.data as T
}

/** 警报列表 + 全局设置 + 轮询状态 */
export async function fetchAlerts(): Promise<AlertOverview> {
  return jsonRequest<AlertOverview>('/api/alerts')
}

export async function createAlert(input: AlertInput): Promise<PriceAlert> {
  return jsonRequest<PriceAlert>('/api/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function updateAlert(id: string, input: AlertInput): Promise<PriceAlert> {
  return jsonRequest<PriceAlert>(`/api/alerts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function setAlertEnabled(id: string, enabled: boolean): Promise<PriceAlert> {
  return jsonRequest<PriceAlert>(`/api/alerts/${encodeURIComponent(id)}/enabled`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}

export async function deleteAlert(id: string): Promise<void> {
  await jsonRequest<{ id: string }>(`/api/alerts/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 条件自测：用当前行情判定一次（不推送、不改状态） */
export async function testAlert(id: string): Promise<{
  matched: boolean
  value: number
  error?: string
  summary: { title: string; body: string }
}> {
  return jsonRequest(`/api/alerts/${encodeURIComponent(id)}/test`, { method: 'POST' })
}

/** 立即推送一条（验证 Telegram / 浏览器通知链路） */
export async function sendAlertNow(id: string): Promise<AlertEvent> {
  return jsonRequest<AlertEvent>(`/api/alerts/${encodeURIComponent(id)}/send`, { method: 'POST' })
}

/** 触发记录增量：`since` = 前端已消费的最大 seq */
export async function fetchAlertEvents(since?: number): Promise<AlertEvent[]> {
  const qs = since === undefined ? '' : `?since=${since}`
  return jsonRequest<AlertEvent[]>(`/api/alerts/events${qs}`)
}

export async function clearAlertEvents(): Promise<void> {
  await jsonRequest('/api/alerts/events', { method: 'DELETE' })
}

export async function updateAlertSettings(patch: Partial<AlertSettings>): Promise<AlertSettings> {
  return jsonRequest<AlertSettings>('/api/alerts/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

/** 发送测试电报消息（可临时传 Token / ChatID 覆盖已保存值） */
export async function testTelegram(payload: {
  botToken?: string
  chatId?: string
}): Promise<{ ok: boolean; error?: string }> {
  return jsonRequest('/api/alerts/settings/test-telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** 立即执行一次服务端轮询 */
export async function runAlertTick(): Promise<AlertMonitorStatus> {
  return jsonRequest<AlertMonitorStatus>('/api/alerts/tick', { method: 'POST' })
}

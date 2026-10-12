import type {
  BacktestResult,
  ExchangeId,
  Instrument,
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

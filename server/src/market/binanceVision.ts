/**
 * Binance Data Vision —— 全历史公开行情直连源。
 *
 * 为什么需要它：
 *   ccxt 走的交易所接口普遍限制「只能取最近 N 根」（Gate 期货硬上限 10000 根），
 *   15m 粒度下仅能覆盖约 104 天，导致回测样本严重不足、交易笔数远少于
 *   TradingView。而 Binance 官方的公开数据镜像 `data-api.binance.vision`
 *   提供**从 2017 年至今天**的完整现货 K 线，无需 API Key、无需鉴权，
 *   并在本机网络环境下可直连（实测 Binance 主站 / OKX / Bybit / Bitget
 *   均连接超时，仅该镜像可用）。
 *
 * 数据一致性说明：
 *   该镜像与 TradingView 的 BINANCE:BTCUSDT 现货数据同源，
 *   因此价格与 TradingView 图表高度一致（优于此前降级到的 Gate 期货价）。
 *   代价是它只有**现货**数据，没有资金费率/持仓量，但本策略不依赖这些。
 *
 * 接口约定（与 Binance 官方一致）：
 *   GET /api/v3/klines?symbol=&interval=&startTime=&endTime=&limit=
 *   单次 limit 上限 1000，翻页靠推进 startTime。
 */

import type { Candle, Timeframe } from '../../../shared/types'
import { TIMEFRAME_MS } from '../../../shared/types'

const BASE_URL = process.env.BINANCE_VISION_BASE ?? 'https://data-api.binance.vision'
/** 单次请求上限（Binance 硬限制 1000） */
const PAGE_LIMIT = 1000
/** 最多翻页次数，防止异常参数导致无限循环 */
const MAX_PAGES = 3000
/** 单次 HTTP 超时 */
const TIMEOUT = 12_000
/** 该镜像可回溯的最早时间（BTCUSDT 现货上架于 2017-08-17） */
export const VISION_EARLIEST_MS = Date.parse('2017-08-01T00:00:00Z')

/** 本策略支持的周期与该接口的周期字符串一一对应，无需映射 */
const SUPPORTED: ReadonlySet<string> = new Set([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '12h',
  '1d', '3d', '1w',
])

/** 探测结果缓存，避免每次都重新试探可用性 */
let availabilityCache: { ok: boolean; at: number } | null = null
const AVAILABILITY_TTL = 10 * 60 * 1000

export function supportsTimeframe(tf: Timeframe): boolean {
  return SUPPORTED.has(tf)
}

/**
 * 把项目内的统一符号（`BTC/USDT:USDT`、`BTC/USDT`、`BTCUSDT`）
 * 归一成 Binance 现货符号（`BTCUSDT`）。
 *
 * 注意：本镜像只提供现货，因此 `XYZ/USDT:USDT` 永续会映射为
 * 同名的现货符号。对于 BTC/ETH/SOL 等主流币，两者的价格差异
 * 通常在千分之几以内，对策略形态判断无实质影响。
 */
export function toVisionSymbol(symbol: string): string {
  const head = symbol.split(':')[0]
  const [base, quote] = head.split('/')
  if (!quote) return head.replace(/[-_]/g, '').toUpperCase()
  return `${base}${quote}`.toUpperCase()
}

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'crypto-backtest/1.0', Accept: 'application/json' },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${body.slice(0, 160)}`)
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

interface VisionOptions {
  symbol: string
  timeframe: Timeframe
  since: number
  until: number
}

/**
 * 拉取一段完整的现货 K 线，自动翻页直至覆盖 until。
 *
 * 翻页策略：以 `startTime = 上一页最后一根的开盘时间 + 周期` 推进。
 * 终止条件必须用「覆盖到 until」或「游标不再前进」判断，
 * 不能用「返回条数 < limit」——交易所会自行收敛单页条数。
 */
export async function fetchVisionKlines(opts: VisionOptions): Promise<Candle[]> {
  if (!supportsTimeframe(opts.timeframe)) {
    throw new Error(`Binance Vision 不支持周期 ${opts.timeframe}`)
  }

  const symbol = toVisionSymbol(opts.symbol)
  const tfMs = TIMEFRAME_MS[opts.timeframe]
  const until = Math.min(opts.until, Date.now())
  // 该镜像最早只到 2017-08，早于它的起始时间直接上提到最早可用点
  let cursor = Math.max(opts.since, VISION_EARLIEST_MS)

  const all: Candle[] = []
  let pages = 0

  while (cursor <= until && pages < MAX_PAGES) {
    pages++
    const url =
      `${BASE_URL}/api/v3/klines?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${opts.timeframe}&startTime=${cursor}&endTime=${until}&limit=${PAGE_LIMIT}`

    const raw = (await fetchJson(url)) as unknown
    if (!Array.isArray(raw) || raw.length === 0) break

    let lastTs = -1
    for (const row of raw as unknown[][]) {
      if (!Array.isArray(row) || row.length < 6) continue
      const ts = Number(row[0])
      if (!Number.isFinite(ts) || ts > until) continue
      const c: Candle = {
        timestamp: ts,
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]) || 0,
      }
      if (
        !Number.isFinite(c.open) ||
        !Number.isFinite(c.high) ||
        !Number.isFinite(c.low) ||
        !Number.isFinite(c.close) ||
        c.close <= 0
      ) {
        continue
      }
      all.push(c)
      if (ts > lastTs) lastTs = ts
    }

    if (lastTs < 0) break
    if (lastTs >= until) break
    const next = lastTs + tfMs
    if (next <= cursor) break
    cursor = next
  }

  // 去重 + 升序
  const seen = new Set<number>()
  const out: Candle[] = []
  for (const c of all) {
    if (seen.has(c.timestamp)) continue
    seen.add(c.timestamp)
    out.push(c)
  }
  out.sort((a, b) => a.timestamp - b.timestamp)
  return out
}

/**
 * 轻量可用性探测：只请求 1 根 K 线，判断该镜像当前是否可访问。
 * 结果缓存 10 分钟，避免回测主流程反复等待超时。
 */
export async function isVisionAvailable(): Promise<boolean> {
  if (availabilityCache && Date.now() - availabilityCache.at < AVAILABILITY_TTL) {
    return availabilityCache.ok
  }
  try {
    const url = `${BASE_URL}/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=1`
    const raw = (await fetchJson(url)) as unknown
    const ok = Array.isArray(raw) && raw.length > 0
    availabilityCache = { ok, at: Date.now() }
    return ok
  } catch {
    availabilityCache = { ok: false, at: Date.now() }
    return false
  }
}

/** 供测试/诊断脚本清空可用性缓存 */
export function resetVisionAvailability(): void {
  availabilityCache = null
}

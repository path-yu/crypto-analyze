/**
 * REST API 路由。
 */

import { Router, type Request, type Response } from 'express'
import type { ExchangeId, Timeframe } from '../../../shared/types'
import { EXCHANGES, TIMEFRAMES } from '../../../shared/types'
import {
  fetchKlines,
  listInstrumentsWithFallback,
  fetchLastPrice,
  MarketError,
} from '../market/exchange'
import {
  runBacktestService,
  ValidationError,
  type BacktestRequest,
} from '../service/backtestService'

export const apiRouter: Router = Router()

function asExchange(v: unknown, fallback: ExchangeId = 'binanceusdm'): ExchangeId {
  const s = String(v ?? '') as ExchangeId
  return EXCHANGES.some((e) => e.id === s) ? s : fallback
}

function asTimeframe(v: unknown, fallback: Timeframe = '1h'): Timeframe {
  const s = String(v ?? '') as Timeframe
  return TIMEFRAMES.includes(s) ? s : fallback
}

function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function fail(res: Response, err: unknown, status = 500): void {
  const message = err instanceof Error ? err.message : String(err)
  const code = err instanceof ValidationError ? 400 : err instanceof MarketError ? 502 : status
  res.status(code).json({ ok: false, error: message })
}

/* ------------------------------------------------------------------ */

apiRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true, ts: Date.now() })
})

apiRouter.get('/exchanges', (_req: Request, res: Response) => {
  res.json({ ok: true, data: EXCHANGES, timeframes: TIMEFRAMES })
})

/** 合约列表（USDT 本位永续） */
apiRouter.get('/instruments', async (req: Request, res: Response) => {
  try {
    const exchange = asExchange(req.query.exchange)
    const q = req.query.q ? String(req.query.q) : undefined
    const limit = toNumber(req.query.limit) ?? 400
    const { instruments, exchange: used, fallbackFrom } = await listInstrumentsWithFallback(
      exchange,
      q,
    )
    res.json({
      ok: true,
      exchange: used,
      requested: exchange,
      fallbackFrom,
      total: instruments.length,
      data: instruments.slice(0, limit),
    })
  } catch (err) {
    fail(res, err)
  }
})

/** 最新成交价 */
apiRouter.get('/price', async (req: Request, res: Response) => {
  try {
    const exchange = asExchange(req.query.exchange)
    const symbol = String(req.query.symbol ?? 'BTC/USDT:USDT')
    const result = await fetchLastPrice(exchange, symbol)
    res.json({
      ok: true,
      symbol,
      requested: exchange,
      exchange: result?.exchange ?? exchange,
      fallbackFrom: result && result.exchange !== exchange ? exchange : undefined,
      price: result?.price ?? null,
    })
  } catch (err) {
    fail(res, err)
  }
})

/**
 * 纯 K 线接口（不带回测），用于快速预览图表。
 * GET /api/klines?exchange=binanceusdm&symbol=BTC/USDT:USDT&timeframe=1h&bars=1000
 */
apiRouter.get('/klines', async (req: Request, res: Response) => {
  try {
    const exchange = asExchange(req.query.exchange)
    const symbol = String(req.query.symbol ?? 'BTC/USDT:USDT')
    const timeframe = asTimeframe(req.query.timeframe)
    const bars = Math.max(100, Math.min(20000, toNumber(req.query.bars) ?? 1000))
    const until = toNumber(req.query.until) ?? Date.now()

    const result = await fetchKlines({
      exchange,
      symbol,
      timeframe,
      until,
      targetBars: bars,
      useCache: req.query.cache !== 'false',
    })
    res.json({
      ok: true,
      exchange: result.exchange,
      symbol,
      timeframe,
      cached: result.cached,
      data: result.candles,
    })
  } catch (err) {
    fail(res, err)
  }
})

/**
 * 回测接口。
 * POST /api/backtest
 * {
 *   "exchange": "binanceusdm",
 *   "symbol": "BTC/USDT:USDT",
 *   "timeframe": "1h",
 *   "since": 1730419200000,
 *   "until": 1761955200000,
 *   "params": { "leverage": 5, "sensitivity": 18, ... }
 * }
 */
apiRouter.post('/backtest', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as BacktestRequest & { params?: Record<string, unknown> }
    const payload: BacktestRequest = {
      exchange: asExchange(body.exchange),
      symbol: typeof body.symbol === 'string' ? body.symbol : undefined,
      timeframe: asTimeframe(body.timeframe),
      since: toNumber(body.since),
      until: toNumber(body.until),
      bars: toNumber(body.bars),
      useCache: body.useCache,
      params: (body.params ?? {}) as BacktestRequest['params'],
    }
    const result = await runBacktestService(payload)
    res.json({ ok: true, data: result })
  } catch (err) {
    fail(res, err)
  }
})

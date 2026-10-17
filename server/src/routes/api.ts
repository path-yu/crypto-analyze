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
import { analyzePine } from '../pine/pinetsAdapter'
import {
  deletePineScript,
  listPineScripts,
  normalizeScriptName,
  savePineScript,
} from '../pine/store'

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

/** 把请求体整理为 runBacktestService 需要的 payload（/backtest 与 /pine/backtest 共用） */
function buildBacktestPayload(body: Record<string, unknown>): BacktestRequest {
  return {
    exchange: asExchange(body.exchange as string),
    symbol: typeof body.symbol === 'string' ? body.symbol : undefined,
    timeframe: asTimeframe(body.timeframe as string),
    since: toNumber(body.since),
    until: toNumber(body.until),
    bars: toNumber(body.bars),
    useCache: body.useCache as boolean | undefined,
    tickSize: toNumber(body.tickSize),
    params: (body.params ?? {}) as BacktestRequest['params'],
    pine: body.pine as BacktestRequest['pine'],
  }
}

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
    const result = await runBacktestService(buildBacktestPayload((req.body ?? {}) as Record<string, unknown>))
    res.json({ ok: true, data: result })
  } catch (err) {
    fail(res, err)
  }
})

/**
 * Pine 实时校验。
 * POST /api/pine/compile  { source, inputs? }
 *
 * 语法 / 语义 / 版本错误仍返回 200 且 ok:true，诊断放进 diagnostics，
 * 编辑器可一边打字一边显示。改用 PineTS 后不再产出「编译出的 TypeScript」，
 * 因此响应里没有 `ts` 字段（前端已不使用它）。
 */
apiRouter.post('/pine/compile', (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { source?: unknown; inputs?: unknown }
    const source = typeof body.source === 'string' ? body.source : ''
    if (!source.trim()) throw new ValidationError('缺少 Pine 源码（source）')
    const inputs = body.inputs as Record<string, number | boolean | string> | undefined
    const analysis = analyzePine(source, inputs)
    res.json({
      ok: true,
      data: {
        diagnostics: analysis.diagnostics,
        meta: analysis.meta,
        ok: !analysis.diagnostics.some((d) => d.severity === 'error'),
      },
    })
  } catch (err) {
    fail(res, err)
  }
})

/**
 * Pine 回测：结构与 /api/backtest 相同，额外要求 params.strategy = 'pine' 与 pine.source。
 * POST /api/pine/backtest  { source, inputs?, ...其余同 /api/backtest }
 */
apiRouter.post('/pine/backtest', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const source = typeof body.source === 'string' ? body.source : undefined
    const payload = buildBacktestPayload(body)
    if (source) {
      payload.pine = {
        source,
        inputs: body.inputs as Record<string, number | boolean | string> | undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
      }
    }
    payload.params = { ...(payload.params ?? {}), strategy: 'pine' }
    const result = await runBacktestService(payload)
    res.json({ ok: true, data: result })
  } catch (err) {
    fail(res, err)
  }
})

/* ------------------------------------------------------------------ */
/* Pine 脚本本地保存                                                    */
/* ------------------------------------------------------------------ */

/**
 * 已保存脚本列表（最近保存的在前）：GET /api/pine/scripts
 *
 * **实时读盘**：每次请求都重新扫描 `server/pine/` 下的脚本目录并读源码，
 * 不读也不写任何索引/缓存文件 —— 因此在 IDE 或 git 里改了 `.pine` 后，
 * 前端刷新列表就能看到最新内容。
 */
apiRouter.get('/pine/scripts', (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, data: listPineScripts() })
  } catch (err) {
    fail(res, err)
  }
})

/**
 * 保存脚本：POST /api/pine/scripts  { name, source }
 *
 * 同名视为更新（就地覆盖同一目录），换名即新增；落盘位置：
 *   server/pine/<脚本名目录>/<脚本名目录>.pine   原始源码
 *
 * 注：改用 PineTS 后不再顺带写入编译产物（`<目录>.ts`）—— PineTS 在内存里
 * 直接转译，产物对前端与后端都没有用途。
 */
apiRouter.post('/pine/scripts', (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { name?: unknown; source?: unknown }
    const source = typeof body.source === 'string' ? body.source : ''
    if (!source.trim()) throw new ValidationError('缺少 Pine 源码（source）')
    let name: string
    try {
      name = normalizeScriptName(body.name)
    } catch (e) {
      throw new ValidationError(e instanceof Error ? e.message : '脚本名不合法')
    }
    res.json({ ok: true, data: savePineScript(name, source) })
  } catch (err) {
    fail(res, err)
  }
})

/** 删除脚本：DELETE /api/pine/scripts/:id */
apiRouter.delete('/pine/scripts/:id', (req: Request, res: Response) => {
  try {
    const id = String(req.params.id ?? '')
    if (!deletePineScript(id)) throw new ValidationError('脚本不存在（可能已被删除）')
    res.json({ ok: true, data: { id } })
  } catch (err) {
    fail(res, err)
  }
})

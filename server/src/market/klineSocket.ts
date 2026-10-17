/**
 * 浏览器侧实时 K 线推送通道（WebSocket，路径 `/ws/klines`）。
 *
 * 职责边界：**历史 K 线仍由 `/api/klines` 一次性拉取**，这里只驱动「实时尾巴」——
 * 最后一根未收盘 bar 的跳动 + 新 bar 收盘时的追加。上游复用 `market/stream.ts` 的
 * ccxt.pro 行情流（滚动窗口 ≤ MAX_BUFFER 根），不重造取数逻辑。
 *
 * 每个连接只允许一条订阅（切品种/周期即覆盖）。订阅/退订/断开三条路径都会同步到
 * stream 的 `chart` 来源，避免在交易所侧泄漏没人消费的 WS 连接。
 */

import type { Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { ExchangeId, Timeframe } from '../../../shared/types'
import { EXCHANGES, TIMEFRAMES } from '../../../shared/types'
import {
  onStreamUpdate,
  setSubscriptionSource,
  streamCandles,
  type StreamSubscription,
} from './stream'

/** 本模块在订阅注册表里占用的来源名 */
const SOURCE = 'chart'
/** 每次推送的最新 bar 根数：2 根便于前端判断「上一根已收盘」并对齐时间戳 */
const PUSH_BARS = 2

/**
 * 推送节流间隔。
 *
 * 上游（ccxt.pro 的 `watchOHLCV`）对**未收盘 K 线**是持续推送的 —— Binance 的 kline 流
 * 实测每 250ms~1s 就来一条。原实现是「来一条转一条」，于是浏览器每秒收到 2~3 帧、
 * 前端每秒重渲染 2~3 次（每帧内容只差最后一根的 close/high/low 几个点）。
 * 图表 1 秒刷新一次完全够用，所以这里把中间态合并掉：
 *   · **新 bar 收盘**（时间戳前进）立即推送，不受节流影响；
 *   · 其余改动最多每 PUSH_MIN_INTERVAL_MS 推一次，且用尾随定时器保证「最后一次状态」一定送达。
 */
const PUSH_MIN_INTERVAL_MS = 1_000

/** 每条连接的状态：订阅 + 节流记账 */
interface ClientState {
  sub: StreamSubscription | null
  /** 最近一次推送时刻（用于节流窗口） */
  lastPushAt: number
  /** 最近一次推出去的最后一根 bar 时间戳（用于识别「新 bar 收盘」） */
  lastPushedTs: number
  /** 被节流挡下、排队等待的尾随推送 */
  timer?: NodeJS.Timeout
}

function asExchange(v: unknown): ExchangeId | null {
  const s = String(v ?? '')
  return EXCHANGES.some((e) => e.id === s) ? (s as ExchangeId) : null
}

function asTimeframe(v: unknown): Timeframe | null {
  const s = String(v ?? '') as Timeframe
  return TIMEFRAMES.includes(s) ? s : null
}

/** 在现有 HTTP server 上挂载 `/ws/klines`；返回卸载函数 */
export function attachKlineSocket(server: Server): () => void {
  const wss = new WebSocketServer({ server, path: '/ws/klines' })
  const clientSubs = new Map<WebSocket, ClientState>()

  const syncChartSource = (): void => {
    const subs: StreamSubscription[] = []
    for (const state of clientSubs.values()) if (state.sub) subs.push(state.sub)
    setSubscriptionSource(SOURCE, subs)
  }

  /**
   * 取当前滚动窗口的最新几根并推给客户端。
   * 注意在**发送时刻**重新读 `streamCandles`（而不是带着调用时的快照），
   * 这样尾随推送发出的一定是最新状态。
   */
  const sendCandles = (ws: WebSocket, state: ClientState): void => {
    const sub = state.sub
    if (!sub || !sub.timeframe) return
    // 注意：`ws.OPEN` 是类上的静态常量，实例上并没有这个属性 ——
    // 写成 `ws.OPEN` 会得到 undefined，从而把所有连接都判成「不可写」而静默丢弃推送。
    if (ws.readyState !== WebSocket.OPEN) return
    const candles = streamCandles(sub.exchange, sub.symbol, sub.timeframe)
    if (!candles || candles.length === 0) return
    ws.send(
      JSON.stringify({
        type: 'candles',
        exchange: sub.exchange,
        symbol: sub.symbol,
        timeframe: sub.timeframe,
        candles: candles.slice(-PUSH_BARS),
      }),
    )
    state.lastPushAt = Date.now()
    state.lastPushedTs = Math.max(state.lastPushedTs, candles[candles.length - 1].timestamp)
  }

  const offUpdate = onStreamUpdate((u) => {
    if (u.kind !== 'ohlcv' || !u.timeframe) return
    const timeframe = u.timeframe
    for (const [ws, state] of clientSubs) {
      const sub = state.sub
      if (!sub || ws.readyState !== WebSocket.OPEN) continue
      if (sub.exchange !== u.exchange || sub.symbol !== u.symbol || sub.timeframe !== timeframe) continue
      const candles = streamCandles(u.exchange, u.symbol, timeframe)
      if (!candles || candles.length === 0) continue
      const lastTs = candles[candles.length - 1].timestamp
      const barClosed = lastTs > state.lastPushedTs
      const now = Date.now()
      if (barClosed || now - state.lastPushAt >= PUSH_MIN_INTERVAL_MS) {
        if (state.timer) {
          clearTimeout(state.timer)
          state.timer = undefined
        }
        sendCandles(ws, state)
        continue
      }
      // 节流窗口内：已有尾随推送排队就什么都不做（它会把最新状态发出去）
      if (state.timer) continue
      const wait = Math.max(50, PUSH_MIN_INTERVAL_MS - (now - state.lastPushAt))
      state.timer = setTimeout(() => {
        state.timer = undefined
        sendCandles(ws, state)
      }, wait)
      state.timer.unref?.()
    }
  })

  const drop = (ws: WebSocket): void => {
    const state = clientSubs.get(ws)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    clientSubs.delete(ws)
    syncChartSource()
  }

  wss.on('connection', (ws: WebSocket) => {
    clientSubs.set(ws, { sub: null, lastPushAt: 0, lastPushedTs: 0 })
    ws.on('message', (data: unknown) => {
      let msg: unknown
      try {
        msg = JSON.parse(String(data))
      } catch {
        return
      }
      const m = msg as { type?: unknown; exchange?: unknown; symbol?: unknown; timeframe?: unknown }
      const state = clientSubs.get(ws)
      if (!state) return
      if (m.type === 'unsubscribe') {
        if (state.timer) {
          clearTimeout(state.timer)
          state.timer = undefined
        }
        state.sub = null
        syncChartSource()
        return
      }
      if (m.type !== 'subscribe') return
      const exchange = asExchange(m.exchange)
      const timeframe = asTimeframe(m.timeframe)
      const symbol = typeof m.symbol === 'string' ? m.symbol.trim() : ''
      if (!exchange || !timeframe || !symbol) return
      // 换订阅即重置节流记账：新标的的第一条推送不应被上一次的窗口挡住
      state.sub = { exchange, symbol, kind: 'ohlcv', timeframe }
      state.lastPushAt = 0
      state.lastPushedTs = 0
      syncChartSource()
    })
    ws.on('close', () => drop(ws))
    ws.on('error', () => drop(ws))
  })

  return () => {
    offUpdate()
    for (const [ws, state] of clientSubs) {
      if (state.timer) clearTimeout(state.timer)
      try {
        ws.close()
      } catch {
        /* 关闭期异常忽略 */
      }
    }
    clientSubs.clear()
    setSubscriptionSource(SOURCE, [])
    wss.close()
  }
}

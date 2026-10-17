/**
 * 浏览器侧实时 K 线尾巴（WebSocket 客户端）。
 *
 * 职责边界：只负责「最后一根未收盘 bar 的跳动 + 新 bar 收盘后的追加」，
 * **历史 K 线仍由 `/api/klines` 一次拉取**（服务端的滚动窗口只有几百根，画不了一年）。
 * 断线自动指数退避重连，重连成功后重发当前订阅。
 */

import type { Candle, ExchangeId, Timeframe } from '@shared/types'

/** 一次订阅：交易所 + 品种 + 周期 */
export interface KlineSubscription {
  exchange: ExchangeId
  symbol: string
  timeframe: Timeframe
}

/** 服务端推送的一批最新 bar（按时间升序，含未收盘的那根） */
export interface KlinePush extends KlineSubscription {
  candles: Candle[]
}

export interface KlineStream {
  /** 切换订阅（切品种 / 周期时调用，服务端会覆盖该连接上旧的那条） */
  subscribe: (sub: KlineSubscription) => void
  /** 关闭连接并停止重连 */
  close: () => void
}

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/** dev 下由 Vite 的 `/ws` 代理转到 8787；生产下与页面同源 */
function socketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws/klines`
}

export function openKlineStream(handlers: {
  onCandles: (push: KlinePush) => void
  onStatus?: (status: 'open' | 'closed') => void
}): KlineStream {
  let socket: WebSocket | null = null
  let current: KlineSubscription | null = null
  let retry = 0
  let closed = false
  let timer: number | undefined

  const sendSubscribe = (): void => {
    if (!current || socket?.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'subscribe', ...current }))
  }

  const connect = (): void => {
    if (closed) return
    socket = new WebSocket(socketUrl())
    socket.onopen = () => {
      retry = 0
      handlers.onStatus?.('open')
      sendSubscribe()
    }
    socket.onmessage = (ev: MessageEvent<string>) => {
      let msg: unknown
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      const m = msg as { type?: unknown; candles?: unknown; exchange?: unknown; symbol?: unknown; timeframe?: unknown }
      if (m.type !== 'candles' || !Array.isArray(m.candles) || m.candles.length === 0) return
      handlers.onCandles({
        exchange: m.exchange as ExchangeId,
        symbol: String(m.symbol ?? ''),
        timeframe: m.timeframe as Timeframe,
        candles: m.candles as Candle[],
      })
    }
    socket.onclose = () => {
      handlers.onStatus?.('closed')
      if (closed) return
      // 退避重连；重连成功后 onopen 会重发当前订阅
      timer = window.setTimeout(connect, Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** retry++))
    }
    socket.onerror = () => {
      /* 交给 onclose 统一重连 */
    }
  }

  connect()

  return {
    subscribe(sub) {
      current = sub
      // 连接尚未建立时什么都不用做：onopen 会按 current 发订阅
      sendSubscribe()
    },
    close() {
      closed = true
      if (timer !== undefined) window.clearTimeout(timer)
      try {
        socket?.close()
      } catch {
        /* 关闭期异常忽略 */
      }
      socket = null
    },
  }
}

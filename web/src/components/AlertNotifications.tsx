/**
 * 页内通知轮询：定时拉取服务端的触发记录，对标注了 `browser: true` 的事件
 * 调用浏览器的 Notification API 弹通知。
 *
 * 挂在 App 顶层（与警报面板开关无关）—— 只要页面开着就能收到提醒；
 * 页面关掉后仍有服务端轮询兜底（电报照常推送）。
 *
 * `lastSeq` 存在 localStorage，刷新页面不会重复弹历史通知。
 */

import { useEffect, useRef } from 'react'
import { fetchAlertEvents } from '../api'

const LS_KEY = 'crypto-alert-last-seq'
/** 轮询间隔（毫秒） */
const POLL_MS = 8_000

function readLastSeq(): number {
  try {
    return Number(localStorage.getItem(LS_KEY) ?? '') || 0
  } catch {
    return 0
  }
}

export default function AlertNotifications() {
  const lastSeqRef = useRef<number>(readLastSeq())
  /** 首次拉取不带 since：只同步进度，不把历史记录一次性弹出来 */
  const syncedRef = useRef<boolean>(lastSeqRef.current > 0)

  useEffect(() => {
    let cancelled = false

    const notify = (title: string, body: string) => {
      if (typeof Notification === 'undefined') return
      if (Notification.permission !== 'granted') return
      try {
        new Notification(title, { body })
      } catch {
        /* 个别浏览器在非安全上下文会抛错，忽略即可 */
      }
    }

    const poll = async () => {
      try {
        const events = await fetchAlertEvents(syncedRef.current ? lastSeqRef.current : undefined)
        if (cancelled || events.length === 0) return
        for (const e of events) {
          lastSeqRef.current = Math.max(lastSeqRef.current, e.seq)
          if (syncedRef.current && e.browser) notify(e.title, e.body)
        }
        syncedRef.current = true
        try {
          localStorage.setItem(LS_KEY, String(lastSeqRef.current))
        } catch {
          /* 无痕模式下写不进去，不影响功能 */
        }
      } catch {
        // 服务未就绪 / 网络抖动：下一次轮询再试
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  return null
}

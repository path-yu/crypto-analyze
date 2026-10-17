/**
 * 警报推送：电报机器人 + 页内浏览器通知（事件落库，前端轮询后弹 Notification）。
 *
 * 电报走 `api.telegram.org`，国内网络常需代理 —— 复用行情层同一套代理解析
 * （`HTTPS_PROXY` / 系统代理），没配代理则直连。
 */

import https from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import type { AlertChannel, AlertEvent, PriceAlert, TelegramConfig } from '../../../shared/types'
import { resolveProxyUrl } from '../market/exchange'
import { appendEvent, getSettings } from './store'

export interface PushResult {
  ok: boolean
  error?: string
}

const TELEGRAM_TIMEOUT_MS = 15_000

/**
 * 发送一条 Telegram 消息。
 * 返回结构不抛异常 —— 推送失败只记录原因，绝不影响警报判定主流程。
 */
export function sendTelegram(text: string, cfg: TelegramConfig): Promise<PushResult> {
  return new Promise((resolve) => {
    const token = cfg.botToken?.trim()
    const chatId = cfg.chatId?.trim()
    if (!token || !chatId) {
      resolve({ ok: false, error: '未配置 Bot Token / Chat ID' })
      return
    }

    const body = JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    })

    const proxy = resolveProxyUrl()
    let agent: https.Agent | undefined
    try {
      agent = proxy ? new HttpsProxyAgent(proxy) : undefined
    } catch {
      agent = undefined
    }

    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        ...(agent ? { agent } : {}),
        timeout: TELEGRAM_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            const json = JSON.parse(text) as { ok?: boolean; description?: string }
            if (json.ok) resolve({ ok: true })
            else resolve({ ok: false, error: json.description ?? `HTTP ${res.statusCode}` })
          } catch {
            resolve({ ok: false, error: `电报接口返回了非 JSON 响应（HTTP ${res.statusCode}）` })
          }
        })
      },
    )

    req.on('timeout', () => {
      req.destroy(new Error('请求超时'))
    })
    req.on('error', (err) => {
      resolve({ ok: false, error: `${err.message}${proxy ? `（代理 ${proxy}）` : '（直连，可尝试配置 HTTPS_PROXY）'}` })
    })
    req.write(body)
    req.end()
  })
}

/** 拼接电报消息正文：标题 + 正文 + 品种/时间等元信息 */
export function telegramText(alert: PriceAlert, title: string, body: string, value: number, at: number): string {
  const time = new Date(at).toLocaleString('zh-CN', { hour12: false })
  return [
    `🔔 ${title}`,
    body,
    `合约：${alert.symbol}（${alert.exchange}）`,
    `触发值：${value}`,
    `时间：${time}`,
  ].join('\n')
}

/**
 * 触发一条警报：按 `channels` 分发到电报 / 页内通知。
 *
 * 无论推送是否成功都会写一条 `AlertEvent` —— 页内通知靠事件表，
 * 电报失败也留在事件里供面板排查。
 */
export async function dispatchAlert(
  alert: PriceAlert,
  payload: { title: string; body: string; value: number; at: number },
): Promise<AlertEvent> {
  const { title, body, value, at } = payload
  const channels = alert.channels ?? []
  const settings = getSettings()

  let telegram: { ok: boolean; error?: string } | undefined
  if (channels.includes('telegram' as AlertChannel)) {
    if (!settings.telegram.enabled) {
      telegram = { ok: false, error: '全局 Telegram 推送未启用（在警报面板的「推送设置」里开启）' }
    } else {
      telegram = await sendTelegram(telegramText(alert, title, body, value, at), settings.telegram)
    }
  }

  return appendEvent({
    alertId: alert.id,
    name: alert.name?.trim() || alert.symbol,
    symbol: alert.symbol,
    exchange: alert.exchange,
    title,
    body,
    value,
    at,
    // 页内通知：该警报选了 browser 渠道 + 全局开关打开
    browser: channels.includes('browser') && settings.browserEnabled,
    ...(telegram ? { telegram } : {}),
  })
}

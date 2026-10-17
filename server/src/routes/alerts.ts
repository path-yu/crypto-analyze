/**
 * 价格警报 REST 路由（挂载在 `/api/alerts`）。
 *
 * | 方法 | 路径 | 说明 |
 * | --- | --- | --- |
 * | GET | `/` | 警报列表 + 全局设置 + 轮询状态 |
 * | POST | `/` | 新建警报 |
 * | PUT | `/settings` | 更新全局设置（Telegram / 间隔 / 浏览器通知） |
 * | POST | `/settings/test-telegram` | 发送一条测试电报消息 |
 * | GET | `/events?since=` | 触发记录增量（前端轮询后弹页内通知） |
 * | DELETE | `/events` | 清空触发记录 |
 * | POST | `/tick` | 立即执行一次轮询（保存后想马上判定时用） |
 * | PUT | `/:id` | 更新警报（含提示信息） |
 * | PATCH | `/:id/enabled` | 启用 / 停用 |
 * | DELETE | `/:id` | 删除 |
 * | POST | `/:id/test` | 用当前行情判定一次（不推送、不写状态），返回是否命中 |
 * | POST | `/:id/send` | 按当前行情立即推送一条（验证电报 / 浏览器通知链路） |
 *
 * ⚠ 路由注册顺序即匹配顺序：固定路径（`/settings`、`/events`、`/tick`）必须排在
 * `/:id` 之前，否则 `PUT /settings` 会被当成 id 为 `settings` 的警报更新。
 */

import { Router, type Request, type Response } from 'express'
import { createSnapshot, evaluateAlert, renderMessage } from '../alerts/evaluator'
import { dispatchAlert, sendTelegram } from '../alerts/notify'
import {
  getMonitorStatus,
  refreshSubscriptions,
  restartAlertMonitor,
  runAlertTick,
} from '../alerts/monitor'
import {
  AlertValidationError,
  clearEvents,
  createAlert,
  deleteAlert,
  getAlert,
  getSettings,
  listAlerts,
  listEvents,
  normalizeAlertInput,
  normalizeSettings,
  setAlertEnabled,
  updateAlert,
  updateSettings,
} from '../alerts/store'

export const alertsRouter: Router = Router()

function fail(res: Response, err: unknown, status = 500): void {
  const message = err instanceof Error ? err.message : String(err)
  res.status(err instanceof AlertValidationError ? 400 : status).json({ ok: false, error: message })
}

/** 综合视图：列表 + 设置 + 调度状态，前端一次请求拿全 */
function overview() {
  return { alerts: listAlerts(), settings: getSettings(), status: getMonitorStatus() }
}

/* ------------------------------ 列表 / 新建 ------------------------------ */

alertsRouter.get('/', (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, data: overview() })
  } catch (err) {
    fail(res, err)
  }
})

alertsRouter.post('/', (req: Request, res: Response) => {
  try {
    const alert = createAlert(normalizeAlertInput(req.body))
    // 立刻建 WS 订阅，同时判定一次：给涨跌幅基准价 / 上次价格一个初值，面板也能马上显示当前值
    refreshSubscriptions()
    void runAlertTick()
    res.json({ ok: true, data: alert })
  } catch (err) {
    fail(res, err)
  }
})

/* ------------------------------ 全局设置 ------------------------------ */

alertsRouter.put('/settings', (req: Request, res: Response) => {
  try {
    const settings = updateSettings(req.body)
    restartAlertMonitor()
    res.json({ ok: true, data: settings })
  } catch (err) {
    fail(res, err)
  }
})

/**
 * 发送测试电报消息。请求体可临时覆盖 `botToken` / `chatId`
 * （未保存也能先验证，避免把错的 Token 存进去才发现发不出去）。
 */
alertsRouter.post('/settings/test-telegram', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { botToken?: unknown; chatId?: unknown }
    const saved = getSettings().telegram
    const cfg = normalizeSettings({
      telegram: {
        enabled: true,
        botToken:
          typeof body.botToken === 'string' && body.botToken.trim() ? body.botToken : saved.botToken,
        chatId: typeof body.chatId === 'string' && body.chatId.trim() ? body.chatId : saved.chatId,
      },
    }).telegram
    const result = await sendTelegram(
      `🔔 测试消息\n价格警报已连通，触发时将推送到本会话。\n时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      cfg,
    )
    res.json({ ok: true, data: result })
  } catch (err) {
    fail(res, err)
  }
})

/* ------------------------------ 触发记录 ------------------------------ */

alertsRouter.get('/events', (req: Request, res: Response) => {
  try {
    const since = req.query.since === undefined ? undefined : Number(req.query.since)
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit)
    res.json({
      ok: true,
      data: listEvents({
        ...(Number.isFinite(since) ? { since: since as number } : {}),
        ...(Number.isFinite(limit) ? { limit: limit as number } : {}),
      }),
    })
  } catch (err) {
    fail(res, err)
  }
})

alertsRouter.delete('/events', (_req: Request, res: Response) => {
  try {
    clearEvents()
    res.json({ ok: true, data: { cleared: true } })
  } catch (err) {
    fail(res, err)
  }
})

/* ------------------------------ 手动轮询 ------------------------------ */

alertsRouter.post('/tick', async (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, data: await runAlertTick() })
  } catch (err) {
    fail(res, err)
  }
})

/* ------------------------------ 单条警报 ------------------------------ */

alertsRouter.put('/:id', (req: Request, res: Response) => {
  try {
    const alert = updateAlert(String(req.params.id), normalizeAlertInput(req.body))
    if (!alert) throw new AlertValidationError('警报不存在（可能已被删除）')
    // 条件 / 品种 / 周期可能都变了，重新对齐 WS 订阅
    refreshSubscriptions()
    res.json({ ok: true, data: alert })
  } catch (err) {
    fail(res, err)
  }
})

alertsRouter.patch('/:id/enabled', (req: Request, res: Response) => {
  try {
    const alert = setAlertEnabled(String(req.params.id), (req.body ?? {}).enabled === true)
    if (!alert) throw new AlertValidationError('警报不存在（可能已被删除）')
    refreshSubscriptions()
    res.json({ ok: true, data: alert })
  } catch (err) {
    fail(res, err)
  }
})

alertsRouter.delete('/:id', (req: Request, res: Response) => {
  try {
    if (!deleteAlert(String(req.params.id))) throw new AlertValidationError('警报不存在（可能已被删除）')
    refreshSubscriptions()
    res.json({ ok: true, data: { id: req.params.id } })
  } catch (err) {
    fail(res, err)
  }
})

/** 条件自测：拿当前行情判定一次，返回是否命中；不推送、不改状态 */
alertsRouter.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const alert = getAlert(String(req.params.id))
    if (!alert) throw new AlertValidationError('警报不存在（可能已被删除）')
    const snap = createSnapshot(alert.exchange, alert.symbol)
    const ev = await evaluateAlert(alert, snap)
    res.json({
      ok: true,
      data: {
        matched: ev.fire,
        value: ev.value,
        error: ev.error,
        summary: renderMessage(alert, ev.value, Date.now()),
      },
    })
  } catch (err) {
    fail(res, err)
  }
})

/** 立即推送一条：用于验证电报 / 浏览器通知链路是否打通 */
alertsRouter.post('/:id/send', async (req: Request, res: Response) => {
  try {
    const alert = getAlert(String(req.params.id))
    if (!alert) throw new AlertValidationError('警报不存在（可能已被删除）')
    const now = Date.now()
    const snap = createSnapshot(alert.exchange, alert.symbol)
    // 优先用真实最新价；取不到就退回上一次判定值，保证「测试推送」不因行情抖动而失败
    const price = (await snap.lastPrice()) ?? alert.state?.lastValue ?? 0
    const { title, body } = renderMessage(alert, price, now)
    const event = await dispatchAlert(alert, { title, body, value: price, at: now })
    res.json({ ok: true, data: event })
  } catch (err) {
    fail(res, err)
  }
})

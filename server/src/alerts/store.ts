/**
 * 价格警报的本地存储。
 *
 * 三份 JSON 落在 `.cache/alerts/`（与 K 线缓存同属运行时数据，已被 .gitignore 忽略，
 * 因此 Telegram Token 这类敏感配置不会进版本库）：
 *
 * ```
 * .cache/alerts/alerts.json     警报列表（含运行期状态）
 * .cache/alerts/settings.json   全局设置（Telegram / 轮询间隔 / 浏览器通知开关）
 * .cache/alerts/events.json     触发记录（环形保留最近 MAX_EVENTS 条）
 * ```
 *
 * 采用「模块级内存态 + 写时整文件覆盖（先写临时文件再 rename）」：
 * 单进程服务，读写量小，简单可靠；进程重启后自动从磁盘恢复。
 * 测试可用环境变量改写目录：`ALERT_DATA_DIR`。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type {
  AlertChannel,
  AlertCondition,
  AlertEvent,
  AlertIndicator,
  AlertKind,
  AlertSettings,
  ExchangeId,
  PriceAlert,
  Timeframe,
} from '../../../shared/types'
import {
  ALERT_INDICATORS,
  ALERT_KIND_META,
  ALERT_POLL_MAX_MS,
  ALERT_POLL_MIN_MS,
  DEFAULT_ALERT_SETTINGS,
  EXCHANGES,
  TIMEFRAMES,
} from '../../../shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../../..')
const DEFAULT_DIR = path.join(PROJECT_ROOT, '.cache/alerts')

/** 触发记录的环形上限 */
export const MAX_EVENTS = 200
/** 提示信息长度上限 */
const MAX_MESSAGE_LEN = 500
/** 展示名长度上限 */
const MAX_NAME_LEN = 60
/** 单条警报的冷却上限（秒） */
const MAX_COOLDOWN_SEC = 24 * 3600

function dataDir(): string {
  return process.env.ALERT_DATA_DIR ?? DEFAULT_DIR
}

/** 警报数据目录绝对路径（monitor 用它放单实例锁文件） */
export function alertsDataDir(): string {
  return dataDir()
}

function fileOf(name: 'alerts' | 'settings' | 'events'): string {
  return path.join(dataDir(), `${name}.json`)
}

/* ------------------------------------------------------------------ */
/* 磁盘读写                                                            */
/* ------------------------------------------------------------------ */

function readJson<T>(file: string, fallback: T): T {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/**
 * 落盘：先写临时文件再 rename（正常路径下保证原子性）。
 *
 * 两个必须兜住的点：
 *  - **Windows 上 rename 覆盖已存在文件可能抛 `EPERM`**（目标被杀软扫描 / 编辑器
 *    持有句柄的竞态）。此时退化为直接覆盖写：牺牲原子性，但要保证数据能落盘。
 *  - **写盘失败绝不能把进程带崩**。这个模块只是持久化层 —— 内存态才是接口读取的
 *    真正数据源，一次落盘失败只应记一条日志，由下一次 flush 重试。
 *
 * @returns 是否写入成功（失败时调用方可保留 dirty 标记等待重试）
 */
function writeJson(file: string, data: unknown): boolean {
  const text = JSON.stringify(data, null, 2)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(tmp, text, 'utf8')
    try {
      fs.renameSync(tmp, file)
    } catch {
      fs.writeFileSync(file, text, 'utf8')
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* 临时文件清理不掉不影响结果 */
      }
    }
    return true
  } catch (err) {
    console.warn(`[alerts] 落盘失败 ${path.basename(file)}：`, err instanceof Error ? err.message : err)
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 内存态                                                              */
/* ------------------------------------------------------------------ */

interface StoreState {
  loaded: boolean
  alerts: PriceAlert[]
  settings: AlertSettings
  events: AlertEvent[]
  nextSeq: number
}

const state: StoreState = {
  loaded: false,
  alerts: [],
  settings: { ...DEFAULT_ALERT_SETTINGS },
  events: [],
  nextSeq: 1,
}

/**
 * 运行期状态（`applyAlertState`）的写盘去抖。
 *
 * 接入 WebSocket 后判定频率从「每 15 秒一次」变成「每有行情推送就判一次」，
 * 逐次整文件重写没必要 —— 内存里始终是最新的（接口读的也是内存），
 * 磁盘最多滞后 1 秒，重启时丢掉的也只是价格 / 基准价这类会自愈的字段。
 */
const ALERTS_FLUSH_DEBOUNCE_MS = 1_000
let alertsFlushTimer: NodeJS.Timeout | null = null
/** 有尚未落盘的运行期状态（落盘失败时保持为 true，等下一次 flush 重试） */
let alertsDirty = false

function scheduleAlertsFlush(): void {
  alertsDirty = true
  if (alertsFlushTimer) return
  alertsFlushTimer = setTimeout(() => {
    alertsFlushTimer = null
    if (!alertsDirty) return
    if (writeJson(fileOf('alerts'), state.alerts)) alertsDirty = false
    // 失败则保持 dirty：下一次判定（WS 推送很密集）会重新排一次 flush
  }, ALERTS_FLUSH_DEBOUNCE_MS)
  alertsFlushTimer.unref?.()
}

/** 立即落盘（结构性增删改用这个，别让磁盘滞后） */
function flushAlertsNow(): void {
  if (alertsFlushTimer) {
    clearTimeout(alertsFlushTimer)
    alertsFlushTimer = null
  }
  alertsDirty = !writeJson(fileOf('alerts'), state.alerts)
}

function load(): StoreState {
  if (state.loaded) return state
  state.alerts = readJson<PriceAlert[]>(fileOf('alerts'), [])
    .filter((a) => a && typeof a.id === 'string')
    .map((a) => ({ ...a, state: a.state ?? {} }))
  state.settings = normalizeSettings(readJson<Partial<AlertSettings>>(fileOf('settings'), {}))
  const events = readJson<{ nextSeq?: number; events?: AlertEvent[] }>(fileOf('events'), {})
  state.events = Array.isArray(events.events) ? events.events.slice(-MAX_EVENTS) : []
  state.nextSeq = Math.max(
    1,
    Number(events.nextSeq) || 0,
    ...state.events.map((e) => (Number(e.seq) || 0) + 1),
  )
  state.loaded = true
  return state
}

/** 仅供测试：丢弃内存态，下次访问重新读盘 */
export function resetAlertStore(): void {
  if (alertsFlushTimer) {
    clearTimeout(alertsFlushTimer)
    alertsFlushTimer = null
  }
  state.loaded = false
  state.alerts = []
  state.settings = { ...DEFAULT_ALERT_SETTINGS }
  state.events = []
  state.nextSeq = 1
  alertsDirty = false
}

/* ------------------------------------------------------------------ */
/* 入参校验与规范化                                                     */
/* ------------------------------------------------------------------ */

export class AlertValidationError extends Error {}

function fail(message: string): never {
  throw new AlertValidationError(message)
}

/** 可写入的警报字段（不含 id / 时间戳 / 运行期状态） */
export interface AlertInput {
  name?: string
  exchange: ExchangeId
  symbol: string
  timeframe: Timeframe
  condition: AlertCondition
  message: string
  channels: AlertChannel[]
  enabled: boolean
  once: boolean
  cooldownSec: number
}

function asExchange(v: unknown): ExchangeId {
  const s = String(v ?? '') as ExchangeId
  if (!EXCHANGES.some((e) => e.id === s)) fail(`不支持的交易所：${s}`)
  return s
}

function asTimeframe(v: unknown): Timeframe {
  const s = String(v ?? '') as Timeframe
  if (!TIMEFRAMES.includes(s)) fail(`不支持的 K 线周期：${s}`)
  return s
}

/** 校验并规范化条件；`kind` 决定必填字段 */
export function normalizeCondition(raw: unknown): AlertCondition {
  const c = (raw ?? {}) as Record<string, unknown>
  const kind = String(c.kind ?? '') as AlertKind
  const meta = ALERT_KIND_META.find((m) => m.kind === kind)
  if (!meta) fail('未知的警报条件类型')

  const out: AlertCondition = { kind }

  if (meta.needsValue) {
    const value = Number(c.value)
    if (!Number.isFinite(value)) fail('请填写有效的阈值')
    if (kind === 'priceRise' || kind === 'priceFall') {
      if (value <= 0) fail('涨跌幅阈值必须大于 0')
    }
    out.value = value
  }

  if (meta.needsIndicator) {
    const ind = String(c.indicator ?? 'rsi') as AlertIndicator
    if (!ALERT_INDICATORS.some((i) => i.id === ind)) fail(`不支持的指标：${ind}`)
    out.indicator = ind
    const needsPeriod = ALERT_INDICATORS.find((i) => i.id === ind)?.needsPeriod
    if (needsPeriod) {
      const period = Math.round(Number(c.period))
      if (!Number.isFinite(period) || period < 2 || period > 1000) {
        fail('指标周期需在 2 ~ 1000 之间')
      }
      out.period = period
    }
  } else if (kind.startsWith('pine')) {
    const id = c.pineScriptId
    if (typeof id === 'string' && id.trim()) out.pineScriptId = id.trim()
  }

  return out
}

/** 校验并规范化整条警报入参 */
export function normalizeAlertInput(raw: unknown): AlertInput {
  const r = (raw ?? {}) as Record<string, unknown>
  const symbol = String(r.symbol ?? '').trim()
  if (!symbol) fail('请选择合约（symbol）')

  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (name.length > MAX_NAME_LEN) fail(`名称过长（上限 ${MAX_NAME_LEN} 字）`)

  const message = typeof r.message === 'string' ? r.message : ''
  if (message.length > MAX_MESSAGE_LEN) fail(`提示信息过长（上限 ${MAX_MESSAGE_LEN} 字）`)

  const channelsRaw = Array.isArray(r.channels) ? r.channels : []
  const channels = channelsRaw.filter(
    (c): c is AlertChannel => c === 'telegram' || c === 'browser',
  )
  if (channels.length === 0) fail('请至少选择一个推送渠道（电报机器人 / 网页通知）')

  const cooldown = Math.round(Number(r.cooldownSec) || 0)
  if (cooldown < 0 || cooldown > MAX_COOLDOWN_SEC) {
    fail(`冷却时间需在 0 ~ ${MAX_COOLDOWN_SEC} 秒之间`)
  }

  return {
    ...(name ? { name } : {}),
    exchange: asExchange(r.exchange),
    symbol,
    timeframe: asTimeframe(r.timeframe ?? '1h'),
    condition: normalizeCondition(r.condition),
    message,
    channels,
    enabled: r.enabled !== false,
    once: r.once === true,
    cooldownSec: cooldown,
  }
}

/** 设置项规范化：Telegram 字段做裁剪，间隔收敛到允许区间 */
export function normalizeSettings(raw: unknown): AlertSettings {
  const r = (raw ?? {}) as Partial<AlertSettings>
  const tg = (r.telegram ?? {}) as Partial<AlertSettings['telegram']>
  const poll = Number(r.pollIntervalMs)
  return {
    telegram: {
      enabled: tg.enabled === true,
      botToken: typeof tg.botToken === 'string' ? tg.botToken.trim() : '',
      chatId: typeof tg.chatId === 'string' ? tg.chatId.trim() : '',
    },
    pollIntervalMs: Number.isFinite(poll)
      ? Math.min(ALERT_POLL_MAX_MS, Math.max(ALERT_POLL_MIN_MS, Math.round(poll)))
      : DEFAULT_ALERT_SETTINGS.pollIntervalMs,
    browserEnabled: r.browserEnabled !== false,
  }
}

/* ------------------------------------------------------------------ */
/* 警报 CRUD                                                           */
/* ------------------------------------------------------------------ */

export function listAlerts(): PriceAlert[] {
  return load().alerts
}

export function getAlert(id: string): PriceAlert | null {
  return load().alerts.find((a) => a.id === id) ?? null
}

export function createAlert(input: AlertInput): PriceAlert {
  const s = load()
  const now = Date.now()
  const alert: PriceAlert = {
    id: crypto.randomUUID(),
    ...input,
    createdAt: now,
    updatedAt: now,
    triggerCount: 0,
    state: {},
  }
  s.alerts.push(alert)
  flushAlertsNow()
  return alert
}

/**
 * 更新警报。`resetState` 为真时清空运行期状态（改条件/换品种后必须重置，
 * 否则旧的基准价与上次判定值会把新条件算歪）。
 */
export function updateAlert(id: string, input: AlertInput): PriceAlert | null {
  const s = load()
  const idx = s.alerts.findIndex((a) => a.id === id)
  if (idx < 0) return null
  const prev = s.alerts[idx]
  const changedMarket =
    prev.symbol !== input.symbol ||
    prev.exchange !== input.exchange ||
    prev.timeframe !== input.timeframe ||
    JSON.stringify(prev.condition) !== JSON.stringify(input.condition)
  const next: PriceAlert = {
    ...prev,
    ...input,
    updatedAt: Date.now(),
    state: changedMarket ? {} : prev.state,
  }
  s.alerts[idx] = next
  flushAlertsNow()
  return next
}

export function deleteAlert(id: string): boolean {
  const s = load()
  const idx = s.alerts.findIndex((a) => a.id === id)
  if (idx < 0) return false
  s.alerts.splice(idx, 1)
  flushAlertsNow()
  return true
}

/** 切换启用状态（面板上的开关） */
export function setAlertEnabled(id: string, enabled: boolean): PriceAlert | null {
  const s = load()
  const alert = s.alerts.find((a) => a.id === id)
  if (!alert) return null
  alert.enabled = enabled
  alert.updatedAt = Date.now()
  // 重新启用时清掉上次的错误，避免旧错误一直挂在界面上
  if (enabled) alert.state = { ...alert.state, lastError: undefined, lastPushError: undefined }
  flushAlertsNow()
  return alert
}

/**
 * 写回运行期状态（每一次判定都会调用）。
 *
 * 只更新内存与磁盘中该条记录的 state —— 不做整体替换，避免把面板刚改的字段覆盖掉。
 * `fire` 为真时顺带累计触发次数 / 触发时间；`once` 触发后自动停用。
 *
 * 注意：`updatedAt` 只在真正触发时更新。它表示「用户最后编辑时间」，若在每次行情
 * 推送时都改动，面板上的语义就失真了。
 */
export function applyAlertState(
  id: string,
  patch: Partial<PriceAlert['state']>,
  fire?: { at: number },
): PriceAlert | null {
  const s = load()
  const alert = s.alerts.find((a) => a.id === id)
  if (!alert) return null
  alert.state = { ...alert.state, ...patch }
  if (fire) {
    alert.triggerCount += 1
    alert.lastTriggeredAt = fire.at
    alert.updatedAt = Date.now()
    if (alert.once) alert.enabled = false
  }
  scheduleAlertsFlush()
  return alert
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

export function getSettings(): AlertSettings {
  return load().settings
}

/**
 * 清掉所有警报上「上一次推送失败」的痕迹，返回是否真的改动过。
 *
 * `state.lastPushError` 记录的是**上一次触发**的推送结果，本身不会因为之后改了配置而失效；
 * 若用户先触发（当时电报没开）再回来打开电报，面板上就会一直挂着一句与当前配置矛盾的
 * 「全局 Telegram 推送未启用」。配置一动，旧原因即失效，这里统一清掉，等下次真实触发重写。
 */
function clearPushErrors(): boolean {
  let touched = false
  for (const a of state.alerts) {
    if (a.state.lastPushError !== undefined) {
      a.state = { ...a.state, lastPushError: undefined }
      touched = true
    }
  }
  return touched
}

export function updateSettings(patch: unknown): AlertSettings {
  const s = load()
  const merged = normalizeSettings({ ...s.settings, ...((patch ?? {}) as object) })
  s.settings = merged
  writeJson(fileOf('settings'), merged)

  // 保存设置 = 用户重新确认了一遍推送配置。各警报上那条「上一次推送为什么没发出去」
  // 记录的是**旧配置下的一次尝试**，此刻已成历史；不回登记本，它就会一直挂在面板上
  // 与当前配置打架（典型现象：「明明配好了电报，却还报全局未启用」）。
  // 清掉即可 —— 若配置本身仍有问题，下一次真实触发会把新的原因重新写回来。
  if (clearPushErrors()) flushAlertsNow()

  return merged
}

/* ------------------------------------------------------------------ */
/* 触发记录                                                            */
/* ------------------------------------------------------------------ */

/** 追加一条触发记录（分配自增 seq），返回写入后的记录 */
export function appendEvent(e: Omit<AlertEvent, 'seq'>): AlertEvent {
  const s = load()
  const event: AlertEvent = { ...e, seq: s.nextSeq++ }
  s.events.push(event)
  if (s.events.length > MAX_EVENTS) s.events = s.events.slice(-MAX_EVENTS)
  writeJson(fileOf('events'), { nextSeq: s.nextSeq, events: s.events })
  return event
}

/** 触发记录：`since` 之后（不含）的增量，或最近 `limit` 条 */
export function listEvents(opts: { since?: number; limit?: number } = {}): AlertEvent[] {
  const all = load().events
  if (opts.since !== undefined) return all.filter((e) => e.seq > opts.since!)
  return all.slice(-(opts.limit ?? 50))
}

/** 清空触发记录 */
export function clearEvents(): void {
  const s = load()
  s.events = []
  writeJson(fileOf('events'), { nextSeq: s.nextSeq, events: [] })
}

/**
 * 警报调度器：WebSocket 优先 + REST 轮询兜底。
 *
 * 两条判定路径共享同一套「判定 → 冷却 → 推送 → 写回状态」逻辑（`evaluateAndPush`）：
 *
 *  1. **事件驱动（WS）**：`market/stream` 收到某个品种的行情推送 → 去抖 300ms →
 *     只重算这个品种的警报。价格类是秒级的；指标 / Pine 类在 K 线收盘瞬间就判掉，
 *     不必等下一次轮询（同一根已收盘 K 线由 `state.lastBarTime` 去重）。
 *  2. **定时轮询（REST 兼底）**：按 `settings.pollIntervalMs` 把**所有**启用的警报
 *     过一遍。WS 断线 / 代理不支持 WS / 交易所不推流时，这一步保证不漏警报；数据
 *     本身优先取自 WS 缓存，只有在 WS 不新鲜时才真正打 REST 接口。
 *
 * 订阅集合由启用的警报推导，每次轮询与警报增删改后做一次增量 diff（`refreshSubscriptions`），
 * 没有警报时不会占用任何 WS 连接。上一个 tick 未跑完时跳过下一次，避免请求堆积。
 *
 * ## 单实例锁（必须）
 *
 * 多个后端实例（例如同时开了两个 `pnpm dev`）会各自订阅行情、各自判定、各自推送 ——
 * 同一根 K 线会被推两遍（实测：电报收到两条一模一样的消息），而且它们还会互相覆盖
 * `.cache/alerts/` 下的 JSON，导致配置看起来「自己变了」。
 *
 * 因此监控权由一个独占锁文件（`.cache/alerts/monitor.lock`，内容含持有者 pid 与心跳）
 * 决定：抢到锁的实例才监控，其它实例进入**待机**（照常提供接口，但不订阅、不判定、不推送）。
 * 持有者进程消失或心跳超过 `LOCK_STALE_MS` 未更新（崩溃）时，锁会被后来者抢占。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AlertMonitorStatus, ExchangeId, PriceAlert } from '../../../shared/types'
import { onStreamUpdate, streamStatus, syncSubscriptions, type StreamSubscription } from '../market/stream'
import { createSnapshot, evaluateAlert, renderMessage, type MarketSnapshot } from './evaluator'
import { alertsDataDir, applyAlertState, getSettings, listAlerts } from './store'
import { dispatchAlert } from './notify'

/** WS 推送的去抖窗口：合并同一品种的连续推送，避免每个 tick 都重算 */
const WS_DEBOUNCE_MS = 300

/** 锁文件与心跳 */
const LOCK_FILE = 'monitor.lock'
const HEARTBEAT_MS = 20_000
/** 心跳超过该时长即认为持有者已死，可以抢占（独立于轮询间隔，用户把轮询调到 5 分钟也不会误抢） */
const LOCK_STALE_MS = 120_000
/** 待机实例尝试接管监控权的间隔 */
const STANDBY_RETRY_MS = 30_000

const status: AlertMonitorStatus = {
  running: false,
  standby: false,
  stream: { tickerSubscriptions: 0, ohlcvSubscriptions: 0, activeExchanges: [] },
}
let timer: NodeJS.Timeout | null = null
let unbindStream: (() => void) | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
/** 待机期间的接管重试定时器 */
let standbyTimer: NodeJS.Timeout | null = null
/** 本实例是否处于待机（监控权在别的实例手里） */
let standby = false
let lockStartedAt = 0
let stopped = true
let ticking = false

/** 待重算的品种（去抖用）：键 = `交易所|品种` */
const pendingScopes = new Map<string, NodeJS.Timeout>()

/**
 * 正在判定中的警报 id。
 *
 * REST 轮询与 WS 定向判定是两条独立的异步路径，可能同时命中同一条警报；
 * 而 `dispatchAlert` 里要等电报 HTTP 往返，那个 await 就是竞态窗口 ——
 * 没有这道闸，同一根 K 线会被两条路径各推一次（实测出现过连发 3 条电报）。
 */
const inFlight = new Set<string>()

export function getMonitorStatus(): AlertMonitorStatus {
  const stream = streamStatus()
  status.stream = stream
  return { ...status, running: !stopped, standby, stream }
}

/* ------------------------------------------------------------------ */
/* 单实例锁（防止多实例重复推送）                                        */
/* ------------------------------------------------------------------ */

function lockFile(): string {
  return path.join(alertsDataDir(), LOCK_FILE)
}

function readLock(): { pid: number; heartbeat: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lockFile(), 'utf8')) as { pid?: unknown; heartbeat?: unknown }
    if (typeof raw.pid !== 'number') return null
    return { pid: raw.pid, heartbeat: typeof raw.heartbeat === 'number' ? raw.heartbeat : 0 }
  } catch {
    return null
  }
}

/** 进程是否还存在（Windows 上对无权限访问的进程会抛 EPERM，那也说明它活着） */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 抢占监控权：无锁 / 持有者是自己 / 持有者已死 / 心跳过期 → 成功 */
function acquireLock(): boolean {
  const cur = readLock()
  if (cur && cur.pid !== process.pid && pidAlive(cur.pid) && Date.now() - cur.heartbeat < LOCK_STALE_MS) {
    return false
  }
  lockStartedAt = Date.now()
  try {
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, startedAt: lockStartedAt, heartbeat: lockStartedAt }))
  } catch {
    // 锁写不进去时选择「照常监控」：宁可重复推送，也不要因为一次临时 IO 故障把监控彻底关掉
    console.warn('[alerts] 监控锁写入失败，本实例仍会监控（若同时跑了多个实例，可能出现重复推送）')
  }
  return true
}

function touchLock(): void {
  if (standby) return
  try {
    fs.writeFileSync(
      lockFile(),
      JSON.stringify({ pid: process.pid, startedAt: lockStartedAt, heartbeat: Date.now() }),
    )
  } catch {
    /* 心跳失败不影响判定 */
  }
}

/** 释放锁（只在锁确实属于自己时才删，别把别的实例的锁删掉） */
function releaseLock(): void {
  const cur = readLock()
  if (!cur || cur.pid !== process.pid) return
  try {
    fs.unlinkSync(lockFile())
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ */
/* 判定                                                                */
/* ------------------------------------------------------------------ */

/**
 * 逐条判定并推送。`snapshotOf` 决定该条警报用哪份行情快照
 * （按「交易所 + 品种」分组，同组共用一份，避免重复取数）。
 */
async function evaluateAndPush(
  alerts: readonly PriceAlert[],
  snapshotOf: (alert: PriceAlert) => MarketSnapshot,
  now: number,
): Promise<number> {
  let fired = 0

  for (const alert of alerts) {
    // 并发闸：同一条警报同一时刻只允许一条判定路径在跑
    if (inFlight.has(alert.id)) continue
    inFlight.add(alert.id)
    try {
      const ev = await evaluateAlert(alert, snapshotOf(alert), now)
      if (!ev.fire) {
        // 判定失败也在 state 里留痕（面板可显示），但不推送
        applyAlertState(alert.id, ev.state)
        continue
      }

      const cooldownMs = Math.max(0, alert.cooldownSec ?? 0) * 1000
      if (cooldownMs > 0 && alert.lastTriggeredAt && now - alert.lastTriggeredAt < cooldownMs) {
        applyAlertState(alert.id, ev.state)
        continue
      }

      const { title, body } = renderMessage(alert, ev.value, now, ev.signalNote)
      // 必须先落状态再推送：state 落在内存里（同步生效），而 dispatchAlert 要等电报
      // HTTP 往返；若等推完才写 lastBarTime / lastTriggeredAt，并发的另一条路径会读到
      // 旧状态，把同一根 K 线重复推一遍，冷却也拦不住。
      applyAlertState(alert.id, ev.state, { at: now })
      const event = await dispatchAlert(alert, { title, body, value: ev.value, at: now })
      fired += 1
      applyAlertState(alert.id, {
        lastPushError: event.telegram && !event.telegram.ok ? event.telegram.error : undefined,
      })
    } finally {
      inFlight.delete(alert.id)
    }
  }

  return fired
}

/** WS 推送后的定向判定：只重算该「交易所 + 品种」下的启用警报 */
async function evaluateScope(exchange: ExchangeId, symbol: string): Promise<void> {
  const alerts = listAlerts().filter((a) => a.enabled && a.exchange === exchange && a.symbol === symbol)
  if (alerts.length === 0) return
  const snap = createSnapshot(exchange, symbol)
  try {
    await evaluateAndPush(alerts, () => snap, Date.now())
  } catch (err) {
    console.warn('[alerts] WS 定向判定失败：', err instanceof Error ? err.message : err)
  }
}

/** 去抖调度：同一个品种 300ms 内的多次推送只触发一次判定 */
function scheduleScopeEval(exchange: ExchangeId, symbol: string): void {
  const key = `${exchange}|${symbol}`
  if (pendingScopes.has(key)) return
  const t = setTimeout(() => {
    pendingScopes.delete(key)
    void evaluateScope(exchange, symbol).catch((err) => {
      console.warn('[alerts] WS 定向判定异常：', err instanceof Error ? err.message : err)
    })
  }, WS_DEBOUNCE_MS)
  t.unref?.()
  pendingScopes.set(key, t)
}

/** 由启用的警报推导出需要的 WS 订阅 */
function desiredSubscriptions(): StreamSubscription[] {
  const out: StreamSubscription[] = []
  for (const alert of listAlerts()) {
    if (!alert.enabled) continue
    const kind = alert.condition.kind
    const needsBars = kind.startsWith('pine') || kind.startsWith('indicator')
    out.push({
      exchange: alert.exchange,
      symbol: alert.symbol,
      kind: needsBars ? 'ohlcv' : 'ticker',
      ...(needsBars ? { timeframe: alert.timeframe } : {}),
    })
  }
  return out
}

/** 把 WS 订阅集合同步到当前启用的警报（增量 diff，廉价，可随时调用） */
export function refreshSubscriptions(): void {
  // 待机实例不订阅任何行情，避免和持有监控权的实例重复拉流
  if (standby) return
  syncSubscriptions(desiredSubscriptions())
}

/* ------------------------------------------------------------------ */
/* 轮询（REST 兼底）                                                    */
/* ------------------------------------------------------------------ */

/** 执行一次全量判定（定时触发，也可由接口手动触发） */
export async function runAlertTick(): Promise<AlertMonitorStatus> {
  // 待机实例即使被接口调用也不能判定/推送，否则又会和持有者重复推
  if (standby) return getMonitorStatus()
  if (ticking) return getMonitorStatus()
  ticking = true
  const started = Date.now()
  status.lastTickAt = started
  status.lastTickError = undefined
  touchLock()
  let fired = 0
  try {
    const alerts = listAlerts().filter((a) => a.enabled)
    if (alerts.length > 0) {
      const snaps = new Map<string, MarketSnapshot>()
      const now = Date.now()
      const snapshotOf = (alert: PriceAlert): MarketSnapshot => {
        const key = `${alert.exchange}|${alert.symbol}`
        let snap = snaps.get(key)
        if (!snap) {
          snap = createSnapshot(alert.exchange, alert.symbol)
          snaps.set(key, snap)
        }
        return snap
      }
      fired = await evaluateAndPush(alerts, snapshotOf, now)
    }
    // 顺带同步订阅：警报被停用/删除后不该继续占着 WS 连接
    refreshSubscriptions()
  } catch (err) {
    status.lastTickError = err instanceof Error ? err.message : String(err)
    console.warn('[alerts] 轮询异常：', status.lastTickError)
  } finally {
    ticking = false
    status.lastTickMs = Date.now() - started
    status.lastFiredCount = fired
  }
  return getMonitorStatus()
}

function schedule(): void {
  if (stopped) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void runAlertTick()
      .catch((err) => {
        console.warn('[alerts] 轮询异常：', err instanceof Error ? err.message : err)
      })
      .finally(() => schedule())
  }, getSettings().pollIntervalMs)
}

/** 启动真正的监控循环（调用前必须已持有锁） */
function startMonitorLoop(): void {
  standby = false
  stopped = false
  status.running = true
  if (!unbindStream) {
    // WS 推送 → 定向判定；挂在这里而不是 evaluator 里，是为了让行情层不必知道警报的存在
    unbindStream = onStreamUpdate((u) => scheduleScopeEval(u.exchange, u.symbol))
  }
  refreshSubscriptions()
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(touchLock, HEARTBEAT_MS)
  heartbeatTimer.unref?.()
  if (timer) return
  // 先等一小会儿再跑第一轮，避开服务刚起来时的接口抖动
  timer = setTimeout(() => {
    timer = null
    void runAlertTick()
      .catch((err) => {
        console.warn('[alerts] 轮询异常：', err instanceof Error ? err.message : err)
      })
      .finally(() => schedule())
  }, 3_000)
}

/** 待机期间定期尝试接管：原监控实例退出后，本实例应自动顶上 */
function scheduleStandbyRetry(): void {
  if (standbyTimer) return
  standbyTimer = setTimeout(() => {
    standbyTimer = null
    if (!standby) return
    if (!acquireLock()) {
      scheduleStandbyRetry()
      return
    }
    console.log('  ● 价格警报:      原监控实例已退出，本实例接管监控')
    startMonitorLoop()
  }, STANDBY_RETRY_MS)
  standbyTimer.unref?.()
}

/** 启动（幂等）。抢不到监控锁就待机 —— 见文件头的「单实例锁」说明 */
export function startAlertMonitor(): void {
  if (!acquireLock()) {
    standby = true
    stopped = true
    status.running = false
    console.warn('  ● 价格警报:      监控权已被另一个实例持有 → 本实例待机（不订阅行情、不判定、不推送）')
    scheduleStandbyRetry()
    return
  }
  startMonitorLoop()
  console.log(`  ● 价格警报:      WebSocket 优先，REST 轮询兜底（间隔 ${getSettings().pollIntervalMs / 1000}s）`)
}

/** 停止：解绑 WS 监听、退掉全部订阅并释放锁 */
export function stopAlertMonitor(): void {
  stopped = true
  status.running = false
  if (timer) clearTimeout(timer)
  timer = null
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
  if (standbyTimer) clearTimeout(standbyTimer)
  standbyTimer = null
  for (const t of pendingScopes.values()) clearTimeout(t)
  pendingScopes.clear()
  inFlight.clear()
  if (unbindStream) {
    unbindStream()
    unbindStream = null
  }
  syncSubscriptions([])
  releaseLock()
}

/** 设置变更（改了轮询间隔）后重启调度，让新间隔立即生效；待机实例保持待机 */
export function restartAlertMonitor(): void {
  const resume = !stopped || standby
  stopAlertMonitor()
  if (resume) startAlertMonitor()
}

/**
 * 回测可视化图层（Vela 插件 SDK）。
 *
 * Vela 的公开接口里没有「交易标记」这种概念，官方给出的宿主覆盖物做法是
 * **一对同名的 `registerRendererLayer` + `registerNativeIndicator`**：
 *   · 图层（id = `stock-trades`）负责逐帧把 payload 画到主图；
 *   · 原生指标（type 同名）负责在每根 bar 变化时用 `ctx.pushData(payload)` 把
 *     数据推给图层，descriptor 上 `legend: false` → 不生成图例行（它的开/关
 *     由宿主自己的「交易标注」开关控制）。
 *
 * payload 由 `buildTradeLayerPayload(result, showTrades, showLevels)` 从
 * `BacktestResult` 折出来：
 *   · `trades`   —— 每笔交易的入场/出场点、持仓区间、止损/TP 价位
 *   · `lines`    —— 策略自带的叠加线（imbaTrendLine / supertrendUp / supertrendDn）
 *
 * 点选交易：图层每帧把「三角标记的屏幕坐标」写进模块级 `tradeHitState`，
 * KLinePanel 在容器 `mouseup` 时按半径命中。只有三角标记能被点中 ——
 * 点空白处、或点 Vela 自带的 HTML chrome（图例行、工具条等）都不会打开交易明细。
 */

import { registerNativeIndicator, registerRendererLayer } from '@luxalgo/vela/plugin'
import type { BacktestResult, Trade } from '@shared/types'
import { UP_COLOR, DOWN_COLOR } from '../theme'

/** 图层 id 同时也是原生指标 type 与原生数据通道名 */
export const TRADE_LAYER_ID = 'stock-trades'
/** 回放弹窗用的第二套图层 id：payload 独立，且不参与点选 */
export const TRADE_REPLAY_LAYER_ID = 'stock-trades-replay'

/* ------------------------------------------------------------------ */
/* payload                                                             */
/* ------------------------------------------------------------------ */

export interface TradeMarkerPayload {
  side: 'long' | 'short'
  /** 依次为「开仓点 / 平仓点」；命中后打开该笔明细 */
  entryTime: number
  entryPrice: number
  exitTime: number
  exitPrice: number
  profitable: boolean
  label: string
  stopLoss?: number
  takeProfit1?: number
  takeProfit2?: number
}

export interface IndicatorLinePayload {
  name: string
  color: string
  /** 逐点；值为 null 表示该根 na（断开） */
  points: { time: number; value: number | null }[]
  /**
   * 仅在设置时，于线的可见段右端画一个同名标签。
   * 主图的策略叠加线不设它（保持原有观感），回放的「盈亏平衡线」会设。
   */
  label?: string
}

export interface TradeLayerPayload {
  showTrades: boolean
  showLevels: boolean
  trades: TradeMarkerPayload[]
  lines: IndicatorLinePayload[]
}

/** 每笔交易在图上最多绘制多少根 K 线区间；超过则退化为只画两个端点 */
const MAX_MARKERS = 1200

/** 从 `BacktestResult` 折出图层 payload */
export function buildTradeLayerPayload(
  result: BacktestResult | null,
  showTrades: boolean,
  showLevels: boolean,
): TradeLayerPayload {
  if (!result) return { showTrades: false, showLevels: false, trades: [], lines: [] }

  const trades: TradeMarkerPayload[] = []
  if (showTrades && result.trades.length <= MAX_MARKERS) {
    for (const t of result.trades) {
      trades.push({
        side: t.side,
        entryTime: t.entryTime,
        entryPrice: t.entryPrice,
        exitTime: t.exitTime,
        exitPrice: t.exitPrice,
        profitable: t.netPnl >= 0,
        label: `${t.side === 'long' ? '多' : '空'} ${t.netPnl >= 0 ? '+' : ''}${t.pnlPercent.toFixed(1)}%`,
        stopLoss: t.stopLoss,
        takeProfit1: t.takeProfit1,
        takeProfit2: t.takeProfit2,
      })
    }
  }

  const lines: IndicatorLinePayload[] = []
  const push = (name: string, color: string, key: 'imbaTrendLine' | 'tsotTrendValue'): void => {
    const points = result.signals.map((s) => {
      const v = s[key]
      return { time: s.timestamp, value: Number.isFinite(v) ? v : null }
    })
    if (points.some((p) => p.value !== null)) lines.push({ name, color, points })
  }
  if (result.meta.strategy === 'supertrend') {
    push('上轨', '#ff4d4f', 'supertrendUp' as never)
    push('下轨', '#3ddc97', 'supertrendDn' as never)
  } else {
    push('趋势线', '#5b8cff', 'imbaTrendLine')
    push('TSOT', '#c084fc', 'tsotTrendValue')
  }

  return { showTrades, showLevels, trades, lines }
}

/**
 * 回放弹窗用的 payload：只画这一笔交易的入场 / 出场标记与价位线。
 * 不画策略叠加线 —— 回放窗口与周期都可能与策略原周期不同，那条线对不上。
 *
 * `breakEvenPrice` 为「毛盈亏 = 双边手续费」的价格，会画成一条带标签的水平线。
 */
export function buildReplayLayerPayload(trade: Trade, breakEvenPrice: number): TradeLayerPayload {
  const lines: IndicatorLinePayload[] = Number.isFinite(breakEvenPrice)
    ? [
        {
          name: '盈亏平衡线',
          label: '盈亏平衡线',
          color: '#ffb01f',
          points: [
            { time: trade.entryTime, value: breakEvenPrice },
            { time: trade.exitTime, value: breakEvenPrice },
          ],
        },
      ]
    : []
  return {
    showTrades: true,
    showLevels: true,
    trades: [
      {
        side: trade.side,
        entryTime: trade.entryTime,
        entryPrice: trade.entryPrice,
        exitTime: trade.exitTime,
        exitPrice: trade.exitPrice,
        profitable: trade.netPnl >= 0,
        label: `${trade.side === 'long' ? '多' : '空'} ${trade.netPnl >= 0 ? '+' : ''}${trade.pnlPercent.toFixed(1)}%`,
        stopLoss: trade.stopLoss,
        takeProfit1: trade.takeProfit1,
        takeProfit2: trade.takeProfit2,
      },
    ],
    lines,
  }
}

/* ------------------------------------------------------------------ */
/* 命中状态（图层每帧写入，KLinePanel 读取）                            */
/* ------------------------------------------------------------------ */

interface HitRegion {
  /** 视口坐标（clientX/clientY），图层已叠加 canvas 的 boundingClientRect */
  x: number
  y: number
  index: number
}

/** 图层每帧写入的命中状态（宿主读取）：只有三角标记的视口坐标 */
export interface TradeHitSink {
  regions: HitRegion[]
}

export const tradeHitState: TradeHitSink = { regions: [] }

/** 点选标记的命中半径（像素），与改造前的 klinecharts 行为保持一致 */
export const MARKER_HIT_RADIUS = 14

/* ------------------------------------------------------------------ */
/* 绘制                                                                */
/* ------------------------------------------------------------------ */

/** 入场价线的固定色（蓝），与涨跌配色无关 */
const COLOR_ENTRY = '#5b8cff'

interface RenderArgs {
  bars: readonly { time: number }[]
  data: unknown
  coords: {
    timeToX(ms: number): number
    xToLogical(x: number): number
    logicalToTime(logical: number): number
    priceToY(price: number, scale: unknown, bounds: unknown): number
    readonly width: number
    readonly height: number
    readonly dpr: number
  }
  scale: unknown
  bounds: unknown
  theme: { textColor: string }
}

function drawLayer(
  canvas: HTMLCanvasElement | null,
  args: RenderArgs,
  ctx2d: CanvasRenderingContext2D | null,
  /** 命中状态出口；null = 只画不记（回放弹窗里的第二张图，不参与点选） */
  sink: TradeHitSink | null,
): void {
  const payload = args.data as TradeLayerPayload | undefined
  if (sink) sink.regions = []
  if (!canvas || !ctx2d) return

  const { coords } = args
  const dpr = coords.dpr || 1
  const w = canvas.width / dpr
  const h = canvas.height / dpr
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx2d.clearRect(0, 0, w, h)

  if (!payload) {
    return
  }

  const rect = canvas.getBoundingClientRect()
  const yOf = (price: number): number => coords.priceToY(price, args.scale, args.bounds)
  const xOf = (time: number): number => coords.timeToX(time)

  /* ---- 策略叠加线 ---- */
  ctx2d.lineWidth = 1.5
  ctx2d.lineJoin = 'round'
  for (const line of payload.lines) {
    ctx2d.strokeStyle = line.color
    ctx2d.beginPath()
    let started = false
    for (const p of line.points) {
      if (p.value === null) {
        started = false
        continue
      }
      const x = xOf(p.time)
      const y = yOf(p.value)
      if (!started) {
        ctx2d.moveTo(x, y)
        started = true
      } else {
        ctx2d.lineTo(x, y)
      }
    }
    ctx2d.stroke()
  }

  /* ---- 交易：持仓区间 / 价位线 / 三角标记 ---- */
  if (payload.showTrades) {
    payload.trades.forEach((t, index) => {
      const x1 = xOf(t.entryTime)
      const x2 = xOf(t.exitTime)
      const yEntry = yOf(t.entryPrice)
      const yExit = yOf(t.exitPrice)
      const color = t.side === 'long' ? UP_COLOR : DOWN_COLOR
      const pnlColor = t.profitable ? UP_COLOR : DOWN_COLOR

      // 持仓区间着色
      ctx2d.fillStyle = `${t.profitable ? UP_COLOR : DOWN_COLOR}1a`
      ctx2d.fillRect(Math.min(x1, x2), Math.min(yEntry, yExit), Math.abs(x2 - x1) || 1, Math.abs(yExit - yEntry) || 1)

      // 入场价线（蓝，自开仓至平仓）
      ctx2d.strokeStyle = COLOR_ENTRY
      ctx2d.lineWidth = 1.2
      ctx2d.beginPath()
      ctx2d.moveTo(x1, yEntry)
      ctx2d.lineTo(x2, yEntry)
      ctx2d.stroke()

      // 出场价线（按盈亏着色）
      ctx2d.strokeStyle = pnlColor
      ctx2d.beginPath()
      ctx2d.moveTo(x1, yExit)
      ctx2d.lineTo(x2, yExit)
      ctx2d.stroke()

      // 止损 / TP 参考虚线
      if (payload.showLevels) {
        ctx2d.setLineDash([4, 4])
        ctx2d.lineWidth = 1
        const levels: [number | undefined, string][] = [
          [t.stopLoss, '#ff7875'],
          [t.takeProfit1, '#69c0ff'],
          [t.takeProfit2, '#b37feb'],
        ]
        for (const [price, c] of levels) {
          if (typeof price !== 'number' || !Number.isFinite(price)) continue
          const y = yOf(price)
          ctx2d.strokeStyle = c
          ctx2d.beginPath()
          ctx2d.moveTo(x1, y)
          ctx2d.lineTo(x2, y)
          ctx2d.stroke()
        }
        ctx2d.setLineDash([])
      }

      // 三角标记：多头朝上、空头朝下，落在开仓/平仓点（带描边 + 圆点，便于识别与点选）
      const tri = (cx: number, cy: number, up: boolean): void => {
        const s = 8
        ctx2d.beginPath()
        if (up) {
          ctx2d.moveTo(cx, cy - s)
          ctx2d.lineTo(cx - s, cy + s)
          ctx2d.lineTo(cx + s, cy + s)
        } else {
          ctx2d.moveTo(cx, cy + s)
          ctx2d.lineTo(cx - s, cy - s)
          ctx2d.lineTo(cx + s, cy - s)
        }
        ctx2d.closePath()
        ctx2d.fillStyle = color
        ctx2d.fill()
        ctx2d.lineWidth = 1.5
        ctx2d.strokeStyle = 'rgba(14,18,27,0.85)'
        ctx2d.stroke()

        // 圆点：既是视觉锚点也是「点选交易」的宽容命中目标
        ctx2d.beginPath()
        ctx2d.arc(cx, cy, 4, 0, Math.PI * 2)
        ctx2d.fillStyle = '#0e121b'
        ctx2d.fill()
        ctx2d.lineWidth = 2
        ctx2d.strokeStyle = color
        ctx2d.stroke()
      }
      tri(x1, yEntry, t.side === 'long')
      tri(x2, yExit, t.side === 'long')

      // 盈亏标签（带底色，避免压在蜡烛上读不出）
      ctx2d.font = '600 11px system-ui, sans-serif'
      const labelW = ctx2d.measureText(t.label).width + 8
      const labelX = x2 + 8
      const labelY = yExit + (t.side === 'long' ? -20 : 6)
      ctx2d.fillStyle = 'rgba(14,18,27,0.78)'
      ctx2d.fillRect(labelX - 4, labelY - 2, labelW, 16)
      ctx2d.fillStyle = pnlColor
      ctx2d.fillText(t.label, labelX, labelY + 11)

      // 命中区：开仓 / 平仓两个点各一个（视口坐标）
      if (sink) {
        sink.regions.push({ x: rect.left + x1, y: rect.top + yEntry, index })
        sink.regions.push({ x: rect.left + x2, y: rect.top + yExit, index })
      }
    })
  }

  /* ---- 带名字的线（如「盈亏平衡线」） ----
     标签钉在「可见段的右端」：回放时线一直延伸到画面右侧之外，若按线的末点
     定位，标签会跑到画布外看不见 —— 所以最后要往画布内夹一下。 */
  ctx2d.font = '600 10px system-ui, sans-serif'
  for (const line of payload.lines) {
    if (!line.label) continue
    let last: { time: number; value: number | null } | null = null
    for (let i = line.points.length - 1; i >= 0; i--) {
      if (line.points[i].value !== null) {
        last = line.points[i]
        break
      }
    }
    if (!last || last.value === null) continue
    const labelW = ctx2d.measureText(line.label).width + 8
    const lx = Math.max(2, Math.min(coords.width - labelW - 2, xOf(last.time)))
    const ly = yOf(last.value)
    ctx2d.fillStyle = 'rgba(14,18,27,0.82)'
    ctx2d.fillRect(lx, ly - 8, labelW, 14)
    ctx2d.fillStyle = line.color
    ctx2d.fillText(line.label, lx + 4, ly + 2)
  }
}

/* ------------------------------------------------------------------ */
/* 注册（模块顶层执行一次，import 即生效）                              */
/* ------------------------------------------------------------------ */

/**
 * 注册一套「渲染图层 + 同名原生指标」，并返回这套自己的 payload 写入口。
 *
 * 主图与回放弹窗各注册一套：两套各自持有 payload 变量，互不干扰 ——
 * 回放弹窗打开时主图仍按自己的回测结果绘制，关掉弹窗后主图也不会被残留的
 * 单笔 payload 覆盖。
 */
function registerTradeLayerPair(
  id: string,
  sink: TradeHitSink | null,
): (payload: TradeLayerPayload) => void {
  let payload: TradeLayerPayload = emptyTradeLayerPayload()

  registerRendererLayer({
    id,
    placement: 'above-data',
    repaintOnCursor: false,
    create: () => {
      let canvas: HTMLCanvasElement | null = null
      let ctx2d: CanvasRenderingContext2D | null = null
      return {
        mount(c: HTMLCanvasElement) {
          canvas = c
          ctx2d = c.getContext('2d')
        },
        render(args: RenderArgs) {
          drawLayer(canvas, args, ctx2d, sink)
        },
        destroy() {
          canvas = null
          ctx2d = null
          if (sink) {
            sink.regions = []
          }
        },
      }
    },
  })

  registerNativeIndicator({
    type: id,
    title: '回测交易标记',
    paneHint: 'price',
    overlay: true,
    // 宿主自己用「交易标注 / 止损止盈线」两个开关控制它，不需要图例行
    legend: false,
    inputsSchema: () => [],
    defaultInputs: () => ({}),
    create: () => {
      let ctx: { pushData(data: unknown): void } | null = null
      const push = (): void => {
        ctx?.pushData(payload)
      }
      return {
        start(c: unknown) {
          ctx = c as { pushData(data: unknown): void }
          push()
        },
        onBars: push,
        setInputs: push,
        onViewport: push,
        suspend() {},
        resume: push,
        stop() {
          ctx = null
        },
      }
    },
  })

  return (next: TradeLayerPayload): void => {
    payload = next
  }
}

function emptyTradeLayerPayload(): TradeLayerPayload {
  return { showTrades: false, showLevels: false, trades: [], lines: [] }
}

/** 主图（KLinePanel）的 payload 写入口 */
let writeMainPayload: ((p: TradeLayerPayload) => void) | null = null
/** 回放弹窗（TradeReplayDialog）的 payload 写入口 */
let writeReplayPayload: ((p: TradeLayerPayload) => void) | null = null

/** 注册主图图层与原生指标；幂等（模块顶层调用一次即可） */
export function registerTradeVisuals(): void {
  if (writeMainPayload) return
  writeMainPayload = registerTradeLayerPair(TRADE_LAYER_ID, tradeHitState)
}

/** 注册回放弹窗图层与原生指标；幂等 */
export function registerTradeReplayVisuals(): void {
  if (writeReplayPayload) return
  writeReplayPayload = registerTradeLayerPair(TRADE_REPLAY_LAYER_ID, null)
}

/** 更新 payload（不触发重推；由宿主显式重启指标或切换行情触发） */
export function setTradeLayerPayload(payload: TradeLayerPayload): void {
  writeMainPayload?.(payload)
}

/** 更新回放弹窗的 payload */
export function setTradeReplayPayload(payload: TradeLayerPayload): void {
  writeReplayPayload?.(payload)
}

/** 供 `onSelectTrade` 复用的交易数组（下标与 payload.trades 一致） */
export function pickTradeAt(result: BacktestResult | null, index: number): Trade | null {
  if (!result) return null
  return result.trades[index] ?? null
}

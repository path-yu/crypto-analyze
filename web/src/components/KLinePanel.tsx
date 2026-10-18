import { useEffect, useMemo, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import IconButton from '@mui/material/IconButton'
import Paper from '@mui/material/Paper'
import Stack from '../ui/Stack'
import Typography from '@mui/material/Typography'
import FormControlLabel from '@mui/material/FormControlLabel'
import Switch from '@mui/material/Switch'
import Tooltip from '@mui/material/Tooltip'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import RefreshIcon from '@mui/icons-material/Refresh'

import { VelaWorkspace } from '@luxalgo/vela/workspace'
import type { DataProvider } from '@luxalgo/vela/plugin'
import { PineEngine } from '@luxalgo/vela-pinets'

import type { BacktestResult, Candle, Timeframe, Trade } from '@shared/types'
import {
  MARKER_HIT_RADIUS,
  TRADE_LAYER_ID,
  buildTradeLayerPayload,
  pickTradeAt,
  registerTradeVisuals,
  setTradeLayerPayload,
  tradeHitState,
} from '../charts/tradeMarkersLayer'
import { loadPineManifest } from '../charts/manifestLoader'
import { installVelaLocale } from '../charts/velaLocale'
import { dateTime, klineAxisTime, price } from '../utils/format'
import { DOWN_COLOR, UP_COLOR } from '../theme'

registerTradeVisuals()

/** 本项目 Timeframe → Vela 的周期字符串（分钟数，D/W 用大写单字母） */
const VELA_TIMEFRAME: Record<Timeframe, string> = {
  '1m': '1',
  '3m': '3',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '2h': '120',
  '4h': '240',
  '6h': '360',
  '12h': '720',
  '1d': '1D',
  '3d': '3D',
  '1w': '1W',
}

/** 与改造前 klinecharts 一致的配色（国内习惯：红涨绿跌） */
const VELA_THEME = {
  background: '#0e121b',
  textColor: '#8a94a6',
  gridColor: 'rgba(255,255,255,0.06)',
  borderColor: 'rgba(255,255,255,0.15)',
  upColor: '#ff4d4f',
  downColor: '#3ddc97',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
}

const MAX_MARKERS = 1200

/** 渲染器上的入口：写 K 线 + 设置价格精度 */
interface KlineSink {
  updateBar?: (bar: unknown) => void
  setBars?: (bars: unknown, opts?: { preserveView?: boolean }) => void
  /**
   * 用交易所的 tick（mintick）设定价格轴的显示位数。
   * Vela 默认按当前缩放推导小数位（见其文档：「undefined ⇒ fall back to the zoom-derived
   * decimals」），于是同一张图缩放一变位数就变、且常常多于交易所的真实精度。
   */
  setPricePrecision?: (mintick: number | undefined) => void
}

/**
 * 取到真正能写 K 线的渲染器实例。
 *
 * `chart.renderer` 是 `RendererControl` 这个 façade：它转发了 `onCrosshairMove` 等方法，
 * 却**没有** `setBars` / `updateBar`（实测运行时都是 undefined，直接调用会静默空转、
 * 图表停在旧数据）。真实实例挂在 façade 内部的 `renderer` 字段上（TS 标为 private，
 * 运行时存在），另可用 `orchestrator.renderer` 兜底。依次探测，取第一个可用的。
 */
function barsSinkOf(chart: unknown): KlineSink | null {
  const c = chart as {
    renderer?: { renderer?: unknown } & Record<string, unknown>
    orchestrator?: { renderer?: unknown }
  }
  const usable = (x: unknown): boolean => {
    const s = x as KlineSink | undefined
    // 必须按 `setBars` 判定：若只在 façade 上认到 `setPricePrecision`，
    // 返回 façade 会让下面的就地更新（setBars/updateBar）静默失效、图表冻结。
    return Boolean(s && typeof s.setBars === 'function')
  }
  const facade = c.renderer
  if (usable(facade)) return facade as KlineSink
  const inner = facade?.renderer
  if (usable(inner)) return inner as KlineSink
  const orch = c.orchestrator?.renderer
  if (usable(orch)) return orch as KlineSink
  return null
}

interface Props {
  /** 图表主数据源：历史 K 线（与回测解耦，未回测也能画图） */
  candles: Candle[]
  /** 当前标的（用于工作区标题 / 表头） */
  symbol: string
  /** 当前周期（用于 Vela 的周期换算） */
  timeframe: Timeframe
  /** 回测结果；未回测时为 null —— 只影响交易标注与 Pine 叠加，不影响蜡烛 */
  result?: BacktestResult | null
  /**
   * 交易所的最小变动价位（syminfo.mintick）。
   * 传进来后会用它设定价格轴的显示位数，使图表的价格精度与交易所一致；
   * 不传（或 ≤0）则沿用 Vela 按缩放推导的默认精度。
   */
  priceTick?: number
  loading: boolean
  showTrades: boolean
  onToggleTrades: (v: boolean) => void
  showLevels: boolean
  onToggleLevels: (v: boolean) => void
  /** 点击图上的交易标记 → 打开该笔交易明细（与「交易明细」表共用弹窗） */
  onSelectTrade?: (trade: Trade) => void
  /**
   * 图表「指标设置」里改了策略输入并点「确定」→ 回传当前输入值。
   *
   * 上层据此重跑回测，并把新值写回 `.pine` 的 input 默认值（保持"图上看到的
   * 参数 = 回测用的参数 = 文件里的默认值"）。
   */
  onIndicatorInputsChange?: (values: Record<string, number | boolean | string>) => void
  /** 重新拉取当前窗口的 K 线（「刷新」按钮，把结束时间前移一根 bar） */
  onRefresh?: () => void
  height?: number
}

/**
 * K 线面板（Vela 渲染）。
 *
 * 组件名与 props 保持不变，内部换成 `VelaWorkspace`：
 *   · 蜡烛与坐标轴 —— Vela 原生渲染器；
 *   · 回测策略自带的叠加线 + 交易标记 —— 自注册的渲染层（`tradeMarkersLayer.ts`）；
 *   · Pine 脚本自己的 `plot()` / 画线 —— 交给 `@luxalgo/vela-pinets` 的 `PineEngine`
 *     在浏览器里跑同一份脚本后交给 Vela 原生绘制（与后端回测用的是同一份源码）。
 *
 * 工作区的顶层 chrome（symbol / 周期 / 指标选择器）在此内嵌场景下关闭 ——
 * 标的、周期与参数由本项目自己的「参数设置」面板驱动，两套控件并存会互相打架。
 * Vela™ 的署名水印由工作区自身挂载，保持可见（Apache-2.0 §4(d) 的署名要求）。
 */
export default function KLinePanel({
  candles,
  symbol,
  timeframe,
  result,
  priceTick,
  loading,
  showTrades,
  onToggleTrades,
  showLevels,
  onToggleLevels,
  onSelectTrade,
  onIndicatorInputsChange,
  onRefresh,
  height = 620,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const workspaceRef = useRef<VelaWorkspace | null>(null)
  /** 图表只在重建时订阅一次指标事件，因此回调走 ref，避免进 effect 依赖 */
  const onIndicatorInputsRef = useRef(onIndicatorInputsChange)
  onIndicatorInputsRef.current = onIndicatorInputsChange
  /**
   * 十字光标所在的那根 K 线；null = 鼠标不在图上。
   * 信息条据此显示「当前选中的 K 线」，鼠标移出时回落到最后一根。
   */
  const [hoverBar, setHoverBar] = useState<Candle | null>(null)

  const velaData = useMemo(
    () =>
      candles.map((c) => ({
        time: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    [candles],
  )

  const payload = useMemo(
    () => buildTradeLayerPayload(result ?? null, showTrades && !!result, showLevels),
    [result, showTrades, showLevels],
  )

  const markerCount = result?.trades.length ?? 0

  /** 时间戳 → 下标，供信息条 O(1) 找「上一根收盘」 */
  const barIndex = useMemo(() => {
    const m = new Map<number, number>()
    candles.forEach((c, i) => m.set(c.timestamp, i))
    return m
  }, [candles])

  /** 信息条当前展示的那根 K 线：有悬停就用悬停的那根，否则默认最后一根 */
  const shownBar = useMemo(() => {
    if (hoverBar) return hoverBar
    return candles.length > 0 ? candles[candles.length - 1] : null
  }, [hoverBar, candles])

  /**
   * 基本信息各项：开/高/低/收 + 涨跌幅、振幅（均以「上一根收盘价」为基准，
   * 与参考图里的信息条口径一致）。
   */
  const barInfo = useMemo(() => {
    if (!shownBar) return []
    const i = barIndex.get(shownBar.timestamp) ?? -1
    const prevClose = i > 0 ? candles[i - 1].close : shownBar.open
    const change = prevClose !== 0 ? ((shownBar.close - prevClose) / prevClose) * 100 : 0
    const amplitude = prevClose !== 0 ? ((shownBar.high - shownBar.low) / prevClose) * 100 : 0
    const tone = change >= 0 ? UP_COLOR : DOWN_COLOR
    return [
      { label: '开', value: price(shownBar.open) },
      { label: '高', value: price(shownBar.high) },
      { label: '低', value: price(shownBar.low) },
      { label: '收', value: price(shownBar.close), tone },
      { label: '涨跌幅', value: `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`, tone },
      { label: '振幅', value: `${amplitude.toFixed(2)}%` },
    ] as { label: string; value: string; tone?: string }[]
  }, [shownBar, barIndex, candles])

  /**
   * 结构键：只要「品种 / 周期 / Pine 源码」不变，就**不重建** Vela 工作区。
   *
   * 以前的初始化 effect 把 `result` / `velaData` 也放进依赖里，于是
   * ①每次回测结果变化、②每根 WS 推来的新 bar，都会销毁并重建整个工作区；
   * 而每次重建都会重新执行 `loadPineManifest()`（拉一次 `/api/pine/scripts`）——
   * 实测该接口被调用过 4319 次。这是「频繁请求 + 图表重复加载」的主因。
   * 现在：结构变化才重建，纯数据变化走 `renderer.setBars/updateBar` 就地更新。
   */
  const pineSource = result?.pine?.source
  /**
   * 注意末尾的「有无数据」：首帧 `candles` 往往还是空的（K 线在异步拉取），
   * 此时 effect 会 early-return；若键不含这一位，等数据到位后键不变、**图就永远建不出来**。
   * 加上它以后：空 → 有数据 会触发一次建图，而后续每根 bar 的跳动不再改键。
   */
  const hasCandles = candles.length > 0
  const structureKey = `${symbol}|${timeframe}|${pineSource ?? ''}|${hasCandles ? 'bars' : 'empty'}`

  /** 建图时用的那份数据（用于判断后续变化是「只有最后一根在跳」还是「换了/多了 bar」） */
  const seededRef = useRef<Candle[] | null>(null)
  const candlesRef = useRef<Candle[]>(candles)
  candlesRef.current = candles
  const payloadRef = useRef(payload)
  payloadRef.current = payload
  /** 当前工作区是用哪个结构键建的（数据更新时据此判断能不能就地更新） */
  const builtKeyRef = useRef<string | null>(null)
  /** 建图时用的「延迟取用 chart」工具，供数据更新复用（cell 未就绪时会重试） */
  const withChartRef = useRef<
    ((fn: (chart: ReturnType<VelaWorkspace['cells']>[number]['chart']) => void) => void) | null
  >(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el || !symbol || velaData.length === 0) return

    // 图层读的是模块级的当前 payload；必须先写入再实例化工作区，
    // 否则原生指标 `start()` 时推进去的是上一份结果。
    setTradeLayerPayload(payloadRef.current)
    setHoverBar(null)
    el.innerHTML = ''

    let ws: VelaWorkspace | null = null
    try {
      ws = new VelaWorkspace(el, {
        layout: false,
        data: velaData,
        symbol,
        timeframe: VELA_TIMEFRAME[timeframe] ?? '60',
        theme: VELA_THEME,
        upColor: VELA_THEME.upColor,
        downColor: VELA_THEME.downColor,
        timezone: 'Asia/Shanghai',
        // 内嵌场景：顶层 chrome 全部关掉，只保留 Vela 自己的署名水印
        topbar: { left: [], right: [] },
        statusline: false,
        bottombar: false,
        watermark: true,
        // 内嵌场景不需要用户绘图：关掉整个绘图面（含左侧工具条），避免误建图形
        drawings: false,
        layoutMode: 'desktop',
        persist: false,
        // Pine 引擎：浏览器侧跑同一份 Pine 源码，由 Vela 原生绘制它的 plot/画线
        engines: { pine: () => new PineEngine() },
        indicators: loadPineManifest,
      })
      workspaceRef.current = ws
      seededRef.current = candlesRef.current
    } catch (err) {
      console.error('[vela] 初始化图表失败：', err)
      return
    }

    // cell 未必在构造函数里就绪，图表访问统一走这个延迟取用（最多重试 10 帧）
    const withChart = (fn: (chart: ReturnType<VelaWorkspace['cells']>[number]['chart']) => void, tries = 10): void => {
      const run = (left: number): void => {
        try {
          const chart = ws!.chart
          fn(chart)
        } catch {
          if (left > 0) requestAnimationFrame(() => run(left - 1))
        }
      }
      run(tries)
    }
    withChartRef.current = withChart
    builtKeyRef.current = structureKey

    let offCross: (() => void) | null = null
    let offInputs: (() => void) | null = null
    // Vela 内置 UI 没有 i18n：这里挂 DOM 层的汉化（图例、右键菜单、设置弹窗等）
    const uninstallLocale = installVelaLocale()

    withChart((chart) => {
      // 调试钩子：便于在控制台/自动化里检查指标输入（不影响渲染）
      ;(window as unknown as { __velaChart?: unknown }).__velaChart = chart
      // 交易标记覆盖物（图层 + 同名的 legend-less 原生指标）
      chart.addNativeIndicator(TRADE_LAYER_ID)
      // Pine 脚本自身的绘制交给 Pine 引擎；脚本报错时 Vela 会自行提示，不阻断蜡烛
      const source = result?.pine?.source
      if (source) {
        try {
          const handle = chart.addIndicator(source)
          // 指标设置弹窗点「确定」后，Vela 派发 indicator:inputs：
          // 读出当前输入值回传上层（重跑回测 + 写回 .pine 默认值）
          if (handle && typeof chart.on === 'function') {
            offInputs = chart.on('indicator:inputs', () => {
              try {
                const raw = handle.inputValues?.() ?? {}
                const next: Record<string, number | boolean | string> = {}
                for (const [k, v] of Object.entries(raw)) {
                  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') next[k] = v
                }
                if (Object.keys(next).length > 0) onIndicatorInputsRef.current?.(next)
              } catch (err) {
                console.warn('[vela] 读取指标输入失败：', err)
              }
            })
          }
        } catch (err) {
          console.warn('[vela] Pine 脚本叠加失败（蜡烛与交易标记不受影响）：', err)
        }
      }
      // 十字光标 → 信息条：鼠标在图上时显示光标那根，移出图（ohlc 为 null）时回落最后一根。
      // 订阅在 renderer 上（chart.renderer.onCrosshairMove），不是 chart 本身。
      offCross = chart.renderer.onCrosshairMove((e) => {
        const o = e.ohlc
        setHoverBar(
          o
            ? {
                timestamp: o.time,
                open: o.open,
                high: o.high,
                low: o.low,
                close: o.close,
                volume: o.volume ?? 0,
              }
            : null,
        )
      })
    })

    const ro = new ResizeObserver(() => ws?.resize())
    ro.observe(el)

    return () => {
      ro.disconnect()
      offCross?.()
      offInputs?.()
      uninstallLocale()
      workspaceRef.current = null
      builtKeyRef.current = null
      seededRef.current = null
      withChartRef.current = null
      tradeHitState.regions = []
      try {
        ws?.destroy()
      } catch {
        /* 卸载期的异常不必上抛 */
      }
    }
    // 只按结构键重建：`velaData` / `payload` / `result` 的变化改由下面的
    // 「就地更新」effect 处理，绝不再销毁重建整个 Vela 工作区。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey])

  /** 交易标注（payload）变化：只更新图层读取的模块级 payload，不重建工作区 */
  useEffect(() => {
    setTradeLayerPayload(payload)
  }, [payload])

  /**
   * 价格精度：把交易所的最小变动价位（mintick）交给渲染器，
   * 让价格轴刻度与十字光标标签显示**与交易所一致**的小数位。
   *
   * 不这么做时 Vela 会按当前缩放自己推导位数 —— 同一张图放大/缩小一次，位数就变一次，
   * 而且常常比交易所的真实精度多几位（例如交易所 tick 0.00001，轴上一度显示 0.07689400）。
   */
  useEffect(() => {
    const chart = withChartRef.current
    if (!chart) return
    const mintick = Number.isFinite(priceTick) && (priceTick as number) > 0 ? priceTick : undefined
    chart((c) => {
      try {
        barsSinkOf(c)?.setPricePrecision?.(mintick)
      } catch (err) {
        console.warn('[vela] 设置价格精度失败（不影响其它功能）：', err)
      }
    })
    // structureKey：换品种/周期会重建工作区，重建后必须重新应用一次
  }, [priceTick, structureKey])

  /**
   * K 线数据变化：往**已有**的工作区里就地换数据。
   *
   * · 只有最后一根在跳动（长度不变）→ `renderer.updateBar`，最省；
   * · 新增 / 换了一批 bar → `renderer.setBars(…, { preserveView: true })`，保留缩放与位置。
   * 这样 WS 每秒推一根也不会让图表「重新加载」，更不会顺带再拉一次脚本清单。
   */
  useEffect(() => {
    const seeded = seededRef.current
    if (!seeded || !builtKeyRef.current || candles === seeded) return
    const chart = withChartRef.current
    if (!chart) return
    const isTickOnly = candles.length === seeded.length
    seededRef.current = candles
    chart((c) => {
      try {
        const sink = barsSinkOf(c)
        if (!sink) {
          console.warn('[vela] 找不到可写 K 线的渲染器，图表将保留上一份快照（等下一次结构重建）')
          return
        }
        if (isTickOnly && typeof sink.updateBar === 'function') {
          sink.updateBar(velaData[velaData.length - 1])
        } else {
          sink.setBars?.(velaData, { preserveView: true })
        }
      } catch (err) {
        console.warn('[vela] 就地更新 K 线数据失败（将等待下一次结构重建）：', err)
      }
    })
  }, [candles, velaData])

  // 图上点选交易：图层每帧把标记的视口坐标写进 tradeHitState，这里按半径命中。
  // 以「按下 → 抬起位移 < 4px」区分点击与拖动、平移，避免缩放拖图时误弹窗。
  // 只认「点在绘图画布上」：Vela 自带的 HTML chrome（图例行、工具条、水印、
  // 折叠箭头等）不是画布，点它们不应该弹交易明细。
  // 用 pointer 事件（Vela 内部也走 pointer，捕获阶段更稳），并保留 mouse 兜底。
  useEffect(() => {
    const el = containerRef.current
    if (!el || !result || !showTrades || result.trades.length === 0) return
    let downX = 0
    let downY = 0
    const onDown = (e: MouseEvent | PointerEvent): void => {
      downX = e.clientX
      downY = e.clientY
    }
    const onUp = (e: MouseEvent | PointerEvent): void => {
      if (!workspaceRef.current) return
      if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return
      if (!(e.target instanceof HTMLCanvasElement)) return
      let best = -1
      let bestDist = Number.POSITIVE_INFINITY
      for (const r of tradeHitState.regions) {
        if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) continue
        const d = Math.hypot(r.x - e.clientX, r.y - e.clientY)
        if (d < bestDist) {
          bestDist = d
          best = r.index
        }
      }
      if (best < 0 || bestDist > MARKER_HIT_RADIUS) return
      const t = pickTradeAt(result, best)
      if (t) onSelectTrade?.(t)
    }
    el.addEventListener('pointerdown', onDown, true)
    el.addEventListener('pointerup', onUp, true)
    el.addEventListener('mousedown', onDown, true)
    el.addEventListener('mouseup', onUp, true)
    return () => {
      el.removeEventListener('pointerdown', onDown, true)
      el.removeEventListener('pointerup', onUp, true)
      el.removeEventListener('mousedown', onDown, true)
      el.removeEventListener('mouseup', onUp, true)
    }
  }, [result, showTrades, onSelectTrade])

  const hasData = velaData.length > 0

  return (
    <Paper sx={{ p: 0, overflow: 'hidden', position: 'relative' }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{
          px: { xs: 1.5, sm: 2 },
          py: 1.25,
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexWrap: 'wrap',
          gap: 1,
        }}
      >
        <Stack direction="row" alignItems="center" spacing={1.25}>
          <Typography variant="subtitle2">{`${symbol || '—'} · ${timeframe}`}</Typography>
          {result ? (
            <Typography variant="caption" color="text.secondary">
              共 {candles.length.toLocaleString()} 根 · 交易 {markerCount} 笔
            </Typography>
          ) : (
            <Typography variant="caption" color="text.secondary">
              共 {candles.length.toLocaleString()} 根 · 未回测
            </Typography>
          )}
          <Tooltip
            title={
              '三角标注每笔交易的入场方向与盈亏；' +
              '蓝线为该笔入场价、红/绿线为出场价（按盈亏着色），线间淡色区域为持仓区间；' +
              'Pine 脚本自身的 plot() 由 Vela 的 Pine 引擎原生绘制'
            }
          >
            <InfoOutlinedIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
          </Tooltip>
        </Stack>
        <Stack direction="row" alignItems="center" spacing={1}>
          {onRefresh && (
            <Tooltip title="重新拉取当前窗口的 K 线（结束时间前移一根）。勾选「同步进行回测」时会一并重跑回测">
              <span>
                <IconButton size="small" disabled={loading} onClick={onRefresh}>
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={showTrades}
                disabled={!result}
                onChange={(e) => onToggleTrades(e.target.checked)}
              />
            }
            label={
              <Tooltip title={result ? '' : '先运行一次回测才能显示交易标注'}>
                <Typography variant="caption">交易标注</Typography>
              </Tooltip>
            }
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={showLevels}
                disabled={!showTrades || !result}
                onChange={(e) => onToggleLevels(e.target.checked)}
              />
            }
            label={
              <Tooltip title="在图上绘制每笔交易的止损 / TP1 / TP2 参考虚线">
                <Typography variant="caption">止损止盈线</Typography>
              </Tooltip>
            }
          />
        </Stack>
      </Stack>

      {/* K 线基本信息：跟随鼠标（十字光标）实时切换；鼠标不在图上时显示最后一根 */}
      {shownBar && (
        <Stack
          direction="row"
          alignItems="center"
          spacing={1.5}
          flexWrap="wrap"
          useFlexGap
          sx={{
            px: { xs: 1.5, sm: 2 },
            py: 0.6,
            borderBottom: '1px solid',
            borderColor: 'divider',
            bgcolor: 'action.hover',
          }}
        >
          <Typography
            variant="caption"
            sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}
          >
            {dateTime(shownBar.timestamp)}
          </Typography>
          {barInfo.map((it) => (
            <Typography
              key={it.label}
              variant="caption"
              sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}
            >
              {it.label}{' '}
              <Box component="span" sx={{ color: it.tone ?? 'text.primary', fontWeight: 600 }}>
                {it.value}
              </Box>
            </Typography>
          ))}
        </Stack>
      )}

      {markerCount > MAX_MARKERS && showTrades && (
        <Box sx={{ px: { xs: 1.5, sm: 2 }, py: 0.5, bgcolor: 'action.hover' }}>
          <Typography variant="caption" color="warning.main">
            交易笔数 {markerCount} 超过 {MAX_MARKERS}，为保证流畅已自动隐藏图上标注，可在「交易明细」中查看。
          </Typography>
        </Box>
      )}

      <Box sx={{ position: 'relative', height, bgcolor: '#0e121b' }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        {!hasData && (
          <Stack
            alignItems="center"
            justifyContent="center"
            spacing={1}
            sx={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          >
            <Typography color="text.secondary" variant="body2">
              {loading ? '正在拉取行情…' : '暂无 K 线数据'}
            </Typography>
          </Stack>
        )}
      </Box>
    </Paper>
  )
}

export { klineAxisTime, VELA_TIMEFRAME, VELA_THEME }

/** 预留：把本项目的数据源做成 Vela Provider 时用（当前走离线 `data`，无需网络） */
export type VelaProviderFactory = () => DataProvider

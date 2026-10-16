import { useEffect, useMemo, useRef, useState } from 'react'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Stack from '../ui/Stack'
import Typography from '@mui/material/Typography'
import FormControlLabel from '@mui/material/FormControlLabel'
import Switch from '@mui/material/Switch'
import Tooltip from '@mui/material/Tooltip'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'

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

interface Props {
  result: BacktestResult | null
  loading: boolean
  showTrades: boolean
  onToggleTrades: (v: boolean) => void
  showLevels: boolean
  onToggleLevels: (v: boolean) => void
  /** 点击图上的交易标记 → 打开该笔交易明细（与「交易明细」表共用弹窗） */
  onSelectTrade?: (trade: Trade) => void
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
  result,
  loading,
  showTrades,
  onToggleTrades,
  showLevels,
  onToggleLevels,
  onSelectTrade,
  height = 620,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const workspaceRef = useRef<VelaWorkspace | null>(null)
  /**
   * 十字光标所在的那根 K 线；null = 鼠标不在图上。
   * 信息条据此显示「当前选中的 K 线」，鼠标移出时回落到最后一根。
   */
  const [hoverBar, setHoverBar] = useState<Candle | null>(null)

  const velaData = useMemo(() => {
    if (!result) return []
    return result.candles.map((c) => ({
      time: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }))
  }, [result])

  const payload = useMemo(
    () => buildTradeLayerPayload(result, showTrades && result !== null, showLevels),
    [result, showTrades, showLevels],
  )

  const markerCount = result?.trades.length ?? 0

  /** 时间戳 → 下标，供信息条 O(1) 找「上一根收盘」 */
  const barIndex = useMemo(() => {
    const m = new Map<number, number>()
    result?.candles.forEach((c, i) => m.set(c.timestamp, i))
    return m
  }, [result])

  /** 信息条当前展示的那根 K 线：有悬停就用悬停的那根，否则默认最后一根 */
  const shownBar = useMemo(() => {
    if (hoverBar) return hoverBar
    const bars = result?.candles
    return bars && bars.length > 0 ? bars[bars.length - 1] : null
  }, [hoverBar, result])

  /**
   * 基本信息各项：开/高/低/收 + 涨跌幅、振幅（均以「上一根收盘价」为基准，
   * 与参考图里的信息条口径一致）。
   */
  const barInfo = useMemo(() => {
    if (!shownBar) return []
    const i = barIndex.get(shownBar.timestamp) ?? -1
    const bars = result?.candles ?? []
    const prevClose = i > 0 ? bars[i - 1].close : shownBar.open
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
  }, [shownBar, barIndex, result])

  useEffect(() => {
    const el = containerRef.current
    if (!el || !result || velaData.length === 0) return

    // 图层读的是模块级的当前 payload；必须先写入再实例化工作区，
    // 否则原生指标 `start()` 时推进去的是上一份结果。
    setTradeLayerPayload(payload)
    setHoverBar(null)
    el.innerHTML = ''

    let ws: VelaWorkspace | null = null
    try {
      ws = new VelaWorkspace(el, {
        layout: false,
        data: velaData,
        symbol: result.report.symbol,
        timeframe: VELA_TIMEFRAME[result.report.timeframe] ?? '60',
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

    let offCross: (() => void) | null = null
    // Vela 内置 UI 没有 i18n：这里挂 DOM 层的汉化（图例、右键菜单、设置弹窗等）
    const uninstallLocale = installVelaLocale()

    withChart((chart) => {
      // 交易标记覆盖物（图层 + 同名的 legend-less 原生指标）
      chart.addNativeIndicator(TRADE_LAYER_ID)
      // Pine 脚本自身的绘制交给 Pine 引擎；脚本报错时 Vela 会自行提示，不阻断蜡烛
      const source = result.pine?.source
      if (source) {
        try {
          chart.addIndicator(source)
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
      uninstallLocale()
      workspaceRef.current = null
      tradeHitState.regions = []
      try {
        ws?.destroy()
      } catch {
        /* 卸载期的异常不必上抛 */
      }
    }
  }, [result, velaData, payload])

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
        sx={{ px: 2, py: 1.25, borderBottom: '1px solid', borderColor: 'divider', flexWrap: 'wrap', gap: 1 }}
      >
        <Stack direction="row" alignItems="center" spacing={1.25}>
          <Typography variant="subtitle2">
            {result ? `${result.report.symbol} · ${result.report.timeframe}` : 'K 线图'}
          </Typography>
          {result && (
            <Typography variant="caption" color="text.secondary">
              共 {result.candles.length.toLocaleString()} 根 · 交易 {markerCount} 笔
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
          <FormControlLabel
            control={
              <Switch size="small" checked={showTrades} onChange={(e) => onToggleTrades(e.target.checked)} />
            }
            label={<Typography variant="caption">交易标注</Typography>}
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={showLevels}
                disabled={!showTrades}
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
            px: 2,
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
        <Box sx={{ px: 2, py: 0.5, bgcolor: 'action.hover' }}>
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
              {loading ? '正在拉取行情并回测…' : '设置参数后点击「开始回测」加载 K 线'}
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

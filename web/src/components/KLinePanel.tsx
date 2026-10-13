import { useEffect, useMemo, useRef } from 'react'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Stack from '../ui/Stack'
import Typography from '@mui/material/Typography'
import FormControlLabel from '@mui/material/FormControlLabel'
import Switch from '@mui/material/Switch'
import Tooltip from '@mui/material/Tooltip'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import { dispose, init, type Chart, type KLineData, type Period } from 'klinecharts'

import type { BacktestResult, Timeframe, Trade } from '@shared/types'
import { registerCustomCharts, type TradeMarkerData } from '../charts/klineRegistrations'
import { klineAxisTime } from '../utils/format'

registerCustomCharts()

const PERIOD_MAP: Record<Timeframe, Period> = {
  '1m': { type: 'minute', span: 1 },
  '3m': { type: 'minute', span: 3 },
  '5m': { type: 'minute', span: 5 },
  '15m': { type: 'minute', span: 15 },
  '30m': { type: 'minute', span: 30 },
  '1h': { type: 'hour', span: 1 },
  '2h': { type: 'hour', span: 2 },
  '4h': { type: 'hour', span: 4 },
  '6h': { type: 'hour', span: 6 },
  '12h': { type: 'hour', span: 12 },
  '1d': { type: 'day', span: 1 },
  '3d': { type: 'day', span: 3 },
  '1w': { type: 'week', span: 1 },
}

function pricePrecisionOf(sample: number): number {
  const abs = Math.abs(sample)
  if (abs >= 1000) return 2
  if (abs >= 100) return 3
  if (abs >= 1) return 4
  if (abs >= 0.01) return 6
  return 8
}

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

/** 点选标记的命中半径（像素） */
const MARKER_HIT_RADIUS = 14

const MAX_MARKERS = 1200

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
  const chartRef = useRef<Chart | null>(null)

  const klineData = useMemo<KLineData[]>(() => {
    if (!result) return []
    return result.candles.map((c, i) => {
      const sig = result.signals[i]
      return {
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        imbaTrendLine: sig?.imbaTrendLine,
        imbaBull: sig?.tsotTrendValue != null && sig.tsotTrendValue > 0 ? 1 : 0,
        tsotTrendValue: sig?.tsotTrendValue,
        supertrendUp: sig?.supertrendUp,
        supertrendDn: sig?.supertrendDn,
      } as KLineData
    })
  }, [result])

  const markerCount = result?.trades.length ?? 0

  useEffect(() => {
    const container = containerRef.current
    if (!container || !result || klineData.length === 0) return

    // 每次回测结果变化时重建图表实例，确保指标/标注状态干净
    dispose(container)
    container.innerHTML = ''

    const chart = init(container, {
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      styles: {
        grid: {
          horizontal: { color: 'rgba(255,255,255,0.05)' },
          vertical: { color: 'rgba(255,255,255,0.05)' },
        },
        candle: {
          bar: {
            upColor: '#ff4d4f',
            downColor: '#3ddc97',
            noChangeColor: '#8a94a6',
            upBorderColor: '#ff4d4f',
            downBorderColor: '#3ddc97',
            upWickColor: '#ff4d4f',
            downWickColor: '#3ddc97',
          },
          priceMark: {
            high: { show: true, color: '#9aa4b8' },
            low: { show: true, color: '#9aa4b8' },
            last: {
              show: true,
              upColor: '#ff4d4f',
              downColor: '#3ddc97',
              noChangeColor: '#8a94a6',
              text: { show: true },
            },
          },
          tooltip: {
            title: { show: true },
            legend: { color: '#c8d0e0' },
          },
        },
        indicator: {
          bars: [{ upColor: '#ff4d4f', downColor: '#3ddc97', noChangeColor: '#8a94a6' }],
          tooltip: { title: { color: '#c8d0e0' }, legend: { color: '#c8d0e0' } },
          lastValueMark: { text: { color: '#c8d0e0' } },
        },
        xAxis: {
          axisLine: { color: 'rgba(255,255,255,0.15)' },
          tickLine: { color: 'rgba(255,255,255,0.15)' },
          tickText: { color: '#8a94a6' },
        },
        yAxis: {
          axisLine: { color: 'rgba(255,255,255,0.15)' },
          tickLine: { color: 'rgba(255,255,255,0.15)' },
          tickText: { color: '#8a94a6' },
        },
        crosshair: {
          horizontal: {
            line: { color: 'rgba(255,255,255,0.35)' },
            text: { backgroundColor: '#2a3242' },
          },
          vertical: {
            line: { color: 'rgba(255,255,255,0.35)' },
            text: { backgroundColor: '#2a3242' },
          },
        },
        separator: { color: 'rgba(255,255,255,0.12)', size: 1 },
        overlay: {
          point: { color: '#5b8cff', borderColor: '#5b8cff' },
        },
      },
    })

    if (!chart) return
    chartRef.current = chart

    const pricePrecision = pricePrecisionOf(result.candles[0]?.close ?? 1)

    chart.setSymbol({
      ticker: result.report.symbol,
      pricePrecision,
      volumePrecision: 2,
    })
    chart.setPeriod(PERIOD_MAP[result.report.timeframe] ?? { type: 'hour', span: 1 })
    chart.setDataLoader({
      getBars: ({ callback }) => {
        callback(klineData)
      },
    })

    // 数据同步装载完毕，接着建立指标与交易标注
    try {
      const strategy = result.meta.strategy
      if (strategy === 'supertrend') {
        chart.createIndicator({ name: 'SUPERTREND', paneId: 'candle_pane' })
        chart.createIndicator({ name: 'VOL' })
      } else {
        chart.createIndicator({ name: 'IMBA_FIB', paneId: 'candle_pane' })
        chart.createIndicator({ name: 'VOL' })
        chart.createIndicator({ name: 'TSOT' })
      }
    } catch {
      // 指标注册异常不应阻断图表渲染
    }

    if (showTrades && markerCount <= MAX_MARKERS) {
      const overlays: { name: string; points: { timestamp: number; value: number }[]; extendData: TradeMarkerData; lock: boolean }[] = []
      for (const t of result.trades) {
        overlays.push({
          name: 'tradeMarker',
          points: [
            { timestamp: t.entryTime, value: t.entryPrice },
            { timestamp: t.exitTime, value: t.exitPrice },
          ],
          extendData: {
            side: t.side,
            profitable: t.netPnl >= 0,
            label: `${t.side === 'long' ? '多' : '空'} ${t.netPnl >= 0 ? '+' : ''}${t.pnlPercent.toFixed(1)}%`,
            stopLoss: t.stopLoss,
            takeProfit1: t.takeProfit1,
            takeProfit2: t.takeProfit2,
            entryPrice: t.entryPrice,
            exitPrice: t.exitPrice,
            showLevels,
          },
          lock: true,
        })
      }
      if (overlays.length > 0) {
        try {
          chart.createOverlay(overlays as never)
        } catch {
          // ignore
        }
      }
    }

    return () => {
      dispose(container)
      chartRef.current = null
    }
  }, [result, klineData, showTrades, showLevels, markerCount])

  // 图上点选交易：把每笔的开仓 / 平仓点转成像素，命中半径内即打开该笔明细。
  // 以「按下 → 抬起位移 < 4px」区分点击与拖动、平移，避免缩放拖图时误弹窗。
  useEffect(() => {
    const el = containerRef.current
    if (!el || !result || !showTrades || result.trades.length === 0) return
    let downX = 0
    let downY = 0
    const onPointerDown = (e: MouseEvent) => {
      downX = e.clientX
      downY = e.clientY
    }
    const onPointerUp = (e: MouseEvent) => {
      const chart = chartRef.current
      if (!chart) return
      if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      // 每笔交易贡献「开仓 / 平仓」两个点，数组下标 i 对应交易 i >> 1
      const points = result.trades.flatMap((t) => [
        { timestamp: t.entryTime, value: t.entryPrice },
        { timestamp: t.exitTime, value: t.exitPrice },
      ])
      let coords: Partial<{ x: number; y: number }>[]
      try {
        const converted = chart.convertToPixel(points)
        coords = Array.isArray(converted) ? converted : [converted]
      } catch {
        return
      }
      let best = -1
      let bestDist = Number.POSITIVE_INFINITY
      coords.forEach((c, i) => {
        if (typeof c.x !== 'number' || typeof c.y !== 'number') return
        const dist = Math.hypot(c.x - px, c.y - py)
        if (dist < bestDist) {
          bestDist = dist
          best = i >> 1
        }
      })
      if (best >= 0 && bestDist <= MARKER_HIT_RADIUS) {
        onSelectTrade?.(result.trades[best])
        return
      }
      // 没点中标记时退一步：把点击位置换算回数据坐标，打开「覆盖该根 K 线」的那笔交易。
      // klinecharts 可能返回 timestamp，也可能只返回 dataIndex（按数据数组下标）。
      let ts: number | undefined
      try {
        const back = chart.convertFromPixel([{ x: px, y: py }])
        const point = Array.isArray(back) ? back[0] : back
        if (typeof point?.timestamp === 'number') ts = point.timestamp
        else if (typeof point?.dataIndex === 'number') {
          const row = result.candles[point.dataIndex]
          if (row) ts = row.timestamp
        }
      } catch {
        ts = undefined
      }
      if (ts === undefined) return
      const covering = result.trades.find((t) => t.entryTime <= ts! && ts! <= t.exitTime)
      if (covering) onSelectTrade?.(covering)
    }
    // 用捕获阶段 + 鼠标事件：图表内部（缩放/平移处理）会在冒泡阶段 stopPropagation，
    // 挂在冒泡阶段会收不到事件；鼠标事件在桌面与触屏上都会派发，兼容性最好。
    // 这里只读坐标、不阻断传播，图表拖动不受影响。
    el.addEventListener('mousedown', onPointerDown, true)
    el.addEventListener('mouseup', onPointerUp, true)
    return () => {
      el.removeEventListener('mousedown', onPointerDown, true)
      el.removeEventListener('mouseup', onPointerUp, true)
    }
  }, [result, showTrades, onSelectTrade])

  // 容器尺寸变化时重绘
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      chartRef.current?.resize()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const hasData = klineData.length > 0

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
              (result?.meta.strategy === 'supertrend'
                ? '主图绿/红线为 SuperTrend 上下轨（up/dn）；'
                : '主图蓝/红线为斐波那契 0.5 回撤趋势线（imba_trend_line），副图为 TSOT 趋势强度；') +
              '三角标注每笔交易的入场方向与盈亏；' +
              '蓝线为该笔入场价、红/绿线为出场价（按盈亏着色），线间淡色区域为持仓区间'
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

export { klineAxisTime }

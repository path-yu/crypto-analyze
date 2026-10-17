import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControl from '@mui/material/FormControl'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Select from '@mui/material/Select'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import CloseIcon from '@mui/icons-material/Close'
import PauseIcon from '@mui/icons-material/Pause'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import ReplayIcon from '@mui/icons-material/Replay'
import SkipNextIcon from '@mui/icons-material/SkipNext'

import { VelaWorkspace } from '@luxalgo/vela/workspace'
import type { BacktestResult, Candle, Timeframe, Trade } from '@shared/types'
import { TIMEFRAMES, TIMEFRAME_MS } from '@shared/types'
import Stack from '../ui/Stack'
import {
  TRADE_REPLAY_LAYER_ID,
  buildReplayLayerPayload,
  registerTradeReplayVisuals,
  setTradeReplayPayload,
} from '../charts/tradeMarkersLayer'
import { VELA_THEME, VELA_TIMEFRAME } from './KLinePanel'
import { installVelaLocale } from '../charts/velaLocale'
import { fetchKlines } from '../api'
import { dateTime, money, pct, price as fmtPrice } from '../utils/format'
import { UP_COLOR, DOWN_COLOR } from '../theme'

// 图层 + 原生指标在模块加载时注册一次（幂等）
registerTradeReplayVisuals()

/**
 * 入场前多带多少根「前情」K 线，让用户看清形态后再进入交易。
 * 回放的起点仍是入场那根，前情 K 线在开始播放时已可见。
 */
const LEAD_BARS = 60

/** 播放档位：每根 K 线的推进间隔（毫秒） */
const SPEED_OPTIONS = [
  { label: '0.5×', intervalMs: 2000 },
  { label: '1×', intervalMs: 1000 },
  { label: '2×', intervalMs: 500 },
  { label: '4×', intervalMs: 250 },
]

interface Props {
  open: boolean
  trade: Trade | null
  result: BacktestResult | null
  onClose: () => void
}

/**
 * 单笔交易的 K 线回溯弹窗。
 *
 * 从该笔交易的入场时间开始，逐根实时回放到出场时间为止，用来复盘
 * 「这笔单子在盘面上是怎么走过来的」。支持切换时间周期重新取数播放。
 *
 * 实现要点：
 *   · 数据窗口 = [入场 − LEAD_BARS 根, 出场]，并把 data 截断在出场那根 ——
 *     这样 Vela 的 bar replay 播到最后一根就会自然结束（它本身不认「出场时间」）。
 *   · 回放走 Vela 自带的 `ws.replay`（start/play/pause/step/stop），不自己造轮子。
 *   · 交易标记复用一个独立注册的图层（`stock-trades-replay`），与主图
 *     `KLinePanel` 的那套 payload 互不干扰。
 */
export default function TradeReplayDialog({ open, trade, result, onClose }: Props) {
  const [timeframe, setTimeframe] = useState<Timeframe>(result?.report.timeframe ?? '1h')
  const [intervalMs, setIntervalMs] = useState(1000)
  const [candles, setCandles] = useState<Candle[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  /** 已经播出去的 K 线根数（每收到一次 replay:step 加一） */
  const [playedSteps, setPlayedSteps] = useState(0)
  /** 当前回放到的 K 线开盘时间（时间轴上的游标），null = 尚未进入回放 */
  const [cursorTime, setCursorTime] = useState<number | null>(null)

  const hostRef = useRef<HTMLDivElement | null>(null)
  const wsRef = useRef<VelaWorkspace | null>(null)

  /** 每次（重新）打开都把周期复位到回测时用的周期 */
  useEffect(() => {
    if (open) setTimeframe(result?.report.timeframe ?? '1h')
  }, [open, result?.report.timeframe, trade?.id])

  /** 数据窗口：以「入场 − LEAD_BARS 根」为起点、出场为终点（出场那根含在内） */
  const replayWindow = useMemo(() => {
    if (!trade) return null
    const tfMs = TIMEFRAME_MS[timeframe]
    const from = trade.entryTime - LEAD_BARS * tfMs
    const to = trade.exitTime
    const bars = Math.ceil((to - from) / tfMs) + 3
    return { from, to, bars }
  }, [trade, timeframe])

  /** 单边手续费率，取自本次回测用的参数（实时盯市与盈亏平衡价都要用它） */
  const feeRate = (result?.report.params.commissionPercent ?? 0) / 100

  /**
   * 盈亏平衡价：让「毛盈亏 = 双边手续费」的那个价格。
   *
   * 引擎的手续费口径是「名义价值 × 费率/单边」，因此
   *   多头：(P − E)·q = r·E·q + r·P·q  →  P = E(1 + r) / (1 − r)
   *   空头：(E − P)·q = r·E·q + r·P·q  →  P = E(1 − r) / (1 + r)
   */
  const breakEvenPrice = useMemo(() => {
    if (!trade || !Number.isFinite(trade.entryPrice)) return Number.NaN
    const e = trade.entryPrice
    if (!(feeRate > 0 && feeRate < 1)) return e
    return trade.side === 'long' ? (e * (1 + feeRate)) / (1 - feeRate) : (e * (1 - feeRate)) / (1 + feeRate)
  }, [trade, feeRate])

  /** 时间戳 → 该根收盘价（O(1) 查当前回放到的那根） */
  const closeByTime = useMemo(() => {
    const m = new Map<number, number>()
    for (const c of candles) m.set(c.timestamp, c.close)
    return m
  }, [candles])

  /**
   * 实时盯市（随回放游标更新）——**按 fills 逐笔累加，口径与引擎完全一致**：
   *
   *   已实现部分 = Σ(游标之前每笔平仓的毛盈亏) −（开仓手续费 + 那些平仓的手续费）
   *   未实现部分 = 剩余数量 ×（当前收盘 − 入场价）× 方向 − 按当前价平仓预估的手续费
   *   浮动收益率 = 浮动金额 / 保证金（与引擎 `pnlPercent` 同一分母）
   *
   * 好处：分批止盈/止损也逐笔算进去，而且**播到出场那根时剩余数量为 0**，
   * 结果正好等于该笔的 `netPnl` —— 与弹窗右上角「最终」严格对齐。
   * 游标还没进场（null）时按入场价算，显示的就是「刚开仓、先亏手续费」。
   */
  const live = useMemo(() => {
    if (!trade) return null
    const cursor = cursorTime ?? trade.entryTime
    const close = (cursorTime !== null ? closeByTime.get(cursorTime) : undefined) ?? trade.entryPrice
    const dir = trade.side === 'long' ? 1 : -1
    const exitFeeTotal = trade.fills.reduce((s, f) => s + f.fee, 0)
    const entryFee = Math.max(0, trade.fee - exitFeeTotal)
    let realizedQty = 0
    let realizedGross = 0
    let realizedFee = entryFee
    for (const f of trade.fills) {
      if (f.timestamp > cursor) break // fills 按时间升序
      realizedQty += f.qty
      realizedGross += (f.price - trade.entryPrice) * f.qty * dir
      realizedFee += f.fee
    }
    const remainingQty = Math.max(0, trade.qty - realizedQty)
    const unrealizedGross = (close - trade.entryPrice) * remainingQty * dir
    const unrealizedFee = close * remainingQty * feeRate
    const netPnl = realizedGross + unrealizedGross - realizedFee - unrealizedFee
    const pct = trade.margin > 0 ? (netPnl / trade.margin) * 100 : 0
    return { close, netPnl, pct }
  }, [trade, cursorTime, closeByTime, feeRate])

  /* ---------------- 取数：优先复用回测结果里已有的 K 线 ---------------- */

  useEffect(() => {
    if (!open || !trade || !result || !replayWindow) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setCandles([])
    setPlaying(false)

    const load = async (): Promise<void> => {
      try {
        const inWindow = (c: Candle): boolean =>
          c.timestamp >= replayWindow.from && c.timestamp <= replayWindow.to
        // 与回测同周期：直接用结果里的 K 线切片，秒开且不依赖网络
        let data =
          timeframe === result.report.timeframe ? result.candles.filter(inWindow) : []
        if (data.length === 0) {
          const res = await fetchKlines({
            exchange: result.report.exchange,
            symbol: result.report.symbol,
            timeframe,
            bars: replayWindow.bars,
            until: replayWindow.to,
          })
          data = res.candles.filter(inWindow)
        }
        if (!cancelled) setCandles(data)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [open, trade, result, timeframe, replayWindow])

  /* ---------------- 建图 + 回放 ---------------- */

  useEffect(() => {
    const el = hostRef.current
    if (!open || !el || !trade || !result || candles.length === 0) return

    // 先写入这一笔的标记 payload（含盈亏平衡线），再实例化工作区
    setTradeReplayPayload(buildReplayLayerPayload(trade, breakEvenPrice))
    setPlayedSteps(0)
    setCursorTime(null)
    el.innerHTML = ''

    let ws: VelaWorkspace | null = null
    try {
      ws = new VelaWorkspace(el, {
        layout: false,
        data: candles.map((c) => ({
          time: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
        })),
        symbol: result.report.symbol,
        timeframe: VELA_TIMEFRAME[timeframe] ?? '60',
        theme: VELA_THEME,
        upColor: VELA_THEME.upColor,
        downColor: VELA_THEME.downColor,
        timezone: 'Asia/Shanghai',
        topbar: { left: [], right: [] },
        statusline: false,
        bottombar: false,
        watermark: true,
        drawings: false,
        layoutMode: 'desktop',
        persist: false,
      })
      wsRef.current = ws
    } catch (err) {
      console.error('[vela] 回放图表初始化失败：', err)
      setError('图表初始化失败')
      return
    }

    let offEnd: (() => void) | null = null
    let offStep: (() => void) | null = null
    let offStart: (() => void) | null = null
    // Vela 内置 UI 没有 i18n：这里挂 DOM 层的汉化（图例、右键菜单、回放水印等）
    const uninstallLocale = installVelaLocale()
    /** 图表已被卸载：所有异步续作（含 start 的重试）都要看这个标志，避免打到已销毁的 cell */
    let disposed = false

    /** cell 未必在构造函数里就绪，图表访问统一延迟取用（最多重试 10 帧） */
    const withChart = (fn: (chart: ReturnType<VelaWorkspace['cells']>[number]['chart']) => void, tries = 10): void => {
      const run = (left: number): void => {
        if (disposed) return
        try {
          fn(ws!.chart)
        } catch {
          if (left > 0) requestAnimationFrame(() => run(left - 1))
        }
      }
      run(tries)
    }

    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    /**
     * 从入场那根开始回放。
     *
     * 必须等 K 线真正装载完再 `start()` —— 它依赖 `chart.replay.bounds`，
     * 历史尚未装载时 bounds 为 null，start() 会静默不动（现象就是「显示暂停了、
     * 但图上的 K 线并没有被回卷」）。这里先轮询 bounds 直到非空（最多 4 秒）。
     */
    const startReplay = async (): Promise<void> => {
      const w = ws
      if (!w) return
      for (let i = 0; i < 80 && !disposed; i++) {
        try {
          if (w.chart.replay.bounds) break
        } catch {
          /* 图表尚未就绪，继续等 */
        }
        await sleep(50)
      }
      if (disposed) return
      try {
        await w.replay.start({ from: trade.entryTime })
      } catch (err) {
        if (!disposed) {
          console.error('[vela] 回放启动失败：', err)
          setError('回放启动失败')
        }
        return
      }
      if (disposed) return
      w.replay.play(intervalMs)
      setPlaying(true)
    }

    withChart((chart) => {
      chart.addNativeIndicator(TRADE_REPLAY_LAYER_ID)
      offEnd = ws!.replay.on('replay:end', () => setPlaying(false))
      offStart = ws!.replay.on('replay:start', (e) => setCursorTime(e.cursorTime))
      offStep = ws!.replay.on('replay:step', (e) => {
        setPlayedSteps((n) => n + 1)
        setCursorTime(e.cursorTime)
      })
      void startReplay()
    })

    const ro = new ResizeObserver(() => ws?.resize())
    ro.observe(el)

    return () => {
      disposed = true
      offEnd?.()
      offStep?.()
      offStart?.()
      uninstallLocale()
      ro.disconnect()
      wsRef.current = null
      try {
        ws?.destroy()
      } catch {
        /* 卸载期异常不上抛 */
      }
    }
    // intervalMs 只作为播放时的参数使用，变化时由下面的 effect 生效，不重建图表
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, trade, result, candles, timeframe, breakEvenPrice])

  /** 播放中切换速度：直接用新的间隔重发 play */
  useEffect(() => {
    if (!playing) return
    wsRef.current?.replay.play(intervalMs)
  }, [playing, intervalMs])

  const handleTogglePlay = useCallback(() => {
    const ws = wsRef.current
    if (!ws || !trade) return
    if (playing) {
      ws.replay.pause()
      setPlaying(false)
      return
    }
    // 已播到出场（replay:end 后已退出回放模式）时，「播放」等同于从头再来一遍
    if (!ws.replay.state.active) {
      setPlayedSteps(0)
      setCursorTime(null)
      void ws.replay.start({ from: trade.entryTime }).then(() => {
        ws.replay.play(intervalMs)
        setPlaying(true)
      })
      return
    }
    ws.replay.play(intervalMs)
    setPlaying(true)
  }, [playing, intervalMs, trade])

  const handleStep = useCallback(() => {
    const ws = wsRef.current
    if (!ws) return
    ws.replay.pause()
    setPlaying(false)
    ws.replay.step()
  }, [])

  /** 回到入场那根重播 */
  const handleRestart = useCallback(() => {
    const ws = wsRef.current
    if (!ws || !trade) return
    ws.replay.stop()
    setPlaying(false)
    setPlayedSteps(0)
    setCursorTime(null)
    void ws.replay.start({ from: trade.entryTime }).then(() => {
      ws.replay.play(intervalMs)
      setPlaying(true)
    })
  }, [trade, intervalMs])

  const hasData = candles.length > 0
  /** 实时浮动盈亏的方向着色（跟随回放游标变化） */
  const liveTone = (live?.netPnl ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ pr: 6 }}>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle1">
            交易 #{trade?.id} · {trade?.side === 'long' ? '多头' : '空头'} · K 线回溯
          </Typography>
          {trade && (
            <Typography variant="caption" color="text.secondary">
              入场 {dateTime(trade.entryTime)} → 出场 {dateTime(trade.exitTime)} · 持仓{' '}
              {trade.barsHeld} 根（原周期）
            </Typography>
          )}
          {/* 随回放游标实时更新的浮动盈亏（口径与引擎一致：金额 / 保证金） */}
          <Stack direction="row" alignItems="baseline" spacing={1} sx={{ ml: 'auto' }}>
            <Typography variant="caption" color="text.secondary">
              浮动
            </Typography>
            <Typography variant="subtitle1" sx={{ color: liveTone, fontWeight: 700 }}>
              {live ? `${money(live.netPnl)} (${pct(live.pct)})` : ''}
            </Typography>
            {trade && (
              <Typography variant="caption" color="text.secondary">
                最终 {money(trade.netPnl)} ({pct(trade.pnlPercent)})
              </Typography>
            )}
          </Stack>
        </Stack>
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }} size="small">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers>
        <Stack spacing={1.5}>
          <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap>
            <FormControl size="small" sx={{ width: 130 }}>
              <InputLabel shrink>时间周期</InputLabel>
              <Select
                label="时间周期"
                notched
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value as Timeframe)}
              >
                {TIMEFRAMES.map((tf) => (
                  <MenuItem key={tf} value={tf}>
                    {tf}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ width: 110 }}>
              <InputLabel shrink>播放速度</InputLabel>
              <Select
                label="播放速度"
                notched
                value={intervalMs}
                onChange={(e) => setIntervalMs(Number(e.target.value))}
              >
                {SPEED_OPTIONS.map((s) => (
                  <MenuItem key={s.intervalMs} value={s.intervalMs}>
                    {s.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Button
              size="small"
              variant="contained"
              startIcon={playing ? <PauseIcon /> : <PlayArrowIcon />}
              disabled={!hasData}
              onClick={handleTogglePlay}
            >
              {playing ? '暂停' : '播放'}
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<SkipNextIcon />}
              disabled={!hasData}
              onClick={handleStep}
            >
              单步
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<ReplayIcon />}
              disabled={!hasData}
              onClick={handleRestart}
            >
              从头重播
            </Button>

            {trade && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ ml: 'auto' }}>
                <Chip size="small" label={`入场 ${fmtPrice(trade.entryPrice)}`} sx={{ height: 20, fontSize: 11, bgcolor: 'action.hover' }} />
                <Chip size="small" label={`出场 ${fmtPrice(trade.exitPrice)}`} sx={{ height: 20, fontSize: 11, bgcolor: 'action.hover' }} />
                {Number.isFinite(breakEvenPrice) && (
                  <Tooltip title="毛盈亏正好抵掉双边手续费的价格（含手续费的保本价），图上橙色水平线即它">
                    <Chip
                      size="small"
                      label={`盈亏平衡线 ${fmtPrice(breakEvenPrice)}`}
                      sx={{ height: 20, fontSize: 11, bgcolor: 'rgba(255,176,31,0.15)', color: '#ffb01f' }}
                    />
                  </Tooltip>
                )}
                {hasData && (
                  <Tooltip title="窗口 K 线根数 / 已播放根数 / 当前回放到的 K 线时间">
                    <Typography variant="caption" color="text.secondary">
                      {candles.length} 根 · 已播放 {playedSteps} 根
                      {cursorTime !== null ? ` · 当前 ${dateTime(cursorTime)}` : ''}
                    </Typography>
                  </Tooltip>
                )}
              </Stack>
            )}
          </Stack>

          {error && <Alert severity="error">{error}</Alert>}

          <Box sx={{ position: 'relative', height: 460, bgcolor: '#0e121b', borderRadius: 1, overflow: 'hidden' }}>
            <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
            {(!hasData || loading) && (
              <Stack
                alignItems="center"
                justifyContent="center"
                spacing={1}
                sx={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
              >
                {loading ? (
                  <>
                    <CircularProgress size={22} />
                    <Typography variant="body2" color="text.secondary">
                      正在拉取该周期 K 线…
                    </Typography>
                  </>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    该窗口没有可回放的 K 线，请换一个更大的时间周期
                  </Typography>
                )}
              </Stack>
            )}
          </Box>

          <Typography variant="caption" color="text.secondary">
            回放从「入场 K 线」开始逐根推进，播到「出场 K 线」自动停止；可用「单步」逐根查看，
            或在左上角切换周期重新取数播放。图上三角标记为该笔交易的入场 / 出场点。
          </Typography>
        </Stack>
      </DialogContent>
    </Dialog>
  )
}

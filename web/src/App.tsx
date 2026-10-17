import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import Alert from '@mui/material/Alert'
import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import CssBaseline from '@mui/material/CssBaseline'
import Drawer from '@mui/material/Drawer'
import IconButton from '@mui/material/IconButton'
import LinearProgress from '@mui/material/LinearProgress'
import Paper from '@mui/material/Paper'
import Stack from './ui/Stack'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import Toolbar from '@mui/material/Toolbar'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import InsightsIcon from '@mui/icons-material/Insights'
import { ThemeProvider } from '@mui/material/styles'

import type {
  BacktestResult,
  Trade,
  ExchangeId,
  SavedPineScript,
  StrategyKind,
  StrategyParams,
  Timeframe,
} from '@shared/types'
import { DEFAULT_STRATEGY_PARAMS, TIMEFRAME_MS } from '@shared/types'
import { buildTheme, UP_COLOR, DOWN_COLOR } from './theme'
import {
  deletePineScript,
  fetchPineScripts,
  runPineBacktest,
  savePineScript,
} from './api'
import ControlPanel, { rangeToSince, rangeToUntil, type RangeKey } from './components/ControlPanel'
import PineEditor, { type PinePanelState } from './components/PineEditor'
import KLinePanel from './components/KLinePanel'
import KpiCards from './components/KpiCards'
import EquityPanel from './components/EquityPanel'
import AnalysisPanel from './components/AnalysisPanel'
import TradesTable from './components/TradesTable'
import TradeDetailDialog from './components/TradeDetailDialog'
import TradeReplayDialog from './components/TradeReplayDialog'
import ReportPanel from './components/ReportPanel'
import { dateTime, humanizeError, money, num, pct } from './utils/format'

type TabKey = 'chart' | 'equity' | 'analysis' | 'trades' | 'report'

const STRATEGY_LABEL: Record<StrategyKind, string> = {
  'fib-trend': 'Fib Trend',
  supertrend: 'SuperTrend',
  'order-block': 'Volume Order Block',
  pine: 'Pine 脚本',
}

/** 顶栏大标题用的完整策略名（比 Chip 里的短名更长，便于一眼看出当前策略） */
const STRATEGY_TITLE: Record<StrategyKind, string> = {
  'fib-trend': 'Fibonacci Trend Reversals',
  supertrend: 'SuperTrend STRATEGY',
  'order-block': 'Volume Order Block Retest',
  pine: 'Pine 脚本',
}

/** 收起后只保留的窄轨宽度 */
const PANEL_RAIL_W = 44
/** 面板展开时的宽度范围（拖拽把手在该区间内调节） */
const PANEL_MIN_W = 300
const PANEL_MAX_W = 640
/** 首次进入时的默认宽度 */
const PANEL_DEFAULT_W = 380

export default function App() {
  const [exchange, setExchange] = useState<ExchangeId>('binanceusdm')
  const [symbol, setSymbol] = useState('BTC/USDT:USDT')
  const [timeframe, setTimeframe] = useState<Timeframe>('1h')
  const [range, setRange] = useState<RangeKey>('1y')
  const [customSince, setCustomSince] = useState(() => {
    const d = new Date(Date.now() - 365 * 86400_000)
    return d.toISOString().slice(0, 10)
  })
  /** 自定义结束日期（YYYY-MM-DD）；空串 = 回测到今天 */
  const [customUntil, setCustomUntil] = useState('')
  /**
   * 本应用现在只跑 Pine 脚本：strategy 固定为 'pine'，并按服务端 normalizeParams
   * 对 pine 的强制语义（Zone OCO / 不分批止盈 / 不加仓）初始化一次。
   */
  const [params, setParams] = useState<StrategyParams>(() => ({
    ...DEFAULT_STRATEGY_PARAMS,
    strategy: 'pine',
    exitStrategy: 'Zone OCO',
    partialTp: false,
    pyramiding: 1,
  }))
  /** Pine 策略源码（strategy === 'pine' 时随回测请求一起提交） */
  const [pineSource, setPineSource] = useState('')
  /**
   * 回测参数覆盖（键 = input 的 title）。
   *
   * 只影响「运行回测」提交的 `inputs` —— 图表上那条指标的参数属于 Vela 自己的
   * 设置弹窗（改它不会重跑回测，也不会写回 .pine 源文件）。
   */
  const [pineInputs, setPineInputs] = useState<Record<string, number | boolean | string>>({})
  /** 保存用的脚本名（同名保存即更新同一份） */
  const [pineName, setPineName] = useState('')
  /** 已保存到本地缓存的脚本（策略下拉菜单直接可选） */
  const [pineScripts, setPineScripts] = useState<SavedPineScript[]>([])
  /** 当前载入的已保存脚本 id */
  const [pineScriptId, setPineScriptId] = useState<string | null>(null)
  /** Pine 编辑器是否在右侧 Drawer 弹窗中放大编辑 */
  const [pineDrawerOpen, setPineDrawerOpen] = useState(false)
  /** 所选合约的最小变动价位（下单精度），用于滑点换算 */
  const [tickSize, setTickSize] = useState(0)

  const [result, setResult] = useState<BacktestResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('chart')
  const [showTrades, setShowTrades] = useState(true)
  /** 单笔交易明细弹窗（「交易明细」表与 K 线图上的交易标记共用） */
  const [detailTrade, setDetailTrade] = useState<Trade | null>(null)
  /** 单笔交易 K 线回放弹窗（「交易明细」表每行的「回溯」按钮打开） */
  const [replayTrade, setReplayTrade] = useState<Trade | null>(null)
  const [showLevels, setShowLevels] = useState(false)

  /** 参数面板是否收起（收起时只显示一条窄轨） */
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  /** 参数面板宽度，由拖拽把手调节 */
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_W)
  const [resizing, setResizing] = useState(false)
  const dragRef = useRef<{ x: number; w: number } | null>(null)

  const expandPanel = useCallback(() => {
    setPanelWidth(PANEL_MAX_W)
    setPanelCollapsed(false)
  }, [])

  const handleResizeStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      dragRef.current = { x: e.clientX, w: panelWidth }
      setResizing(true)
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [panelWidth],
  )

  const handleResizeMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const next = drag.w + (e.clientX - drag.x)
    setPanelWidth(Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, next)))
  }, [])

  const handleResizeEnd = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    setResizing(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  const estimatedBars = useMemo(() => {
    const since = rangeToSince(range, customSince)
    // 结束日期留空即「今天（当前时刻）」
    const until = rangeToUntil(customUntil) ?? Date.now()
    const span = Math.max(0, until - since)
    return Math.floor(span / TIMEFRAME_MS[timeframe])
  }, [range, customSince, customUntil, timeframe])

  /**
   * 发起回测。`opts` 可覆盖源码 / 参数 —— 图表「指标设置」改完参数时用新值直接重跑，
   * 避免 setState 之后闭包还读到旧值。
   */
  const runBacktest = useCallback(
    async (opts: { source?: string; inputs?: Record<string, number | boolean | string> } = {}) => {
      const src = opts.source ?? pineSource
      const ins = opts.inputs ?? pineInputs
      setLoading(true)
      setError(null)
      try {
        const since = rangeToSince(range, customSince)
        const until = rangeToUntil(customUntil)
        if (until !== undefined && until <= since) {
          throw new Error('结束日期必须晚于起始日期')
        }
        const base = {
          exchange,
          symbol,
          timeframe,
          since,
          // 未设置结束日期时回测到当前时刻
          until: until ?? Date.now(),
          params,
          tickSize,
        }
        if (!src.trim()) throw new Error('请先选择一份已保存脚本，或粘贴 / 载入 Pine 源码')
        setResult(await runPineBacktest({ ...base, source: src, inputs: ins }))
        setTab('chart')
        setDetailTrade(null)
      } catch (err) {
        setError(humanizeError(err instanceof Error ? err.message : String(err)))
      } finally {
        setLoading(false)
      }
    },
    [exchange, symbol, timeframe, range, customSince, customUntil, params, pineSource, pineInputs, tickSize],
  )

  const handleRun = useCallback(() => {
    void runBacktest()
  }, [runBacktest])

  /** 图表的事件只在建图时订阅一次，这里用 ref 指向最新的回测函数 */
  const runBacktestRef = useRef(runBacktest)
  runBacktestRef.current = runBacktest

  /* ---------------- Pine 脚本：保存 / 载入 ---------------- */

  /** 拉取已保存脚本列表；选中项若已被删除则清空，避免下拉菜单出现悬空值 */
  const refreshPineScripts = useCallback(async () => {
    try {
      const list = await fetchPineScripts()
      setPineScripts(list)
      setPineScriptId((id) => (id && list.some((s) => s.id === id) ? id : null))
    } catch (err) {
      // 列表拉取失败不影响回测（下次打开下拉 / 保存 / 刷新时会再试），
      // 但要留下日志，否则「明明脚本在磁盘上、下拉里却没有」会无从排查
      console.warn('[pine] 已保存脚本列表拉取失败：', err)
    }
  }, [])

  useEffect(() => {
    void refreshPineScripts()
  }, [refreshPineScripts])

  /** 从「策略」下拉菜单选中一份已保存脚本：填入源码与名称，编辑器随即实时编译 */
  const handleSelectPineScript = useCallback(
    (id: string | null) => {
      setPineScriptId(id)
      if (!id) return
      const script = pineScripts.find((s) => s.id === id)
      if (!script) return
      setPineSource(script.source)
      setPineName(script.name)
      // 换脚本时清空参数覆盖，避免把上一个脚本的名义价值等参数带到新脚本上
      setPineInputs({})
    },
    [pineScripts],
  )

  /**
   * 首次拿到脚本列表时自动选中第一份 —— 本应用只跑 Pine 脚本，
   * 「一进页面就有脚本在跑」靠这一步兜住（没有它，首屏只能空着等用户选）。
   */
  useEffect(() => {
    if (pineScriptId || pineScripts.length === 0) return
    handleSelectPineScript(pineScripts[0].id)
  }, [pineScripts, pineScriptId, handleSelectPineScript])

  /** 首次进入自动跑一次默认回测（等脚本载入后才跑，避免首屏必然报「未选择脚本」） */
  const autoRanRef = useRef(false)
  useEffect(() => {
    if (autoRanRef.current || !pineSource.trim()) return
    autoRanRef.current = true
    void handleRun()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pineSource])

  /**
   * 保存当前源码：同名即更新。
   * 落盘到 `server/pine/<脚本名目录>/`，保存后刷新列表并选中这一份；返回值供编辑器提示具体路径。
   */
  const handleSavePine = useCallback(async () => {
    const saved = await savePineScript(pineName.trim(), pineSource)
    await refreshPineScripts()
    setPineScriptId(saved.id)
    return saved
  }, [pineName, pineSource, refreshPineScripts])

  /**
   * 从磁盘重新载入当前脚本：丢弃编辑器里的文本，用服务端最新源码覆盖。
   *
   * 编译/回测用的都是**编辑器里的文本**，因此在本应用之外修改（或修复）了
   * `.pine` 之后，编辑器不会自动感知，会一直拿旧文本报旧错 —— 用这一步同步。
   */
  const handleReloadPine = useCallback(async () => {
    if (!pineScriptId) throw new Error('当前未载入已保存脚本')
    const list = await fetchPineScripts()
    setPineScripts(list)
    const script = list.find((s) => s.id === pineScriptId)
    if (!script) throw new Error('该脚本在服务端已不存在（可能已被删除或改名）')
    setPineSource(script.source)
    setPineName(script.name)
  }, [pineScriptId])

  /**
   * 图表「指标设置」点「确定」→ 一次同步三处：
   *   1. 用图表里的新参数**重跑回测**
   *   2. 把新值写回 `.pine` 里对应 `input` 的默认值（只有匹配到声明才改）
   *   3. 落盘保存并刷新脚本列表
   */
  const applyIndicatorInputs = useCallback(
    (values: Record<string, number | boolean | string>) => {
      if (JSON.stringify(values) === JSON.stringify(pineInputs)) return
      // 图表（Vela）回传的键是脚本里的**变量名**（notional / volMult …），
      // 这里把变量名映射成 input 声明的标题，后面覆盖面板与服务端都按标题走。
      const titleOf = new Map<string, string>()
      for (const m of pineSource.matchAll(/(\w+)\s*=\s*input\.\w+\(\s*[^,]+,\s*"([^"]+)"/g)) {
        titleOf.set(m[1], m[2])
      }
      const titled: Record<string, number | boolean | string> = {}
      let nextSource = pineSource
      for (const [key, v] of Object.entries(values)) {
        titled[titleOf.get(key) ?? key] = v
        if (typeof v !== 'number' || !Number.isFinite(v)) continue
        // 按变量名定位声明行：`notional = input.float(200.0, "…")`；
        // 值没变就不动，避免 14 → 14.0 这种无意义的格式漂移。
        const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const re = new RegExp(`(^|\\n)(\\s*${esc}\\s*=\\s*input\\.(?:float|int)\\(\\s*)(-?\\d+(?:\\.\\d+)?)`)
        nextSource = nextSource.replace(re, (whole, p1: string, p2: string, p3: string) =>
          Number(p3) === v ? whole : `${p1}${p2}${v}`,
        )
      }
      const changed = nextSource !== pineSource
      if (changed) setPineSource(nextSource)
      setPineInputs(titled)
      const nm = pineName.trim()
      if (changed && nm && pineScriptId) {
        void savePineScript(nm, nextSource)
          .then(() => refreshPineScripts())
          .catch((err) => console.warn('[pine] 指标参数回写源文件失败：', err))
      }
      void runBacktestRef.current({ source: nextSource, inputs: titled })
    },
    [pineInputs, pineSource, pineName, pineScriptId, refreshPineScripts],
  )

  /** 删除当前载入的脚本（编辑器里的源码保留） */
  const handleDeletePine = useCallback(async () => {
    if (!pineScriptId) return
    await deletePineScript(pineScriptId)
    setPineScriptId(null)
    await refreshPineScripts()
  }, [pineScriptId, refreshPineScripts])

  /** 放大编辑开关：编辑器在右侧 Drawer 中铺满显示（面板宽度不受影响） */
  const togglePineDrawer = useCallback(() => setPineDrawerOpen((open) => !open), [])

  /** 透传给 ControlPanel / PineEditor 的 Pine 面板状态 */
  const pine = useMemo<PinePanelState>(
    () => ({
      source: pineSource,
      onSourceChange: setPineSource,
      name: pineName,
      onNameChange: setPineName,
      inputs: pineInputs,
      onInputsChange: setPineInputs,
      scripts: pineScripts,
      selectedId: pineScriptId,
      onSelect: handleSelectPineScript,
      onSave: handleSavePine,
      onDelete: handleDeletePine,
      onReload: handleReloadPine,
      onRefresh: refreshPineScripts,
      drawerOpen: pineDrawerOpen,
      onToggleDrawer: togglePineDrawer,
    }),
    [
      pineSource,
      pineName,
      pineInputs,
      pineScripts,
      pineScriptId,
      handleSelectPineScript,
      handleSavePine,
      handleDeletePine,
      handleReloadPine,
      refreshPineScripts,
      pineDrawerOpen,
      togglePineDrawer,
    ],
  )

  const themeMode = 'dark' as const
  const theme = useMemo(() => buildTheme(themeMode), [themeMode])

  const report = result?.report
  const strategyLabel = result ? STRATEGY_LABEL[result.meta.strategy] : ''
  /**
   * 顶栏标题：跟随左侧「策略」下拉实时切换（不必等回测完成）。
   * Pine 脚本用当前脚本名，未命名时回落到「Pine 脚本」。
   */
  const strategyTitle =
    params.strategy === 'pine'
      ? pineName.trim() || STRATEGY_TITLE.pine
      : STRATEGY_TITLE[params.strategy]
  const headline = report
    ? `${strategyLabel} · ${report.symbol} ${report.timeframe} · ${report.leverage}x · ${money(
        report.initialCapital,
        0,
      )} → ${money(report.finalEquity, 0)}`
    : '等待回测'

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box
        sx={{
          height: { xs: 'auto', lg: '100vh' },
          display: 'flex',
          flexDirection: 'column',
          overflowX: 'hidden',
          bgcolor: 'background.default',
        }}
      >
        <AppBar
          position="sticky"
          elevation={0}
          sx={{
            flexShrink: 0,
            bgcolor: 'background.paper',
            borderBottom: '1px solid',
            borderColor: 'divider',
            color: 'text.primary',
          }}
        >
          <Toolbar sx={{ gap: 2, flexWrap: 'wrap', py: 0.5 }}>
            <Stack direction="row" alignItems="center" spacing={1.25}>
              <InsightsIcon sx={{ color: 'primary.main' }} />
              <Box>
                <Typography variant="h6" sx={{ fontSize: 17, lineHeight: 1.2 }}>
                  {strategyTitle}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  ccxt 公开合约行情 · TypeScript 回测引擎 · Vela 可视化
                </Typography>
              </Box>
            </Stack>
            <Box sx={{ flex: 1 }} />
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Chip size="small" label={headline} variant="outlined" />
              {report && (
                <>
                  <Chip
                    size="small"
                    label={`收益 ${pct(report.totalReturnPercent)}`}
                    sx={{
                      color: report.totalReturnPercent >= 0 ? UP_COLOR : DOWN_COLOR,
                      borderColor: 'currentColor',
                    }}
                    variant="outlined"
                  />
                  <Chip
                    size="small"
                    label={`回撤 ${pct(report.maxDrawdownPercent, 1, false)}`}
                    variant="outlined"
                  />
                  <Chip size="small" label={`${report.stats.totalTrades} 笔`} variant="outlined" />
                </>
              )}
            </Stack>
          </Toolbar>
          {loading && <LinearProgress />}
        </AppBar>

        <Box
          sx={{
            flex: { lg: 1 },
            minHeight: 0,
            display: 'flex',
            flexDirection: { xs: 'column', lg: 'row' },
            gap: { xs: 2, lg: 0 },
            px: { xs: 2, lg: 3 },
            py: 2,
          }}
        >
          {/* ---------- 左：参数面板（可收起 / 可拖拽宽度 / 独立滚动） ---------- */}
          <Box
            sx={{
              width: { xs: '100%', lg: panelCollapsed ? PANEL_RAIL_W : panelWidth },
              flexShrink: 0,
              minWidth: 0,
              height: { lg: '100%' },
              overflowY: { lg: panelCollapsed ? 'hidden' : 'auto' },
              overflowX: 'hidden',
              transition: resizing ? 'none' : 'width .2s ease',
            }}
          >
            {panelCollapsed && (
              <Paper
                sx={{
                  p: { xs: 1, lg: 0.5 },
                  display: 'flex',
                  flexDirection: { xs: 'row', lg: 'column' },
                  alignItems: 'center',
                  gap: 1,
                }}
              >
                <Tooltip title="展开参数面板" placement="right">
                  <IconButton size="small" onClick={expandPanel}>
                    <ChevronRightIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Typography
                  variant="caption"
                  sx={{
                    display: { xs: 'none', lg: 'block' },
                    writingMode: 'vertical-rl',
                    letterSpacing: 2,
                    color: 'text.secondary',
                  }}
                >
                  参数面板
                </Typography>
              </Paper>
            )}

            {/* 收起时仅隐藏（保留挂载状态，避免重挂载后重新拉取合约列表） */}
            <Box sx={{ display: panelCollapsed ? 'none' : 'block', width: panelWidth }}>
              <ControlPanel
                onCollapse={() => setPanelCollapsed(true)}
                exchange={exchange}
                onExchangeChange={setExchange}
                symbol={symbol}
                onSymbolChange={setSymbol}
                timeframe={timeframe}
                onTimeframeChange={setTimeframe}
                range={range}
                onRangeChange={setRange}
                customSince={customSince}
                onCustomSinceChange={setCustomSince}
                customUntil={customUntil}
                onCustomUntilChange={setCustomUntil}
                params={params}
                onParamsChange={setParams}
                onRun={handleRun}
                loading={loading}
                estimatedBars={estimatedBars}
                pine={pine}
                onTickSizeChange={setTickSize}
              />
            </Box>

            {/* ---------- Pine 放大编辑：右侧 Drawer（不占面板宽度，跨过图表区） ---------- */}
            <Drawer
              anchor="right"
              open={pineDrawerOpen}
              onClose={togglePineDrawer}
              slotProps={{
                paper: {
                  sx: {
                    width: { xs: '100%', md: '80vw' },
                    maxWidth: 1200,
                    p: 2,
                    boxSizing: 'border-box',
                  },
                },
              }}
            >
              <PineEditor {...pine} onRun={handleRun} loading={loading} />
            </Drawer>
          </Box>

          {/* ---------- 拖拽把手：调节面板宽度 ---------- */}
          {!panelCollapsed && (
            <Box
              role="separator"
              aria-orientation="vertical"
              aria-label="拖拽调整参数面板宽度"
              onPointerDown={handleResizeStart}
              onPointerMove={handleResizeMove}
              onPointerUp={handleResizeEnd}
              onPointerCancel={handleResizeEnd}
              sx={{
                display: { xs: 'none', lg: 'block' },
                flexShrink: 0,
                width: 10,
                cursor: 'col-resize',
                touchAction: 'none',
                position: 'relative',
                '&::after': {
                  content: '""',
                  position: 'absolute',
                  top: 0,
                  bottom: 0,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: 2,
                  borderRadius: 1,
                  bgcolor: resizing ? 'primary.main' : 'divider',
                  transition: 'background-color .15s',
                },
                '&:hover::after': { bgcolor: 'primary.main' },
              }}
            />
          )}

          {/* ---------- 右：回测结果（独立滚动） ---------- */}
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              height: { lg: '100%' },
              overflowY: { lg: 'auto' },
              pl: { xs: 0, lg: 1 },
            }}
          >
            <Stack spacing={2} sx={{ minWidth: 0 }}>
              {error && (
                <Alert severity="error" onClose={() => setError(null)}>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                    {error}
                  </Typography>
                </Alert>
              )}

              {/* 数据源降级 / 区间被自动收缩等提示：以前只在「回测报告」页可见 */}
              {(report?.warnings.length ?? 0) > 0 && (
                <Alert severity="warning">
                  <Stack spacing={0.5}>
                    {report!.warnings.map((w) => (
                      <Typography key={w} variant="body2">
                        {w}
                      </Typography>
                    ))}
                  </Stack>
                </Alert>
              )}

              {report && (
                <>
                  <KpiCards report={report} />
                  <Paper sx={{ overflow: 'hidden' }}>
                    <Tabs
                      value={tab}
                      onChange={(_e, v: TabKey) => setTab(v)}
                      variant="scrollable"
                      scrollButtons="auto"
                      sx={{ px: 1, borderBottom: '1px solid', borderColor: 'divider' }}
                    >
                      <Tab value="chart" label="K 线与交易" />
                      <Tab value="equity" label="收益分析" />
                      <Tab value="analysis" label="交易分析" />
                      <Tab value="trades" label="交易明细" />
                      <Tab value="report" label="回测报告" />
                    </Tabs>
                  </Paper>

                  {tab === 'chart' && (
                    <KLinePanel
                      result={result}
                      loading={loading}
                      showTrades={showTrades}
                      onToggleTrades={setShowTrades}
                      showLevels={showLevels}
                      onToggleLevels={setShowLevels}
                      onSelectTrade={setDetailTrade}
                      onIndicatorInputsChange={applyIndicatorInputs}
                    />
                  )}
                  {tab === 'equity' && <EquityPanel result={result!} />}
                  {tab === 'analysis' && <AnalysisPanel result={result!} />}
                  {tab === 'trades' && (
                    <TradesTable
                      result={result!}
                      onSelectTrade={setDetailTrade}
                      onReplayTrade={setReplayTrade}
                    />
                  )}
                  {tab === 'report' && <ReportPanel result={result!} />}

                  {/* 单笔交易明细：交易明细表点行、K 线图点交易标记都会打开这里 */}
                  <TradeDetailDialog trade={detailTrade} onClose={() => setDetailTrade(null)} />

                  {/* 单笔交易 K 线回溯：交易明细表每行的「回溯」按钮打开 */}
                  <TradeReplayDialog
                    open={replayTrade !== null}
                    trade={replayTrade}
                    result={result}
                    onClose={() => setReplayTrade(null)}
                  />

                  <Paper sx={{ p: 1.75 }}>
                    <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                      <Typography variant="caption" color="text.secondary">
                        数据源 {report.exchange}
                        {result?.meta.cached ? '（缓存）' : '（实时）'}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        区间 {dateTime(report.startTime)} ~ {dateTime(report.endTime)} UTC+8
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        手续费 {report.params.commissionPercent}%/单边 · 杠杆 {report.leverage}x ·
                        仓位 {report.params.positionSizePercent}%
                      </Typography>
                      <Tooltip title="年化收益率按回测天数做连续复利换算；未计入资金费与滑点">
                        <Typography variant="caption" color="text.secondary">
                          年化 {pct(report.annualizedReturnPercent)} · 夏普 {num(report.sharpeRatio, 2)} ·
                          年化波动 {num(report.volatilityPercent, 1)}%
                        </Typography>
                      </Tooltip>
                    </Stack>
                  </Paper>
                </>
              )}

              {!report && !loading && (
                <Paper sx={{ p: 6, textAlign: 'center' }}>
                  <Typography variant="h6" sx={{ mb: 1 }}>
                    还没有回测结果
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    在左侧选择交易所、合约、周期与杠杆，调整策略参数后点击「开始回测」。
                  </Typography>
                </Paper>
              )}
            </Stack>
          </Box>
        </Box>
      </Box>
    </ThemeProvider>
  )
}

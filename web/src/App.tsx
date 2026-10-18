import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import Alert from '@mui/material/Alert'
import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
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
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import TuneIcon from '@mui/icons-material/Tune'
import CircularProgress from '@mui/material/CircularProgress'
import useMediaQuery from '@mui/material/useMediaQuery'
import { ThemeProvider } from '@mui/material/styles'

import type {
  BacktestResult,
  Candle,
  ChartDataset,
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
  fetchKlines,
  fetchPineScripts,
  runPineBacktest,
  savePineScript,
} from './api'
import { openKlineStream } from './marketStream'
import { invalidatePineManifest } from './charts/manifestLoader'
import ControlPanel, { rangeToSince, rangeToUntil, type RangeKey } from './components/ControlPanel'
import PineEditor, { type PinePanelState } from './components/PineEditor'
import AlertPanel from './components/AlertPanel'
import AlertNotifications from './components/AlertNotifications'
import KLinePanel from './components/KLinePanel'
import KpiCards from './components/KpiCards'
import EquityPanel from './components/EquityPanel'
import AnalysisPanel from './components/AnalysisPanel'
import TradesTable from './components/TradesTable'
import TradeDetailDialog from './components/TradeDetailDialog'
import TradeReplayDialog from './components/TradeReplayDialog'
import ReportPanel from './components/ReportPanel'
import useIsMobile from './ui/useIsMobile'
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

/**
 * 实时 K 线推送（WebSocket）开关。
 *
 * 置 false 时只走 REST 拉取历史 K 线、不再订阅实时尾巴 —— 便于布局调试等场景
 * 排除 WS 推流的干扰（WS 会在收盘时反复刷新图表）；默认开启。
 */
const REALTIME_WS_ENABLED = true

/**
 * 把时间向下取整到 bar 边界。
 *
 * 窗口终点必须冻结到 bar 边界：服务端缓存的键是 `…_alignFloor(since)_alignFloor(until)`，
 * 若每次都用 `Date.now()` 这种毫秒级漂移的值，同一根 bar 内重复请求也会全部落到新键上
 * ——「点回测不再拉 K 线」就无从谈起。
 */
function alignFloor(t: number, tfMs: number): number {
  return Math.floor(t / tfMs) * tfMs
}

/**
 * 把 WS 推来的最新 bar 合并进已有 K 线：时间戳已存在则覆盖（未收盘 bar 会反复更新），
 * 出现更晚的时间戳则追加，并从头部裁掉同样多的旧 bar，保持窗口长度稳定。
 */
function upsertCandles(prev: Candle[], incoming: Candle[]): Candle[] {
  const next = prev.slice()
  let appended = 0
  for (const c of incoming) {
    const last = next[next.length - 1]
    if (!last || c.timestamp > last.timestamp) {
      next.push(c)
      appended++
      continue
    }
    if (c.timestamp === last.timestamp) {
      next[next.length - 1] = c
      continue
    }
    const idx = next.findIndex((x) => x.timestamp === c.timestamp)
    if (idx >= 0) next[idx] = c
  }
  // 有新增才裁剪，且保留至少 incoming 根，避免窗口被清空
  if (appended === 0 || prev.length === 0) return next
  return next.slice(Math.min(appended, Math.max(0, next.length - 1)))
}

/**
 * 比较两组「指标输入」是否等价（键序无关）。
 *
 * 用于 `applyIndicatorInputs` 的去重守卫：Vela 回传的是变量名键、面板里存的是标题键，
 * 必须先归一到同一键空间再比，否则守卫会永远失效。
 */
function sameInputs(
  a: Record<string, number | boolean | string>,
  b: Record<string, number | boolean | string>,
): boolean {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!(k in b) || a[k] !== b[k]) return false
  return true
}

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
  /** 价格警报面板（右侧 Drawer） */
  const [alertPanelOpen, setAlertPanelOpen] = useState(false)
  /** 所选合约的最小变动价位（下单精度），用于滑点换算 */
  const [tickSize, setTickSize] = useState(0)

  const [result, setResult] = useState<BacktestResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * 图表数据集（历史 K 线 + 窗口元信息），与回测结果**解耦**：
   * 切换行情设置时先把它拉回来立即出图，统计区留空态等回测。
   */
  const [chartData, setChartData] = useState<ChartDataset | null>(null)
  /** 正在拉取 K 线（与回测的 loading 分开，图表有自己的加载态） */
  const [chartLoading, setChartLoading] = useState(false)
  /** 「同步进行回测」：切换品种/周期/区间后自动重跑一次回测（默认关闭） */
  const [syncBacktest, setSyncBacktest] = useState(false)
  const [tab, setTab] = useState<TabKey>('chart')
  const [showTrades, setShowTrades] = useState(true)
  /** 单笔交易明细弹窗（「交易明细」表与 K 线图上的交易标记共用） */
  const [detailTrade, setDetailTrade] = useState<Trade | null>(null)
  /** 单笔交易 K 线回放弹窗（「交易明细」表每行的「回溯」按钮打开） */
  const [replayTrade, setReplayTrade] = useState<Trade | null>(null)
  const [showLevels, setShowLevels] = useState(false)

  /** 参数面板是否收起（收起时只显示一条窄轨） */
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  /** 移动端：参数面板以左侧抽屉弹出（桌面端为内嵌可拖拽列） */
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false)
  /** 参数面板宽度，由拖拽把手调节 */
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_W)
  const [resizing, setResizing] = useState(false)
  const dragRef = useRef<{ x: number; w: number } | null>(null)
  /** 顶栏元素与实测高度：移动端标签栏要吸在它正下方，高度得跟着实际渲染走 */
  const appBarRef = useRef<HTMLElement | null>(null)
  const [appBarH, setAppBarH] = useState(0)

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
   * 冻结的窗口终点（已取整到 bar 边界）。
   *
   * 取 K 线时写入，点「开始回测」时复用 —— 两个接口必须传**同一个 until**，
   * 服务端的缓存键才会命中同一份数据，回测才不会重新去交易所拉 K 线。
   */
  const dataUntilRef = useRef<number>(Date.now())
  /**
   * 数据窗口代次：每次发起「取 K 线」就 +1。响应回来时代次对不上就丢弃，
   * 连点两个品种时最终图上一定是后选中的那个。
   */
  const seqRef = useRef(0)
  /** 回测调用序：只用于丢弃过期回测的 loading / 结果 */
  const backtestSeqRef = useRef(0)

  /** 当前应使用的窗口终点：自定义结束日期优先，否则对齐到「当前 bar 边界」 */
  const resolveUntil = useCallback((): number => {
    const custom = rangeToUntil(customUntil)
    return custom ?? alignFloor(Date.now(), TIMEFRAME_MS[timeframe])
  }, [customUntil, timeframe])

  const syncBacktestRef = useRef(syncBacktest)
  syncBacktestRef.current = syncBacktest
  const pineSourceRef = useRef(pineSource)
  pineSourceRef.current = pineSource

  /**
   * 发起回测。`opts` 可覆盖源码 / 参数 / 窗口 —— 图表「指标设置」改完参数时用新值直接重跑，
   * 避免 setState 之后闭包还读到旧值。
   *
   * **不再拉取 K 线**：`until` 复用 `dataUntilRef`（取 K 线接口刚用过的那个值），
   * 服务端因此命中同一份缓存，只做编译 + 撮合 + 统计。
   */
  const runBacktest = useCallback(
    async (
      opts: {
        source?: string
        inputs?: Record<string, number | boolean | string>
        since?: number
        until?: number
      } = {},
    ) => {
      const gen = seqRef.current
      const bt = ++backtestSeqRef.current
      const stale = (): boolean => gen !== seqRef.current || bt !== backtestSeqRef.current
      const src = opts.source ?? pineSource
      const ins = opts.inputs ?? pineInputs
      setLoading(true)
      setError(null)
      try {
        const since = opts.since ?? rangeToSince(range, customSince)
        const until = opts.until ?? dataUntilRef.current
        if (until <= since) throw new Error('结束日期必须晚于起始日期')
        if (!src.trim()) throw new Error('请先选择一份已保存脚本，或粘贴 / 载入 Pine 源码')
        const data = await runPineBacktest({
          exchange,
          symbol,
          timeframe,
          since,
          until,
          params,
          tickSize,
          source: src,
          inputs: ins,
        })
        if (stale()) return
        setResult(data)
        setTab('chart')
        setDetailTrade(null)
      } catch (err) {
        if (stale()) return
        setError(humanizeError(err instanceof Error ? err.message : String(err)))
      } finally {
        if (bt === backtestSeqRef.current) setLoading(false)
      }
    },
    [exchange, symbol, timeframe, range, customSince, params, pineSource, pineInputs, tickSize],
  )

  const handleRun = useCallback(() => {
    void runBacktest()
  }, [runBacktest])

  /** 图表的事件只在建图时订阅一次，这里用 ref 指向最新的回测函数 */
  const runBacktestRef = useRef(runBacktest)
  runBacktestRef.current = runBacktest

  /**
   * 拉取当前行情设置的 K 线并立即出图（**不等回测**）。
   *
   * 顺序刻意如此：先清空上一次回测结果（统计区归零）→ 取 K 线 → 出图 →
   * 若勾选了「同步进行回测」再用**同一个窗口**跑回测（服务端命中缓存，不再拉 K 线）。
   */
  const loadDataset = useCallback(
    async (refresh = false) => {
      const ticket = ++seqRef.current
      const tfMs = TIMEFRAME_MS[timeframe]
      // refresh = 用户点「刷新」或 WS 推来新 bar 收盘：重新对齐到当前 bar 边界
      const until = refresh ? alignFloor(Date.now(), tfMs) : resolveUntil()
      const since = rangeToSince(range, customSince)
      dataUntilRef.current = until
      setChartLoading(true)
      setError(null)
      // 切品种/周期/区间先清空上一次回测结果：统计区归零，图表照常渲染
      setResult(null)
      setDetailTrade(null)
      try {
        const ds = await fetchKlines({ exchange, symbol, timeframe, since, until })
        if (ticket !== seqRef.current) return
        dataUntilRef.current = ds.until || until
        setChartData({
          exchange,
          symbol,
          timeframe,
          since: ds.since || since,
          until: ds.until || until,
          candles: ds.candles,
          cached: ds.cached,
          fetchedAt: Date.now(),
        })
        if (syncBacktestRef.current && pineSourceRef.current.trim()) {
          await runBacktestRef.current({ since: ds.since || since, until: ds.until || until })
        }
      } catch (err) {
        if (ticket !== seqRef.current) return
        setError(humanizeError(err instanceof Error ? err.message : String(err)))
        setChartData(null)
      } finally {
        if (ticket === seqRef.current) setChartLoading(false)
      }
    },
    [exchange, symbol, timeframe, range, customSince, resolveUntil],
  )

  // 行情设置变化（交易所 / 品种 / 周期 / 区间）→ 立即拉 K 线刷新图表
  useEffect(() => {
    void loadDataset()
  }, [loadDataset])

  /**
   * 实测顶栏高度。
   *
   * 移动端标签栏用 `top: 顶栏高度` 吸在顶栏正下方；顶栏高度不是固定值
   * （加载进度条、字号、安全区都会让它变化），因此用 ResizeObserver 跟着量，
   * 避免写死像素值后在进度条出现时被顶栏压住。
   */
  useEffect(() => {
    const el = appBarRef.current
    if (!el) return
    const measure = () => setAppBarH(el.getBoundingClientRect().height)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** 供实时推送回调（不随渲染重建）触发一次「刷新」（含可选同步回测） */
  const loadDatasetRef = useRef(loadDataset)
  loadDatasetRef.current = loadDataset

  /* ---------------- Pine 脚本：保存 / 载入 ---------------- */

  /** 拉取已保存脚本列表；选中项若已被删除则清空，避免下拉菜单出现悬空值 */
  const refreshPineScripts = useCallback(async () => {
    try {
      const list = await fetchPineScripts()
      setPineScripts(list)
      setPineScriptId((id) => (id && list.some((s) => s.id === id) ? id : null))
      // 列表已变（保存 / 删除 / 下拉刷新）：让 Vela 的指标清单缓存失效，
      // 下次重建图表时取到最新脚本；平时图表的实时刷新不会再重复拉这个接口。
      invalidatePineManifest()
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

  /**
   * 实时尾巴（WebSocket）：订阅当前窗口的 (交易所, 品种, 周期)，把推来的最新 bar
   * upsert 进 `chartData.candles`。首屏不再自动跑回测 —— 图表数据由 /api/klines 提供，
   * 回测要么手动点「开始回测」，要么勾选「同步进行回测」。
   */
  const chartKeys = chartData ? `${chartData.exchange}|${chartData.symbol}|${chartData.timeframe}` : ''
  /** 已见过的最后一根 bar 时间戳：WS 推出更晚的时间戳即代表「上一根已收盘」 */
  const lastBarTsRef = useRef(0)
  useEffect(() => {
    if (!REALTIME_WS_ENABLED) return
    if (!chartData) return
    const { exchange: ex, symbol: sym, timeframe: tf } = chartData
    lastBarTsRef.current = chartData.candles[chartData.candles.length - 1]?.timestamp ?? 0
    const stream = openKlineStream({
      onCandles: (push) => {
        if (push.exchange !== ex || push.symbol !== sym || push.timeframe !== tf) return
        const pushMax = push.candles.reduce((m, c) => Math.max(m, c.timestamp), 0)
        setChartData((prev) => {
          if (!prev || prev.symbol !== sym || prev.timeframe !== tf) return prev
          return {
            ...prev,
            candles: upsertCandles(prev.candles, push.candles),
            until: Math.max(prev.until, pushMax),
          }
        })
        if (pushMax > lastBarTsRef.current) {
          lastBarTsRef.current = pushMax
          // 新 bar 收盘：勾选了「同步进行回测」就前移一根窗口重跑（取 K 线 + 回测）
          if (syncBacktestRef.current) window.setTimeout(() => void loadDatasetRef.current(true), 0)
        }
      },
    })
    stream.subscribe({ exchange: ex, symbol: sym, timeframe: tf })
    return () => stream.close()
    // 仅按「交易所|品种|周期」重订阅：蜡烛自身的更新不该导致重连
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartKeys])

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
      /**
       * 去重守卫必须在**同一个键空间**里比较。
       *
       * Vela 回传的是「变量名 → 值」，而 `pineInputs` 存的是「标题 → 值」，
       * 原先直接拿两者比 JSON.stringify 永远不相等 → 守卫形同虚设 →
       * 只要 Vela 派发一次 `indicator:inputs`（重建工作区时也会派发）就会
       * 重写源码 + 重跑回测 + 触发重新编译，进而引发循环。
       * 现在先算出 `titled`，再按「排序后的键值对」比较，并顺带判掉源码未变的空写。
       */
      if (sameInputs(titled, pineInputs) && nextSource === pineSource) return
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
  /** 移动端判定（< 900px）：参数面板走抽屉、图表区独占整屏 */
  const isMobile = useIsMobile()
  /**
   * 宽屏两栏布局（≥ lg / 1200px）。
   *
   * 标签栏吸顶的 `top` 取决于「谁在滚动」：
   *   · 宽屏：右侧结果区自身是滚动容器（overflowY: auto），标签栏贴它顶部即可；
   *   · 窄屏 / 中屏：页面在滚动、顶栏吸在视口顶部，标签栏得贴在顶栏正下方。
   */
  const isWideLayout = useMediaQuery(theme.breakpoints.up('lg'))

  /**
   * 参数面板工厂：桌面端内嵌在左列、移动端放进左侧抽屉，两处控件完全一致
   * （仅「收起」按钮的动作不同 —— 桌面收起成窄轨、移动关闭抽屉）。
   */
  const renderControlPanel = (onCollapse: () => void) => (
    <ControlPanel
      onCollapse={onCollapse}
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
      syncBacktest={syncBacktest}
      onSyncBacktestChange={setSyncBacktest}
      pine={pine}
      onTickSizeChange={setTickSize}
    />
  )

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
          // 用 clip 而不是 hidden：`overflow-x: hidden` 会把 overflow-y 计算成 auto，
          // 根容器因此变成滚动容器，顶部吸顶栏的 sticky 只能相对它生效 —— 它自身不滚动，
          // 结果就是页面一滚顶栏跟着滑出视口。clip 不再创建滚动容器，sticky 才能贴住视口。
          overflowX: 'clip',
          bgcolor: 'background.default',
        }}
      >
        <AppBar
          ref={appBarRef}
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
          <Toolbar
            sx={{
              gap: { xs: 1, sm: 2 },
              flexWrap: 'nowrap',
              py: 0.5,
              px: { xs: 1.5, sm: 2 },
            }}
          >
            <Stack direction="row" alignItems="center" spacing={1.25} sx={{ minWidth: 0, flexShrink: 1 }}>
              <InsightsIcon sx={{ color: 'primary.main', display: { xs: 'none', sm: 'block' } }} />
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="h6" noWrap sx={{ fontSize: { xs: 15, sm: 17 }, lineHeight: 1.2 }}>
                  {strategyTitle}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  sx={{ display: { xs: 'none', sm: 'block' } }}
                >
                  ccxt 公开合约行情 · TypeScript 回测引擎 · Vela 可视化
                </Typography>
              </Box>
            </Stack>
            <Box sx={{ flex: 1 }} />
            <Stack direction="row" spacing={1} alignItems="center">
              {/* 移动端：参数面板入口（抽屉）+ 快捷回测；桌面端这两个按钮让位给信息 Chip */}
              {isMobile && (
                <>
                  <Tooltip title="回测参数 / 行情设置">
                    <IconButton
                      size="small"
                      color="inherit"
                      aria-label="打开回测参数面板"
                      onClick={() => setMobilePanelOpen(true)}
                    >
                      <TuneIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={
                      loading ? <CircularProgress size={14} color="inherit" /> : <PlayArrowIcon fontSize="small" />
                    }
                    disabled={loading}
                    onClick={handleRun}
                  >
                    回测
                  </Button>
                </>
              )}
              <Tooltip title="为合约添加实时价格警报，支持电报机器人与网页通知推送">
                {isMobile ? (
                  // 移动端：与「参数」保持一致的纯图标按钮（给足点击区域，避免空按钮）
                  <IconButton
                    size="small"
                    color="inherit"
                    aria-label="价格警报"
                    onClick={() => setAlertPanelOpen(true)}
                  >
                    <NotificationsActiveIcon fontSize="small" />
                  </IconButton>
                ) : (
                  <Button
                    size="small"
                    variant="outlined"
                    startIcon={<NotificationsActiveIcon />}
                    onClick={() => setAlertPanelOpen(true)}
                  >
                    价格警报
                  </Button>
                )}
              </Tooltip>
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ display: { xs: 'none', sm: 'flex' } }}
                flexWrap="wrap"
                useFlexGap
              >
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
            </Stack>
          </Toolbar>
          {(loading || chartLoading) && <LinearProgress />}
        </AppBar>

        <Box
          sx={{
            flex: { lg: 1 },
            minHeight: 0,
            display: 'flex',
            flexDirection: { xs: 'column', lg: 'row' },
            gap: { xs: 0, lg: 0 },
            px: { xs: 1.5, sm: 2, lg: 3 },
            py: { xs: 1.5, sm: 2 },
          }}
        >
          {/* ---------- 左：参数面板（仅桌面端内嵌可拖拽；移动端见下方 Drawer） ---------- */}
          {!isMobile && (
            <>
              <Box
                sx={{
                  width: panelCollapsed ? PANEL_RAIL_W : panelWidth,
                  flexShrink: 0,
                  minWidth: 0,
                  height: '100%',
                  overflowY: panelCollapsed ? 'hidden' : 'auto',
                  overflowX: 'hidden',
                  transition: resizing ? 'none' : 'width .2s ease',
                }}
              >
                {panelCollapsed && (
                  <Paper
                    sx={{
                      p: 0.5,
                      display: 'flex',
                      flexDirection: 'column',
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
                  {renderControlPanel(() => setPanelCollapsed(true))}
                </Box>
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
            </>
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

              {/* 统计卡片：无回测结果时各卡显示「—」，保持布局稳定。
                  移动端置于图表之后 —— 首屏先看到 K 线，避免十几张统计卡把图表挤出视口 */}
              {!isMobile && <KpiCards report={report ?? null} />}

              <Paper
                sx={{
                  overflow: 'hidden',
                  // 标签栏（K 线与交易 / 收益分析 / 交易分析 / 交易明细 / 回测报告）吸顶：
                  // 滚动长内容时不必再滚回顶部切页签。
                  // zIndex 低于顶栏：窄屏下它吸在顶栏正下方，不能被顶栏压住。
                  position: 'sticky',
                  top: isWideLayout ? 0 : appBarH,
                  zIndex: (t) => t.zIndex.appBar - 1,
                }}
              >
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

              {/* 图表只依赖 K 线数据集，未回测也照常渲染 */}
              {tab === 'chart' && (
                <KLinePanel
                  candles={chartData?.candles ?? []}
                  symbol={chartData?.symbol ?? symbol}
                  timeframe={chartData?.timeframe ?? timeframe}
                  priceTick={tickSize}
                  result={result}
                  loading={chartLoading || loading}
                  showTrades={showTrades}
                  onToggleTrades={setShowTrades}
                  showLevels={showLevels}
                  onToggleLevels={setShowLevels}
                  onSelectTrade={setDetailTrade}
                  onIndicatorInputsChange={applyIndicatorInputs}
                  onRefresh={() => void loadDataset(true)}
                  // 移动端给一个贴合一屏的高度，避免图表把结果区顶得过长
                  height={isMobile ? 360 : undefined}
                />
              )}

              {tab !== 'chart' &&
                (result && report ? (
                  <>
                    {tab === 'equity' && <EquityPanel result={result} />}
                    {tab === 'analysis' && <AnalysisPanel result={result} />}
                    {tab === 'trades' && (
                      <TradesTable
                        result={result}
                        onSelectTrade={setDetailTrade}
                        onReplayTrade={setReplayTrade}
                      />
                    )}
                    {tab === 'report' && <ReportPanel result={result} />}
                  </>
                ) : (
                  !loading && (
                    <Paper sx={{ p: { xs: 3, sm: 6 }, textAlign: 'center' }}>
                      <Typography variant="h6" sx={{ mb: 1 }}>
                        还没有回测结果
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {isMobile
                          ? '点右上角「回测」运行一次，或打开「参数」面板勾选「同步进行回测」。'
                          : '点左侧「开始回测」运行一次，或勾选「同步进行回测」让切换行情设置时自动回测。'}
                      </Typography>
                    </Paper>
                  )
                ))}

              {/* 单笔交易明细：交易明细表点行、K 线图点交易标记都会打开这里 */}
              <TradeDetailDialog trade={detailTrade} onClose={() => setDetailTrade(null)} />

              {/* 单笔交易 K 线回溯：交易明细表每行的「回溯」按钮打开 */}
              <TradeReplayDialog
                open={replayTrade !== null}
                trade={replayTrade}
                result={result}
                onClose={() => setReplayTrade(null)}
              />

              {/* 移动端统计卡片：图表/结果区之后 */}
              {isMobile && <KpiCards report={report ?? null} />}

              {report && (
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
              )}
            </Stack>
          </Box>
        </Box>

        {/* ---------- 移动端：回测参数（左侧抽屉；桌面端为内嵌左列） ---------- */}
        {isMobile && (
          <Drawer
            anchor="left"
            open={mobilePanelOpen}
            onClose={() => setMobilePanelOpen(false)}
            // 常驻挂载：关闭抽屉时保留面板状态，避免每次打开都重新拉取合约列表
            keepMounted
            slotProps={{
              paper: {
                sx: { width: '100%', maxWidth: 480, boxSizing: 'border-box' },
              },
            }}
          >
            {renderControlPanel(() => setMobilePanelOpen(false))}
          </Drawer>
        )}

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
                p: { xs: 1.5, sm: 2 },
                boxSizing: 'border-box',
              },
            },
          }}
        >
          <PineEditor {...pine} onRun={handleRun} loading={loading} />
        </Drawer>

        {/* ---------- 价格警报：管理面板（右侧 Drawer） ---------- */}
        <AlertPanel
          open={alertPanelOpen}
          onClose={() => setAlertPanelOpen(false)}
          defaultExchange={exchange}
          defaultSymbol={symbol}
          defaultTimeframe={timeframe}
        />

        {/* ---------- 页内通知：轮询触发记录并弹 Notification（与面板开关无关） ---------- */}
        <AlertNotifications />
      </Box>
    </ThemeProvider>
  )
}

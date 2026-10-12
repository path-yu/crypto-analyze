import { useCallback, useEffect, useMemo, useState } from 'react'
import Alert from '@mui/material/Alert'
import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Container from '@mui/material/Container'
import CssBaseline from '@mui/material/CssBaseline'
import LinearProgress from '@mui/material/LinearProgress'
import Paper from '@mui/material/Paper'
import Stack from './ui/Stack'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import Toolbar from '@mui/material/Toolbar'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import InsightsIcon from '@mui/icons-material/Insights'
import { ThemeProvider } from '@mui/material/styles'

import type {
  BacktestResult,
  ExchangeId,
  StrategyKind,
  StrategyParams,
  Timeframe,
} from '@shared/types'
import { DEFAULT_STRATEGY_PARAMS, TIMEFRAME_MS } from '@shared/types'
import { buildTheme, UP_COLOR, DOWN_COLOR } from './theme'
import { runBacktest } from './api'
import ControlPanel, { rangeToSince, type RangeKey } from './components/ControlPanel'
import KLinePanel from './components/KLinePanel'
import KpiCards from './components/KpiCards'
import EquityPanel from './components/EquityPanel'
import AnalysisPanel from './components/AnalysisPanel'
import TradesTable from './components/TradesTable'
import ReportPanel from './components/ReportPanel'
import { dateTime, humanizeError, money, num, pct } from './utils/format'

type TabKey = 'chart' | 'equity' | 'analysis' | 'trades' | 'report'

const STRATEGY_LABEL: Record<StrategyKind, string> = {
  'fib-trend': 'Fib Trend',
  supertrend: 'SuperTrend',
  'order-block': 'Volume Order Block',
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
  const [params, setParams] = useState<StrategyParams>({ ...DEFAULT_STRATEGY_PARAMS })
  /** 所选合约的最小变动价位（下单精度），用于滑点换算 */
  const [tickSize, setTickSize] = useState(0)

  const [result, setResult] = useState<BacktestResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>('chart')
  const [showTrades, setShowTrades] = useState(true)
  const [showLevels, setShowLevels] = useState(false)

  const estimatedBars = useMemo(() => {
    const since = rangeToSince(range, customSince)
    const span = Math.max(0, Date.now() - since)
    return Math.floor(span / TIMEFRAME_MS[timeframe])
  }, [range, customSince, timeframe])

  const handleRun = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const since = rangeToSince(range, customSince)
      const data = await runBacktest({
        exchange,
        symbol,
        timeframe,
        since,
        until: Date.now(),
        params,
        tickSize,
      })
      setResult(data)
      setTab('chart')
    } catch (err) {
      setError(humanizeError(err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }, [exchange, symbol, timeframe, range, customSince, params])

  // 首次进入自动跑一次默认回测
  useEffect(() => {
    void handleRun()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const themeMode = 'dark' as const
  const theme = useMemo(() => buildTheme(themeMode), [themeMode])

  const report = result?.report
  const strategyLabel = result ? STRATEGY_LABEL[result.meta.strategy] : ''
  const headline = report
    ? `${strategyLabel} · ${report.symbol} ${report.timeframe} · ${report.leverage}x · ${money(
        report.initialCapital,
        0,
      )} → ${money(report.finalEquity, 0)}`
    : '等待回测'

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
        <AppBar
          position="sticky"
          elevation={0}
          sx={{
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
                  Fibonacci Trend Reversals
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  ccxt 公开合约行情 · TypeScript 回测引擎 · KLineChart 可视化
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

        <Container maxWidth={false} sx={{ py: 2, px: { xs: 2, lg: 3 } }}>
          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: { xs: '1fr', xl: '380px minmax(0, 1fr)' },
              alignItems: 'start',
            }}
          >
            <Box sx={{ position: { xl: 'sticky' }, top: { xl: 84 } }}>
              <ControlPanel
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
                params={params}
                onParamsChange={setParams}
                onRun={handleRun}
                loading={loading}
                estimatedBars={estimatedBars}
                onTickSizeChange={setTickSize}
              />
            </Box>

            <Stack spacing={2} sx={{ minWidth: 0 }}>
              {error && (
                <Alert severity="error" onClose={() => setError(null)}>
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                    {error}
                  </Typography>
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
                    />
                  )}
                  {tab === 'equity' && <EquityPanel result={result!} />}
                  {tab === 'analysis' && <AnalysisPanel result={result!} />}
                  {tab === 'trades' && <TradesTable result={result!} />}
                  {tab === 'report' && <ReportPanel result={result!} />}

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
        </Container>
      </Box>
    </ThemeProvider>
  )
}

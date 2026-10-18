import { useEffect, useMemo, useState } from 'react'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import InputLabel from '@mui/material/InputLabel'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import Stack from '../ui/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ClearIcon from '@mui/icons-material/Clear'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward'
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward'
import SwapVertIcon from '@mui/icons-material/SwapVert'
import CircularProgress from '@mui/material/CircularProgress'

import type { ExchangeId, Instrument, StrategyParams, Timeframe } from '@shared/types'
import { DEFAULT_STRATEGY_PARAMS, EXCHANGES, TIMEFRAMES } from '@shared/types'
import { fetchInstruments } from '../api'
import { DOWN_COLOR, UP_COLOR } from '../theme'
import PineEditor, { type PinePanelState } from './PineEditor'

export type RangeKey = '1m' | '3m' | '6m' | '1y' | '2y' | '3y' | 'custom'

/**
 * 合约下拉的 24h 涨跌幅排序档位。
 *
 * 用「点一下循环一档」的单按钮表达三态，而不是一个开关 + 一个方向按钮：
 * `off` 保留交易所默认顺序（主流币优先 + 字母序），`desc` / `asc` 才按
 * 24h 涨跌幅排序 —— 这样既能切到升序，也不会把原本的默认顺序弄丢。
 */
type ChangeSort = 'off' | 'desc' | 'asc'

const CHANGE_SORT_STEPS: Record<ChangeSort, { hint: string; Icon: typeof SwapVertIcon }> = {
  off: { hint: '按 24 小时涨跌幅排序：未排序（点击切降序）', Icon: SwapVertIcon },
  desc: { hint: '按 24 小时涨跌幅排序：降序（点击切升序）', Icon: ArrowDownwardIcon },
  asc: { hint: '按 24 小时涨跌幅排序：升序（点击恢复默认顺序）', Icon: ArrowUpwardIcon },
}

const RANGE_OPTIONS: { key: RangeKey; label: string; ms?: number }[] = [
  { key: '1m', label: '最近 1 个月', ms: 30 * 86400_000 },
  { key: '3m', label: '最近 3 个月', ms: 90 * 86400_000 },
  { key: '6m', label: '最近 6 个月', ms: 180 * 86400_000 },
  { key: '1y', label: '最近 1 年', ms: 365 * 86400_000 },
  { key: '2y', label: '最近 2 年', ms: 730 * 86400_000 },
  { key: '3y', label: '最近 3 年', ms: 1095 * 86400_000 },
  { key: 'custom', label: '自定义起始日期' },
]

/** 各周期的推荐回测区间，避免 K 线数量爆炸 */
export const RECOMMENDED_RANGE: Record<Timeframe, RangeKey> = {
  '1m': '3m',
  '3m': '3m',
  '5m': '6m',
  '15m': '6m',
  '30m': '1y',
  '1h': '1y',
  '2h': '1y',
  '4h': '3y',
  '6h': '3y',
  '12h': '3y',
  '1d': '3y',
  '3d': '3y',
  '1w': '3y',
}

/** 面板宽度可拖拽（见 App.tsx），表单网格因此按「容器可用宽度自动填充列」排布，
 *  而不是按视口断点——这样面板在 300～640px 的任意宽度下都不会把输入框压扁。 */
const FIELD_GRID = 'repeat(auto-fill, minmax(150px, 1fr))'

export function rangeToSince(key: RangeKey, custom?: string): number {
  if (key === 'custom' && custom) {
    const t = new Date(custom).getTime()
    if (Number.isFinite(t)) return t
  }
  const opt = RANGE_OPTIONS.find((r) => r.key === key)
  const ms = opt?.ms ?? 180 * 86400_000
  return Date.now() - ms
}

/**
 * 结束日期 → 时间戳（当天 23:59:59.999）。
 *
 * 留空 / 非法输入返回 undefined，调用方按「今天（当前时刻）」处理。
 * 与起始日期一样按本地时区解析（界面标注 UTC+8）。
 */
export function rangeToUntil(custom?: string): number | undefined {
  const text = (custom ?? '').trim()
  if (!text) return undefined
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  if (!m) return undefined
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime()
  return Number.isFinite(t) ? t : undefined
}

interface Props {
  exchange: ExchangeId
  onExchangeChange: (v: ExchangeId) => void
  symbol: string
  onSymbolChange: (v: string) => void
  timeframe: Timeframe
  onTimeframeChange: (v: Timeframe) => void
  range: RangeKey
  onRangeChange: (v: RangeKey) => void
  customSince: string
  onCustomSinceChange: (v: string) => void
  /** 自定义结束日期（YYYY-MM-DD）；留空 = 回测到今天 */
  customUntil: string
  onCustomUntilChange: (v: string) => void
  params: StrategyParams
  onParamsChange: (v: StrategyParams) => void
  onRun: () => void
  loading: boolean
  estimatedBars: number
  /**
   * 「同步进行回测」：勾选后，切交易所 / 品种 / 周期 / 区间时会在拉完 K 线后
   * 立即重跑一次回测；关闭（默认）则只更新图表、统计区留空态。
   */
  syncBacktest: boolean
  onSyncBacktestChange: (v: boolean) => void
  /** Pine 面板状态（仅在 strategy === 'pine' 时使用） */
  pine: PinePanelState
  /** 收起面板（宽度收敛为一条窄轨），由外层布局控制实际宽度 */
  onCollapse?: () => void
  /** 所选合约的下单精度（syminfo.mintick），用于把滑点 tick 数换算成价格 */
  onTickSizeChange?: (tickSize: number) => void
}

/** 由合约的下单精度推导最小变动价位：< 1 视为 tick 本身，否则视为小数位数 */
function tickSizeOf(inst: Instrument | null): number {
  const p = inst?.pricePrecision
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return 0
  return p < 1 ? p : Math.pow(10, -Math.round(p))
}

function NumField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  tooltip,
  suffix,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  max?: number
  tooltip?: string
  suffix?: string
}) {
  return (
    <Tooltip title={tooltip ?? ''} placement="top">
      <TextField
        size="small"
        type="number"
        label={label}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(v)
          else if (e.target.value === '') onChange(min ?? 0)
        }}
        slotProps={{
          htmlInput: { step, min, max, style: { fontSize: 13 } },
          inputLabel: { shrink: true },
          input: suffix ? { endAdornment: <Typography variant="caption">{suffix}</Typography> } : undefined,
        }}
        fullWidth
      />
    </Tooltip>
  )
}

export default function ControlPanel({
  exchange,
  onExchangeChange,
  symbol,
  onSymbolChange,
  timeframe,
  onTimeframeChange,
  range,
  onRangeChange,
  customSince,
  onCustomSinceChange,
  customUntil,
  onCustomUntilChange,
  params,
  onParamsChange,
  onRun,
  loading,
  estimatedBars,
  syncBacktest,
  onSyncBacktestChange,
  pine,
  onCollapse,
  onTickSizeChange,
}: Props) {
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [loadingInstruments, setLoadingInstruments] = useState(false)
  const [instrumentError, setInstrumentError] = useState<string | null>(null)
  const [instrumentNote, setInstrumentNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoadingInstruments(true)
    setInstrumentError(null)
    setInstrumentNote(null)
    fetchInstruments(exchange)
      .then((res) => {
        if (cancelled) return
        setInstruments(res.data)
        if (res.fallbackFrom) {
          setInstrumentNote(
            `${res.fallbackFrom} 暂不可用，合约列表已回退到 ${res.exchange}。行情与价格与该交易所保持一致。`,
          )
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // 不回退成一片空白：保留手动输入的 symbol，并给出可读的提示
        setInstrumentError(err instanceof Error ? err.message : '加载合约列表失败')
      })
      .finally(() => {
        if (!cancelled) setLoadingInstruments(false)
      })
    return () => {
      cancelled = true
    }
  }, [exchange])

  const selected = useMemo(
    () => instruments.find((i) => i.symbol === symbol) ?? null,
    [instruments, symbol],
  )

  /** 合约下拉的排序档位（默认保留交易所顺序；另两档按 24h 涨跌幅排） */
  const [changeSort, setChangeSort] = useState<ChangeSort>('off')

  /** 排序后的下拉选项：涨跌幅取不到的排在最后，避免它们混在中间 */
  const sortedInstruments = useMemo(() => {
    if (changeSort === 'off') return instruments
    const dir = changeSort === 'asc' ? 1 : -1
    return [...instruments].sort((a, b) => {
      if (a.change24h === undefined && b.change24h === undefined) return 0
      if (a.change24h === undefined) return 1
      if (b.change24h === undefined) return -1
      return (a.change24h - b.change24h) * dir
    })
  }, [instruments, changeSort])

  const changeSortStep = CHANGE_SORT_STEPS[changeSort]
  const SortIcon = changeSortStep.Icon
  const cycleChangeSort = (): void =>
    setChangeSort((s) => (s === 'off' ? 'desc' : s === 'desc' ? 'asc' : 'off'))

  // 把所选合约的最小变动价位上抛给 App，回测时用于把滑点 tick 换算成价格
  useEffect(() => {
    onTickSizeChange?.(tickSizeOf(selected))
  }, [selected, onTickSizeChange])

  const set = <K extends keyof StrategyParams>(key: K, value: StrategyParams[K]) => {
    onParamsChange({ ...params, [key]: value })
  }

  /** 切换策略：应用只运行已保存的 Pine 脚本，统一套用后端 normalizeParams 对 pine 的强制语义 */
  const changeStrategy = () => {
    // 与后端 normalizeParams 对 pine 的强制语义保持一致，避免界面与行为不符
    onParamsChange({
      ...params,
      strategy: 'pine',
      exitStrategy: 'Zone OCO',
      partialTp: false,
      pyramiding: 1,
    })
  }

  /**
   * 策略下拉的选中值：只可能是某份已保存的 Pine 脚本。
   * 选中已保存脚本 = 切到 Pine 策略 + 载入该脚本（编辑器随即实时编译）。
   */
  const selectStrategy = (value: string) => {
    if (value.startsWith('saved:')) {
      changeStrategy()
      pine.onSelect(value.slice('saved:'.length))
      return
    }
    pine.onSelect(null)
  }

  return (
    <Paper sx={{ p: { xs: 1.5, sm: 2 } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
        <Typography variant="subtitle1" sx={{ fontSize: 15, fontWeight: 700 }}>
          回测参数
        </Typography>
        {onCollapse && (
          <Tooltip title="收起面板">
            <IconButton size="small" onClick={onCollapse} sx={{ mr: -0.5 }}>
              <ChevronLeftIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      <Stack spacing={2}>
        {/* ---------------- 行情设置 ---------------- */}
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1.25 }}>
            行情设置
          </Typography>
          <Box
            sx={{
              display: 'grid',
              gap: 1.5,
              gridTemplateColumns: { xs: '1fr', sm: 'minmax(110px, 1fr) minmax(0, 2.2fr)' },
            }}
          >
            <FormControl size="small" fullWidth>
              <InputLabel shrink>交易所</InputLabel>
              <Select
                label="交易所"
                notched
                value={exchange}
                onChange={(e) => onExchangeChange(e.target.value as ExchangeId)}
              >
                {EXCHANGES.map((e) => (
                  <MenuItem key={e.id} value={e.id}>
                    {e.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <Autocomplete
              size="small"
              fullWidth
              options={sortedInstruments}
              loading={loadingInstruments}
              value={selected}
              getOptionLabel={(o) => (typeof o === 'string' ? o : `${o.label} · ${o.symbol}`)}
              isOptionEqualToValue={(a, b) => a.symbol === b.symbol}
              onChange={(_e, v) => {
                if (!v) return
                onSymbolChange(typeof v === 'string' ? v : v.symbol)
              }}
              /** 每行右侧显示该合约的 24h 涨跌幅（涨红跌绿，取不到时显示 —） */
              renderOption={({ key, ...liProps }, o) => (
                <Box
                  component="li"
                  key={key}
                  {...liProps}
                  sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}
                >
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="body2" noWrap>
                      {o.label}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                      {o.symbol}
                    </Typography>
                  </Box>
                  <Typography
                    variant="body2"
                    sx={{
                      flexShrink: 0,
                      fontWeight: 600,
                      fontVariantNumeric: 'tabular-nums',
                      color:
                        o.change24h === undefined
                          ? 'text.disabled'
                          : o.change24h >= 0
                            ? UP_COLOR
                            : DOWN_COLOR,
                    }}
                  >
                    {o.change24h === undefined
                      ? '—'
                      : `${o.change24h >= 0 ? '+' : ''}${o.change24h.toFixed(2)}%`}
                  </Typography>
                </Box>
              )}
              renderInput={(p) => (
                <TextField
                  {...p}
                  label="合约（USDT 本位永续）"
                  placeholder={loadingInstruments ? '加载中…' : '输入 BTC / ETH 搜索'}
                  helperText={instrumentError ?? instrumentNote ?? undefined}
                  error={Boolean(instrumentError)}
                  color={instrumentNote ? 'info' : undefined}
                  focused={instrumentNote ? true : undefined}
                  slotProps={{
                    ...p.slotProps,
                    input: {
                      ...p.slotProps.input,
                      endAdornment: (
                        <>
                          <InputAdornment position="end">
                            <Tooltip title={changeSortStep.hint}>
                              <IconButton
                                size="small"
                                edge="end"
                                aria-label="按 24 小时涨跌幅排序"
                                // 点排序按钮时不要让事件透回输入框（弹层的开合挂在输入框的
                                // mousedown 上），否则会顺带把下拉展开/收起
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  cycleChangeSort()
                                }}
                              >
                                <SortIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </InputAdornment>
                          {p.slotProps.input.endAdornment}
                        </>
                      ),
                    },
                  }}
                />
              )}
            />
            {instrumentNote && (
              <Alert severity="info" sx={{ gridColumn: '1 / -1' }} onClose={() => setInstrumentNote(null)}>
                {instrumentNote}
              </Alert>
            )}

            <FormControl size="small" fullWidth>
              <InputLabel shrink>K 线周期</InputLabel>
              <Select
                label="K 线周期"
                notched
                value={timeframe}
                onChange={(e) => {
                  const tf = e.target.value as Timeframe
                  onTimeframeChange(tf)
                  onRangeChange(RECOMMENDED_RANGE[tf])
                }}
              >
                {TIMEFRAMES.map((tf) => (
                  <MenuItem key={tf} value={tf}>
                    {tf}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" fullWidth>
              <InputLabel shrink>回测区间</InputLabel>
              <Select
                label="回测区间"
                notched
                value={range}
                onChange={(e) => onRangeChange(e.target.value as RangeKey)}
              >
                {RANGE_OPTIONS.map((r) => (
                  <MenuItem key={r.key} value={r.key}>
                    {r.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          {range === 'custom' && (
            <TextField
              sx={{ mt: 1.5, maxWidth: 260 }}
              size="small"
              type="date"
              label="起始日期（UTC+8）"
              value={customSince}
              onChange={(e) => onCustomSinceChange(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
            />
          )}

          <TextField
            sx={{ mt: 1.5, maxWidth: 260, display: 'block' }}
            size="small"
            type="date"
            label="结束日期（留空 = 今天）"
            value={customUntil}
            onChange={(e) => onCustomUntilChange(e.target.value)}
            slotProps={{
              inputLabel: { shrink: true },
              input: customUntil
                ? {
                    endAdornment: (
                      <InputAdornment position="end">
                        <Tooltip title="清空则回测到当前时刻（今天）">
                          <IconButton size="small" onClick={() => onCustomUntilChange('')}>
                            <ClearIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </InputAdornment>
                    ),
                  }
                : undefined,
            }}
            helperText="按该日 23:59（UTC+8）收盘；留空即回测到今天"
          />

          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} alignItems="center" flexWrap="wrap" useFlexGap>
            <Tooltip title="按「起始 → 结束」区间估算。若起始早于该合约上市时间，实际会从上市日起算，根数会少于这里">
              <Chip size="small" label={`预计约 ${estimatedBars.toLocaleString()} 根 K 线`} />
            </Tooltip>
            {estimatedBars > 40000 && (
              <Chip size="small" color="warning" label="数据量较大，拉取与计算会偏慢" />
            )}
            {selected?.maxLeverage && (
              <Chip size="small" variant="outlined" label={`该合约最大杠杆 ${selected.maxLeverage}x`} />
            )}
          </Stack>

          <FormControlLabel
            sx={{ mt: 1, display: 'flex', alignItems: 'flex-start' }}
            control={
              <Switch
                size="small"
                sx={{ mt: -0.25 }}
                checked={syncBacktest}
                onChange={(e) => onSyncBacktestChange(e.target.checked)}
              />
            }
            label={
              <Tooltip
                title={
                  '勾选后：切换交易所 / 合约 / 周期 / 区间时，拉完 K 线会立即重跑一次回测（统计区同步更新）。\n' +
                  '关闭时（默认）：只刷新图表，统计区留空态，需要时再点「开始回测」。\n' +
                  '注意实时行情下每根新 K 线收盘也会自动重跑一次，短周期 + 长区间会明显变慢。'
                }
              >
                <Typography variant="caption">同步进行回测（切换行情设置时自动回测）</Typography>
              </Tooltip>
            }
          />
        </Box>

        <Divider />

        {/* ---------------- 资金与杠杆 ---------------- */}
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1.25 }}>
            资金与杠杆
          </Typography>
          <Box
            sx={{
              display: 'grid',
              gap: 1.5,
              gridTemplateColumns: FIELD_GRID,
            }}
          >
            <NumField
              label="初始资金"
              value={params.initialCapital}
              step={100}
              min={10}
              suffix="USDT"
              onChange={(v) => set('initialCapital', v)}
            />
            <NumField
              label="杠杆倍数"
              value={params.leverage}
              step={1}
              min={1}
              max={125}
              suffix="x"
              tooltip="名义价值 = 保证金 × 杠杆；杠杆越高，同等价格波动下的盈亏放大越多，也越容易触及强平。（Pine 脚本默认由脚本内 qty 定仓位，此处不生效，见下方开关）"
              onChange={(v) => set('leverage', Math.round(v))}
            />
            <NumField
              label="仓位比例"
              value={params.positionSizePercent}
              step={5}
              min={1}
              max={100}
              suffix="%"
              tooltip="每次开仓使用的保证金占当前权益的百分比。（Pine 脚本默认由脚本内 qty 定仓位，此处不生效，见下方开关）"
              onChange={(v) => set('positionSizePercent', v)}
            />
            <NumField
              label="单边手续费"
              value={params.commissionPercent}
              step={0.005}
              min={0}
              max={2}
              suffix="%"
              tooltip="Pine 脚本 commission_value = 0.055，即单边 0.055%，双边合计约 0.11%"
              onChange={(v) => set('commissionPercent', v)}
            />
          </Box>
          <FormControlLabel
            sx={{ mt: 1 }}
            control={
              <Switch
                size="small"
                checked={params.checkLiquidation}
                onChange={(e) => set('checkLiquidation', e.target.checked)}
              />
            }
            label={
              <Tooltip title="按逐仓 1/杠杆 的价格波动估算强平价；关闭则假设永不爆仓">
                <Typography variant="caption">启用强平检查</Typography>
              </Tooltip>
            }
          />
          {/* Pine 脚本专属：脚本给了 qty 时，由谁决定仓位 */}
          <FormControlLabel
            sx={{ mt: 0.5, display: 'flex', alignItems: 'flex-start' }}
            control={
              <Switch
                size="small"
                sx={{ mt: -0.25 }}
                checked={params.useScriptPositionSize}
                onChange={(e) => set('useScriptPositionSize', e.target.checked)}
              />
            }
            label={
              <Tooltip
                title={
                  '开启（TradingView 口径）：名义价值 = 脚本 strategy.entry(qty=…) × 价格，' +
                  '「杠杆 / 仓位比例」不参与定仓（杠杆只影响保证金与「收益率」列的分母）。\n' +
                  '关闭（引擎口径）：忽略脚本 qty，名义价值 = 权益 × 仓位比例 × 杠杆 —— ' +
                  '例如 1000 本金 / 仓位 100% / 杠杆 10 得名义价值 10000。'
                }
              >
                <Typography variant="caption">仓位由脚本 qty 决定（TradingView 口径）</Typography>
              </Tooltip>
            }
          />
        </Box>

        <Divider />

        {/* ---------------- 策略参数 ---------------- */}
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1.25 }}>
            策略参数
          </Typography>

          <FormControl size="small" fullWidth sx={{ mb: 1.5 }}>
            <InputLabel shrink>策略</InputLabel>
            <Select
              label="策略"
              notched
              value={pine.selectedId ? `saved:${pine.selectedId}` : ''}
              onChange={(e) => selectStrategy(e.target.value)}
              // 打开下拉时重新拉一次已保存脚本：应用之外新增的脚本目录（IDE / git pull）也能立刻看到
              onOpen={() => void pine.onRefresh()}
            >
              {pine.scripts.map((s) => (
                <MenuItem key={s.id} value={`saved:${s.id}`}>
                  已保存 · {s.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
              Pine 脚本：由 PineTS 在服务端一次跑完脚本，读取 strategy.entry / strategy.exit 的券商账本，
              折算成引擎逐根消费的信号；引擎在信号 bar 的下一根开盘成交。脚本自带的手续费 / 滑点被丢弃，
              由上方「资金与杠杆」参数统一决定。
            </Typography>
            {/* 放大编辑时编辑器整个搬到右侧 Drawer，面板内留一行提示，避免同时挂载两个编辑器 */}
            {pine.drawerOpen ? (
              <Alert severity="info" sx={{ py: 0 }}>
                <Typography variant="caption">
                  编辑器已在右侧弹窗中打开；关闭弹窗后回到此处编辑。
                </Typography>
              </Alert>
            ) : (
              <PineEditor {...pine} onRun={onRun} loading={loading} />
            )}
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, display: 'block' }}>
              脚本声明的固定语义（离场/仓位/方向）由引擎统一撮合，上方「资金与杠杆」通用参数继续生效。
            </Typography>
          </>
        </Box>

        <Divider />

        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap sx={{ minWidth: 0 }}>
          <Button
            variant="contained"
            size="large"
            startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <PlayArrowIcon />}
            disabled={loading}
            onClick={onRun}
            sx={{ flex: 1 }}
          >
            {loading ? '回测中…' : '开始回测'}
          </Button>
          <Button
            variant="outlined"
            startIcon={<RestartAltIcon />}
            disabled={loading}
            onClick={() => onParamsChange({ ...DEFAULT_STRATEGY_PARAMS })}
          >
            恢复默认参数
          </Button>
        </Stack>

        <Accordion disableGutters elevation={0} sx={{ bgcolor: 'transparent', '&:before': { display: 'none' } }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 32 }}>
            <Typography variant="caption" color="text.secondary">
              策略说明与实现细节
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 0 }}>
            <Typography variant="caption" color="text.secondary" component="div" sx={{ lineHeight: 1.9 }}>
              <>
                · <b>执行</b>：由 PineTS 在服务端一次跑完整个脚本（批量，无逐 bar 回调），
                读取 strategy.entry / strategy.exit 留下的券商账本。
                <br />
                · <b>信号</b>：账本折算成引擎逐根消费的信号 —— 开仓 → canLong / canShort（方向取 sign(size)），
                strategy.close / strategy.close_all → 下一根开盘市价平仓。
                <br />
                · <b>撮合</b>：引擎在信号 bar 的**下一根开盘**成交（PineTS 在 fill bar 成交，信号 bar 比它早 1 根）。
                <br />
                · <b>手续费与滑点</b>：脚本自带的手续费 / 滑点被丢弃，由本项目的「资金与杠杆」参数统一决定。
                <br />
                · <b>未计入</b>：资金费率与流动性冲击，实盘表现通常弱于回测。
              </>
            </Typography>
          </AccordionDetails>
        </Accordion>
      </Stack>
    </Paper>
  )
}

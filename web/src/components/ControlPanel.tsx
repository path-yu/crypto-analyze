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
import CircularProgress from '@mui/material/CircularProgress'

import type { ExchangeId, Instrument, StrategyKind, StrategyParams, Timeframe } from '@shared/types'
import { DEFAULT_STRATEGY_PARAMS, EXCHANGES, TIMEFRAMES } from '@shared/types'
import { fetchInstruments } from '../api'
import PineEditor, { type PinePanelState } from './PineEditor'

export type RangeKey = '1m' | '3m' | '6m' | '1y' | '2y' | '3y' | 'custom'

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
const TOGGLE_GRID = 'repeat(auto-fill, minmax(160px, 1fr))'

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

  // 把所选合约的最小变动价位上抛给 App，回测时用于把滑点 tick 换算成价格
  useEffect(() => {
    onTickSizeChange?.(tickSizeOf(selected))
  }, [selected, onTickSizeChange])

  const set = <K extends keyof StrategyParams>(key: K, value: StrategyParams[K]) => {
    onParamsChange({ ...params, [key]: value })
  }

  /** 数字输入：空串或非法值回落到 fallback，合法值夹到 [lo, hi] 的整数 */
  const clampNum = (raw: string, lo: number, hi: number, fallback: number): number => {
    const v = Number(raw)
    if (!Number.isFinite(v)) return fallback
    return Math.min(hi, Math.max(lo, Math.round(v)))
  }

  const isATR = params.exitStrategy === 'ATR'
  const isFixed = params.exitStrategy === 'Fixed Percent'

  /** 切换策略：订单块策略按原 Pine 的 strategy() 声明同步资金/费用/仓位默认值 */
  const changeStrategy = (next: StrategyKind) => {
    const patch: StrategyParams = { ...params, strategy: next }
    if (next === 'order-block') {
      // strategy(...) 声明：initial_capital=10000, commission 0.05%,
      // default_qty = 10% of equity（= 仓位 10% × 1x）, slippage = 2 tick, pyramiding = 0
      patch.initialCapital = 10000
      patch.commissionPercent = 0.05
      patch.positionSizePercent = 10
      patch.leverage = 1
      patch.slippageTicks = 2
    } else if (next === 'pine') {
      // 与后端 normalizeParams 对 pine 的强制语义保持一致，避免界面与行为不符
      patch.exitStrategy = 'Zone OCO'
      patch.partialTp = false
      patch.pyramiding = 1
    } else if (next === 'supertrend') {
      patch.slippageTicks = 0
    } else {
      patch.slippageTicks = 0
    }
    onParamsChange(patch)
  }

  /**
   * 策略下拉的选中值：既可能是内置策略，也可能是某份已保存的 Pine 脚本。
   * 选中已保存脚本 = 切到 Pine 策略 + 载入该脚本（编辑器随即实时编译）。
   */
  const selectStrategy = (value: string) => {
    if (value.startsWith('saved:')) {
      changeStrategy('pine')
      pine.onSelect(value.slice('saved:'.length))
      return
    }
    pine.onSelect(null)
    changeStrategy(value as StrategyKind)
  }

  /** 订单块数值输入 */
  const obNum = (
    key: keyof StrategyParams['orderBlock'],
    label: string,
    opts: {
      step?: number
      min?: number
      max?: number
      suffix?: string
      tooltip?: string
      integer?: boolean
    } = {},
  ) => (
    <NumField
      key={String(key)}
      label={label}
      value={Number(params.orderBlock[key])}
      step={opts.step ?? 1}
      min={opts.min ?? 0}
      max={opts.max ?? 10_000}
      suffix={opts.suffix}
      tooltip={opts.tooltip}
      onChange={(v) =>
        onParamsChange({
          ...params,
          orderBlock: {
            ...params.orderBlock,
            [key]: opts.integer === false ? v : Math.round(v),
          },
        })
      }
    />
  )

  /** 订单块开关 */
  const obBool = (key: keyof StrategyParams['orderBlock'], label: string, tooltip?: string) => (
    <FormControlLabel
      key={String(key)}
      control={
        <Switch
          size="small"
          checked={Boolean(params.orderBlock[key])}
          onChange={(e) =>
            onParamsChange({
              ...params,
              orderBlock: { ...params.orderBlock, [key]: e.target.checked },
            })
          }
        />
      }
      label={
        <Tooltip title={tooltip ?? ''}>
          <Typography variant="caption">{label}</Typography>
        </Tooltip>
      }
    />
  )

  return (
    <Paper sx={{ p: 2 }}>
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
              options={instruments}
              loading={loadingInstruments}
              value={selected}
              getOptionLabel={(o) => (typeof o === 'string' ? o : `${o.label} · ${o.symbol}`)}
              isOptionEqualToValue={(a, b) => a.symbol === b.symbol}
              onChange={(_e, v) => {
                if (!v) return
                onSymbolChange(typeof v === 'string' ? v : v.symbol)
              }}
              renderInput={(p) => (
                <TextField
                  {...p}
                  label="合约（USDT 本位永续）"
                  placeholder={loadingInstruments ? '加载中…' : '输入 BTC / ETH 搜索'}
                  helperText={instrumentError ?? instrumentNote ?? undefined}
                  error={Boolean(instrumentError)}
                  color={instrumentNote ? 'info' : undefined}
                  focused={instrumentNote ? true : undefined}
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
              tooltip="名义价值 = 保证金 × 杠杆；杠杆越高，同等价格波动下的盈亏放大越多，也越容易触及强平"
              onChange={(v) => set('leverage', Math.round(v))}
            />
            <NumField
              label="仓位比例"
              value={params.positionSizePercent}
              step={5}
              min={1}
              max={100}
              suffix="%"
              tooltip="每次开仓使用的保证金占当前权益的百分比"
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
              value={pine.selectedId ? `saved:${pine.selectedId}` : params.strategy}
              onChange={(e) => selectStrategy(e.target.value)}
            >
              <MenuItem value="fib-trend">Fibonacci Trend Reversals（IMBA + TSOT）</MenuItem>
              <MenuItem value="supertrend">SuperTrend（KivancOzbilgic）</MenuItem>
              <MenuItem value="order-block">Volume Order Block Retest（订单块回踩）</MenuItem>
              <MenuItem value="pine">Pine 脚本（实时编译）</MenuItem>
              {pine.scripts.length > 0 && <Divider sx={{ my: 0.5 }} />}
              {pine.scripts.map((s) => (
                <MenuItem key={s.id} value={`saved:${s.id}`}>
                  已保存 · {s.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {params.strategy === 'fib-trend' ? (
            <>
              <Box
                sx={{
                  display: 'grid',
                  gap: 1.5,
                  gridTemplateColumns: FIELD_GRID,
                }}
              >
                <NumField
                  label="Sensitivity 敏感度"
                  value={params.sensitivity}
                  step={1}
                  min={1}
                  max={200}
                  tooltip="Pine 中该值会 ×10 作为 highest/lowest 的窗口长度。默认 18 → 180 根 K 线构成斐波那契通道"
                  onChange={(v) => set('sensitivity', v)}
                />
                <NumField
                  label="ATR 长度"
                  value={params.atrLength}
                  step={1}
                  min={1}
                  max={500}
                  onChange={(v) => set('atrLength', Math.round(v))}
                />
                <FormControl size="small" fullWidth>
                  <InputLabel shrink>ATR 平滑方式</InputLabel>
                  <Select
                    label="ATR 平滑方式"
                    notched
                    value={params.atrSmoothing}
                    onChange={(e) => set('atrSmoothing', e.target.value as StrategyParams['atrSmoothing'])}
                  >
                    {['RMA', 'SMA', 'EMA', 'WMA'].map((s) => (
                      <MenuItem key={s} value={s}>
                        {s}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <NumField
                  label="ATR 止损倍数"
                  value={params.atrMultiplier}
                  step={0.1}
                  min={0.1}
                  max={50}
                  suffix="×ATR"
                  onChange={(v) => set('atrMultiplier', v)}
                />
              </Box>

              <Box
                sx={{
                  display: 'grid',
                  gap: 1.5,
                  mt: 1.5,
                  gridTemplateColumns: FIELD_GRID,
                }}
              >
                <FormControl size="small" fullWidth>
                  <InputLabel shrink>交易方向</InputLabel>
                  <Select
                    label="交易方向"
                    notched
                    value={params.tradeDirection}
                    onChange={(e) => set('tradeDirection', e.target.value as StrategyParams['tradeDirection'])}
                  >
                    <MenuItem value="Both">双向（多 + 空）</MenuItem>
                    <MenuItem value="Long Only">仅做多</MenuItem>
                    <MenuItem value="Short Only">仅做空</MenuItem>
                  </Select>
                </FormControl>

                <FormControl size="small" fullWidth>
                  <InputLabel shrink>止损模式</InputLabel>
                  <Select
                    label="止损模式"
                    notched
                    value={params.exitStrategy}
                    onChange={(e) => set('exitStrategy', e.target.value as StrategyParams['exitStrategy'])}
                  >
                    <MenuItem value="ATR">ATR 动态止损</MenuItem>
                    <MenuItem value="Fixed Percent">固定百分比止损</MenuItem>
                    <MenuItem value="Trend Switch">趋势反转离场（无止损）</MenuItem>
                  </Select>
                </FormControl>

                <NumField
                  label="固定止损百分比"
                  value={params.slPercent}
                  step={0.1}
                  min={0.05}
                  max={50}
                  suffix="%"
                  tooltip="仅当止损模式为「固定百分比止损」时生效"
                  onChange={(v) => set('slPercent', v)}
                />

                <NumField
                  label="盈亏比 (Risk/Reward)"
                  value={params.riskRewardRatio}
                  step={0.1}
                  min={0.1}
                  max={50}
                  tooltip="TP1 = 入场 + 盈亏比×风险/2，TP2 = 入场 + 盈亏比×风险"
                  onChange={(v) => set('riskRewardRatio', v)}
                />
              </Box>

              <Stack direction="row" spacing={3} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={params.partialTp}
                      onChange={(e) => set('partialTp', e.target.checked)}
                    />
                  }
                  label={
                    <Tooltip title="开启后：TP1 平掉 50% 并移动止损到保本，TP2 平掉剩余 50%">
                      <Typography variant="caption">分批止盈（TP1 平 50%）</Typography>
                    </Tooltip>
                  }
                />
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={params.allowReversePosition}
                      onChange={(e) => set('allowReversePosition', e.target.checked)}
                    />
                  }
                  label={
                    <Tooltip title="持有多单时出现做空信号（或反之）立即平仓反手">
                      <Typography variant="caption">允许反手</Typography>
                    </Tooltip>
                  }
                />
              </Stack>

              {(isATR || isFixed) && (
                <Box sx={{ mt: 2 }}>
                  <TextField
                    label="金字塔式加仓上限（订单数）"
                    type="number"
                    size="small"
                    fullWidth
                    value={params.pyramiding}
                    onChange={(e) => set('pyramiding', clampNum(e.target.value, 0, 20, 1))}
                    slotProps={{
                      htmlInput: { min: 0, max: 20, step: 1 },
                      input: {
                        endAdornment: (
                          <Tooltip title="对应 TradingView 策略属性里的「金字塔式 N 订单」。持仓期间再出现同向信号时允许继续加仓，总订单数不超过该值；填 0 表示不限制。填 1 即完全不加仓。">
                            <InputAdornment position="end">
                              <Typography variant="caption" color="text.secondary">
                                ?
                              </Typography>
                            </InputAdornment>
                          </Tooltip>
                        ),
                      },
                    }}
                    helperText="TradingView 图表上同一根 K 线出现多笔同向开仓，就是这里的值大于 1。"
                  />
                </Box>
              )}

              {(isATR || isFixed) && !params.partialTp && (
                <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                  当前为整仓离场模式：价格触及 TP2 或止损时一次性平掉全部仓位。
                </Typography>
              )}
            </>
          ) : params.strategy === 'order-block' ? (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                Volume Order Block Retest：用「放量脉冲 K 线 + 其前一根 K 线区间」标记订单块，
                价格回踩区域时顺势入场；止损放在区域外侧，止盈按固定盈亏比，可选保本移动与时间止损。
                参数与原 Pine v6 脚本逐条对应，成交时点同样按「信号下一根开盘」。
              </Typography>

              <Typography variant="caption" sx={{ display: 'block', mb: 0.75, fontWeight: 600 }}>
                订单块检测
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gap: 1.5,
                  gridTemplateColumns: FIELD_GRID,
                }}
              >
                {obNum('atrLen', 'ATR 周期', {
                  min: 1,
                  max: 500,
                  tooltip: 'Pine: ATR length（默认 14）',
                })}
                {obNum('dispMult', '脉冲实体 ≥', {
                  step: 0.1,
                  min: 0.1,
                  max: 50,
                  suffix: '×ATR',
                  integer: false,
                  tooltip: 'Pine: Displacement body ≥ ATR ×（默认 0.8）',
                })}
                {obNum('volLen', '量能 SMA 周期', { min: 1, max: 500, tooltip: 'Pine: Volume SMA length（默认 20）' })}
                {obNum('impVolMult', '脉冲量能 ≥', {
                  step: 0.1,
                  min: 0,
                  max: 50,
                  suffix: '×SMA',
                  integer: false,
                  tooltip: 'Pine: Impulse volume ≥ SMA ×（默认 1.0）',
                })}
                {obNum('maxZones', '最大存活区域', { min: 1, max: 40, suffix: '个', tooltip: 'Pine: Max active zones（默认 15）' })}
                {obNum('maxAge', '区域存活上限', { min: 10, max: 100_000, suffix: '根', tooltip: 'Pine: Max zone age (bars)（默认 300）' })}
              </Box>
              <Box
                sx={{
                  display: 'grid',
                  gap: 0.5,
                  mt: 1,
                  gridTemplateColumns: TOGGLE_GRID,
                }}
              >
                {obBool('needOpp', '要求脉冲前反向 K 线', 'Pine: Require opposite-colour candle before impulse')}
                {obBool('needBreak', '要求脉冲突破前一根区间', 'Pine: Require impulse close beyond prior candle range')}
                {obBool('bodyZone', '区域取实体（否则取高低点）', 'Pine: Use candle body only for zone')}
              </Box>

              <Typography variant="caption" sx={{ display: 'block', mt: 2, mb: 0.75, fontWeight: 600 }}>
                入场过滤
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gap: 1.5,
                  gridTemplateColumns: FIELD_GRID,
                }}
              >
                {obNum('emaLen', 'EMA 周期', { min: 2, max: 2000, tooltip: 'Pine: EMA length（默认 100）' })}
                {obNum('wickPct', '最小影线占比', {
                  min: 5,
                  max: 95,
                  suffix: '%',
                  tooltip: 'Pine: Min wick % of range（默认 25）',
                })}
                {obNum('retestVolMax', '回踩量能 ≤', {
                  step: 0.05,
                  min: 0.1,
                  max: 50,
                  suffix: '×脉冲',
                  integer: false,
                  tooltip: 'Pine: Retest volume ≤ impulse volume ×（默认 1.0）',
                })}
              </Box>
              <Box
                sx={{
                  display: 'grid',
                  gap: 0.5,
                  mt: 1,
                  gridTemplateColumns: TOGGLE_GRID,
                }}
              >
                {obBool('firstTouch', '每个区域只成交一次', 'Pine: Each zone trades once')}
                {obBool('needCandle', '要求顺势 K 线', 'Pine: Require candle in trade direction')}
                {obBool('useRejection', '要求拒绝影线', 'Pine: Require rejection wick')}
                {obBool('useRetestVol', '要求回踩缩量', 'Pine: Require volume dry-up on retest')}
                {obBool('useTrend', 'EMA 趋势过滤', 'Pine: EMA trend filter')}
                {obBool('allowLong', '允许做多', 'Pine: Allow longs')}
                {obBool('allowShort', '允许做空', 'Pine: Allow shorts')}
              </Box>

              <Typography variant="caption" sx={{ display: 'block', mt: 2, mb: 0.75, fontWeight: 600 }}>
                风险控制
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gap: 1.5,
                  gridTemplateColumns: FIELD_GRID,
                }}
              >
                {obNum('slBuf', '止损缓冲', {
                  step: 0.05,
                  min: 0,
                  max: 50,
                  suffix: '×ATR',
                  integer: false,
                  tooltip: 'Pine: SL buffer beyond zone（默认 0.2）：止损放在区域外侧 ATR×该值 处',
                })}
                {obNum('rrTarget', '止盈目标', {
                  step: 0.1,
                  min: 0.2,
                  max: 50,
                  suffix: 'R',
                  integer: false,
                  tooltip: 'Pine: Take profit (R multiple)（默认 1.5）',
                })}
                {obNum('beAtR', '保本触发', {
                  step: 0.1,
                  min: 0.2,
                  max: 50,
                  suffix: 'R',
                  integer: false,
                  tooltip: 'Pine: Break-even trigger (R)（默认 1.0）：浮盈达到该 R 倍数后把止损移到开仓价',
                })}
                {obNum('maxBars', '时间止损', {
                  min: 0,
                  max: 100_000,
                  suffix: '根',
                  tooltip: 'Pine: Time stop (bars)（默认 60，0 = 关闭）：持仓超过该根数后下一根开盘市价平仓',
                })}
                <TextField
                  label="滑点"
                  type="number"
                  size="small"
                  fullWidth
                  value={params.slippageTicks}
                  onChange={(e) => set('slippageTicks', clampNum(e.target.value, 0, 200, 0))}
                  slotProps={{
                    htmlInput: { min: 0, max: 200, step: 1 },
                    input: {
                      endAdornment: (
                        <Tooltip title="Pine: slippage = 2（单位 tick，按所选合约最小变动价位换算成价格）。市价单与止损单按劣势方向成交，止盈限价单不受影响">
                          <InputAdornment position="end">
                            <Typography variant="caption" color="text.secondary">
                              tick
                            </Typography>
                          </InputAdornment>
                        </Tooltip>
                      ),
                    },
                  }}
                />
              </Box>
              <Box
                sx={{
                  display: 'grid',
                  gap: 0.5,
                  mt: 1,
                  gridTemplateColumns: TOGGLE_GRID,
                }}
              >
                {obBool('useBE', '保本移动止损', 'Pine: Move stop to break-even')}
              </Box>

              <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, display: 'block' }}>
                原脚本声明的固定语义：初始资金 10,000、手续费单边 0.05%、下单量为权益的 10%（1 倍杠杆）、
                滑点 2 tick、同时只持有一仓（不加仓、无分批止盈），离场为「区域止损 / 固定盈亏比目标 / 保本 / 时间止损」。
                切换策略时已自动套用，可在上方「资金与杠杆」处覆盖。
              </Typography>
            </>
          ) : params.strategy === 'pine' ? (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                Pine 脚本：源码在后端实时编译为 TypeScript 并在沙箱中执行，逐根 K 线产出信号。
                strategy() 脚本用 strategy.entry / strategy.exit 驱动；indicator() 脚本用 plotshape
                的方向判定多空、以标题含 sl/stop 的 plot 作为离场止损。
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
          ) : (
            <>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                SuperTrend 策略为纯趋势策略：趋势翻多即做多，翻空即做空并在同一根 K 线上反手。
                原版脚本无固定止损/止盈，由趋势反转触发离场。
              </Typography>

              <Box
                sx={{
                  display: 'grid',
                  gap: 1.5,
                  gridTemplateColumns: FIELD_GRID,
                }}
              >
                <NumField
                  label="ATR 周期"
                  value={params.supertrend.atrPeriod}
                  step={1}
                  min={1}
                  max={500}
                  tooltip="Pine input 'ATR Period'，用于计算波动幅度"
                  onChange={(v) =>
                    onParamsChange({
                      ...params,
                      supertrend: { ...params.supertrend, atrPeriod: Math.max(1, Math.round(v)) },
                    })
                  }
                />
                <NumField
                  label="ATR 乘数"
                  value={params.supertrend.multiplier}
                  step={0.1}
                  min={0.1}
                  max={50}
                  suffix="×ATR"
                  tooltip="Pine input 'ATR Multiplier'，越大趋势越不容易翻转"
                  onChange={(v) =>
                    onParamsChange({
                      ...params,
                      supertrend: { ...params.supertrend, multiplier: v },
                    })
                  }
                />
                <FormControl size="small" fullWidth>
                  <InputLabel shrink>价格源</InputLabel>
                  <Select
                    label="价格源"
                    notched
                    value={params.supertrend.source}
                    onChange={(e) =>
                      onParamsChange({
                        ...params,
                        supertrend: {
                          ...params.supertrend,
                          source: e.target.value as StrategyParams['supertrend']['source'],
                        },
                      })
                    }
                  >
                    <MenuItem value="hl2">hl2（默认）</MenuItem>
                    <MenuItem value="close">close</MenuItem>
                    <MenuItem value="open">open</MenuItem>
                    <MenuItem value="high">high</MenuItem>
                    <MenuItem value="low">low</MenuItem>
                  </Select>
                </FormControl>
                <FormControl size="small" fullWidth>
                  <InputLabel shrink>ATR 算法</InputLabel>
                  <Select
                    label="ATR 算法"
                    notched
                    value={params.supertrend.useSmaAtr ? 'SMA' : 'RMA'}
                    onChange={(e) =>
                      onParamsChange({
                        ...params,
                        supertrend: { ...params.supertrend, useSmaAtr: e.target.value === 'SMA' },
                      })
                    }
                  >
                    <MenuItem value="RMA">RMA（Wilder，原版默认）</MenuItem>
                    <MenuItem value="SMA">SMA（changeATR 切换）</MenuItem>
                  </Select>
                </FormControl>
              </Box>

              <Box
                sx={{
                  display: 'grid',
                  gap: 1.5,
                  mt: 1.5,
                  gridTemplateColumns: FIELD_GRID,
                }}
              >
                <FormControl size="small" fullWidth>
                  <InputLabel shrink>交易方向</InputLabel>
                  <Select
                    label="交易方向"
                    notched
                    value={params.tradeDirection}
                    onChange={(e) => set('tradeDirection', e.target.value as StrategyParams['tradeDirection'])}
                  >
                    <MenuItem value="Both">双向（多 + 空）</MenuItem>
                    <MenuItem value="Long Only">仅做多</MenuItem>
                    <MenuItem value="Short Only">仅做空</MenuItem>
                  </Select>
                </FormControl>
              </Box>

              <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5, display: 'block' }}>
                资金与杠杆、佣金与强平检查等通用参数继续生效；止损/止盈/分批/加仓相关项在 SuperTrend
                下无意义，已隐藏。
              </Typography>
            </>
          )}
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
              {params.strategy === 'supertrend' ? (
                <>
                  · <b>信号</b>：基于 ATR 动态上下轨。up = src − Multiplier×ATR（多头支撑线），
                  dn = src + Multiplier×ATR（空头阻力线）。收盘价跌破上一根 up → 翻空做空；
                  收盘价升破上一根 dn → 翻多做多。
                  <br />
                  · <b>上下轨约束</b>：up 只能上移（max(本次 up, 上次 up)）、dn 只能下移
                  （min(本次 dn, 上次 dn)），避免小幅来回穿越造成虚假翻向。
                  <br />
                  · <b>离场</b>：原脚本无 strategy.exit，仅由反向信号（趋势翻向）平旧仓并反手。
                  本引擎以「趋势反转离场」语义复刻。
                  <br />
                  · <b>撮合</b>：开平仓按信号 K 线收盘价成交；同一根 K 线上同时出现翻多/翻空时，
                  实际只会按收盘那一刻的最终方向入场。
                  <br />
                  · <b>手续费</b>：开仓与每笔平仓均按名义价值收取，默认单边 0.055%。
                  <br />
                  · <b>未计入</b>：资金费率、滑点与流动性冲击，实盘表现通常弱于回测。
                </>
              ) : params.strategy === 'order-block' ? (
                <>
                  · <b>订单块</b>：放量脉冲 K 线（实体 ≥ ATR×0.8 且成交量 ≥ 20 根均量）出现时，
                  把它的**前一根** K 线的最高/最低（可选实体）标记为同向区域；同向已被覆盖的区域不重复创建，
                  超过 maxZones 个时丢弃最旧的一个。
                  <br />
                  · <b>回踩入场</b>：价格再次触及区域（high ≥ 区域下沿且 low ≤ 区域上沿）时，
                  按过滤器（顺势 K 线、拒绝影线、回踩缩量、EMA 趋势）判定；每个区域默认只成交一次。
                  信号 bar 之后**下一根开盘**市价进场（对应 TV 未开启 process_orders_on_close）。
                  <br />
                  · <b>离场</b>：进场同时挂出 OCO —— 止损 = 区域外侧 ∓ ATR×slBuf，止盈 = 信号收盘价 ± 风险×盈亏比。
                  浮盈达到 beAtR 倍风险后把止损移动到开仓价；持仓超过 maxBars 根后下一根开盘市价平仓。
                  <br />
                  · <b>撮合</b>：同一根 K 线内同时触及止损与止盈时，按阳线先探低、阴线先探高处理；
                  市价单与止损单按 slippage tick 取劣势价，止盈限价单不受影响。
                  <br />
                  · <b>手续费</b>：开仓与平仓均按名义价值收取，本策略默认单边 0.05%。
                  <br />
                  · <b>未计入</b>：资金费率与流动性冲击，实盘表现通常弱于回测。
                </>
              ) : params.strategy === 'pine' ? (
                <>
                  · <b>编译</b>：源码经词法（注释剥离、续行合并、缩进插桩）→ 语法 → 语义检查，
                  生成 TypeScript 后由 Node 内置类型擦除转成 JS，在 vm 沙箱中执行；
                  同一份源码走 LRU 缓存，只编译一次。
                  <br />
                  · <b>信号</b>：每根 K 线调用一次编译产物（脚本的 var 状态在预热期自然累积）。
                  strategy.entry 的方向决定多空；strategy.exit 的止损/止盈在空仓 bar 上被引擎读取。
                  <br />
                  · <b>撮合</b>：与订单块策略共用引擎既有通路 —— 信号 bar 之后**下一根开盘**市价进场，
                  离场为「区域止损 / 目标 / 保本 / 时间止损」；同一根 K 线内同时触及止损与止盈时，
                  按阳线先探低、阴线先探高处理。
                  <br />
                  · <b>保本与时间止损</b>：脚本内的相应语句照常执行并进入 plot 输出，
                  但对交易的实际影响由引擎既有通路承担（与 order-block 完全一致）。
                  <br />
                  · <b>未计入</b>：资金费率与流动性冲击，实盘表现通常弱于回测。
                </>
              ) : (
                <>
                  · <b>信号</b>：以 0.5 斐波那契回撤位作为趋势线，K 线由下向上穿越且 TSOT 趋势强度为正 → 做多；
                  由上向下穿越且趋势强度为负 → 做空。
                  <br />
                  · <b>TSOT</b>：统计 13/21/34/55/89 周期的 75 分位高点与 25 分位低点相对 144 周期分位区间的位置，
                  综合得到多空强度差。
                  <br />
                  · <b>撮合</b>：开平仓按信号 K 线收盘价成交（对应 Pine 的 process_orders_on_close = true），
                  挂单从下一根 K 线开始生效；同一根 K 线内同时触及止损与止盈时，按阳线先探低、阴线先探高处理。
                  <br />
                  · <b>手续费</b>：开仓与每笔平仓均按名义价值收取，默认单边 0.055%。
                  <br />
                  · <b>未计入</b>：资金费率、滑点与流动性冲击，实盘表现通常弱于回测。
                </>
              )}
            </Typography>
          </AccordionDetails>
        </Accordion>
      </Stack>
    </Paper>
  )
}

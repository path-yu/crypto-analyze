import { useMemo } from 'react'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Stack from '../ui/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from 'recharts'

import type { BacktestResult, ExitReason } from '@shared/types'
import { EXIT_REASON_LABEL, money, num, pct, weekdayName } from '../utils/format'
import { downsample, histogram, quantile } from '../utils/series'
import { darkChartPalette, UP_COLOR, DOWN_COLOR } from '../theme'

const PAL = darkChartPalette

function Card({
  title,
  subtitle,
  children,
  height,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  height?: number
}) {
  return (
    <Paper sx={{ overflow: 'hidden' }}>
      <Stack sx={{ px: 2, py: 1.25, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="subtitle2">{title}</Typography>
        {subtitle && (
          <Typography variant="caption" color="text.secondary">
            {subtitle}
          </Typography>
        )}
      </Stack>
      <Box sx={{ height, p: height ? 0.5 : 1.5, py: height ? 1 : undefined }}>{children}</Box>
    </Paper>
  )
}

const tooltipStyle = {
  background: PAL.tooltipBg,
  border: `1px solid ${PAL.tooltipBorder}`,
  borderRadius: 8,
  fontSize: 12,
}

export default function AnalysisPanel({ result }: { result: BacktestResult }) {
  const { trades, report } = result
  const s = report.stats

  const exitData = useMemo(
    () =>
      Object.entries(s.exitReasonCounts)
        .map(([k, v]) => ({
          reason: EXIT_REASON_LABEL[k as ExitReason] ?? k,
          key: k,
          count: v,
        }))
        .sort((a, b) => b.count - a.count),
    [s.exitReasonCounts],
  )

  const pnlHist = useMemo(() => {
    const values = trades.map((t) => t.pnlPercent)
    const bins = histogram(values, 21)
    return downsample(bins, bins.length).map((b) => ({
      label: `${num(b.from, 0)}~${num(b.to, 0)}%`,
      mid: b.mid,
      count: b.count,
    }))
  }, [trades])

  const hourly = useMemo(
    () =>
      report.hourlyPnl.map((h) => ({
        hour: `${String(h.hour).padStart(2, '0')}`,
        pnl: h.pnl,
        trades: h.trades,
      })),
    [report.hourlyPnl],
  )

  const weekday = useMemo(
    () =>
      report.weekdayPnl.map((w) => ({
        day: weekdayName(w.weekday),
        pnl: w.pnl,
        trades: w.trades,
      })),
    [report.weekdayPnl],
  )

  const pnlPercents = useMemo(
    () => trades.map((t) => t.pnlPercent).sort((a, b) => a - b),
    [trades],
  )

  const bestWorst = useMemo(() => {
    if (trades.length === 0) return null
    const best = trades.reduce((a, b) => (b.pnlPercent > a.pnlPercent ? b : a))
    const worst = trades.reduce((a, b) => (b.pnlPercent < a.pnlPercent ? b : a))
    return { best, worst }
  }, [trades])

  const grossProfit = s.grossProfit
  const grossLoss = s.grossLoss
  const totalAbs = grossProfit + grossLoss

  return (
    <Box sx={{ display: 'grid', gap: 1.5 }}>
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' } }}>
        <Card title="平仓原因分布" subtitle="TP1 = 第一目标平 50%，TP2 = 第二目标平剩余">
          <Table size="small">
            <TableBody>
              {exitData.map((d) => (
                <TableRow key={d.key}>
                  <TableCell sx={{ border: 0, py: 0.5 }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Chip
                        size="small"
                        label={
                          d.key === 'TP1' || d.key === 'TP2'
                            ? '盈'
                            : d.key === 'BreakEven'
                              ? '平'
                              : '亏'
                        }
                        sx={{
                          height: 18,
                          fontSize: 10,
                          bgcolor:
                            d.key === 'TP1' || d.key === 'TP2'
                              ? 'rgba(255,77,79,0.15)'
                              : d.key === 'BreakEven'
                                ? 'rgba(138,148,166,0.15)'
                                : 'rgba(61,220,151,0.15)',
                          color:
                            d.key === 'TP1' || d.key === 'TP2'
                              ? UP_COLOR
                              : d.key === 'BreakEven'
                                ? '#8a94a6'
                                : DOWN_COLOR,
                        }}
                      />
                      <Typography variant="body2">{d.reason}</Typography>
                    </Stack>
                  </TableCell>
                  <TableCell align="right" sx={{ border: 0, py: 0.5 }}>
                    <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {d.count} 笔
                    </Typography>
                  </TableCell>
                  <TableCell align="right" sx={{ border: 0, py: 0.5, width: 120 }}>
                    <Stack direction="row" alignItems="center" spacing={1} justifyContent="flex-end">
                      <Box
                        sx={{
                          height: 6,
                          width: 70,
                          borderRadius: 3,
                          bgcolor: 'action.hover',
                          overflow: 'hidden',
                        }}
                      >
                        <Box
                          sx={{
                            height: '100%',
                            width: `${s.totalTrades ? (d.count / s.totalTrades) * 100 : 0}%`,
                            bgcolor: 'primary.main',
                          }}
                        />
                      </Box>
                      <Typography variant="caption" sx={{ width: 42, textAlign: 'right' }}>
                        {num(s.totalTrades ? (d.count / s.totalTrades) * 100 : 0, 1)}%
                      </Typography>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
              {exitData.length === 0 && (
                <TableRow>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      无交易
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>

        <Card title="多空与盈亏结构" subtitle="胜率、盈亏贡献与极端样本">
          <Table size="small">
            <TableBody>
              <TableRow>
                <TableCell sx={{ border: 0, py: 0.6 }}>多头交易</TableCell>
                <TableCell align="right" sx={{ border: 0, py: 0.6 }}>
                  {s.longTrades} 笔 · 胜率 {num(s.longWinRate, 1)}%
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ border: 0, py: 0.6 }}>空头交易</TableCell>
                <TableCell align="right" sx={{ border: 0, py: 0.6 }}>
                  {s.shortTrades} 笔 · 胜率 {num(s.shortWinRate, 1)}%
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ border: 0, py: 0.6 }}>总盈利 / 总亏损</TableCell>
                <TableCell align="right" sx={{ border: 0, py: 0.6, color: 'text.primary' }}>
                  <span style={{ color: UP_COLOR }}>{money(grossProfit)}</span> /{' '}
                  <span style={{ color: DOWN_COLOR }}>{money(-grossLoss)}</span>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ border: 0, py: 0.6 }}>盈利因子</TableCell>
                <TableCell align="right" sx={{ border: 0, py: 0.6 }}>
                  {num(s.profitFactor, 3)}
                  {totalAbs > 0 && (
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                      （盈利占比 {num((grossProfit / totalAbs) * 100, 1)}%）
                    </Typography>
                  )}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ border: 0, py: 0.6 }}>单笔最大盈利</TableCell>
                <TableCell align="right" sx={{ border: 0, py: 0.6, color: UP_COLOR }}>
                  {money(bestWorst?.best.netPnl ?? 0)}（{pct(bestWorst?.best.pnlPercent ?? 0)}）
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ border: 0, py: 0.6 }}>单笔最大亏损</TableCell>
                <TableCell align="right" sx={{ border: 0, py: 0.6, color: DOWN_COLOR }}>
                  {money(bestWorst?.worst.netPnl ?? 0)}（{pct(bestWorst?.worst.pnlPercent ?? 0)}）
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ border: 0, py: 0.6 }}>收益率分位（25/50/75）</TableCell>
                <TableCell align="right" sx={{ border: 0, py: 0.6 }}>
                  {pnlPercents.length > 0
                    ? [0.25, 0.5, 0.75]
                        .map((q) => pct(quantile(pnlPercents, q), 1))
                        .join('  /  ')
                    : '—'}
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell sx={{ border: 0, py: 0.6 }}>平均有利 / 不利幅度</TableCell>
                <TableCell align="right" sx={{ border: 0, py: 0.6 }}>
                  {num(
                    trades.length
                      ? trades.reduce((a, b) => a + b.maxFavorableExcursion, 0) / trades.length
                      : 0,
                    2,
                  )}
                  % /{' '}
                  {num(
                    trades.length
                      ? trades.reduce((a, b) => a + b.maxAdverseExcursion, 0) / trades.length
                      : 0,
                    2,
                  )}
                  %
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>
      </Box>

      <Card
        title="单笔收益率分布"
        subtitle={`以保证金为基准的单笔净收益率（%） · 共 ${trades.length} 笔`}
        height={240}
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={pnlHist} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
            <CartesianGrid stroke={PAL.grid} vertical={false} />
            <XAxis dataKey="label" stroke={PAL.axis} tick={{ fill: PAL.text, fontSize: 9 }} minTickGap={16} />
            <YAxis stroke={PAL.axis} tick={{ fill: PAL.text, fontSize: 11 }} width={44} />
            <RTooltip
              contentStyle={tooltipStyle}
              formatter={(v: unknown) => `${Number(v)} 笔`}
              labelFormatter={(l: unknown) => `收益率 ${String(l)}`}
            />
            <ReferenceLine x={pnlHist[Math.floor(pnlHist.length / 2)]?.label} stroke={PAL.muted} />
            <Bar dataKey="count" name="频数" isAnimationActive={false} radius={[2, 2, 0, 0]}>
              {pnlHist.map((d) => (
                <Cell key={d.label} fill={d.mid >= 0 ? UP_COLOR : DOWN_COLOR} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' } }}>
        <Card title="按开仓小时统计盈亏" subtitle="UTC+8 时区 · 单位 USDT" height={240}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={hourly} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid stroke={PAL.grid} vertical={false} />
              <XAxis dataKey="hour" stroke={PAL.axis} tick={{ fill: PAL.text, fontSize: 10 }} />
              <YAxis
                stroke={PAL.axis}
                tick={{ fill: PAL.text, fontSize: 10 }}
                tickFormatter={(v: number) => num(v, 0)}
                width={58}
              />
              <RTooltip
                contentStyle={tooltipStyle}
                formatter={(v: unknown) => money(Number(v))}
                labelFormatter={(l: unknown) => `${String(l)}:00 时`}
              />
              <ReferenceLine y={0} stroke={PAL.axis} />
              <Bar dataKey="pnl" name="净盈亏" isAnimationActive={false} radius={[2, 2, 0, 0]}>
                {hourly.map((d) => (
                  <Cell key={d.hour} fill={d.pnl >= 0 ? UP_COLOR : DOWN_COLOR} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="按星期统计盈亏" subtitle="按开仓时间归属 · 单位 USDT" height={240}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={weekday} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid stroke={PAL.grid} vertical={false} />
              <XAxis dataKey="day" stroke={PAL.axis} tick={{ fill: PAL.text, fontSize: 11 }} />
              <YAxis
                stroke={PAL.axis}
                tick={{ fill: PAL.text, fontSize: 10 }}
                tickFormatter={(v: number) => num(v, 0)}
                width={58}
              />
              <RTooltip
                contentStyle={tooltipStyle}
                formatter={(v: unknown) => money(Number(v))}
                labelFormatter={(l: unknown) => String(l)}
              />
              <ReferenceLine y={0} stroke={PAL.axis} />
              <Bar dataKey="pnl" name="净盈亏" isAnimationActive={false} radius={[2, 2, 0, 0]}>
                {weekday.map((d) => (
                  <Cell key={d.day} fill={d.pnl >= 0 ? UP_COLOR : DOWN_COLOR} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </Box>

      <Card title="交易节奏" subtitle="交易频率与盈亏随时间的分布">
        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
          <Chip label={`总交易 ${s.totalTrades} 笔`} size="small" />
          <Chip label={`平均持仓 ${num(s.avgBarsHeld, 1)} 根 K 线`} size="small" />
          <Chip label={`最长连盈 ${s.maxConsecutiveWins} 笔`} size="small" />
          <Chip label={`最长连亏 ${s.maxConsecutiveLosses} 笔`} size="small" />
          <Chip label={`累计手续费 ${money(s.totalFees)}`} size="small" />
          <Chip
            label={`手续费占毛利 ${num(
              grossProfit > 0 ? (s.totalFees / grossProfit) * 100 : 0,
              1,
            )}%`}
            size="small"
            color={s.totalFees / Math.max(grossProfit, 1e-9) > 0.3 ? 'warning' : 'default'}
          />
          <Chip label={`回测区间 ${report.bars} 根 K 线`} size="small" />
        </Stack>
      </Card>
    </Box>
  )
}

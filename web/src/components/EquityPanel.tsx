import { useMemo } from 'react'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  ReferenceLine,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from 'recharts'

import type { BacktestResult } from '@shared/types'
import { axisTimeLabel, compact, money, num, pct, price } from '../utils/format'
import { downsample } from '../utils/series'
import { darkChartPalette, UP_COLOR, DOWN_COLOR } from '../theme'

const PAL = darkChartPalette

function ChartCard({
  title,
  subtitle,
  height,
  children,
}: {
  title: string
  subtitle?: string
  height: number
  children: React.ReactNode
}) {
  return (
    <Paper sx={{ p: 0, overflow: 'hidden' }}>
      <Stack sx={{ px: 2, py: 1.25, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="subtitle2">{title}</Typography>
        {subtitle && (
          <Typography variant="caption" color="text.secondary">
            {subtitle}
          </Typography>
        )}
      </Stack>
      <Box sx={{ height, px: 0.5, py: 1 }}>{children}</Box>
    </Paper>
  )
}

export default function EquityPanel({ result }: { result: BacktestResult }) {
  const { equityCurve, candles, report } = result

  const equityData = useMemo(() => {
    if (equityCurve.length === 0) return []
    const firstClose = candles[0]?.close ?? 1
    const rows = equityCurve.map((p, i) => {
      const c = candles[i]
      return {
        t: p.timestamp,
        equity: p.equity,
        drawdown: p.drawdownPercent,
        price: c?.close,
        buyHold: c ? (c.close / firstClose) * report.initialCapital : report.initialCapital,
      }
    })
    return downsample(rows, 1400)
  }, [equityCurve, candles, report.initialCapital])

  /** 品种价格区间的统计信息（用于价格曲线卡片的副标题） */
  const priceStats = useMemo(() => {
    if (candles.length === 0) return null
    const first = candles[0].close
    const last = candles[candles.length - 1].close
    let high = -Infinity
    let low = Infinity
    for (const c of candles) {
      if (c.high > high) high = c.high
      if (c.low < low) low = c.low
    }
    return { first, last, high, low, change: first > 0 ? ((last - first) / first) * 100 : 0 }
  }, [candles])

  const spanMs = useMemo(() => {
    if (candles.length === 0) return 0
    return candles[candles.length - 1].timestamp - candles[0].timestamp
  }, [candles])

  const monthlyData = useMemo(
    () =>
      report.monthlyReturns.map((m) => ({
        month: m.month.slice(2),
        value: m.returnPercent,
      })),
    [report.monthlyReturns],
  )

  const tickFormatter = (v: number) => axisTimeLabel(v, spanMs)

  return (
    <Box sx={{ display: 'grid', gap: 1.5 }}>
      <ChartCard
        title="资金曲线"
        subtitle={`初始 ${money(report.initialCapital, 0)} → 期末 ${money(
          report.finalEquity,
        )} · 对比灰线为买入持有基准（杠杆回测下不计复利放大）`}
        height={300}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={equityData} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
            <defs>
              <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={PAL.equity} stopOpacity={0.35} />
                <stop offset="100%" stopColor={PAL.equity} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={PAL.grid} vertical={false} />
            <XAxis
              dataKey="t"
              tickFormatter={tickFormatter}
              stroke={PAL.axis}
              tick={{ fill: PAL.text, fontSize: 11 }}
              minTickGap={48}
            />
            <YAxis
              stroke={PAL.axis}
              tick={{ fill: PAL.text, fontSize: 11 }}
              tickFormatter={(v: number) => compact(v)}
              domain={['auto', 'auto']}
              width={62}
            />
            <RTooltip
              contentStyle={{
                background: PAL.tooltipBg,
                border: `1px solid ${PAL.tooltipBorder}`,
                borderRadius: 8,
                fontSize: 12,
              }}
              labelFormatter={(v) => axisTimeLabel(Number(v), spanMs)}
              formatter={(value: unknown) => money(Number(value))}
            />
            <ReferenceLine y={report.initialCapital} stroke={PAL.muted} strokeDasharray="4 4" />
            <Area
              type="monotone"
              dataKey="buyHold"
              name="买入持有"
              stroke={PAL.buyHold}
              strokeWidth={1}
              fill="none"
              dot={false}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="equity"
              name="策略权益"
              stroke={PAL.equity}
              strokeWidth={1.6}
              fill="url(#eqFill)"
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {priceStats && (
        <ChartCard
          title="价格曲线"
          subtitle={`${report.symbol} · ${report.timeframe} · 区间 ${pct(priceStats.change)}（首 ${price(
            priceStats.first,
          )} → 末 ${price(priceStats.last)}）· 最高 ${price(priceStats.high)} / 最低 ${price(
            priceStats.low,
          )}`}
          height={230}
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={equityData} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
              <defs>
                <linearGradient id="pxFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={PAL.accent} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={PAL.accent} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={PAL.grid} vertical={false} />
              <XAxis
                dataKey="t"
                tickFormatter={tickFormatter}
                stroke={PAL.axis}
                tick={{ fill: PAL.text, fontSize: 11 }}
                minTickGap={48}
              />
              <YAxis
                stroke={PAL.axis}
                tick={{ fill: PAL.text, fontSize: 11 }}
                tickFormatter={(v: number) => compact(v)}
                domain={['auto', 'auto']}
                width={62}
              />
              <RTooltip
                contentStyle={{
                  background: PAL.tooltipBg,
                  border: `1px solid ${PAL.tooltipBorder}`,
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={(v) => axisTimeLabel(Number(v), spanMs)}
                formatter={(value: unknown) => `$${price(Number(value))}`}
              />
              <ReferenceLine y={priceStats.first} stroke={PAL.muted} strokeDasharray="4 4" />
              <Area
                type="monotone"
                dataKey="price"
                name="收盘价"
                stroke={PAL.accent}
                strokeWidth={1.4}
                fill="url(#pxFill)"
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' } }}>
        <ChartCard
          title="回撤曲线"
          subtitle={`最大回撤 ${pct(report.maxDrawdownPercent, 2, false)} · 最大回撤金额 ${money(
            report.maxDrawdownAbs,
          )}`}
          height={230}
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={equityData} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
              <defs>
                <linearGradient id="ddFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={DOWN_COLOR} stopOpacity={0.05} />
                  <stop offset="100%" stopColor={DOWN_COLOR} stopOpacity={0.4} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={PAL.grid} vertical={false} />
              <XAxis
                dataKey="t"
                tickFormatter={tickFormatter}
                stroke={PAL.axis}
                tick={{ fill: PAL.text, fontSize: 11 }}
                minTickGap={48}
              />
              <YAxis
                stroke={PAL.axis}
                tick={{ fill: PAL.text, fontSize: 11 }}
                tickFormatter={(v: number) => `${num(v, 1)}%`}
                width={62}
              />
              <RTooltip
                contentStyle={{
                  background: PAL.tooltipBg,
                  border: `1px solid ${PAL.tooltipBorder}`,
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={(v) => axisTimeLabel(Number(v), spanMs)}
                formatter={(value: unknown) => pct(Number(value), 2, false)}
              />
              <Area
                type="monotone"
                dataKey="drawdown"
                name="回撤"
                stroke={DOWN_COLOR}
                strokeWidth={1.4}
                fill="url(#ddFill)"
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="月度收益"
          subtitle={`共 ${monthlyData.length} 个自然月 · 红涨绿跌`}
          height={230}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthlyData} margin={{ top: 8, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid stroke={PAL.grid} vertical={false} />
              <XAxis
                dataKey="month"
                stroke={PAL.axis}
                tick={{ fill: PAL.text, fontSize: 10 }}
                minTickGap={12}
              />
              <YAxis
                stroke={PAL.axis}
                tick={{ fill: PAL.text, fontSize: 11 }}
                tickFormatter={(v: number) => `${num(v, 0)}%`}
                width={56}
              />
              <RTooltip
                contentStyle={{
                  background: PAL.tooltipBg,
                  border: `1px solid ${PAL.tooltipBorder}`,
                  borderRadius: 8,
                  fontSize: 12,
                }}
                formatter={(value: unknown) => pct(Number(value))}
              />
              <ReferenceLine y={0} stroke={PAL.axis} />
              <Bar dataKey="value" name="月度收益" isAnimationActive={false} radius={[2, 2, 0, 0]}>
                {monthlyData.map((d) => (
                  <Cell key={d.month} fill={d.value >= 0 ? UP_COLOR : DOWN_COLOR} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </Box>
    </Box>
  )
}

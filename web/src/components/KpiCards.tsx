import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Stack from '../ui/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'

import type { PerformanceReport } from '@shared/types'
import { money, num, pct } from '../utils/format'
import { UP_COLOR, DOWN_COLOR } from '../theme'

interface KpiProps {
  label: string
  value: string
  sub?: string
  tooltip?: string
  tone?: 'up' | 'down' | 'neutral'
}

function Kpi({ label, value, sub, tooltip, tone = 'neutral' }: KpiProps) {
  const color =
    tone === 'up' ? UP_COLOR : tone === 'down' ? DOWN_COLOR : 'text.primary'
  return (
    <Paper sx={{ p: 1.75, minWidth: 0 }}>
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 0.5 }}>
        <Typography variant="caption" color="text.secondary" noWrap>
          {label}
        </Typography>
        {tooltip && (
          <Tooltip title={tooltip}>
            <InfoOutlinedIcon sx={{ fontSize: 13, color: 'text.disabled' }} />
          </Tooltip>
        )}
      </Stack>
      <Typography
        variant="h6"
        sx={{ color, fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}
        noWrap
      >
        {value}
      </Typography>
      {sub && (
        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', mt: 0.25 }}>
          {sub}
        </Typography>
      )}
    </Paper>
  )
}

export default function KpiCards({ report }: { report: PerformanceReport }) {
  const s = report.stats
  const tone = (v: number): 'up' | 'down' | 'neutral' => (v > 0 ? 'up' : v < 0 ? 'down' : 'neutral')

  const cards: KpiProps[] = [
    {
      label: '总收益率',
      value: pct(report.totalReturnPercent),
      sub: `${money(report.initialCapital, 0)} → ${money(report.finalEquity, 0)}`,
      tone: tone(report.totalReturnPercent),
      tooltip: '期末权益 / 初始资金 - 1，已扣除手续费',
    },
    {
      label: '净利润',
      value: money(report.netProfit),
      sub: `手续费合计 ${money(s.totalFees)}`,
      tone: tone(report.netProfit),
    },
    {
      label: '年化收益率',
      value: pct(report.annualizedReturnPercent),
      sub: `基准买入持有 ${pct(report.buyHoldReturnPercent)}`,
      tone: tone(report.annualizedReturnPercent),
      tooltip: '按回测区间的实际天数做连续复利年化',
    },
    {
      label: '最大回撤',
      // 内部以负数表示回撤，展示时统一转为正幅度（与 TradingView 等工具的惯例一致）
      value: pct(Math.abs(report.maxDrawdownPercent), 2, false),
      sub: `${money(report.maxDrawdownAbs)} · 持续 ${report.maxDrawdownBars} 根`,
      tone: 'down',
      tooltip: '权益从历史高点回落的最大幅度（正数表示回撤深度）',
    },
    {
      label: '夏普比率',
      value: num(report.sharpeRatio, 2),
      sub: `索提诺 ${num(report.sortinoRatio, 2)}`,
      tone: report.sharpeRatio > 1 ? 'up' : 'neutral',
      tooltip: '按每根 K 线收益率年化，无风险利率按 0 处理',
    },
    {
      label: '卡玛比率 / SQN',
      value: `${num(report.calmarRatio, 2)} / ${num(report.sqn, 2)}`,
      sub: `年化波动率 ${num(report.volatilityPercent, 1)}%`,
      tooltip: '卡玛 = 年化收益 / 最大回撤；SQN 为交易系统质量评分',
    },
    {
      label: '胜率',
      value: pct(s.winRate, 1, false),
      sub: `${s.winningTrades} 胜 / ${s.losingTrades} 负 / ${s.breakEvenTrades} 平`,
      tone: s.winRate >= 50 ? 'up' : 'neutral',
    },
    {
      label: '盈亏比 / 盈利因子',
      value: `${num(s.payoffRatio, 2)} / ${num(s.profitFactor, 2)}`,
      sub: `均盈 ${money(s.avgWin)} · 均亏 ${money(s.avgLoss)}`,
      tooltip: '盈亏比 = 平均盈利 / 平均亏损；盈利因子 = 总盈利 / 总亏损',
    },
    {
      label: '期望值 / 笔',
      value: money(s.expectancy),
      sub: `${s.totalTrades} 笔交易`,
      tone: tone(s.expectancy),
      tooltip: '每笔交易的平均期望收益',
    },
    {
      label: '最长连亏',
      value: `${s.maxConsecutiveLosses} 笔`,
      sub: `最长连盈 ${s.maxConsecutiveWins} 笔`,
      tone: s.maxConsecutiveLosses > 8 ? 'down' : 'neutral',
    },
    {
      label: '多 / 空 胜率',
      value: `${num(s.longWinRate, 0)}% / ${num(s.shortWinRate, 0)}%`,
      sub: `多 ${s.longTrades} 笔 · 空 ${s.shortTrades} 笔`,
    },
    {
      label: '平均持仓',
      value: `${num(s.avgBarsHeld, 1)} 根`,
      sub: `最长 ${s.maxBarsHeld} 根 · 成交额 ${money(s.totalVolume, 0)}`,
    },
  ]

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 1.25,
        gridTemplateColumns: {
          xs: 'repeat(2, minmax(0,1fr))',
          sm: 'repeat(3, minmax(0,1fr))',
          md: 'repeat(4, minmax(0,1fr))',
          lg: 'repeat(6, minmax(0,1fr))',
        },
      }}
    >
      {cards.map((c) => (
        <Kpi key={c.label} {...c} />
      ))}
    </Box>
  )
}

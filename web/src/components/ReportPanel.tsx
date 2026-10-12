import Alert from '@mui/material/Alert'
import AlertTitle from '@mui/material/AlertTitle'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import Paper from '@mui/material/Paper'
import Stack from '../ui/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Typography from '@mui/material/Typography'
import ArticleIcon from '@mui/icons-material/Article'
import DataObjectIcon from '@mui/icons-material/DataObject'
import TableChartIcon from '@mui/icons-material/TableChart'

import type { BacktestResult } from '@shared/types'
import { EXIT_REASON_LABEL, dateTime, money, num, pct, price } from '../utils/format'
import { downloadText, reportFileName, reportToMarkdown, tradesToCsv } from '../utils/report'
import { UP_COLOR, DOWN_COLOR } from '../theme'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Paper sx={{ overflow: 'hidden' }}>
      <Typography variant="subtitle2" sx={{ px: 2, py: 1.25, borderBottom: '1px solid', borderColor: 'divider' }}>
        {title}
      </Typography>
      <Box sx={{ p: 2 }}>{children}</Box>
    </Paper>
  )
}

function KV({ k, v, color }: { k: string; v: React.ReactNode; color?: string }) {
  return (
    <TableRow>
      <TableCell sx={{ border: 0, py: 0.6, color: 'text.secondary', width: '52%' }}>{k}</TableCell>
      <TableCell align="right" sx={{ border: 0, py: 0.6, fontVariantNumeric: 'tabular-nums', color }}>
        {v}
      </TableCell>
    </TableRow>
  )
}

export default function ReportPanel({ result }: { result: BacktestResult }) {
  const { report: r } = result
  const s = r.stats
  const p = r.params

  const exportMd = () =>
    downloadText(reportFileName(result, 'md'), reportToMarkdown(result), 'text/markdown')
  const exportCsv = () =>
    downloadText(reportFileName(result, 'csv'), `\uFEFF${tradesToCsv(result.trades)}`, 'text/csv')
  const exportJson = () =>
    downloadText(
      reportFileName(result, 'json'),
      JSON.stringify({ report: r, trades: result.trades, meta: result.meta }, null, 2),
      'application/json',
    )

  return (
    <Stack spacing={1.5}>
      <Paper sx={{ p: 2 }}>
        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center">
          <Typography variant="subtitle2" sx={{ mr: 'auto' }}>
            导出回测报告
          </Typography>
          <Button variant="contained" startIcon={<ArticleIcon />} onClick={exportMd}>
            下载 Markdown 报告
          </Button>
          <Button variant="outlined" startIcon={<TableChartIcon />} onClick={exportCsv}>
            下载交易明细 CSV
          </Button>
          <Button variant="outlined" startIcon={<DataObjectIcon />} onClick={exportJson}>
            下载原始 JSON
          </Button>
        </Stack>
      </Paper>

      {r.warnings.length > 0 && (
        <Alert severity="warning" variant="outlined">
          <AlertTitle>风险提示</AlertTitle>
          <Stack component="ul" spacing={0.25} sx={{ m: 0, pl: 2.5 }}>
            {r.warnings.map((w) => (
              <li key={w}>
                <Typography variant="body2">{w}</Typography>
              </li>
            ))}
          </Stack>
        </Alert>
      )}

      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' } }}>
        <Section title="回测概要">
          <Table size="small">
            <TableBody>
              <KV k="数据源" v={r.exchange} />
              <KV k="交易对" v={r.symbol} />
              <KV k="K 线周期" v={r.timeframe} />
              <KV k="回测区间（UTC+8）" v={`${dateTime(r.startTime)} ~ ${dateTime(r.endTime)}`} />
              <KV k="K 线根数" v={r.bars.toLocaleString()} />
              <KV k="跨度" v={`${Math.round((r.endTime - r.startTime) / 86400000)} 天`} />
              <KV k="数据获取" v={result.meta.cached ? '命中缓存' : '实时拉取'} />
              <KV k="生成时间" v={dateTime(result.meta.fetchedAt)} />
            </TableBody>
          </Table>
        </Section>

        <Section title="策略参数">
          <Table size="small">
            <TableBody>
              <KV k="Sensitivity" v={`${p.sensitivity}（通道窗口 ${Math.trunc(p.sensitivity * 10)} 根）`} />
              <KV k="ATR 长度 / 平滑 / 倍数" v={`${p.atrLength} / ${p.atrSmoothing} / ${p.atrMultiplier}`} />
              <KV k="交易方向" v={p.tradeDirection} />
              <KV k="止损模式" v={p.exitStrategy} />
              <KV k="固定止损 / 盈亏比" v={`${p.slPercent}% / ${p.riskRewardRatio}`} />
              <KV k="分批止盈" v={p.partialTp ? '开启（TP1 平 50%）' : '关闭（整仓离场）'} />
              <KV k="允许反手" v={p.allowReversePosition ? '是' : '否'} />
              <KV
                k="金字塔式加仓"
                v={p.pyramiding === 0 ? '不限' : p.pyramiding === 1 ? '关闭（1 单）' : `最多 ${p.pyramiding} 单`}
              />
              <KV k="初始资金" v={`${money(p.initialCapital, 0)}`} />
              <KV k="杠杆 / 仓位比例" v={`${p.leverage}x / ${p.positionSizePercent}%`} />
              <KV k="单边手续费" v={`${p.commissionPercent}%`} />
              <KV k="强平检查" v={p.checkLiquidation ? '启用' : '关闭'} />
            </TableBody>
          </Table>
        </Section>

        <Section title="收益与风险">
          <Table size="small">
            <TableBody>
              <KV k="初始资金 / 期末权益" v={`${money(r.initialCapital, 0)} → ${money(r.finalEquity, 0)}`} />
              <KV
                k="净利润"
                v={money(r.netProfit)}
                color={r.netProfit >= 0 ? UP_COLOR : DOWN_COLOR}
              />
              <KV
                k="总收益率"
                v={pct(r.totalReturnPercent)}
                color={r.totalReturnPercent >= 0 ? UP_COLOR : DOWN_COLOR}
              />
              <KV k="年化收益率" v={pct(r.annualizedReturnPercent)} />
              <KV k="最大回撤" v={`${pct(r.maxDrawdownPercent, 2, false)} · ${money(r.maxDrawdownAbs)}`} />
              <KV k="最大回撤区间" v={`${dateTime(r.maxDrawdownStart)} ~ ${dateTime(r.maxDrawdownEnd)}`} />
              <KV k="夏普 / 索提诺 / 卡玛" v={`${num(r.sharpeRatio, 2)} / ${num(r.sortinoRatio, 2)} / ${num(r.calmarRatio, 2)}`} />
              <KV k="SQN / 年化波动率" v={`${num(r.sqn, 2)} / ${num(r.volatilityPercent, 2)}%`} />
              <KV
                k="基准买入持有"
                v={pct(r.buyHoldReturnPercent)}
                color={r.buyHoldReturnPercent >= 0 ? UP_COLOR : DOWN_COLOR}
              />
              <KV
                k="策略超额收益"
                v={pct(r.totalReturnPercent - r.buyHoldReturnPercent)}
                color={
                  r.totalReturnPercent - r.buyHoldReturnPercent >= 0 ? UP_COLOR : DOWN_COLOR
                }
              />
            </TableBody>
          </Table>
        </Section>

        <Section title="交易统计">
          <Table size="small">
            <TableBody>
              <KV k="总交易笔数" v={s.totalTrades} />
              <KV k="盈利 / 亏损 / 持平" v={`${s.winningTrades} / ${s.losingTrades} / ${s.breakEvenTrades}`} />
              <KV k="整体胜率" v={pct(s.winRate, 2, false)} />
              <KV k="多头 笔数 / 胜率" v={`${s.longTrades} / ${pct(s.longWinRate, 2, false)}`} />
              <KV k="空头 笔数 / 胜率" v={`${s.shortTrades} / ${pct(s.shortWinRate, 2, false)}`} />
              <KV k="总盈利 / 总亏损" v={`${money(s.grossProfit)} / ${money(-s.grossLoss)}`} />
              <KV k="盈利因子 / 盈亏比" v={`${num(s.profitFactor, 3)} / ${num(s.payoffRatio, 3)}`} />
              <KV k="平均每笔 / 期望值" v={`${money(s.avgTrade)} / ${money(s.expectancy)}`} />
              <KV k="单笔最大盈利 / 亏损" v={`${money(s.largestWin)} / ${money(s.largestLoss)}`} />
              <KV k="最长连盈 / 最长连亏" v={`${s.maxConsecutiveWins} / ${s.maxConsecutiveLosses}`} />
              <KV k="平均 / 最长持仓" v={`${num(s.avgBarsHeld, 2)} / ${s.maxBarsHeld} 根`} />
              <KV k="累计手续费 / 成交额" v={`${money(s.totalFees)} / ${money(s.totalVolume, 0)}`} />
            </TableBody>
          </Table>
        </Section>
      </Box>

      <Section title="平仓原因分布">
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {Object.entries(s.exitReasonCounts).map(([k, v]) => (
            <Chip
              key={k}
              label={`${EXIT_REASON_LABEL[k] ?? k} · ${v} 笔（${num(
                s.totalTrades ? (v / s.totalTrades) * 100 : 0,
                1,
              )}%）`}
            />
          ))}
          {Object.keys(s.exitReasonCounts).length === 0 && (
            <Typography variant="body2" color="text.secondary">
              无交易
            </Typography>
          )}
        </Stack>
      </Section>

      {result.trades.length > 0 && (
        <Section title={`全部交易明细（${result.trades.length} 笔）`}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>#</TableCell>
                <TableCell align="center">方向</TableCell>
                <TableCell>入场时间</TableCell>
                <TableCell align="right">入场价</TableCell>
                <TableCell>出场时间</TableCell>
                <TableCell align="right">出场价</TableCell>
                <TableCell align="right">止损</TableCell>
                <TableCell align="right">TP1</TableCell>
                <TableCell align="right">TP2</TableCell>
                <TableCell align="right">价格变动</TableCell>
                <TableCell align="right">净盈亏</TableCell>
                <TableCell align="right">收益率</TableCell>
                <TableCell align="center">原因</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {result.trades.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>{t.id}</TableCell>
                  <TableCell align="center" sx={{ color: t.side === 'long' ? UP_COLOR : DOWN_COLOR }}>
                    {t.side === 'long' ? '多' : '空'}
                  </TableCell>
                  <TableCell>{dateTime(t.entryTime)}</TableCell>
                  <TableCell align="right">{price(t.entryPrice)}</TableCell>
                  <TableCell>{dateTime(t.exitTime)}</TableCell>
                  <TableCell align="right">{price(t.exitPrice)}</TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary' }}>
                    {price(t.stopLoss)}
                  </TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary' }}>
                    {price(t.takeProfit1)}
                  </TableCell>
                  <TableCell align="right" sx={{ color: 'text.secondary' }}>
                    {price(t.takeProfit2)}
                  </TableCell>
                  <TableCell align="right" sx={{ color: t.priceChangePercent >= 0 ? UP_COLOR : DOWN_COLOR }}>
                    {pct(t.priceChangePercent)}
                  </TableCell>
                  <TableCell align="right" sx={{ color: t.netPnl >= 0 ? UP_COLOR : DOWN_COLOR, fontWeight: 600 }}>
                    {money(t.netPnl)}
                  </TableCell>
                  <TableCell align="right" sx={{ color: t.netPnl >= 0 ? UP_COLOR : DOWN_COLOR }}>
                    {pct(t.pnlPercent)}
                  </TableCell>
                  <TableCell align="center">{EXIT_REASON_LABEL[t.exitReason] ?? t.exitReason}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      <Divider />
      <Typography variant="caption" color="text.secondary">
        回测不考虑资金费率、滑点与流动性冲击，实盘表现通常弱于回测结果。本报告仅用于策略研究，不构成任何投资建议。
      </Typography>
    </Stack>
  )
}

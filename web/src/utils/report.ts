import type { BacktestResult, StrategyParams, Trade } from '@shared/types'
import { EXIT_REASON_LABEL, dateTime, num, pct } from './format'

const EXPORT_TIMEZONE_NOTE = '时间均为 UTC+8'

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

function csvCell(v: unknown): string {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function tradesToCsv(trades: readonly Trade[]): string {
  const header = [
    '序号',
    '方向',
    '入场时间',
    '入场价',
    '出场时间',
    '出场价(加权)',
    '数量',
    '名义价值',
    '保证金',
    '杠杆',
    '止损价',
    'TP1',
    'TP2',
    '价格变动%',
    '手续费',
    '毛利润',
    '净盈亏',
    '保证金收益率%',
    '持仓K线',
    '最大有利幅度%',
    '最大不利幅度%',
    '平仓原因',
    '平仓说明',
  ]
  const lines = [header.join(',')]
  for (const t of trades) {
    lines.push(
      [
        t.id,
        t.side === 'long' ? '多' : '空',
        dateTime(t.entryTime),
        t.entryPrice,
        dateTime(t.exitTime),
        t.exitPrice,
        t.qty,
        t.notional.toFixed(2),
        t.margin.toFixed(2),
        t.leverage,
        t.stopLoss,
        t.takeProfit1,
        t.takeProfit2,
        t.priceChangePercent.toFixed(4),
        t.fee.toFixed(4),
        t.grossPnl.toFixed(4),
        t.netPnl.toFixed(4),
        t.pnlPercent.toFixed(4),
        t.barsHeld,
        t.maxFavorableExcursion.toFixed(3),
        t.maxAdverseExcursion.toFixed(3),
        EXIT_REASON_LABEL[t.exitReason] ?? t.exitReason,
        t.comment,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* Markdown 回测报告                                                    */
/* ------------------------------------------------------------------ */

function paramRows(p: StrategyParams): [string, string][] {
  return [
    ['Sensitivity 敏感度', `${p.sensitivity}（通道窗口 ${Math.trunc(p.sensitivity * 10)} 根）`],
    ['ATR 长度 / 平滑 / 倍数', `${p.atrLength} / ${p.atrSmoothing} / ${p.atrMultiplier}`],
    ['交易方向', p.tradeDirection],
    ['止损模式', p.exitStrategy],
    ['固定止损百分比', `${p.slPercent}%`],
    ['盈亏比', String(p.riskRewardRatio)],
    ['分批止盈', p.partialTp ? '开启（TP1 平 50%，移止损至保本）' : '关闭（TP1/TP2 整仓离场）'],
    ['允许反手', p.allowReversePosition ? '是' : '否'],
    ['初始资金', `${p.initialCapital} USDT`],
    ['杠杆 / 仓位比例', `${p.leverage}x / ${p.positionSizePercent}%`],
    ['单边手续费', `${p.commissionPercent}%`],
    ['强平检查', p.checkLiquidation ? '启用' : '关闭'],
  ]
}

export function reportToMarkdown(result: BacktestResult): string {
  const { report: r, meta } = result
  const s = r.stats

  const md: string[] = []
  md.push(`# Fibonacci Trend Reversals 回测报告`)
  md.push('')
  md.push(`> ${EXPORT_TIMEZONE_NOTE}，由 ccxt 公开行情 + TypeScript 回测引擎生成。`)
  md.push('')
  md.push('## 一、回测概要')
  md.push('')
  md.push('| 项目 | 数值 |')
  md.push('| --- | --- |')
  md.push(`| 数据源 | ${r.exchange} |`)
  md.push(`| 交易对 | ${r.symbol} |`)
  md.push(`| K 线周期 | ${r.timeframe} |`)
  md.push(`| 回测区间 | ${dateTime(r.startTime)} ~ ${dateTime(r.endTime)} |`)
  md.push(`| K 线根数 | ${r.bars} |`)
  md.push(`| 数据缓存 | ${meta.cached ? '命中缓存' : '实时拉取'} |`)
  md.push('')

  md.push('## 二、绩效指标')
  md.push('')
  md.push('| 指标 | 数值 |')
  md.push('| --- | --- |')
  md.push(`| 初始资金 | ${num(r.initialCapital)} USDT |`)
  md.push(`| 期末权益 | ${num(r.finalEquity)} USDT |`)
  md.push(`| 净利润 | ${num(r.netProfit)} USDT |`)
  md.push(`| 总收益率 | ${pct(r.totalReturnPercent)} |`)
  md.push(`| 年化收益率 | ${pct(r.annualizedReturnPercent)} |`)
  md.push(`| 最大回撤 | ${pct(r.maxDrawdownPercent, 2, false)}（${num(r.maxDrawdownAbs)} USDT，持续 ${r.maxDrawdownBars} 根 K 线） |`)
  md.push(`| 夏普比率 | ${num(r.sharpeRatio, 3)} |`)
  md.push(`| 索提诺比率 | ${num(r.sortinoRatio, 3)} |`)
  md.push(`| 卡玛比率 | ${num(r.calmarRatio, 3)} |`)
  md.push(`| SQN | ${num(r.sqn, 3)} |`)
  md.push(`| 年化波动率 | ${num(r.volatilityPercent, 2)}% |`)
  md.push(`| 买入持有基准 | ${pct(r.buyHoldReturnPercent)} |`)
  md.push(`| 策略超额收益 | ${pct(r.totalReturnPercent - r.buyHoldReturnPercent)} |`)
  md.push('')

  md.push('## 三、交易统计')
  md.push('')
  md.push('| 指标 | 数值 |')
  md.push('| --- | --- |')
  md.push(`| 总交易笔数 | ${s.totalTrades} |`)
  md.push(`| 盈利 / 亏损 / 持平 | ${s.winningTrades} / ${s.losingTrades} / ${s.breakEvenTrades} |`)
  md.push(`| 胜率 | ${pct(s.winRate, 2, false)} |`)
  md.push(`| 多头交易 / 胜率 | ${s.longTrades} / ${pct(s.longWinRate, 2, false)} |`)
  md.push(`| 空头交易 / 胜率 | ${s.shortTrades} / ${pct(s.shortWinRate, 2, false)} |`)
  md.push(`| 总盈利 / 总亏损 | ${num(s.grossProfit)} / ${num(s.grossLoss)} |`)
  md.push(`| 盈利因子 | ${num(s.profitFactor, 3)} |`)
  md.push(`| 盈亏比 | ${num(s.payoffRatio, 3)} |`)
  md.push(`| 平均每笔 | ${num(s.avgTrade)} USDT |`)
  md.push(`| 期望值 | ${num(s.expectancy)} USDT |`)
  md.push(`| 单笔最大盈利 | ${num(s.largestWin)} USDT |`)
  md.push(`| 单笔最大亏损 | ${num(s.largestLoss)} USDT |`)
  md.push(`| 最长连盈 / 连亏 | ${s.maxConsecutiveWins} / ${s.maxConsecutiveLosses} |`)
  md.push(`| 平均持仓 | ${num(s.avgBarsHeld, 2)} 根 K 线（最长 ${s.maxBarsHeld}） |`)
  md.push(`| 累计手续费 | ${num(s.totalFees)} USDT |`)
  md.push(`| 累计成交额 | ${num(s.totalVolume)} USDT |`)
  md.push('')

  md.push('### 平仓原因分布')
  md.push('')
  md.push('| 原因 | 笔数 | 占比 |')
  md.push('| --- | --- | --- |')
  for (const [k, v] of Object.entries(s.exitReasonCounts)) {
    md.push(
      `| ${EXIT_REASON_LABEL[k] ?? k} | ${v} | ${pct(s.totalTrades ? (v / s.totalTrades) * 100 : 0, 2, false)} |`,
    )
  }
  md.push('')

  md.push('## 四、策略参数')
  md.push('')
  md.push('| 参数 | 取值 |')
  md.push('| --- | --- |')
  for (const [k, v] of paramRows(r.params)) md.push(`| ${k} | ${v} |`)
  md.push('')

  if (r.monthlyReturns.length > 0) {
    md.push('## 五、月度收益')
    md.push('')
    md.push('| 月份 | 收益率 |')
    md.push('| --- | --- |')
    for (const m of r.monthlyReturns) md.push(`| ${m.month} | ${pct(m.returnPercent)} |`)
    md.push('')
  }

  if (result.trades.length > 0) {
    md.push('## 六、交易明细')
    md.push('')
    md.push('| # | 方向 | 入场时间 | 入场价 | 出场时间 | 出场价 | 净盈亏 | 收益率 | 持仓 | 平仓原因 |')
    md.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const t of result.trades) {
      md.push(
        `| ${t.id} | ${t.side === 'long' ? '多' : '空'} | ${dateTime(t.entryTime)} | ${t.entryPrice} | ${dateTime(
          t.exitTime,
        )} | ${num(t.exitPrice, 4)} | ${num(t.netPnl)} | ${pct(t.pnlPercent)} | ${t.barsHeld} | ${
          EXIT_REASON_LABEL[t.exitReason] ?? t.exitReason
        } |`,
      )
    }
    md.push('')
  }

  if (r.warnings.length) {
    md.push('## 七、风险提示')
    md.push('')
    for (const w of r.warnings) md.push(`- ${w}`)
    md.push('')
  }

  md.push('---')
  md.push('')
  md.push(
    '*回测不考虑资金费率、滑点与流动性冲击，实盘表现通常弱于回测结果。本报告仅用于策略研究，不构成任何投资建议。*',
  )
  md.push('')

  return md.join('\n')
}

/* ------------------------------------------------------------------ */
/* 下载                                                                */
/* ------------------------------------------------------------------ */

export function downloadText(filename: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function reportFileName(result: BacktestResult, ext: string): string {
  const sym = result.report.symbol.replace(/[^a-zA-Z0-9]/g, '')
  const tf = result.report.timeframe
  const d = new Date(result.report.endTime)
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`
  return `fib-trend-${sym}-${tf}-${stamp}.${ext}`
}

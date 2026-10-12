/**
 * 命令行回测 —— 无需前端即可跑一遍策略并打印报告。
 *
 * 用法示例：
 *   npm run backtest -- --symbol BTC/USDT:USDT --timeframe 1h --bars 5000 --leverage 5
 *   npm run backtest -- --symbol ETH/USDT:USDT --timeframe 15m --since 2025-01-01 --exit "Fixed Percent"
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExchangeId, StrategyParams, Timeframe } from '../../shared/types'
import { runBacktestService, normalizeParams } from './service/backtestService'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = 'true'
      }
    }
  }
  return out
}

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function pct(n: number): string {
  return `${n >= 0 ? '+' : ''}${fmt(n, 2)}%`
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const symbol = args.symbol ?? 'BTC/USDT:USDT'
  const timeframe = (args.timeframe ?? '1h') as Timeframe
  const exchange = (args.exchange ?? 'binanceusdm') as ExchangeId
  const bars = args.bars ? Number(args.bars) : 5000
  const since = args.since ? new Date(args.since).getTime() : undefined
  const until = args.until ? new Date(args.until).getTime() : undefined

  const params: Partial<StrategyParams> = {
    leverage: args.leverage ? Number(args.leverage) : undefined,
    sensitivity: args.sensitivity ? Number(args.sensitivity) : undefined,
    riskRewardRatio: args.rr ? Number(args.rr) : undefined,
    exitStrategy: args.exit as StrategyParams['exitStrategy'] | undefined,
    tradeDirection: args.direction as StrategyParams['tradeDirection'] | undefined,
    slPercent: args.sl ? Number(args.sl) : undefined,
    initialCapital: args.capital ? Number(args.capital) : undefined,
  }
  // 清理 undefined，避免覆盖默认值
  for (const k of Object.keys(params) as (keyof StrategyParams)[]) {
    if (params[k] === undefined) delete params[k]
  }

  console.log('\n运行回测…')
  console.log(`  交易所  ${exchange}`)
  console.log(`  交易对  ${symbol}`)
  console.log(`  周期    ${timeframe}`)
  console.log(`  参数    ${JSON.stringify(normalizeParams(params))}\n`)

  const t0 = Date.now()
  const result = await runBacktestService({
    exchange,
    symbol,
    timeframe,
    bars,
    since,
    until,
    params,
  })
  const elapsed = Date.now() - t0

  const { report: r } = result
  const from = new Date(r.startTime).toISOString().slice(0, 16).replace('T', ' ')
  const to = new Date(r.endTime).toISOString().slice(0, 16).replace('T', ' ')

  console.log('══════════════════ 回测报告 ══════════════════')
  console.log(`区间            ${from} → ${to} UTC`)
  console.log(`K 线数量        ${r.bars}`)
  console.log(`杠杆 / 仓位     ${r.leverage}x / ${r.params.positionSizePercent}%`)
  console.log('──────────────────────────────────────────────')
  console.log(`初始资金        ${fmt(r.initialCapital)} USDT`)
  console.log(`期末权益        ${fmt(r.finalEquity)} USDT`)
  console.log(`净利润          ${fmt(r.netProfit)} USDT  (${pct(r.totalReturnPercent)})`)
  console.log(`年化收益        ${pct(r.annualizedReturnPercent)}`)
  console.log(`最大回撤        ${fmt(r.maxDrawdownPercent)}%  (${fmt(r.maxDrawdownAbs)} USDT)`)
  console.log(`夏普 / 索提诺   ${fmt(r.sharpeRatio)} / ${fmt(r.sortinoRatio)}`)
  console.log(`卡玛 / SQN      ${fmt(r.calmarRatio)} / ${fmt(r.sqn)}`)
  console.log(`基准买入持有    ${pct(r.buyHoldReturnPercent)}`)
  console.log('──────────────────────────────────────────────')
  const s = r.stats
  console.log(`交易笔数        ${s.totalTrades}  (多 ${s.longTrades} / 空 ${s.shortTrades})`)
  console.log(`胜率            ${fmt(s.winRate)}%   (${s.winningTrades} 胜 / ${s.losingTrades} 负)`)
  console.log(`盈亏比          ${fmt(s.payoffRatio)}   盈利因子 ${fmt(s.profitFactor)}`)
  console.log(`平均每笔        ${fmt(s.avgTrade)} USDT   期望值 ${fmt(s.expectancy)} USDT`)
  console.log(`最大连亏        ${s.maxConsecutiveLosses} 笔`)
  console.log(`累计手续费      ${fmt(s.totalFees)} USDT`)
  console.log('平仓原因分布    ' + JSON.stringify(s.exitReasonCounts))
  console.log('══════════════════════════════════════════════\n')

  if (r.warnings.length) {
    console.log('提示：')
    for (const w of r.warnings) console.log(`  · ${w}`)
    console.log()
  }

  const outDir = path.resolve(__dirname, '../../output')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `backtest-${symbol.replace(/[^a-zA-Z0-9]/g, '')}-${timeframe}.json`)
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      { report: result.report, trades: result.trades, meta: result.meta },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`完整结果已保存: ${outFile}  (耗时 ${elapsed}ms)\n`)
}

main().catch((err) => {
  console.error('\n回测失败：', err instanceof Error ? err.message : err)
  process.exit(1)
})

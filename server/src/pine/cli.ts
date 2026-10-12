/**
 * Pine 命令行工具 —— 无需前端即可编译脚本、跑回测并打印报告。
 *
 * 用法示例：
 *   npm run pine -- server/pine/test.pine --dump-ts output/pine/test.ts
 *   npm run pine -- server/pine/test.pine --symbol BTC/USDT:USDT --timeframe 1h --bars 3000
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExchangeId, StrategyParams, Timeframe } from '../../../shared/types'
import { compilePine } from './compile'
import { runBacktestService, normalizeParams } from '../service/backtestService'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 项目根目录（server/src/pine → 上三级） */
const ROOT = path.resolve(__dirname, '../../..')

function parseArgs(argv: string[]): { opts: Record<string, string>; positional: string[] } {
  const opts: Record<string, string> = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        opts[key] = next
        i++
      } else {
        opts[key] = 'true'
      }
    } else {
      positional.push(a)
    }
  }
  return { opts, positional }
}

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function pct(n: number): string {
  return `${n >= 0 ? '+' : ''}${fmt(n, 2)}%`
}

async function main(): Promise<void> {
  const { opts, positional } = parseArgs(process.argv.slice(2))
  const file = positional[0]
  if (!file) {
    console.error(
      '用法：npm run pine -- <file.pine> [--dump-ts <out.ts>] [--symbol … --timeframe … --bars …]',
    )
    process.exit(1)
  }

  const srcPath = path.isAbsolute(file) ? file : path.resolve(ROOT, file)
  const source = fs.readFileSync(srcPath, 'utf8')
  const sourceName = path.basename(srcPath)

  const comp = compilePine(source, { sourceName })
  for (const d of comp.diagnostics) {
    const tag = d.severity === 'error' ? '错误' : '警告'
    console.log(`  [${tag}] 第 ${d.line} 行 第 ${d.column} 列 · ${d.message}`)
  }
  const errors = comp.diagnostics.filter((d) => d.severity === 'error')
  if (errors.length) {
    console.error(`\n编译失败：共 ${errors.length} 个错误\n`)
    process.exit(1)
  }
  console.log(
    `\n编译成功：kind=${comp.meta.kind}，plots=[${comp.meta.plotTitles.join(', ')}]，` +
      `alerts=${comp.meta.alerts.length}，inputs=${comp.meta.inputs.length}\n`,
  )

  if (opts['dump-ts']) {
    const out = path.isAbsolute(opts['dump-ts']) ? opts['dump-ts'] : path.resolve(ROOT, opts['dump-ts'])
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, comp.ts, 'utf8')
    console.log(`已写入 TS 产物: ${out}\n`)
    return
  }

  const symbol = opts.symbol ?? 'BTC/USDT:USDT'
  const timeframe = (opts.timeframe ?? '1h') as Timeframe
  const exchange = (opts.exchange ?? 'binanceusdm') as ExchangeId
  const bars = opts.bars ? Number(opts.bars) : 5000
  const since = opts.since ? new Date(opts.since).getTime() : undefined
  const until = opts.until ? new Date(opts.until).getTime() : undefined

  const params: Partial<StrategyParams> = {
    strategy: 'pine',
    leverage: opts.leverage ? Number(opts.leverage) : undefined,
    riskRewardRatio: opts.rr ? Number(opts.rr) : undefined,
    initialCapital: opts.capital ? Number(opts.capital) : undefined,
  }
  for (const k of Object.keys(params) as (keyof StrategyParams)[]) {
    if (params[k] === undefined) delete params[k]
  }

  console.log('运行回测…')
  console.log(`  交易所  ${exchange}`)
  console.log(`  交易对  ${symbol}`)
  console.log(`  周期    ${timeframe}`)
  console.log(`  脚本    ${sourceName}`)
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
    pine: { source, name: sourceName },
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

  const outDir = path.resolve(ROOT, 'output')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `pine-${sourceName.replace(/\.pine$/, '')}-${timeframe}.json`)
  fs.writeFileSync(
    outFile,
    JSON.stringify({ report: result.report, trades: result.trades, meta: result.meta }, null, 2),
    'utf8',
  )
  console.log(`完整结果已保存: ${outFile}  (耗时 ${elapsed}ms)\n`)
}

main().catch((err) => {
  console.error('\n运行失败：', err instanceof Error ? err.message : err)
  process.exit(1)
})
/**
 * 策略复盘批量回测：按 Pine 脚本自身声明的口径（initial_capital / commission_value）
 * 在多个周期上各跑一年，导出逐笔交易 + 资金曲线，供后续复盘分析。
 *
 * 用法：
 *   npx tsx scripts/strategy-review.ts <file.pine> [--tag base] [--tfs 1h,2h,4h,1d]
 *        [--from 2025-10-13T00:00:00Z] [--to 2026-10-13T00:00:00Z]
 *        [--capital 1000] [--commission 0.1] [--leverage 1]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StrategyParams, Timeframe } from '../shared/types'
import { runBacktestService } from '../server/src/service/backtestService'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

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
      } else opts[key] = 'true'
    } else positional.push(a)
  }
  return { opts, positional }
}

const { opts, positional } = parseArgs(process.argv.slice(2))
const file = positional[0]
if (!file) {
  console.error('用法：npx tsx scripts/strategy-review.ts <file.pine> [--tag base] [--tfs 1h,2h,4h,1d]')
  process.exit(1)
}

const srcPath = path.isAbsolute(file) ? file : path.resolve(ROOT, file)
const source = fs.readFileSync(srcPath, 'utf8')
const sourceName = path.basename(srcPath)

const tag = opts.tag ?? sourceName.replace(/\.pine$/i, '')
const symbol = opts.symbol ?? 'BTC/USDT:USDT'
const tfs = (opts.tfs ?? '1h 2h 4h 1d').split(/[,;\s]+/).filter(Boolean) as Timeframe[]
const sinceArg = opts.from ?? '2025-10-13T00:00:00Z'
const untilArg = opts.to ?? '2026-10-13T00:00:00Z'
const since = new Date(sinceArg).getTime()
const until = new Date(untilArg).getTime()

const capital = Number(opts.capital ?? 1000)
const commission = Number(opts.commission ?? 0.1)
/**
 * 引擎杠杆。**对 Pine 固定下单量（strategy.entry(qty=…)）的盈亏没有影响**：
 * 名义价值 = qty × 价格 由脚本给定，引擎只用杠杆反推占用保证金。
 * 但 `addSubOrder` 有一条「保证金 > 现金则不下单」的资金校验，脚本声明的
 * leverage=1 会让每笔占用 = 全部本金，从而在首笔之后把后续信号全部挡掉
 * （实测 1 年只剩 1~4 笔）。TradingView 的 strategy() 没有保证金模型，
 * 因此这里取 3（本项目默认值）以贴合「固定 1000 名义仓位、可重复开仓」的原意。
 */
const leverage = Number(opts.leverage ?? 3)
/** 仓位比例（占当前权益的保证金 %）；引擎口径下的**敞口** = 仓位比例 × 杠杆 */
const sizePct = Number(opts.sizePct ?? 100)
/**
 * 仓位口径：本报告全程采用「脚本 qty 决定名义价值」的 TradingView 口径，
 * 即在 UI 里对应「仓位由脚本 qty 决定」开关为打开状态。
 * 传 `--sizing engine` 可切换为「权益 × 仓位比例 × 杠杆」口径（名义价值随杠杆放大）。
 */
const useScriptPositionSize = (opts.sizing ?? 'script') !== 'engine'

/** 覆盖脚本内 input.* 默认值：`--inputs stopLossPct=5,beAtrMult=1` */
const inputs: Record<string, number> = {}
for (const kv of (opts.inputs ?? '').split(/[,;\s]+/).filter(Boolean)) {
  const [k, v] = kv.split('=')
  if (k && v !== undefined) inputs[k] = Number(v)
}
const inputArg = Object.keys(inputs).length ? inputs : undefined

const outDir = path.resolve(ROOT, 'output/review')
fs.mkdirSync(outDir, { recursive: true })

function f2(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : '—'
}

async function main(): Promise<void> {
  console.log(`\n策略复盘：${sourceName}`)
  console.log(`区间  ${sinceArg} → ${untilArg}`)
  console.log(
    `口径  本金 ${capital} / 手续费 ${commission}% / 杠杆 ${leverage}x / 仓位口径 ${
      useScriptPositionSize ? '脚本 qty（TradingView）' : '引擎（权益×仓位比例×杠杆）'
    }\n`,
  )

  const rows: string[] = []
  for (const tf of tfs) {
    const params: Partial<StrategyParams> = {
      strategy: 'pine',
      initialCapital: capital,
      commissionPercent: commission,
      leverage,
      positionSizePercent: sizePct,
      slippageTicks: 0,
      useScriptPositionSize,
    }
    const t0 = Date.now()
    const result = await runBacktestService({
      exchange: 'binanceusdm',
      symbol,
      timeframe: tf,
      since,
      until,
      params,
      pine: { source, name: sourceName, inputs: inputArg },
    })
    const r = result.report
    const s = r.stats
    const out = {
      tag,
      sourceName,
      timeframe: tf,
      window: { since, until },
      fidelity: { capital, commission, leverage, sizing: useScriptPositionSize ? 'script' : 'engine' },
      inputs: inputArg ?? null,
      report: r,
      trades: result.trades,
      candles: result.candles,
      equityCurve: result.equityCurve,
    }
    const outFile = path.join(outDir, `${tag}-${tf}.json`)
    fs.writeFileSync(outFile, JSON.stringify(out), 'utf8')

    rows.push(
      `${tf.padEnd(4)} 净收益 ${f2(r.totalReturnPercent).padStart(8)}%  ` +
        `期末 ${f2(r.finalEquity).padStart(9)}  回撤 ${f2(r.maxDrawdownPercent).padStart(7)}%  ` +
        `笔数 ${String(s.totalTrades).padStart(3)}  胜率 ${f2(s.winRate).padStart(6)}%  ` +
        `盈亏比 ${f2(s.payoffRatio).padStart(5)}  盈利因子 ${f2(s.profitFactor).padStart(5)}  ` +
        `买入持有 ${f2(r.buyHoldReturnPercent).padStart(8)}%  (${Date.now() - t0}ms)`,
    )
    console.log(rows[rows.length - 1])
  }

  fs.writeFileSync(
    path.join(outDir, `${tag}-summary.json`),
    JSON.stringify({ tag, sourceName, window: { since, until }, fidelity: { capital, commission, leverage }, rows }, null, 2),
    'utf8',
  )
  console.log(`\n结果已写入 ${outDir}\n`)
}

main().catch((err) => {
  console.error('\n运行失败：', err instanceof Error ? err.message : err)
  process.exit(1)
})

/**
 * 优化参数网格扫描（双窗口，防过拟合）：同一进程内复用缓存的 K 线，遍历
 *   beAtrMult × trailAtrMult × useCrossExit
 * 组合，在「样本内年」与「样本外年」× 3 个周期上分别回测，按 6 格均值 / 最差格排序。
 *
 * 用法：npx tsx scripts/sweep-opt.ts <opt.pine> [tfs]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StrategyParams, Timeframe } from '../shared/types'
import { runBacktestService } from '../server/src/service/backtestService'
import { fetchKlines } from '../server/src/market/exchange'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const file = process.argv[2]
if (!file) { console.error('用法：npx tsx scripts/sweep-opt.ts <opt.pine> [tfs]'); process.exit(1) }
const srcPath = path.isAbsolute(file) ? file : path.resolve(ROOT, file)
const source = fs.readFileSync(srcPath, 'utf8')
const sourceName = path.basename(srcPath)
const tfs = (process.argv[3] ?? '1h 2h 4h').split(/[,;\s]+/).filter(Boolean) as Timeframe[]

const WINDOWS = [
  { name: 'IS', title: '样本内 2025-10→2026-10', since: Date.UTC(2025, 9, 13), until: Date.UTC(2026, 9, 13) },
  { name: 'OOS', title: '样本外 2024-10→2025-10', since: Date.UTC(2024, 9, 13), until: Date.UTC(2025, 9, 13) },
]
const capital = 1000, commission = 0.1, leverage = 3
const TF_MS: Record<string, number> = { '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '1d': 86_400_000 }

/** 网格：beAtrMult × useCrossExit(1=总是/2=仅浮亏) */
const grid: Array<Record<string, number>> = []
for (const be of [0, 0.5, 0.75, 1, 1.25, 1.5, 2])
  for (const cross of [1])
    grid.push({ stopLossPct: 5, beAtrMult: be, trailAtrMult: 0, trailAfterBE: 1, useCrossExit: cross, useTrendFilter: 0 })

interface Cell { win: string; tf: string; ret: number; dd: number; trades: number; winRate: number; pf: number }
interface Row { key: string; inputs: Record<string, number>; cells: Cell[]; mean: number; worst: number; ratio: number }

async function main(): Promise<void> {
  for (const w of WINDOWS) for (const tf of tfs) {
    await fetchKlines({
      exchange: 'binanceusdm', symbol: 'BTC/USDT:USDT', timeframe: tf,
      since: w.since - 400 * TF_MS[tf], until: w.until, targetBars: Math.floor((w.until - w.since) / TF_MS[tf]) + 400,
    })
  }

  const rows: Row[] = []
  for (const inputs of grid) {
    const cells: Cell[] = []
    for (const w of WINDOWS) for (const tf of tfs) {
      const params: Partial<StrategyParams> = {
        strategy: 'pine', initialCapital: capital, commissionPercent: commission,
        leverage, positionSizePercent: 100, slippageTicks: 0,
      }
      const res = await runBacktestService({
        exchange: 'binanceusdm', symbol: 'BTC/USDT:USDT', timeframe: tf,
        since: w.since, until: w.until, params,
        pine: { source, name: sourceName, inputs },
      })
      const r = res.report
      cells.push({ win: w.name, tf, ret: r.totalReturnPercent, dd: r.maxDrawdownPercent, trades: r.stats.totalTrades, winRate: r.stats.winRate, pf: r.stats.profitFactor })
    }
    const rets = cells.map((c) => c.ret)
    rows.push({
      key: `be${inputs.beAtrMult} trail${inputs.trailAtrMult} cross${inputs.useCrossExit}`,
      inputs, cells,
      mean: rets.reduce((a, b) => a + b, 0) / rets.length,
      worst: Math.min(...rets),
      ratio: rets.reduce((a, b) => a + b, 0) / cells.reduce((a, c) => a + Math.abs(c.dd), 0),
    })
  }

  const hdr = ['参数'.padEnd(26), ...WINDOWS.flatMap((w) => tfs.map((t) => `${w.name}-${t}`.padStart(12)))].join(' ')
  const line = (r: Row): string =>
    r.key.padEnd(26) + ' ' + r.cells.map((c) => `${c.ret.toFixed(1)}%/${c.trades}`.padStart(12)).join(' ')

  console.log(`\n===== 双窗口网格（${sourceName}，按 6 格均值降序）=====`)
  console.log('格式：净收益%/交易笔数  （IS=样本内年，OOS=样本外年）\n')
  console.log(hdr)
  for (const r of [...rows].sort((a, b) => b.mean - a.mean).slice(0, 20)) console.log(line(r))

  console.log('\n----- 最差格最优（minimax，前 12）-----')
  for (const r of [...rows].sort((a, b) => b.worst - a.worst).slice(0, 12)) console.log(line(r))

  console.log('\n----- 收益/回撤 比最优（前 12）-----')
  for (const r of [...rows].sort((a, b) => b.ratio - a.ratio).slice(0, 12)) console.log(line(r))

  console.log('\n----- 明细（前 8 名 + 基线）-----')
  const detail = [...rows].sort((a, b) => b.mean - a.mean).slice(0, 8)
  const baseline = rows.find((r) => r.key === 'be0 trail0 cross1')
  for (const r of baseline ? [...detail, baseline] : detail) {
    console.log(`\n  ${r.key}  mean=${r.mean.toFixed(2)}%  worst=${r.worst.toFixed(2)}%  ret/|dd|=${r.ratio.toFixed(2)}`)
    for (const c of r.cells) console.log(`    ${c.win}-${c.tf.padEnd(3)} ret=${c.ret.toFixed(2).padStart(7)}% dd=${c.dd.toFixed(2).padStart(7)}% n=${String(c.trades).padStart(3)} win=${c.winRate.toFixed(1).padStart(5)}% pf=${c.pf.toFixed(2)}`)
  }

  fs.writeFileSync(path.resolve(ROOT, 'output/review/sweep-2win.json'), JSON.stringify({ sourceName, windows: WINDOWS, rows }, null, 2), 'utf8')
  console.log('\n明细已写入 output/review/sweep-2win.json\n')
}

main().catch((e) => { console.error('失败：', e instanceof Error ? e.message : e); process.exit(1) })

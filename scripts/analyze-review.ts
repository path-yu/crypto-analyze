/**
 * 策略复盘分析：读取 strategy-review.ts 导出的逐笔交易，输出
 *   · 逐笔明细（含持仓时长、MFE/MAE、离场后价格延续）
 *   · 亏损交易共性 / 盈利交易「回吐」分析
 *   · 汇总指标（MFE 捕获率、离场后延续幅度、止损穿透等）
 *
 * 用法：npx tsx scripts/analyze-review.ts <tag> [tfs]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIR = path.resolve(ROOT, 'output/review')

const tag = process.argv[2] ?? 'base'
const tfs = (process.argv[3] ?? '1h 2h 4h 1d').split(/[,;\s]+/).filter(Boolean)
/**
 * 离场机制标注方案（由调参配置决定，无法从交易记录里直接读出）：
 *   swing：保留 EMA/SMA 死叉离场 → 离场 = 硬止损 或 死叉
 *   be   ：取消死叉离场、仅有「硬止损 + 保本止损」 → 离场 = 硬止损 或 保本
 */
const scheme: 'swing' | 'be' = (process.argv[4] as 'swing' | 'be') ?? 'swing'
/** `--quiet`：只输出汇总，不打逐笔明细（批量刷新分析 JSON 时用） */
const quiet = process.argv.includes('--quiet')

interface Candle { timestamp: number; open: number; high: number; low: number; close: number; volume: number }
interface Trade {
  id: number; side: string; entryIndex: number; exitIndex: number
  entryTime: number; exitTime: number; entryPrice: number; exitPrice: number
  qty: number; notional: number; margin: number; exitReason: string
  barsHeld: number; grossPnl: number; fee: number; netPnl: number; pnlPercent: number
  balanceAfter: number; priceChangePercent: number
  maxFavorableExcursion: number; maxAdverseExcursion: number
}

const fm = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : '—')
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
/** 离场后同类方向还能走多远（多单看后续最高价，空单看后续最低价） */
function postExit(candles: Candle[], exitIndex: number, side: string, look: number): { max: number; min: number } {
  let max = -Infinity, min = Infinity
  const end = Math.min(candles.length, exitIndex + 1 + look)
  for (let i = exitIndex + 1; i < end; i++) {
    if (candles[i].high > max) max = candles[i].high
    if (candles[i].low < min) min = candles[i].low
  }
  const ref = candles[exitIndex]?.close ?? NaN
  if (!Number.isFinite(ref)) return { max: NaN, min: NaN }
  const dir = side === 'long' ? 1 : -1
  return {
    max: ((max - ref) / ref) * 100 * dir,
    min: ((min - ref) / ref) * 100 * dir,
  }
}

const out: Record<string, unknown> = {}

for (const tf of tfs) {
  const f = path.join(DIR, `${tag}-${tf}.json`)
  if (!fs.existsSync(f)) { console.log(`跳过 ${tf}（无 ${f}）`); continue }
  const d = JSON.parse(fs.readFileSync(f, 'utf8')) as {
    report: { initialCapital: number; finalEquity: number; totalReturnPercent: number; maxDrawdownPercent: number; buyHoldReturnPercent: number; stats: Record<string, number> }
    trades: Trade[]; candles: Candle[]
  }
  const r = d.report, s = r.stats, trades = d.trades, candles = d.candles

  console.log(`\n${'='.repeat(96)}\n【${tf}】净收益 ${fm(r.totalReturnPercent)}%  期末 ${fm(r.finalEquity)}  回撤 ${fm(r.maxDrawdownPercent)}%  笔数 ${trades.length}  买入持有 ${fm(r.buyHoldReturnPercent)}%\n${'='.repeat(96)}`)

  const rows: string[] = []
  const enriched = trades.map((t) => {
    const look = tf === '1d' ? 30 : tf === '4h' ? 60 : tf === '2h' ? 120 : 240
    const pe = postExit(candles, t.exitIndex, t.side, look)
    /**
     * 离场类型：按配置方案区分机制。
     *   两种方案都用「是否吃满 -4% 以上」判定硬止损（脚本里那个几乎不触发的固定 5% 止损）；
     *   其余按方案标为死叉（swing）或保本（be）。
     */
    const kind =
      t.priceChangePercent <= -4 ? '硬止损' : scheme === 'be' ? '保本' : '死叉'
    return { t, pe, kind, giveBack: t.maxFavorableExcursion - t.priceChangePercent }
  })

  rows.push('  #  方向  开仓时间(UTC)      持仓  开仓价     平仓价     收益%   MFE%   MAE%  净额$   离场   离场后延续%')
  for (const e of enriched) {
    const t = e.t
    rows.push(
      `${String(t.id).padStart(3)}  ${t.side === 'long' ? '多' : '空'}  ${iso(t.entryTime)}  ` +
      `${String(t.barsHeld).padStart(4)}  ${fm(t.entryPrice, 1).padStart(9)}  ${fm(t.exitPrice, 1).padStart(9)}  ` +
      `${fm(t.priceChangePercent).padStart(6)}  ${fm(t.maxFavorableExcursion).padStart(6)}  ${fm(t.maxAdverseExcursion).padStart(6)}  ` +
      `${fm(t.netPnl).padStart(7)}  ${e.kind.padStart(6)}  ${fm(e.pe.max).padStart(7)}`,
    )
  }
  if (!quiet) console.log(rows.join('\n'))
  const winners = enriched.filter((e) => e.t.netPnl > 0)
  const losers = enriched.filter((e) => e.t.netPnl <= 0)
  const avg = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
  const countKind = (arr: typeof enriched, k: string): number => arr.filter((e) => e.kind === k).length

  const mfeWin = avg(winners.map((e) => e.t.maxFavorableExcursion))
  const realWin = avg(winners.map((e) => e.t.priceChangePercent))
  // 亏损单是否曾经浮盈
  const losersEverGreen = losers.filter((e) => e.t.maxFavorableExcursion >= 0.5).length
  const losersDeepGreen = losers.filter((e) => e.t.maxFavorableExcursion >= 2).length

  const summary = {
    timeframe: tf,
    netReturn: r.totalReturnPercent,
    finalEquity: r.finalEquity,
    maxDrawdown: r.maxDrawdownPercent,
    buyHold: r.buyHoldReturnPercent,
    trades: trades.length,
    winRate: s.winRate,
    profitFactor: s.profitFactor,
    payoff: s.payoffRatio,
    avgBarsHeld: avg(trades.map((t) => t.barsHeld)),
    exitSplit: {
      hardStop: countKind(enriched, '硬止损'),
      breakeven: countKind(enriched, '保本'),
      cross: countKind(enriched, '死叉'),
    },
    winners: {
      count: winners.length,
      avgMfe: mfeWin,
      avgRealized: realWin,
      captureRate: mfeWin > 0 ? (realWin / mfeWin) * 100 : NaN,
      avgGiveBack: avg(winners.map((e) => e.giveBack)),
      maxGiveBack: Math.max(...winners.map((e) => e.giveBack), 0),
    },
    losers: {
      count: losers.length,
      avgMae: avg(losers.map((e) => e.t.maxAdverseExcursion)),
      everGreen: losersEverGreen,
      deepGreen: losersDeepGreen,
      avgPostExit: avg(losers.map((e) => e.pe.max)),
      hardStop: countKind(losers, '硬止损'),
      breakeven: countKind(losers, '保本'),
      cross: countKind(losers, '死叉'),
    },
    all: {
      avgMfe: avg(trades.map((t) => t.maxFavorableExcursion)),
      avgRealized: avg(trades.map((t) => t.priceChangePercent)),
    },
  }
  out[tf] = summary

  console.log(
    `\n  汇总：盈利 ${winners.length} 笔（均 MFE ${fm(mfeWin)}% / 落地 ${fm(realWin)}% / 捕获率 ${fm(summary.winners.captureRate as number, 1)}% / 平均回吐 ${fm(summary.winners.avgGiveBack as number)}%）\n` +
    `        亏损 ${losers.length} 笔（均 MAE ${fm(summary.losers.avgMae as number)}%；曾浮盈≥0.5% ${losersEverGreen} 笔、≥2% ${losersDeepGreen} 笔；\n` +
    `                   离场构成 硬止损${summary.exitSplit.hardStop} / 保本${summary.exitSplit.breakeven} / 死叉${summary.exitSplit.cross}；离场后同向还能走 ${fm(summary.losers.avgPostExit as number)}%）`,
  )
}

fs.writeFileSync(path.join(DIR, `${tag}-analysis.json`), JSON.stringify(out, null, 2), 'utf8')
console.log(`\n分析摘要已写入 ${path.join(DIR, `${tag}-analysis.json`)}\n`)

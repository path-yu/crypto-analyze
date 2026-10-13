/**
 * PumpHunter 参数扫描（样本内 6 币 → 样本外 14 币）。
 *
 * 指标用「逐币权益收益率%」的 中位数 / 均值 / 最差 三个口径，
 * 而不是盈亏金额之和 —— 暴涨币里个别彩票单（如 AKE 一年 951 倍）会把金额之和完全带偏。
 *
 * 用法：npx tsx scripts/sweep-pump.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StrategyParams } from '../shared/types'
import { runBacktestService } from '../server/src/service/backtestService'
import { fetchKlines } from '../server/src/market/exchange'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const FILE = process.env.PUMP_FILE ?? 'server/pine/PumpHunter/PumpHunter.pine'
const source = fs.readFileSync(path.join(ROOT, FILE), 'utf8')

/** 样本内：用户点名的 6 个暴涨币 */
const IN = ['AKE/USDT:USDT', '币安人生/USDT:USDT', '龙虾/USDT:USDT', 'BANK/USDT:USDT', 'LAB/USDT:USDT', 'MYX/USDT:USDT']
/** 样本外：另外 14 个高波动 meme 币（用来检验是否过拟合） */
const OOS = [
  'PENGU/USDT:USDT', 'WIF/USDT:USDT', 'POPCAT/USDT:USDT', 'TRUMP/USDT:USDT', 'FARTCOIN/USDT:USDT',
  'MOODENG/USDT:USDT', 'PNUT/USDT:USDT', 'ACT/USDT:USDT', 'GOAT/USDT:USDT', 'NEIRO/USDT:USDT',
  'BRETT/USDT:USDT', 'TURBO/USDT:USDT', 'BOME/USDT:USDT', 'DOGS/USDT:USDT',
]
/** 真·验证集：从 745 个合约里随机抽 22 个（seed=20261013，且排除上面 20 个已参与调参的币）*/
const FRESH = [
  'API3/USDT:USDT', 'CTSI/USDT:USDT', 'V/USDT:USDT', 'HOLO/USDT:USDT', 'DDOG/USDT:USDT', 'PROM/USDT:USDT',
  'ZHIPU/USDT:USDT', 'SECZ/USDT:USDT', 'HK1810/USDT:USDT', 'GLM/USDT:USDT', 'WAL/USDT:USDT', 'O/USDT:USDT',
  'FIGHT/USDT:USDT', 'STEEM/USDT:USDT', 'KAVA/USDT:USDT', 'GIGGLE/USDT:USDT', 'ROBO/USDT:USDT', 'Q/USDT:USDT',
  'A/USDT:USDT', 'DEXE/USDT:USDT', 'SPX/USDT:USDT', 'FLUID/USDT:USDT',
]
const since = Date.UTC(2025, 9, 13)
const until = Date.UTC(2026, 9, 13)
const TF = '1h' as const

interface Stat { med: number; mean: number; worst: number; best: number; trades: number }
interface Row { key: string; g: Record<string, number>; inS: Stat; ooS: Stat }

function stat(rets: number[], trades: number): Stat {
  const s = rets.filter(Number.isFinite).sort((a, b) => a - b)
  return {
    med: s.length ? s[(s.length - 1) >> 1] : NaN,
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN,
    worst: s.length ? Math.min(...s) : NaN,
    best: s.length ? Math.max(...s) : NaN,
    trades,
  }
}

async function main(): Promise<void> {
  for (const s of [...IN, ...OOS, ...FRESH]) {
    try {
      await fetchKlines({ exchange: 'binanceusdm', symbol: s, timeframe: TF, since, until, targetBars: 9000 })
    } catch (e) {
      console.warn(`[skip warm] ${s}: ${e instanceof Error ? e.message : e}`)
    }
  }

  const run = async (g: Record<string, number>, symbols: string[]): Promise<Stat & { per: number[] }> => {
    const rets: number[] = []
    let trades = 0
    for (const s of symbols) {
      const params: Partial<StrategyParams> = {
        strategy: 'pine', initialCapital: 1000, commissionPercent: 0.055,
        leverage: 3, positionSizePercent: 100, slippageTicks: 0, useScriptPositionSize: true,
      }
      try {
        const res = await runBacktestService({
          exchange: 'binanceusdm', symbol: s, timeframe: TF, since, until, params,
          pine: { source, name: FILE, inputs: g },
        })
        rets.push(res.report.totalReturnPercent)
        trades += res.report.stats.totalTrades
      } catch {
        rets.push(NaN) // 新上币历史不足等 → 记 NaN，统计时自动剔除
      }
    }
    return { ...stat(rets, trades), per: rets }
  }

  /** `--report`：只跑脚本默认参数（= 最终推荐配置），逐币列出 */
  if (process.argv.includes('report')) {
    const rIn = await run({}, IN)
    const rOos = await run({}, OOS)
    const rFresh = await run({}, FRESH)
    console.log('\n===== 逐币结果（参数取脚本默认值）=====')
    const dump = (title: string, syms: string[], r: Stat & { per: number[] }): void => {
      const win = r.per.filter((x) => x > 0).length
      const valid = r.per.filter(Number.isFinite).length
      console.log(`\n${title}  中位 ${r.med.toFixed(1)}%  均值 ${r.mean.toFixed(1)}%  最差 ${r.worst.toFixed(1)}%  最好 ${r.best.toFixed(1)}%  为正 ${win}/${valid}  笔数 ${r.trades}`)
      syms.forEach((s, i) => {
        const v = r.per[i]
        if (!Number.isFinite(v)) { console.log(`   ${s.split('/')[0].padEnd(12)}       —（历史不足）`); return }
        const bar = '█'.repeat(Math.min(30, Math.max(0, Math.round(v / 10))))
        console.log(`   ${s.split('/')[0].padEnd(12)} ${v.toFixed(1).padStart(8)}%  ${bar}`)
      })
    }
    dump('【样本内 6 币】', IN, rIn)
    dump('【样本外 14 币（前两轮用过）】', OOS, rOos)
    dump('【★ 真·验证集：随机 22 币（从未参与调参）】', FRESH, rFresh)
    fs.mkdirSync(path.join(ROOT, 'output/pump'), { recursive: true })
    fs.writeFileSync(
      path.join(ROOT, 'output/pump/mainwave.json'),
      JSON.stringify({ FILE, IN, OOS, FRESH, inS: rIn, ooS: rOos, fresh: rFresh }, null, 2),
      'utf8',
    )
    return
  }

  /** `mw`：MainWave 网格（突破窗口 = 稀有度 × 成交量倍数）*/
  if (process.argv.includes('mw')) {
    const rows: Array<Row & { fresh: Stat }> = []
    for (const bl of [480, 720, 960, 1200, 1440])
      for (const vol of [1.5, 2.5]) {
        const g = { brkLen: bl, volMult: vol, useMA200: 1, trailPct: 25, slPct: 12, useFailStop: 0, coolBars: 48 }
        const inS = await run(g, IN)
        const ooS = await run(g, OOS)
        const fresh = await run(g, FRESH)
        rows.push({ key: `突破${bl}根(=${Math.round(bl / 24)}天) 量≥${vol}`, g, inS, ooS, fresh })
      }
    rows.sort((a, b) => b.fresh.med - a.fresh.med || b.ooS.med - a.ooS.med)
    console.log('\n===== MainWave 网格：入场稀有度（按真·验证集中位排序）=====')
    console.log(
      `${'参数'.padEnd(26)} ${'内6中位'.padStart(8)} ${'内6均值'.padStart(8)} | ` +
      `${'外14中位'.padStart(8)} ${'外14均值'.padStart(8)} | ${'新22中位'.padStart(8)} ${'新22均值'.padStart(8)} ` +
      `${'新22最差'.padStart(9)} ${'新22笔数'.padStart(9)} ${'内6笔数'.padStart(8)}`,
    )
    for (const r of rows) {
      console.log(
        `${r.key.padEnd(26)} ${r.inS.med.toFixed(0).padStart(8)} ${r.inS.mean.toFixed(0).padStart(8)} | ` +
        `${r.ooS.med.toFixed(0).padStart(8)} ${r.ooS.mean.toFixed(0).padStart(8)} | ` +
        `${r.fresh.med.toFixed(0).padStart(8)} ${r.fresh.mean.toFixed(0).padStart(8)} ${r.fresh.worst.toFixed(0).padStart(9)} ` +
        `${String(r.fresh.trades).padStart(9)} ${String(r.inS.trades).padStart(8)}`,
      )
    }
    return
  }

  const fmt = (r: Row): string =>
    `${r.key.padEnd(52)} ` +
    `${r.inS.med.toFixed(0).padStart(6)} ${r.inS.mean.toFixed(0).padStart(7)} ${r.inS.worst.toFixed(0).padStart(7)} ${String(r.inS.trades).padStart(4)} | ` +
    `${r.ooS.med.toFixed(0).padStart(6)} ${r.ooS.mean.toFixed(0).padStart(7)} ${r.ooS.worst.toFixed(0).padStart(7)} ${String(r.ooS.trades).padStart(4)}`

  const head =
    `${'参数'.padEnd(52)} ` +
    `${'样本内中位'.padStart(6)} ${'均值'.padStart(7)} ${'最差'.padStart(7)} ${'笔数'.padStart(4)} | ` +
    `${'样本外中位'.padStart(6)} ${'均值'.padStart(7)} ${'最差'.padStart(7)} ${'笔数'.padStart(4)}`

  /** `amb`：埋伏型（PumpAmbush）网格 —— 布仓位置 × 止损口径 × 移动止损宽度 */
  if (process.argv.includes('amb')) {
    const rows: Row[] = []
    for (const mp of [25, 50, 100])
      for (const ls of [0, 1])
        for (const sl of [8, 15])
          for (const tr of [10, 15]) {
            const g = { maxPos: mp, useLowStop: ls, slPct: sl, trailPct: tr }
            const inS = await run(g, IN)
            const ooS = await run(g, OOS)
            rows.push({ key: `区间下沿${mp}% 低点止损${ls} 固定止损${sl}% 移动${tr}%`, g, inS, ooS })
          }
    rows.sort((a, b) => b.ooS.med - a.ooS.med || b.inS.med - a.inS.med)
    console.log('\n===== 埋伏型网格（样本内 6 币 / 样本外 14 币）=====')
    console.log(head)
    for (const r of rows) console.log(fmt(r))
    return
  }

  /* ---------- 阶段 1：入场参数 ---------- */
  const stopDefaults = { slPct: 12, bePct: 0, trailArm: 25, trailPct: 12, maxBars: 96 }
  const rows1: Row[] = []
  for (const vol of [3, 5])
    for (const b1 of [0, 6, 12])
      for (const imp of [0, 10]) {
        const g = { notional: 1000, volMult: vol, bar1Pct: b1, impPct: imp, distMaPct: 2, useBrk: 0, ...stopDefaults }
        const inS = await run(g, IN)
        const ooS = await run(g, OOS)
        rows1.push({ key: `量${vol} 单根${b1}% 6根${imp}%`, g, inS, ooS })
      }
  rows1.sort((a, b) => b.ooS.med - a.ooS.med || b.inS.med - a.inS.med)
  console.log('\n===== 阶段 1：入场参数（离场固定 止损12% / 移动12%@浮盈25%）=====')
  console.log(head)
  for (const r of rows1) console.log(fmt(r))

  /* ---------- 阶段 2：离场参数（取阶段 1 样本外中位最优的入场）---------- */
  const bestEntry = rows1[0].g
  const rows2: Row[] = []
  for (const sl of [8, 12, 18])
    for (const arm of [0, 25, 50])
      for (const tr of [10, 15, 25]) {
        const g = { ...bestEntry, slPct: sl, bePct: 0, trailArm: arm, trailPct: tr }
        const inS = await run(g, IN)
        const ooS = await run(g, OOS)
        rows2.push({ key: `止损${sl}% 移动${tr}% 激活@${arm}%  [${rows1[0].key}]`, g, inS, ooS })
      }
  rows2.sort((a, b) => b.ooS.med - a.ooS.med || b.inS.med - a.inS.med)
  console.log('\n===== 阶段 2：离场参数 =====')
  console.log(head)
  for (const r of rows2) console.log(fmt(r))

  fs.mkdirSync(path.join(ROOT, 'output/pump'), { recursive: true })
  fs.writeFileSync(
    path.join(ROOT, 'output/pump/sweep2.json'),
    JSON.stringify({ window: { since, until }, IN, OOS, entry: rows1, exit: rows2 }, null, 2),
    'utf8',
  )
  console.log('\n明细已写入 output/pump/sweep2.json')
}

main().catch((e) => { console.error('失败：', e instanceof Error ? e.message : e); process.exit(1) })

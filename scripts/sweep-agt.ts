/**
 * AgtPump 参数扫描（单币 AGT，含时间上的训练/验证切分，防止过拟合）。
 *
 * 用法：
 *   npx tsx scripts/sweep-agt.ts entry   # 阶段1：入场参数（离场固定）
 *   npx tsx scripts/sweep-agt.ts exit    # 阶段2：离场参数（入场取阶段1最优）
 *
 * 指标口径：固定 1000 名义（脚本 qty），净收益% = 逐笔盈亏之和 / 1000。
 * 训练段 2025-10-15→2026-04-15；验证段 2026-04-15→2026-10-17。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StrategyParams } from '../shared/types'
import { runBacktestService } from '../server/src/service/backtestService'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const FILE = 'server/pine/AgtPump/AgtPump.pine'
const source = fs.readFileSync(path.join(ROOT, FILE), 'utf8')
const SYMBOL = 'AGT/USDT:USDT'
const TF = '1h' as const

const WINDOWS = [
  { name: 'FULL', since: Date.UTC(2025, 9, 15), until: Date.UTC(2026, 9, 17) },
  { name: 'TRAIN', since: Date.UTC(2025, 9, 15), until: Date.UTC(2026, 3, 15) },
  { name: 'TEST', since: Date.UTC(2026, 3, 15), until: Date.UTC(2026, 9, 17) },
]

const BASE = {
  notional: 1000, volMult: 14, brkLen: 50, impPct: 16, useRsi: 0,
  slPct: 12, trailArm: 20, trailPct: 15, maxBars: 120,
}

interface Cell { ret: number; dd: number; n: number; win: number; pf: number }

async function runOne(inputs: Record<string, number>, w: (typeof WINDOWS)[number]): Promise<Cell> {
  const params: Partial<StrategyParams> = {
    strategy: 'pine', initialCapital: 1000, commissionPercent: 0.055,
    leverage: 3, positionSizePercent: 100, slippageTicks: 0, useScriptPositionSize: true,
  }
  const res = await runBacktestService({
    exchange: 'binanceusdm', symbol: SYMBOL, timeframe: TF, since: w.since, until: w.until, params,
    pine: { source, name: FILE, inputs },
  })
  const r = res.report, s = r.stats
  return { ret: r.totalReturnPercent, dd: r.maxDrawdownPercent, n: s.totalTrades, win: s.winRate, pf: s.profitFactor }
}

async function evaluate(inputs: Record<string, number>, label: string): Promise<void> {
  const cells = await Promise.all(WINDOWS.map((w) => runOne(inputs, w)))
  const [full, train, test] = cells
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1).padStart(8) : '     —  ')
  console.log(
    `${label.padEnd(46)} 全${f(full.ret)}% (${String(full.n).padStart(2)}笔 ${full.win.toFixed(0).padStart(3)}% 回撤${full.dd.toFixed(0).padStart(4)}%) ` +
    `| 训${f(train.ret)}% | 验${f(test.ret)}%`,
  )
}

async function main(): Promise<void> {
  const stage = process.argv[2] ?? 'entry'

  console.log(`\n===== AgtPump 扫描 · ${stage} · ${SYMBOL} ${TF}（固定1000名义 / 0.055%手续费）=====`)
  console.log(`训练 ${new Date(WINDOWS[1].since).toISOString().slice(0, 10)} → ${new Date(WINDOWS[1].until).toISOString().slice(0, 10)}`
    + `  验证 ${new Date(WINDOWS[2].since).toISOString().slice(0, 10)} → ${new Date(WINDOWS[2].until).toISOString().slice(0, 10)}\n`)

  if (stage === 'entry') {
    await evaluate(BASE, '★ 基线 vol14 brk50 imp16 / sl12 trail15 arm20')
    for (const vol of [6, 8, 10, 14, 20])
      for (const brk of [20, 50, 100])
        for (const imp of [8, 12, 16, 20]) {
          const g = { ...BASE, volMult: vol, brkLen: brk, impPct: imp }
          await evaluate(g, `量≥${vol} 破${brk}新高 6根${imp}%`)
        }
    for (const rsi of [70, 75, 80]) {
      const g = { ...BASE, useRsi: rsi }
      await evaluate(g, `RSI ≥ ${rsi}（叠加）`)
    }
  } else {
    for (const arm of [0, 5, 10, 15, 20, 25, 30, 40])
      for (const tr of [12, 15, 18]) {
        const g = { ...BASE, trailArm: arm, trailPct: tr }
        await evaluate(g, `激活@浮盈${arm}% 移动${tr}% (止损12%)`)
      }
    for (const sl of [8, 10, 12, 15, 20]) {
      const g = { ...BASE, slPct: sl }
      await evaluate(g, `初始止损 ${sl}% (移动15% 激活@20%)`)
    }
  }
}

main().catch((e) => { console.error('失败：', e instanceof Error ? e.message : e); process.exit(1) })

/**
 * AGT 下跌形态两套策略的参数扫描（单币，含训练/验证时间切分）。
 *
 *   entry  做空 AgtDump 的入场参数（单根跌幅 × 量倍数 × 距MA20）
 *   exit   做空 AgtDump 的离场参数（止盈 / 移动止损 / 止损 / 时间止损）
 *   dip    做多 AgtDip  的入场参数（深跌幅度 × 单根跌幅 × 量倍数）
 *
 * 口径：固定 1000 名义（脚本 qty）；做空阶段显式 Short Only。
 * 训练段 2025-10-15→2026-04-15；验证段 2026-04-15→2026-10-17。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StrategyParams } from '../shared/types'
import { runBacktestService } from '../server/src/service/backtestService'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SYMBOL = 'AGT/USDT:USDT'
const TF = '1h' as const
const stage = process.argv[2] ?? 'entry'

const DUMP_FILE = 'server/pine/AgtDump/AgtDump.pine'
const DIP_FILE = 'server/pine/AgtDump/AgtDip.pine'
const FILE = stage === 'dip' ? DIP_FILE : DUMP_FILE
const source = fs.readFileSync(path.join(ROOT, FILE), 'utf8')

const WINDOWS = [
  { name: 'FULL', since: Date.UTC(2025, 9, 15), until: Date.UTC(2026, 9, 17) },
  { name: 'TRAIN', since: Date.UTC(2025, 9, 15), until: Date.UTC(2026, 3, 15) },
  { name: 'TEST', since: Date.UTC(2026, 3, 15), until: Date.UTC(2026, 9, 17) },
]

/** 做空 AgtDump 的默认参数 */
const BASE_DUMP = {
  notional: 1000, revPct: 8, volMult: 5, minExt: 0, brkLen: 0,
  slPct: 10, tpPct: 0, trailArm: 15, trailPct: 15, maxBars: 96,
}
/** 做多 AgtDip 的默认参数 */
const BASE_DIP = {
  notional: 1000, dropPct: 25, revPct: 6, volMult: 4,
  slPct: 10, trailArm: 15, trailPct: 15, maxBars: 96,
}

interface Cell { ret: number; dd: number; n: number; win: number; pf: number }

async function runOne(inputs: Record<string, number>, w: (typeof WINDOWS)[number]): Promise<Cell> {
  const params: Partial<StrategyParams> = {
    strategy: 'pine', initialCapital: 1000, commissionPercent: 0.055,
    leverage: 3, positionSizePercent: 100, slippageTicks: 0, useScriptPositionSize: true,
    ...(stage === 'dip' ? {} : { tradeDirection: 'Short Only' as const }),
  }
  const res = await runBacktestService({
    exchange: 'binanceusdm', symbol: SYMBOL, timeframe: TF, since: w.since, until: w.until, params,
    pine: { source, name: FILE, inputs },
  })
  const r = res.report, s = r.stats
  return { ret: r.totalReturnPercent, dd: r.maxDrawdownPercent, n: s.totalTrades, win: s.winRate, pf: s.profitFactor }
}

async function evaluate(inputs: Record<string, number>, label: string): Promise<void> {
  const [full, train, test] = await Promise.all(WINDOWS.map((w) => runOne(inputs, w)))
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1).padStart(8) : '     —  ')
  console.log(
    `${label.padEnd(40)} 全${f(full.ret)}% (${String(full.n).padStart(2)}笔 ${full.win.toFixed(0).padStart(3)}% 回撤${full.dd.toFixed(0).padStart(4)}% PF${full.pf.toFixed(1).padStart(5)}) ` +
    `| 训${f(train.ret)}% | 验${f(test.ret)}%`,
  )
}

async function main(): Promise<void> {
  console.log(`\n===== ${path.basename(FILE)} 扫描 · ${stage} · ${SYMBOL} ${TF}（固定1000名义 / 0.055%）=====\n`)

  if (stage === 'dip') {
    await evaluate(BASE_DIP, '★ 基线 跌25% 单根6% 量4')
    for (const drop of [20, 25, 30, 35])
      for (const rev of [6, 8, 10])
        for (const vol of [4, 5, 8]) {
          await evaluate({ ...BASE_DIP, dropPct: drop, revPct: rev, volMult: vol }, `跌${drop}% 单根${rev}% 量${vol}`)
        }
  } else if (stage === 'exit') {
    for (const tp of [0, 8, 12, 16, 20]) await evaluate({ ...BASE_DUMP, tpPct: tp }, `止盈 ${tp}%`)
    for (const arm of [0, 10])
      for (const tr of [8, 15]) await evaluate({ ...BASE_DUMP, trailArm: arm, trailPct: tr }, `激活@浮盈${arm}% 移动${tr}%`)
    for (const sl of [6, 10, 15]) await evaluate({ ...BASE_DUMP, slPct: sl }, `初始止损 ${sl}%`)
    for (const mb of [48, 168, 336]) await evaluate({ ...BASE_DUMP, maxBars: mb }, `时间止损 ${mb} 根`)
  } else {
    await evaluate(BASE_DUMP, '★ 基线 rev8 vol5 minExt0')
    for (const rev of [8, 12])
      for (const vol of [5, 12])
        for (const ext of [0, 15, 25]) await evaluate({ ...BASE_DUMP, revPct: rev, volMult: vol, minExt: ext }, `单根跌≥${rev}% 量≥${vol} 距MA20≥${ext}%`)
  }
}

main().catch((e) => { console.error('失败：', e instanceof Error ? e.message : e); process.exit(1) })

/**
 * 交叉验证：PineTS（第三方 Pine Script 运行时） × 本仓库自研 Pine 编译器。
 *
 * 做法：同一份 .pine、同一批 K 线、同一份回测参数，分别驱动既有回测引擎，
 * 然后比对「逐 bar 信号」与「逐笔交易记录」。
 *
 * 差异分两类：
 *   · 精度差异 —— PineTS 把 plot 数值截断到 10 位小数，自研保留完整 double；
 *     相对误差 ≤ 1e-9，视为「同值」。
 *   · 实质差异 —— 布尔取值不同，或数值相对误差 > 1e-6。
 *
 * 若检测到实质差异且脚本用到了 session.isfirstbar，脚本会自动再跑一遍「归因对比」：
 * 把 session.isfirstbar 替换为 (bar_index == 0) 后再比，用来判断差异是否全部由它引起。
 *
 * 用法：
 *   pnpm compare:pinets
 *   pnpm compare:pinets --bars 800
 *   pnpm compare:pinets --live --symbol BTC/USDT:USDT --timeframe 1h --bars 3000
 *   pnpm compare:pinets --pine server/pine/test.pine
 *
 * 退出码：无实质差异 → 0；存在实质差异 → 1。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Candle, ExchangeId, StrategyParams, Timeframe } from '../shared/types'
import { compilePine, emptyPineSignal, runPineProgram, type PineSignal } from '../server/src/pine'
import { runBacktest } from '../server/src/backtest/engine'
import { normalizeParams } from '../server/src/service/backtestService'
import { fetchKlines } from '../server/src/market/exchange'
import { PineTS } from 'pinets'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = 'true'
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

const PINE_FILE = path.resolve(ROOT, args.pine ?? 'server/pine/test1.pine')
const BARS = args.bars ? Number(args.bars) : 400
const TICK = args.tick ? Number(args.tick) : 0.1
const LIVE = args.live === 'true'
const EXCHANGE = (args.exchange ?? 'binanceusdm') as ExchangeId
const SYMBOL = args.symbol ?? 'BTC/USDT:USDT'
const TIMEFRAME = (args.timeframe ?? '1h') as Timeframe

/** PineTS 把 plot 数值截断到 10 位小数；相对误差在此以内视为同值 */
const REL_EPS = 1e-9
/** 相对误差超过此阈值才计为「实质差异」 */
const MATERIAL_EPS = 1e-6

/* ------------------------------------------------------------------ */
/* K 线                                                                */
/* ------------------------------------------------------------------ */

/** 确定性伪随机 K 线（线性同余），反复运行结果一致，不依赖网络 */
function synthCandles(n: number): Candle[] {
  let seed = 20261012
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const out: Candle[] = []
  let price = 100
  let t = Date.UTC(2025, 0, 1)
  for (let i = 0; i < n; i++) {
    const open = price
    // 每 12 根切换一次趋势方向，制造连续同色 K 线 → 触发连续性突破信号
    const dir = Math.floor(i / 12) % 2 === 0 ? 1 : -1
    const close = open + dir * (0.5 + rnd() * 0.9) + (rnd() - 0.5) * 0.6
    out.push({
      timestamp: t,
      open,
      high: Math.max(open, close) + rnd() * 0.5,
      low: Math.min(open, close) - rnd() * 0.5,
      close,
      volume: 1000 + Math.round(rnd() * 500),
    })
    price = close
    t += 3600_000
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const toNum = (v: unknown): number => {
  if (v === null || v === undefined) return Number.NaN
  const n = Number(v)
  return Number.isFinite(n) ? n : Number.NaN
}

type Verdict = 'same' | 'precision' | 'material'

function compareNum(a: number, b: number): Verdict {
  if (Object.is(a, b)) return 'same'
  if (Number.isNaN(a) || Number.isNaN(b)) return 'material'
  const scale = Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE)
  const rel = Math.abs(a - b) / scale
  if (rel <= REL_EPS) return 'precision'
  return rel <= MATERIAL_EPS ? 'precision' : 'material'
}

function fmtTime(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ')
}

function fmtNum(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—'
}

/** 信号的可比对切片 */
interface SigSlice {
  canLong: boolean
  canShort: boolean
  obStopLoss: number
  obTakeProfit: number
  obRisk: number
}

const SIG_FIELDS: Array<keyof SigSlice> = ['canLong', 'canShort', 'obStopLoss', 'obTakeProfit', 'obRisk']

function slice(s: PineSignal): SigSlice {
  return {
    canLong: !!s.canLong,
    canShort: !!s.canShort,
    obStopLoss: toNum(s.obStopLoss),
    obTakeProfit: toNum(s.obTakeProfit),
    obRisk: toNum(s.obRisk),
  }
}

/** 从 PineTS 的 plots 里取某条 plot 的逐 bar 数值 */
function plotValues(
  plots: Record<string, { data?: Array<{ value?: unknown }> }>,
  title: string,
  n: number,
): number[] {
  const data = plots?.[title]?.data
  const out = new Array<number>(n).fill(Number.NaN)
  if (!Array.isArray(data)) return out
  for (let i = 0; i < n && i < data.length; i++) out[i] = toNum(data[i]?.value)
  return out
}

/* ------------------------------------------------------------------ */
/* 单轮对比                                                            */
/* ------------------------------------------------------------------ */

interface TradeRow {
  side: string
  entryIndex: number
  exitIndex: number
  entryPrice: number
  exitPrice: number
  qty: number
  netPnl: number
  exitReason: string
  fills: number
}

interface RoundResult {
  label: string
  /** 自研 / PineTS 的买、卖信号 bar 列表 */
  mineBuyBars: number[]
  mineSellBars: number[]
  tsBuyBars: number[]
  tsSellBars: number[]
  signalPrecision: string[]
  signalMaterial: string[]
  mineTrades: TradeRow[]
  tsTrades: TradeRow[]
  mineTradeBars: Array<{ entryIndex: number; exitIndex: number }>
  tradePrecision: string[]
  tradeMaterial: string[]
}

async function runRound(
  label: string,
  source: string,
  candles: Candle[],
  params: StrategyParams,
): Promise<RoundResult> {
  const n = candles.length

  // ---- ① 自研编译器 ----
  const comp = compilePine(source, { sourceName: path.basename(PINE_FILE) })
  const errors = comp.diagnostics.filter((d) => d.severity === 'error')
  if (errors.length) {
    console.error(`\n[${label}] 自研编译失败：`)
    for (const d of errors) console.error(`  第 ${d.line} 行 第 ${d.column} 列 · ${d.message}`)
    process.exit(2)
  }
  const program = runPineProgram(comp.ts, candles, { tickSize: TICK })
  const FLAT = { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: Number.NaN, side: null }
  const mineSlices: SigSlice[] = []
  for (let i = 0; i < n; i++) mineSlices.push(slice(program.step(i, FLAT as never)))

  // ---- ② PineTS ----
  const pineTS = new PineTS(candles.map((c) => ({ ...c, openTime: c.timestamp })))
  const pineRes = (await pineTS.run(source)) as unknown as {
    plots: Record<string, { data?: Array<{ value?: unknown }> }>
  }
  const buy = plotValues(pineRes.plots, 'Buy Signal', n)
  const sell = plotValues(pineRes.plots, 'Sell Signal', n)
  const sl = plotValues(pineRes.plots, 'Active Stop Loss Line', n)

  const tsSlices: SigSlice[] = []
  for (let i = 0; i < n; i++) {
    const hasBuy = Number.isFinite(buy[i])
    const hasSell = Number.isFinite(sell[i])
    const hasSl = Number.isFinite(sl[i])
    tsSlices.push({
      canLong: hasBuy,
      canShort: hasSell,
      obStopLoss: hasSl ? sl[i] : Number.NaN,
      obTakeProfit: Number.NaN,
      // 与自研指标脚本 epilogue 保持一致：|close − sl|，仅当买信号与止损线同时存在
      obRisk: hasBuy && hasSl ? Math.abs(candles[i].close - sl[i]) : Number.NaN,
    })
  }

  // ---- ③ 信号级 ----
  const signalPrecision: string[] = []
  const signalMaterial: string[] = []
  for (let i = 0; i < n; i++) {
    for (const f of SIG_FIELDS) {
      const a = tsSlices[i][f]
      const b = mineSlices[i][f]
      const v: Verdict =
        typeof a === 'boolean' ? (a === b ? 'same' : 'material') : compareNum(a as number, b as number)
      if (v === 'same') continue
      const line = `  bar ${String(i).padStart(5)} · ${f}: PineTS=${String(a)} 自研=${String(b)}`
      ;(v === 'precision' ? signalPrecision : signalMaterial).push(line)
    }
  }

  // ---- ④ 交易级 ----
  const buildSignals = (s: SigSlice[]): PineSignal[] => s.map((x) => ({ ...emptyPineSignal(), ...x }))
  const row = (t: ReturnType<typeof runBacktest>['trades'][number]): TradeRow => ({
    side: t.side,
    entryIndex: t.entryIndex,
    exitIndex: t.exitIndex,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    qty: t.qty,
    netPnl: t.netPnl,
    exitReason: t.exitReason,
    fills: t.fills.length,
  })

  const mineRaw = runBacktest({
    candles,
    series: { signals: buildSignals(mineSlices) },
    params,
    tickSize: TICK,
  }).trades
  const tsRaw = runBacktest({
    candles,
    series: { signals: buildSignals(tsSlices) },
    params,
    tickSize: TICK,
  }).trades

  const mineTrades = mineRaw.map(row)
  const tsTrades = tsRaw.map(row)

  const tradePrecision: string[] = []
  const tradeMaterial: string[] = []
  if (mineTrades.length !== tsTrades.length) {
    tradeMaterial.push(`  交易笔数不同：PineTS=${tsTrades.length} 自研=${mineTrades.length}`)
  }
  for (let k = 0; k < Math.min(mineTrades.length, tsTrades.length); k++) {
    const a = tsTrades[k]
    const b = mineTrades[k]
    for (const key of Object.keys(a) as Array<keyof TradeRow>) {
      const va = a[key]
      const vb = b[key]
      const v: Verdict =
        typeof va === 'number' ? compareNum(va, vb as number) : va === vb ? 'same' : 'material'
      if (v === 'same') continue
      const line = `  #${k + 1} ${key}: PineTS=${String(va)} 自研=${String(vb)}`
      ;(v === 'precision' ? tradePrecision : tradeMaterial).push(line)
    }
  }

  const bars = (s: SigSlice[], f: 'canLong' | 'canShort') =>
    s.map((x, i) => (x[f] ? i : -1)).filter((i) => i >= 0)

  return {
    label,
    mineBuyBars: bars(mineSlices, 'canLong'),
    mineSellBars: bars(mineSlices, 'canShort'),
    tsBuyBars: bars(tsSlices, 'canLong'),
    tsSellBars: bars(tsSlices, 'canShort'),
    signalPrecision,
    signalMaterial,
    mineTrades,
    tsTrades,
    mineTradeBars: mineTrades.map((t) => ({ entryIndex: t.entryIndex, exitIndex: t.exitIndex })),
    tradePrecision,
    tradeMaterial,
  }
}

/* ------------------------------------------------------------------ */
/* 报告                                                                */
/* ------------------------------------------------------------------ */

const LINE = '══════════════════════════════════════════════════════════'

function reportSignal(r: RoundResult, n: number): void {
  console.log(`── 信号级（逐 bar × ${SIG_FIELDS.length} 字段）──`)
  const total = r.signalPrecision.length + r.signalMaterial.length
  if (total === 0) {
    console.log(`✅ 完全一致：${n} 根 K 线 × ${SIG_FIELDS.length} 字段，逐值相同`)
  } else if (r.signalMaterial.length === 0) {
    console.log(`✅ 语义一致：${n} 根 K 线 × ${SIG_FIELDS.length} 字段无实质差异`)
    console.log(`   （另有 ${r.signalPrecision.length} 处仅浮点精度差异，相对误差 ≤ ${REL_EPS}）`)
  } else {
    console.log(`❌ 实质差异 ${r.signalMaterial.length} 处：`)
    for (const m of r.signalMaterial.slice(0, 15)) console.log(m)
    if (r.signalMaterial.length > 15) console.log(`  … 另有 ${r.signalMaterial.length - 15} 处`)
    if (r.signalPrecision.length) console.log(`   （另有 ${r.signalPrecision.length} 处仅浮点精度差异）`)
  }
  const list = (a: number[]) => (a.length ? a.join(',') : '无')
  console.log(`自研 买信号 bar(${r.mineBuyBars.length}): ${list(r.mineBuyBars)}`)
  console.log(`PineTS 买信号 bar(${r.tsBuyBars.length}): ${list(r.tsBuyBars)}`)
  console.log(`自研 卖信号 bar(${r.mineSellBars.length}): ${list(r.mineSellBars)}`)
  console.log(`PineTS 卖信号 bar(${r.tsSellBars.length}): ${list(r.tsSellBars)}`)
  console.log('')
}

function reportTrades(r: RoundResult): void {
  console.log('── 交易级（同一回测引擎 + 同一份参数）──')
  const total = r.tradePrecision.length + r.tradeMaterial.length
  if (total === 0) {
    console.log(`✅ 完全一致：两侧各 ${r.mineTrades.length} 笔，逐笔全字段相同`)
  } else if (r.tradeMaterial.length === 0) {
    console.log(`✅ 语义一致：两侧各 ${r.mineTrades.length} 笔，逐笔全字段无实质差异`)
    console.log(`   （另有 ${r.tradePrecision.length} 处仅浮点精度差异）`)
  } else {
    console.log(`❌ 实质差异 ${r.tradeMaterial.length} 处：`)
    for (const m of r.tradeMaterial.slice(0, 15)) console.log(m)
    if (r.tradeMaterial.length > 15) console.log(`  … 另有 ${r.tradeMaterial.length - 15} 处`)
    if (r.tradePrecision.length) console.log(`   （另有 ${r.tradePrecision.length} 处仅浮点精度差异）`)
  }
  console.log('')
}

function dump(label: string, candles: Candle[], list: TradeRow[]): void {
  console.log(`${label}（${list.length} 笔）`)
  console.log('  #  方向   入场时间          入场价      出场时间          出场价      数量       净盈亏     平仓原因')
  list.forEach((t, k) => {
    console.log(
      `  ${String(k + 1).padStart(2)}  ${t.side === 'long' ? '多' : '空'}   ` +
        `${fmtTime(candles[t.entryIndex].timestamp)}   ${fmtNum(t.entryPrice, 2).padStart(10)}  ` +
        `${fmtTime(candles[t.exitIndex].timestamp)}   ${fmtNum(t.exitPrice, 2).padStart(10)}  ` +
        `${fmtNum(t.qty, 6).padStart(9)}  ${fmtNum(t.netPnl, 2).padStart(9)}   ${t.exitReason}`,
    )
  })
  console.log('')
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const rawSource = fs.readFileSync(PINE_FILE, 'utf8')

  // ---- 取 K 线 ----
  let candles: Candle[]
  let dataLabel: string
  if (LIVE) {
    console.log(`\n拉取行情 ${EXCHANGE} ${SYMBOL} ${TIMEFRAME} × ${BARS} …`)
    const res = await fetchKlines({
      exchange: EXCHANGE,
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      until: Date.now(),
      targetBars: BARS,
      useCache: true,
    })
    candles = res.candles
    dataLabel = `${res.exchange} ${SYMBOL} ${TIMEFRAME}（真实行情，cached=${res.cached}）`
  } else {
    candles = synthCandles(BARS)
    dataLabel = `合成确定性 K 线（LCG，${BARS} 根）`
  }
  const n = candles.length
  const params: StrategyParams = normalizeParams({ strategy: 'pine' })

  // ---- 第 1 轮：原样 ----
  const t0 = Date.now()
  const base = await runRound('原样', rawSource, candles, params)
  const elapsed = Date.now() - t0

  console.log(`\n${LINE}`)
  console.log(' PineTS × 自研编译器  交叉验证')
  console.log(LINE)
  console.log(`脚本          ${path.relative(ROOT, PINE_FILE)}`)
  console.log(`数据源        ${dataLabel}`)
  console.log(`K 线数量      ${n}`)
  console.log(`耗时          ${elapsed} ms（含两侧编译与两次回测）`)
  console.log(`回测参数      strategy=pine, exit=${params.exitStrategy}, 杠杆=${params.leverage}x, 仓位=${params.positionSizePercent}%, 手续费=${params.commissionPercent}%, 滑点=${params.slippageTicks} tick, tickSize=${TICK}`)
  console.log('')
  console.log(`【第 1 轮】脚本原样`)
  console.log('')
  reportSignal(base, n)
  reportTrades(base)

  const baseMaterial = base.signalMaterial.length + base.tradeMaterial.length

  // ---- 第 2 轮：只在存在实质差异且脚本用到 session.isfirstbar 时归因 ----
  const usesFirstbar = rawSource.includes('session.isfirstbar')
  let aligned: RoundResult | null = null
  if (baseMaterial > 0 && usesFirstbar) {
    const patched = rawSource.replaceAll('session.isfirstbar', '(bar_index == 0)')
    aligned = await runRound('对齐 session.isfirstbar', patched, candles, params)
    console.log(`【第 2 轮 · 归因】把 session.isfirstbar 替换为 (bar_index == 0) 后重跑`)
    console.log('')
    reportSignal(aligned, n)
    reportTrades(aligned)
  }

  // ---- 交易明细 ----
  if (baseMaterial === 0) {
    dump('交易历史（两侧一致）', candles, base.mineTrades)
  } else {
    dump('自研编译器侧交易历史', candles, base.mineTrades)
    dump('PineTS 侧交易历史', candles, base.tsTrades)
  }

  // ---- 结论 ----
  const alignedMaterial = aligned ? aligned.signalMaterial.length + aligned.tradeMaterial.length : -1
  console.log(LINE)
  if (baseMaterial === 0) {
    console.log('结论：✅ 两侧逐 bar 信号与逐笔交易记录完全一致')
  } else if (aligned && alignedMaterial === 0) {
    console.log('结论：⚠️ 两侧存在实质差异，且已完整归因于 session.isfirstbar 的语义分歧')
    console.log('      · 自研：只有数据集首根 bar 视为 isfirstbar')
    console.log('      · PineTS：每个交易时段（本例按自然日）首根 bar 均视为 isfirstbar')
    console.log('      · 一旦把该语义对齐，两侧逐 bar 信号与逐笔交易记录即完全一致')
  } else {
    console.log('结论：❌ 存在未被 session.isfirstbar 解释的实质差异，见上方明细')
  }
  console.log(LINE)
  console.log('')

  process.exit(baseMaterial === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n运行失败：', err instanceof Error ? err.message : err)
  if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(1, 6).join('\n'))
  process.exit(2)
})
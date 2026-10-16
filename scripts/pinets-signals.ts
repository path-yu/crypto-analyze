/**
 * PineTS-only 回归基线：**只用 PineTS 适配层**跑 Pine 脚本 → 自研引擎 → 输出逐笔 JSON。
 *
 * 与 `scripts/pinets-parity.ts` 的区别：那个脚本拿旧编译器做对拍（其使命在旧编译器
 * 删除后即结束）；本脚本只依赖现行实现（`runPineTsSignals`），可长期当作回归基线 ——
 * 改动适配层后重跑一次，对比逐笔结果有无漂移。
 *
 * 用法：
 *   npx tsx scripts/pinets-signals.ts --pine server/pine/MainWave/MainWave.v6.pine --bars 3000
 *   npx tsx scripts/pinets-signals.ts --live --symbol BTC/USDT:USDT --timeframe 1h --bars 3000 \
 *                                    --pine server/pine/MainWave/MainWave.v6.pine --json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Candle, StrategyParams } from '../shared/types'
import { runPineTsSignals } from '../server/src/pine/pinetsAdapter'
import { runBacktest } from '../server/src/backtest/engine'
import { normalizeParams } from '../server/src/service/backtestService'
import { fetchKlines } from '../server/src/market/exchange'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { out[a.slice(2)] = next; i++ } else out[a.slice(2)] = 'true'
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const PINE = path.resolve(ROOT, args.pine ?? 'server/pine/MainWave/MainWave.v6.pine')
const BARS = args.bars ? Number(args.bars) : 3000
const LIVE = args.live === 'true'
const SYMBOL = args.symbol ?? 'BTC/USDT:USDT'
const TIMEFRAME = args.timeframe ?? '1h'
const CAPITAL = args.capital ? Number(args.capital) : 1000
/** 引擎口径：是否采纳脚本 `strategy.entry(qty=…)` 的下单量 */
const USE_SCRIPT_SIZE = args.scriptSize !== 'false'

/** 确定性合成 K 线（与 studio 内的极性数据同款，供离线回归） */
function synthCandles(n: number): Candle[] {
  let seed = 20261012
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const out: Candle[] = []
  let price = 100
  let t = Date.UTC(2025, 0, 1)
  for (let i = 0; i < n; i++) {
    const open = price
    const dir = Math.floor(i / 12) % 2 === 0 ? 1 : -1
    const close = open + dir * (0.5 + rnd() * 0.9) + (rnd() - 0.5) * 0.6
    out.push({
      timestamp: t, open, high: Math.max(open, close) + rnd() * 0.5,
      low: Math.min(open, close) - rnd() * 0.5, close, volume: 1000 + Math.round(rnd() * 500),
    })
    price = close
    t += 3600_000
  }
  return out
}

async function main(): Promise<void> {
  const source = fs.readFileSync(PINE, 'utf8')
  const candles = LIVE
    ? (await fetchKlines({
        exchange: 'binanceusdm', symbol: SYMBOL, timeframe: TIMEFRAME as never,
        until: args.until ? Number(args.until) : Date.now(), targetBars: BARS, useCache: true,
      })).candles
    : synthCandles(BARS)

  const run = await runPineTsSignals(source, candles, {
    tickerId: `BINANCE:${SYMBOL}`,
    timeframe: TIMEFRAME,
  })

  const errors = run.diagnostics.filter((d) => d.severity === 'error')
  const warnings = [...run.warnings]
  if (!USE_SCRIPT_SIZE) for (const s of run.signals) s.entryQty = Number.NaN

  const params: StrategyParams = normalizeParams({ strategy: 'pine', initialCapital: CAPITAL })
  const { trades, equityCurve } = errors.length
    ? { trades: [], equityCurve: [] }
    : runBacktest({ candles, series: { signals: run.signals }, params, tickSize: 0.1 })

  const nLong = run.signals.filter((s) => s.canLong).length
  const nShort = run.signals.filter((s) => s.canShort).length
  const nClose = run.signals.filter((s) => s.forceClose).length
  const netPnl = trades.reduce((a, t) => a + t.netPnl, 0)

  if (args.json === 'true') {
    console.log(JSON.stringify({
      pine: path.relative(ROOT, PINE),
      bars: candles.length,
      live: LIVE,
      symbol: LIVE ? SYMBOL : null,
      timeframe: TIMEFRAME,
      meta: {
        kind: run.meta.kind,
        inputs: run.meta.inputs.map((i) => `${i.name}:${i.type}=${String(i.default)}`),
        plotTitles: run.meta.plotTitles,
      },
      diagnostics: run.diagnostics,
      warnings,
      signals: { canLong: nLong, canShort: nShort, forceClose: nClose },
      markers: run.markers.length,
      plots: Object.keys(run.plots),
      summary: {
        trades: trades.length,
        netPnl: Number(netPnl.toFixed(6)),
        finalEquity: equityCurve.length ? equityCurve[equityCurve.length - 1].equity : null,
      },
      tradeList: trades.map((t) => ({
        side: t.side, entryIndex: t.entryIndex, exitIndex: t.exitIndex,
        entryPrice: t.entryPrice, exitPrice: t.exitPrice, qty: t.qty,
        netPnl: Number(t.netPnl.toFixed(6)), exitReason: t.exitReason,
      })),
    }, null, 2))
    return
  }

  console.log(`\n脚本 ${path.relative(ROOT, PINE)}`)
  console.log(`数据 ${LIVE ? `${SYMBOL} ${TIMEFRAME}（真实行情）` : '合成 K 线'} × ${candles.length}`)
  console.log(`声明 ${run.meta.kind} · input ${run.meta.inputs.length} 个 · plot ${run.meta.plotTitles.length} 条`)
  if (run.meta.inputs.length) {
    console.log(`  input: ${run.meta.inputs.map((i) => `${i.name}(${i.type})=${String(i.default)}`).join(', ')}`)
  }
  if (errors.length) {
    for (const d of errors) console.log(`  ✘ L${d.line}:C${d.column} ${d.message}`)
  }
  for (const w of warnings) console.log(`  ⚠ ${w}`)
  console.log(`信号 canLong=${nLong} canShort=${nShort} forceClose=${nClose}  标记 ${run.markers.length}  命名 plot ${Object.keys(run.plots).length}`)
  console.log(`逐笔 ${trades.length} 笔 · 净盈亏 ${netPnl.toFixed(2)} · 末权益 ${equityCurve.length ? equityCurve[equityCurve.length - 1].equity.toFixed(2) : '—'}`)
  console.log(
    `\n结论：${errors.length ? '❌ 脚本执行失败' : trades.length ? '✅ 产出可回测信号' : '⚠ 脚本执行成功但零成交'}\n`,
  )
}

main().catch((e) => {
  console.error('\n失败：', e instanceof Error ? e.message : e)
  if (e instanceof Error && e.stack) console.error(e.stack.split('\n').slice(1, 6).join('\n'))
  process.exit(1)
})

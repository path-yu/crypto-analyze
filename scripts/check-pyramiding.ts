/**
 * 复核 2026-10-12 附近的交易笔数。
 *
 * 背景：TradingView 在 2026-10-12 记录到 4 笔交易
 *   #75 做空 02:00 → 03:00
 *   #76 做空 02:00 → 08:00
 *   #77 做空 02:00 → 10:00
 *   #78 做多 10:00 → 11:00
 * 而本项目改造前只有 2 笔（#35 空、#36 多）。
 *
 * 用法：pnpm exec tsx scripts/check-pyramiding.ts [pyramiding]
 */
import { fetchKlines } from '../server/src/market/exchange'
import { DEFAULT_STRATEGY_PARAMS, TIMEFRAME_MS, type Candle, type Timeframe } from '../shared/types'
import { computeFibTrendSeries } from '../server/src/indicators/fibTrendReversal'
import { runBacktest } from '../server/src/backtest/engine'

const SYMBOL = 'BTC/USDT:USDT'
const TF: Timeframe = '1h'
/** 目标时间点：2026-10-12（北京时间） */
const DAY = Date.parse('2026-10-12T00:00:00+08:00')

async function load(pyramiding: number) {
  const tfMs = TIMEFRAME_MS[TF]
  const until = DAY + 2 * 86400_000
  const warmupBars = 200
  const since = DAY - 30 * 86400_000

  const r = await fetchKlines({
    exchange: 'binanceusdm',
    symbol: SYMBOL,
    timeframe: TF,
    since: since - warmupBars * tfMs,
    until,
    targetBars: 5000,
    useCache: false,
  })

  const candles: Candle[] = r.candles
  let tradeFromIndex = 0
  while (tradeFromIndex < candles.length && candles[tradeFromIndex].timestamp < since) {
    tradeFromIndex++
  }

  const series = computeFibTrendSeries(candles, {
    sensitivity: DEFAULT_STRATEGY_PARAMS.sensitivity,
    atrLength: DEFAULT_STRATEGY_PARAMS.atrLength,
    atrSmoothing: DEFAULT_STRATEGY_PARAMS.atrSmoothing,
    atrMultiplier: DEFAULT_STRATEGY_PARAMS.atrMultiplier,
  })

  const { trades } = runBacktest({
    candles,
    series,
    params: { ...DEFAULT_STRATEGY_PARAMS, pyramiding },
    tradeFromIndex,
  })

  return { trades, source: r.sourceLabel ?? '（ccxt）', total: candles.length }
}

function fmt(ts: number) {
  // 转成北京时间便于与 TradingView 对照
  return new Date(ts + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')
}

async function main() {
  const pArg = process.argv[2]
  const cases = pArg ? [Number(pArg)] : [1, 2, 3, 5]

  console.log('\n  2026-10-12 交易笔数复核（BTC 1h）')
  console.log('='.repeat(74))

  let firstSource = ''
  for (const p of cases) {
    const { trades, source, total } = await load(p)
    if (!firstSource) firstSource = source

    const dayTrades = trades.filter(
      (t) => t.entryTime >= DAY && t.entryTime < DAY + 86400_000,
    )

    console.log(`\n  金字塔式 = ${p}`)
    console.log(`    全区间交易 ${trades.length} 笔（数据源 ${source}，${total.toLocaleString()} 根）`)
    console.log(`    2026-10-12 当日交易 ${dayTrades.length} 笔：`)
    for (const t of dayTrades) {
      const e = t.entryPrice.toFixed(1)
      const x = t.exitPrice.toFixed(1)
      console.log(
        `      ${String(t.id).padStart(3)} ${t.side === 'short' ? '做空' : '做多'}  ` +
          `${fmt(t.entryTime)} → ${fmt(t.exitTime)}  ${e} → ${x}  ` +
          `${t.netPnl >= 0 ? '+' : ''}${t.netPnl.toFixed(2)} USDT  [${t.exitReason}]`,
      )
    }
  }

  console.log('\n  TradingView 参照（4 笔）：')
  console.log('      75 做空  10-12 02:00 → 03:00  83,643.1')
  console.log('      76 做空  10-12 02:00 → 08:00  83,643.1')
  console.log('      77 做空  10-12 02:00 → 10:00  83,643.1')
  console.log('      78 做多  10-12 10:00 → 11:00')
  console.log()
}

main().catch((e) => {
  console.error('异常：', e)
  process.exit(1)
})

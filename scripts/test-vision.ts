/**
 * 验证 Binance Data Vision 全历史源接入效果。
 *
 * 对比同一个区间在「旧路径（ccxt 交易所）」与「新路径（Vision 全历史）」
 * 下的可得根数与交易样本量。
 *
 * 用法：pnpm exec tsx scripts/test-vision.ts
 */
import { fetchKlines } from '../server/src/market/exchange'
import { DEFAULT_STRATEGY_PARAMS, type Timeframe } from '../shared/types'
import { computeFibTrendSeries } from '../server/src/indicators/fibTrendReversal'
import { runBacktest } from '../server/src/backtest/engine'

const SYMBOL = 'BTC/USDT:USDT'
const SINCE = Date.parse('2025-01-01T00:00:00+08:00')
const UNTIL = Date.parse('2026-10-12T23:59:00+08:00')

const CASES: Timeframe[] = ['15m', '30m', '1h', '4h']

async function main() {
  console.log('\n  Binance Data Vision 全历史源验证')
  console.log(`  品种 ${SYMBOL}  区间 2025-01-01 → 2026-10-12`)
  console.log('='.repeat(74))

  for (const tf of CASES) {
    const t0 = Date.now()
    try {
      const r = await fetchKlines({
        exchange: 'binanceusdm',
        symbol: SYMBOL,
        timeframe: tf,
        since: SINCE,
        until: UNTIL,
        targetBars: 60_000,
        useCache: false,
      })
      const ms = Date.now() - t0
      const from = new Date(r.candles[0].timestamp).toISOString().slice(0, 16)
      const to = new Date(r.candles.at(-1)!.timestamp).toISOString().slice(0, 16)
      const days = Math.round((r.candles.at(-1)!.timestamp - r.candles[0].timestamp) / 86400_000)

      console.log(`\n  ${tf}`)
      console.log(`    来源    ${r.sourceLabel ?? '（ccxt 交易所）'}`)
      console.log(`    根数    ${r.candles.length.toLocaleString()}   耗时 ${ms}ms`)
      console.log(`    区间    ${from} → ${to}  (${days} 天)`)

      // 直接跑一次回测，看能出多少笔交易
      const series = computeFibTrendSeries(r.candles, {
        sensitivity: DEFAULT_STRATEGY_PARAMS.sensitivity,
        atrLength: DEFAULT_STRATEGY_PARAMS.atrLength,
        atrSmoothing: DEFAULT_STRATEGY_PARAMS.atrSmoothing,
        atrMultiplier: DEFAULT_STRATEGY_PARAMS.atrMultiplier,
      })
      const { trades } = runBacktest({
        candles: r.candles,
        series,
        params: DEFAULT_STRATEGY_PARAMS,
        tradeFromIndex: 0,
      })
      const wins = trades.filter((t) => t.netPnl > 0).length
      const ret = trades.reduce((a, t) => a + t.netPnl, 0)
      console.log(
        `    交易    ${trades.length} 笔   胜率 ${trades.length ? ((wins / trades.length) * 100).toFixed(2) : '0'}%   ` +
          `净利 ${ret.toFixed(2)} USDT`,
      )
    } catch (err) {
      console.log(`\n  ${tf}  ✗ ${(err as Error).message.slice(0, 160)}`)
    }
  }
  console.log()
}

main().catch((e) => {
  console.error('异常：', e)
  process.exit(1)
})

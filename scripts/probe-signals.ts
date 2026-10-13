/**
 * 诊断 2026-10-12 附近的入场信号。
 * 用途：确认该日 02:00 那根 bar 上到底出现几次同向信号，
 *       从而判断金字塔加仓能否生效。
 *
 * 用法：pnpm exec tsx scripts/probe-signals.ts
 */
import { fetchKlines } from '../server/src/market/exchange'
import { DEFAULT_STRATEGY_PARAMS } from '../shared/types'
import { computeFibTrendSeries } from '../server/src/indicators/fibTrendReversal'

const DAY = Date.parse('2026-10-12T00:00:00+08:00')
const BJ = (t: number) => new Date(t + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')

async function main() {
  const r = await fetchKlines({
    exchange: 'binanceusdm',
    symbol: 'BTC/USDT:USDT',
    timeframe: '1h',
    since: DAY - 60 * 86400_000,
    until: DAY + 2 * 86400_000,
    targetBars: 2000,
    useCache: false,
  })
  console.log(`\n  根数 ${r.candles.length}   来源 ${r.sourceLabel ?? '（ccxt 交易所）'}`)
  console.log(`  区间 ${BJ(r.candles[0].timestamp)} → ${BJ(r.candles.at(-1)!.timestamp)} (北京)\n`)

  const s = computeFibTrendSeries(r.candles, {
    sensitivity: DEFAULT_STRATEGY_PARAMS.sensitivity,
    atrLength: DEFAULT_STRATEGY_PARAMS.atrLength,
    atrSmoothing: DEFAULT_STRATEGY_PARAMS.atrSmoothing,
    atrMultiplier: DEFAULT_STRATEGY_PARAMS.atrMultiplier,
  })

  console.log('  时间(北京)     收盘        趋势线      canLong canShort')
  console.log('  ' + '-'.repeat(58))
  let longCount = 0
  let shortCount = 0
  for (let i = 0; i < r.candles.length; i++) {
    const t = r.candles[i].timestamp
    if (t < DAY - 8 * 3600_000 || t > DAY + 16 * 3600_000) continue
    const g = s.signals[i]
    if (g.canLong) longCount++
    if (g.canShort) shortCount++
    const line = Number.isFinite(g.imbaTrendLine) ? g.imbaTrendLine.toFixed(1) : 'NaN'
    console.log(
      `  ${BJ(t)}  ${r.candles[i].close.toFixed(1).padStart(9)}  ${line.padStart(9)}  ` +
        `${g.canLong ? '  ✓    ' : '  ·    '} ${g.canShort ? '  ✓' : '  ·'}`,
    )
  }
  console.log(`\n  该窗口内 canLong 次数 = ${longCount}，canShort 次数 = ${shortCount}`)
  console.log(
    '\n  说明：canLong/canShort 内部带有 !isLongTrend / !isShortTrend 条件，\n' +
      '        因此同方向的信号在趋势被反向信号重置前只会触发一次。\n',
  )
}

main().catch((e) => {
  console.error('异常：', e)
  process.exit(1)
})

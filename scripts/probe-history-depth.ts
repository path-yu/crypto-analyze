/**
 * 深挖行情数据获取能力：逐一测试主流交易所能拿到多久的历史 K 线。
 *
 * 目的：TradingView 能取到完整历史，验证本机网络环境下
 *       是否也能通过某种交易所 / 端点 / 分页方式拿到更早的数据。
 *
 * 用法：pnpm exec tsx scripts/probe-history-depth.ts
 */
import ccxt from 'ccxt'
import type { ExchangeId } from '../shared/types'

const SYMBOL = 'BTC/USDT:USDT'
const TF = '15m'

interface Probe {
  id: ExchangeId
  label: string
  make: () => ccxt.Exchange
}

const PROBES: Probe[] = [
  { id: 'binanceusdm', label: 'Binance USDT-M', make: () => new ccxt.binanceusdm({ enableRateLimit: true, timeout: 12000, options: { defaultType: 'future' } }) },
  { id: 'okx', label: 'OKX', make: () => new ccxt.okx({ enableRateLimit: true, timeout: 12000, options: { defaultType: 'swap' } }) },
  { id: 'bybit', label: 'Bybit', make: () => new ccxt.bybit({ enableRateLimit: true, timeout: 12000, options: { defaultType: 'swap' } }) },
  { id: 'bitget', label: 'Bitget', make: () => new ccxt.bitget({ enableRateLimit: true, timeout: 12000, options: { defaultType: 'swap' } }) },
  { id: 'gate', label: 'Gate.io', make: () => new ccxt.gate({ enableRateLimit: true, timeout: 12000, options: { defaultType: 'swap' } }) },
]

/** 目标：2026-01-01 起的 15m 数据 */
const TARGET_SINCE = Date.parse('2026-01-01T00:00:00+08:00')

async function probeOne(p: Probe) {
  console.log(`\n${'─'.repeat(70)}`)
  console.log(`  ${p.label}  (${p.id})`)
  console.log('─'.repeat(70))

  let ex: ccxt.Exchange
  try {
    ex = p.make()
    const t0 = Date.now()
    await ex.loadMarkets()
    console.log(`  ✓ loadMarkets 成功 (${Date.now() - t0}ms, ${Object.keys(ex.markets ?? {}).length} 个市场)`)
  } catch (err) {
    console.log(`  ✗ 无法连接：${(err as Error).message.slice(0, 110)}`)
    return { id: p.id, ok: false, reason: 'unreachable' as const }
  }

  // 1) 直接请求 2026-01-01 的 15m
  try {
    const r = (await ex.fetchOHLCV(SYMBOL, TF, TARGET_SINCE, 100)) as number[][]
    const first = r[0]?.[0]
    console.log(`  直接请求 2026-01-01：返回 ${r.length} 根，起点 ${first ? new Date(first).toISOString().slice(0, 16) : 'N/A'}`)
    if (first && first <= TARGET_SINCE + 86400_000) {
      console.log(`  ${green('★ 可覆盖 2026-01-01')}`)
    }
  } catch (err) {
    console.log(`  直接请求 2026-01-01：✗ ${(err as Error).message.slice(0, 100)}`)
  }

  // 2) 探测各时间粒度的最远可回溯点
  for (const tf of ['15m', '1h', '4h']) {
    try {
      const r = (await ex.fetchOHLCV(SYMBOL, tf, TARGET_SINCE, 5)) as number[][]
      const first = r[0]?.[0]
      console.log(`  ${tf.padEnd(4)} 请求 2026-01-01 → 实得起点 ${first ? new Date(first).toISOString().slice(0, 16) : 'N/A'}`)
    } catch (err) {
      console.log(`  ${tf.padEnd(4)} 请求 2026-01-01 → ✗ ${(err as Error).message.slice(0, 80)}`)
    }
  }

  // 3) 分页深挖：从 6 个月前开始，用 limit 拉满，看能连续走多远
  try {
    const start = Date.now() - 200 * 86400_000
    const batch = (await ex.fetchOHLCV(SYMBOL, '15m', start, 1000)) as number[][]
    console.log(`  分页测试(200天前起, limit=1000)：返回 ${batch.length} 根，起点 ${batch[0] ? new Date(batch[0][0]).toISOString().slice(0, 16) : 'N/A'}`)
  } catch (err) {
    console.log(`  分页测试：✗ ${(err as Error).message.slice(0, 90)}`)
  }

  return { id: p.id, ok: true }
}

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

async function main() {
  console.log('\n  交易所历史数据深度探测')
  console.log(`  目标：${SYMBOL}  ${TF}  从 2026-01-01 起`)
  console.log(`  当前时间：${new Date().toISOString()}`)

  const results = []
  for (const p of PROBES) {
    results.push(await probeOne(p))
  }

  console.log(`\n${'═'.repeat(70)}`)
  console.log('  汇总')
  console.log('═'.repeat(70))
  for (const r of results) {
    console.log(`  ${r.id.padEnd(12)} ${r.ok ? green('可连接') : yellow('不可达')}`)
  }
  console.log()
}

main().catch((e) => {
  console.error('探测异常：', e)
  process.exit(1)
})

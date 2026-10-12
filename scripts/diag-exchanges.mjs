/**
 * 诊断脚本：逐个测试各交易所公开合约 K 线接口的可用性与分页上限。
 * 用法： node scripts/diag-exchanges.mjs [symbol] [timeframe] [hours]
 */
import ccxt from 'ccxt'

const symbolArg = process.argv[2] ?? 'BTC/USDT:USDT'
const timeframe = process.argv[3] ?? '1h'
const hours = Number(process.argv[4] ?? 60)

const ids = ['binanceusdm', 'okx', 'bybit', 'bitget', 'gate']
const until = Date.now()
const since = until - hours * 3600 * 1000

for (const id of ids) {
  const t0 = Date.now()
  try {
    const ex = new ccxt[id]({
      enableRateLimit: true,
      timeout: 20000,
      options: { defaultType: 'swap' },
    })
    await ex.loadMarkets()
    let sym = symbolArg
    if (!ex.markets[sym]) {
      sym = Object.keys(ex.markets).find((s) => s.toUpperCase() === symbolArg.toUpperCase())
    }
    if (!sym) {
      console.log(`${id.padEnd(12)} NO SYMBOL ${symbolArg}`)
      continue
    }
    const batch = await ex.fetchOHLCV(sym, timeframe, since, 1000)
    const first = batch[0]?.[0]
    const last = batch[batch.length - 1]?.[0]
    console.log(
      `${id.padEnd(12)} OK   market=${sym}  ${batch.length} 根  ` +
        `首=${first ? new Date(first).toISOString() : '-'} 末=${
          last ? new Date(last).toISOString() : '-'
        }  ${Date.now() - t0}ms`,
    )
  } catch (e) {
    console.log(`${id.padEnd(12)} FAIL ${String(e.message).slice(0, 120)}  ${Date.now() - t0}ms`)
  }
}

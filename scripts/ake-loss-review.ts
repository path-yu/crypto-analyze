/**
 * AKE 交易亏损复盘：解析应用导出的交易 CSV，定位大亏交易的成因并测试过滤规则。
 *
 * 用法：npx tsx scripts/ake-loss-review.ts "C:\Users\z\Desktop\trades-AKEUSDTUSDT-1h.csv"
 */
import fs from 'node:fs'

import { atr, ema, highest, lowest, sma } from '../server/src/indicators/ta'
import { fetchKlines } from '../server/src/market/exchange'

const csvPath = process.argv[2] ?? 'trades-AKEUSDTUSDT-1h.csv'
const raw = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '')
const lines = raw.split(/\r?\n/).filter((l) => l.trim())
const header = lines[0].split(',')
const col = (name: string): number => header.findIndex((h) => h.trim() === name)
const C = {
  idx: col('序号'),
  entryT: col('入场时间'),
  entry: col('入场价'),
  exitT: col('出场时间'),
  exit: col('出场价(加权)'),
  notional: col('名义价值'),
  margin: col('保证金'),
  lev: col('杠杆'),
  stop: col('止损价'),
  chg: col('价格变动%'),
  pnl: col('净盈亏'),
  ret: col('保证金收益率%'),
  bal: col('账户余额'),
  bars: col('持仓K线'),
  mfe: col('最大有利幅度%'),
  mae: col('最大不利幅度%'),
  reason: col('平仓原因'),
}

interface Trade {
  idx: number
  entryT: number
  exitT: number
  entry: number
  exit: number
  notional: number
  margin: number
  lev: number
  stop: number
  chg: number
  pnl: number
  ret: number
  bal: number
  bars: number
  mfe: number
  mae: number
  reason: string
}
const trades: Trade[] = lines.slice(1).map((l) => {
  const c = l.split(',')
  const num = (i: number): number => Number(c[i])
  return {
    idx: num(C.idx),
    entryT: new Date(c[C.entryT].replace(' ', 'T') + '+08:00').getTime(),
    exitT: new Date(c[C.exitT].replace(' ', 'T') + '+08:00').getTime(),
    entry: num(C.entry),
    exit: num(C.exit),
    notional: num(C.notional),
    margin: num(C.margin),
    lev: num(C.lev),
    stop: num(C.stop),
    chg: num(C.chg),
    pnl: num(C.pnl),
    ret: num(C.ret),
    bal: num(C.bal),
    bars: num(C.bars),
    mfe: num(C.mfe),
    mae: num(C.mae),
    reason: c[C.reason]?.trim() ?? '',
  }
})

console.log(`交易 ${trades.length} 笔 · 期末余额 ${trades[trades.length - 1].bal.toFixed(2)}（期初 1000）`)
const wins = trades.filter((t) => t.pnl > 0)
const losses = trades.filter((t) => t.pnl <= 0)
console.log(
  `胜 ${wins.length}（${((wins.length / trades.length) * 100).toFixed(0)}%）· 亏 ${losses.length} · ` +
    `盈利合计 +${wins.reduce((a, t) => a + t.pnl, 0).toFixed(0)} · 亏损合计 ${losses.reduce((a, t) => a + t.pnl, 0).toFixed(0)}`,
)

/* ---------- 1) 亏损阶梯 ---------- */
console.log('\n===== 亏损阶梯（按权益损耗排序，前 10）=====')
const byLoss = [...losses].sort((a, b) => a.ret - b.ret)
for (const t of byLoss.slice(0, 10)) {
  const d = new Date(t.entryT + 8 * 3600_000).toISOString().slice(5, 16).replace('T', ' ')
  console.log(
    `  #${t.idx} ${d} 入 ${t.entry.toPrecision(4)} 出 ${t.exit.toPrecision(4)}` +
      ` 价格 ${t.chg.toFixed(1)}% → 权益 ${t.ret.toFixed(1)}% · 持仓 ${t.bars} 根 · MFE ${t.mfe.toFixed(1)}% MAE ${t.mae.toFixed(1)}%`,
  )
}

/* ---------- 2) 杠杆敏感性：同样的交易序列在 1x/2x/3x 下的权益曲线 ---------- */
console.log('\n===== 杠杆敏感性（同一批交易，只改杠杆）=====')
for (const lev of [1, 2, 3]) {
  let eq = 1000
  let peak = eq
  let dd = 0
  for (const t of trades) {
    // 保证金收益率% × (用户杠杆/该口径) —— 用户的 ret 已含 3x；换算为按 lev 的收益率
    const retAtLev = (t.ret * lev) / (t.lev || 3)
    eq *= 1 + retAtLev / 100
    if (eq < 0) eq = 0
    if (eq > peak) peak = eq
    if (peak > 0) dd = Math.max(dd, (peak - eq) / peak)
  }
  console.log(
    `  ${lev}x：期末 ${eq.toFixed(0)}（收益 ${((eq / 1000 - 1) * 100).toFixed(0)}%）· 最大回撤 ${(dd * 100).toFixed(0)}%`,
  )
}

/* ---------- 3) 入场时刻特征 → 找可过滤的信号 ---------- */
const SYMBOL = 'AKE/USDT:USDT'
const { candles } = await fetchKlines({
  exchange: 'binanceusdm',
  symbol: SYMBOL,
  timeframe: '1h',
  since: Date.UTC(2024, 6, 1),
  until: Date.now(),
  targetBars: 20000,
  useCache: true,
})
const close = candles.map((c) => c.close)
const n = candles.length
const tsIndex = new Map<number, number>()
candles.forEach((c, i) => tsIndex.set(c.timestamp, i))

const atrPct = atr(candles.map((c) => c.high), candles.map((c) => c.low), close, 14).map((a, i) =>
  isF2(a) && close[i] > 0 ? (a / close[i]) * 100 : NaN,
)
const atrAvg = sma(atrPct.map((v) => (isF2(v) ? v : 0)), 240)
const ema200 = ema(close, 200)
const ema50 = ema(close, 50)
const hi24 = highest(candles.map((c) => c.high), 24)
const lo24 = lowest(candles.map((c) => c.low), 24)
const rangeBase = sma(
  candles.map((c, i) => (isF2(hi24[i]) && isF2(lo24[i]) && close[i] > 0 ? (hi24[i] - lo24[i]) / close[i] * 100 : NaN)).map((v) => (isF2(v) ? v : 0)),
  240,
)
const delta = candles.map((c) => {
  const rng = c.high - c.low
  return rng > 0 ? c.volume * ((c.close - c.open) / rng) : 0
})
const deltaEma = ema(delta, 48)
const cumDelta = (() => {
  const out = new Array<number>(n).fill(NaN)
  let acc = 0
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(deltaEma[i])) acc += deltaEma[i]
    out[i] = acc
  }
  return out
})()
const rangeCompPct = candles.map((c, i) =>
  isF2(hi24[i]) && isF2(lo24[i]) && close[i] > 0 ? ((hi24[i] - lo24[i]) / close[i]) * 100 : NaN,
)

function isF2(v: number | undefined | null): boolean {
  return typeof v === 'number' && Number.isFinite(v)
}

interface EntryFeat {
  t: Trade
  i: number
  atrRank: number // ATR% 在过去 240 根中的分位（0~1）
  rngRank: number // 24 根振幅分位
  posInBar: number // 点火 K 线收盘在自身区间中的位置（0~1）
  above200: boolean
  cumUp: boolean
  barsHeld: number
}
const feats: EntryFeat[] = []
for (const t of trades) {
  const i = tsIndex.get(t.entryT - 3600_000) // 信号 bar = 入场前一根
  if (i === undefined) continue
  const atrRank = rollingRank(atrPct, i, 240)
  const rngRank = rollingRank(rangeCompPct, i, 240)
  const rng = candles[i].high - candles[i].low
  const posInBar = rng > 0 ? (close[i] - candles[i].low) / rng : NaN
  feats.push({
    t,
    i,
    atrRank,
    rngRank,
    posInBar,
    above200: close[i] > (ema200[i] ?? Number.POSITIVE_INFINITY),
    cumUp: isF2(cumDelta[i]) && isF2(cumDelta[i - 48]) && cumDelta[i] > cumDelta[i - 48],
    barsHeld: t.bars,
  })
}
function rollingRank(series: number[], i: number, window: number): number {
  if (i < window) return NaN
  const v = series[i]
  if (!isF2(v)) return NaN
  let cnt = 0
  for (let k = i - window; k < i; k++) if (isF2(series[k]) && series[k] <= v) cnt++
  return cnt / window
}

/* ---------- 4) 特征分组对比：各组平均权益收益 ---------- */
console.log('\n===== 入场特征分组（平均单笔权益收益%，样本=全部交易）=====')
const groupAvg = (name: string, pred: (f: EntryFeat) => boolean): void => {
  const g = feats.filter(pred)
  const avg = g.length ? g.reduce((a, x) => a + x.t.ret, 0) / g.length : NaN
  const sum = g.reduce((a, x) => a + x.t.pnl, 0)
  console.log(
    `  ${name.padEnd(24)} ${String(g.length).padStart(3)} 笔 · 平均权益收益 ${avg.toFixed(1)}% · 净贡献 ${sum.toFixed(0)}`,
  )
}
groupAvg('ATR 分位 > 0.7（高波动）', (f) => isF2(f.atrRank) && f.atrRank > 0.7)
groupAvg('ATR 分位 ≤ 0.5（低波动）', (f) => isF2(f.atrRank) && f.atrRank <= 0.5)
groupAvg('振幅分位 > 0.7（已扩张）', (f) => isF2(f.rngRank) && f.rngRank > 0.7)
groupAvg('点火K线收盘位于上半区', (f) => isF2(f.posInBar) && f.posInBar >= 0.5)
groupAvg('点火K线收盘位于下半区', (f) => isF2(f.posInBar) && f.posInBar < 0.5)
groupAvg('CVD 48根走强', (f) => f.cumUp)
groupAvg('CVD 48根走弱', (f) => !f.cumUp)

/* ---------- 5) 候选过滤规则：去掉匹配的交易后的净影响 ---------- */
console.log('\n===== 过滤规则测试（去掉命中的交易后的净盈亏变化）=====')
const totalPnl = trades.reduce((a, t) => a + t.pnl, 0)
console.log(`  基准净盈亏 ${totalPnl.toFixed(0)}（本金 1000）`)
const testFilter = (name: string, pred: (f: EntryFeat) => boolean): void => {
  const hit = feats.filter(pred)
  const removed = hit.reduce((a, x) => a + x.t.pnl, 0)
  const rest = totalPnl - removed
  console.log(
    `  ${name.padEnd(26)} 剔除 ${String(hit.length).padStart(3)} 笔（净 ${removed.toFixed(0)}）→ 剩余净盈亏 ${rest.toFixed(0)}`,
  )
}
testFilter('剔除 ATR 分位>0.7 的进场', (f) => isF2(f.atrRank) && f.atrRank > 0.7)
testFilter('剔除 ATR 分位>0.8 的进场', (f) => isF2(f.atrRank) && f.atrRank > 0.8)
testFilter('剔除振幅分位>0.7 的进场', (f) => isF2(f.rngRank) && f.rngRank > 0.7)
testFilter('剔除点火K线收下半区的进场', (f) => isF2(f.posInBar) && f.posInBar < 0.5)
testFilter('剔除 CVD 48根走弱的进场', (f) => !f.cumUp)
testFilter('剔除持仓>48根仍亏损的进场', (f) => f.t.bars > 48 && f.t.pnl <= 0)

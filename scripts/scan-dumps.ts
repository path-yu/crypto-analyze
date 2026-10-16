/**
 * 「砸盘 / 阴跌」复盘扫描器（1h 周期、近一年）—— 与 scan-pumps.ts 同一框架，方向相反。
 *
 * 1) 客观标注每一段「W 根内自最高 high 回落 ≥ MIN_DROP」的下跌段（带非极大抑制）；
 * 2) 打印每段形态（历时、单根最大跌幅 → 区分「砸盘」与「阴跌」）；
 * 3) 统计「确认 bar」特征（成交量倍数、ATR%、距均线、破新低…）并与全样本基线对照；
 * 4) 评估若干候选**做空**入场规则的捕获率 / 误报 / 精度。
 *
 * 用法：npx tsx scripts/scan-dumps.ts [symbols...]
 *   npx tsx scripts/scan-dumps.ts "AGT/USDT:USDT"
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Candle } from '../shared/types'
import { fetchKlines } from '../server/src/market/exchange'
import { atr, highest, lowest, rsi, sma } from '../server/src/indicators/ta'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const DEFAULT_SYMBOLS = ['AGT/USDT:USDT']
const SYMBOLS = process.argv.slice(2).filter((a) => a.includes('/'))
const symbols = SYMBOLS.length ? SYMBOLS : DEFAULT_SYMBOLS

const since = Date.UTC(2025, 9, 15)
const until = Date.now()
const TF = '1h' as const

/** 下跌定义：窗口 W 根内、自区间最高 high 起回落 ≥ MIN_DROP（收盘口径） */
const W = 72
const MIN_DROP = 0.3
/** 确认入场：自峰值回落 10% 的那根收盘 */
const CONF = 0.1

interface Leg {
  symbol: string
  peakIndex: number
  troughIndex: number
  peakTime: number
  troughTime: number
  peak: number
  trough: number
  drop: number
  bars: number
  maxBar: number
  confIndex: number
}

const fm = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : '—')
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
function median(a: number[]): number {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y)
  return v.length ? v[(v.length - 1) >> 1] : NaN
}

function detectLegs(symbol: string, c: Candle[]): Leg[] {
  const n = c.length
  const close = c.map((x) => x.close)
  const high = c.map((x) => x.high)
  const low = c.map((x) => x.low)
  const rollMax = highest(high, W)
  const drop = close.map((v, i) => (i >= W - 1 && rollMax[i] > 0 ? v / rollMax[i] - 1 : NaN))
  const marked = drop.map((v) => Number.isFinite(v) && v <= -MIN_DROP)

  const segs: Array<{ peak: number; s: number; e: number }> = []
  let i = Math.max(0, W - 1)
  while (i < n) {
    if (!marked[i]) { i++; continue }
    let j = i
    while (j + 1 < n && marked[j + 1]) j++
    let pk = i
    for (let k = Math.max(0, i - W + 1); k <= i; k++) if (high[k] > high[pk]) pk = k
    segs.push({ peak: pk, s: i, e: j })
    i = j + 1
  }

  const legs: Leg[] = segs.map((s) => {
    let tr = s.peak
    for (let k = s.peak; k <= s.e; k++) if (low[k] < low[tr]) tr = k
    let maxBar = 0
    for (let k = s.peak + 1; k <= tr; k++) maxBar = Math.min(maxBar, close[k] / close[k - 1] - 1)
    const target = high[s.peak] * (1 - CONF)
    let ci = -1
    for (let k = s.peak + 1; k <= tr; k++) if (close[k] <= target) { ci = k; break }
    return {
      symbol, peakIndex: s.peak, troughIndex: tr, peakTime: c[s.peak].timestamp, troughTime: c[tr].timestamp,
      peak: high[s.peak], trough: low[tr], drop: low[tr] / high[s.peak] - 1, bars: tr - s.peak, maxBar, confIndex: ci,
    }
  })

  // 去重叠：peak 落在上一段 [peak, trough] 内时，保留跌幅更大者
  legs.sort((a, b) => a.peakIndex - b.peakIndex)
  const kept: Leg[] = []
  for (const l of legs) {
    const p = kept[kept.length - 1]
    if (p && l.peakIndex <= p.troughIndex) {
      if (l.drop < p.drop) kept[kept.length - 1] = l
      continue
    }
    kept.push(l)
  }
  return kept
}

async function main(): Promise<void> {
  const perSymbol: Record<string, { candles: Candle[]; legs: Leg[] }> = {}
  const allLegs: Leg[] = []

  for (const s of symbols) {
    const { candles } = await fetchKlines({ exchange: 'binanceusdm', symbol: s, timeframe: TF, since, until, targetBars: 9000 })
    const legs = detectLegs(s, candles)
    perSymbol[s] = { candles, legs }
    allLegs.push(...legs)
    console.log(`\n### ${s}  K线 ${candles.length} 根（${iso(candles[0].timestamp)} → ${iso(candles[candles.length - 1].timestamp)}）  下跌段 ${legs.length} 段`)
    for (const l of legs) {
      let down = 0
      for (let k = l.peakIndex + 1; k <= l.troughIndex; k++) if (candles[k].close < candles[k].open) down++
      console.log(
        `   峰 ${iso(l.peakTime)} ${fm(l.peak, 6)}  →  谷 ${iso(l.troughTime)} ${fm(l.trough, 6)}  ` +
        `跌幅 ${fm(l.drop * 100, 1)}%  历时 ${l.bars} 根  单根最大 ${fm(l.maxBar * 100, 1)}%  ` +
        `阴线占比 ${fm((down / Math.max(1, l.bars)) * 100, 0)}%  ${l.maxBar <= -0.10 ? '【砸盘】' : '【阴跌】'}`,
      )
    }
  }

  const all = [...symbols].map((s) => perSymbol[s])
  /* ---- 特征对照 ---- */
  console.log(`\n================ 下跌【确认 bar】特征 vs 全样本基线 ================`)
  const FEATS: Array<[string, (c: Candle[], k: number) => number]> = [
    ['近6根涨幅', (c, k) => c[k].close / c[k - 6].close - 1],
    ['近24根涨幅', (c, k) => c[k].close / c[k - 24].close - 1],
    ['成交量/96均量', (c, k) => { const m = sma(c.map((x) => x.volume), 96)[k]; return m > 0 ? c[k].volume / m : NaN }],
    ['成交量/24均量', (c, k) => { const m = sma(c.map((x) => x.volume), 24)[k]; return m > 0 ? c[k].volume / m : NaN }],
    ['ATR%', (c, k) => (atr(c.map((x) => x.high), c.map((x) => x.low), c.map((x) => x.close), 14)[k] / c[k].close) * 100],
    ['距MA20', (c, k) => { const m = sma(c.map((x) => x.close), 20)[k]; return m > 0 ? c[k].close / m - 1 : NaN }],
    ['距MA50', (c, k) => { const m = sma(c.map((x) => x.close), 50)[k]; return m > 0 ? c[k].close / m - 1 : NaN }],
    ['距MA200', (c, k) => { const m = sma(c.map((x) => x.close), 200)[k]; return m > 0 ? c[k].close / m - 1 : NaN }],
    ['空头排列(20<50<200)', (c, k) => { const a = sma(c.map((x) => x.close), 20)[k], b = sma(c.map((x) => x.close), 50)[k], d = sma(c.map((x) => x.close), 200)[k]; return a < b && b < d ? 1 : 0 }],
    ['MA50下行(10根)', (c, k) => { const m = sma(c.map((x) => x.close), 50); return m[k] < m[k - 10] ? 1 : 0 }],
    ['RSI14', (c, k) => rsi(c.map((x) => x.close), 14)[k]],
    ['相对50根新低', (c, k) => { const l = lowest(c.map((x) => x.low), 50)[k]; return l > 0 ? c[k].close / l - 1 : NaN }],
  ]
  const ev: Record<string, number[]> = {}
  const base: Record<string, number[]> = {}
  for (const [name] of FEATS) { ev[name] = []; base[name] = [] }
  for (const { candles, legs } of all) {
    for (const l of legs) {
      if (l.confIndex < 0) continue
      for (const [name, f] of FEATS) { const v = f(candles, l.confIndex); if (Number.isFinite(v)) ev[name].push(v) }
    }
    for (let k = 240; k < candles.length; k++) for (const [name, f] of FEATS) { const v = f(candles, k); if (Number.isFinite(v)) base[name].push(v) }
  }
  console.log(`${'特征'.padEnd(22)} ${'下跌bar中位'.padStart(12)} ${'基线中位'.padStart(10)}`)
  for (const [name] of FEATS) console.log(`${name.padEnd(22)} ${fm(median(ev[name]), 3).padStart(12)} ${fm(median(base[name]), 3).padStart(10)}`)

  /* ---- 做空规则捕获 ---- */
  const RULES: Array<[string, (c: Candle[], k: number) => boolean]> = [
    ['S1 破50根新低', (c, k) => { const l = lowest(c.map((x) => x.low), 50)[k - 1]; return l > 0 && c[k].close < l }],
    ['S2 破50新低 且 量>2', (c, k) => { const l = lowest(c.map((x) => x.low), 50)[k - 1], m = sma(c.map((x) => x.volume), 96)[k]; return l > 0 && c[k].close < l && m > 0 && c[k].volume / m > 2 }],
    ['S5 空头排列 且 收盘<MA200', (c, k) => { const a = sma(c.map((x) => x.close), 20)[k], b = sma(c.map((x) => x.close), 50)[k], d = sma(c.map((x) => x.close), 200)[k]; return a < b && b < d && c[k].close < d }],
    ['S6 破50新低 且 空头排列', (c, k) => { const l = lowest(c.map((x) => x.low), 50)[k - 1], a = sma(c.map((x) => x.close), 20)[k], b = sma(c.map((x) => x.close), 50)[k], d = sma(c.map((x) => x.close), 200)[k]; return l > 0 && c[k].close < l && a < b && b < d }],
    ['S7 连阴≥3 且 量>1.5', (c, k) => { let r = 0; for (let j = k; j >= 0 && c[j].close < c[j].open; j--) r++; const m = sma(c.map((x) => x.volume), 96)[k]; return r >= 3 && m > 0 && c[k].volume / m > 1.5 }],
    ['S8 距72根高点≤-12% 且 收盘<MA20', (c, k) => { const h = highest(c.map((x) => x.high), 72)[k], m = sma(c.map((x) => x.close), 20)[k]; return h > 0 && c[k].close / h - 1 <= -0.12 && c[k].close < m }],
    ['T1 6根涨≥20% 且 阴线 且 单根跌≥6% 且 量>3', (c, k) => { const m = sma(c.map((x) => x.volume), 96)[k]; return c[k].close / c[k - 6].close - 1 >= 0.2 && c[k].close < c[k].open && c[k].close / c[k - 1].close - 1 <= -0.06 && m > 0 && c[k].volume / m > 3 }],
    ['T4 阴线 且 单根跌≥8% 且 量>5', (c, k) => { const m = sma(c.map((x) => x.volume), 96)[k]; return c[k].close < c[k].open && c[k].close / c[k - 1].close - 1 <= -0.08 && m > 0 && c[k].volume / m > 5 }],
  ]
  console.log(`\n================ 候选做空规则（在【下跌段内、触底之前】触发算捕获）================`)
  console.log(`${'规则'.padEnd(40)} ${'捕获率'.padStart(9)} ${'误报段'.padStart(7)} ${'精度'.padStart(7)} ${'距底剩余'.padStart(9)} ${'触发时已跌'.padStart(10)} ${'触发后还能跌'.padStart(12)}`)
  for (const [name, test] of RULES) {
    let hit = 0, fp = 0
    const leads: number[] = [], vsPeak: number[] = [], left: number[] = []
    for (const { candles, legs } of all) {
      const inSeg = new Array<boolean>(candles.length).fill(false)
      for (const l of legs) for (let k = l.peakIndex; k <= l.troughIndex; k++) inSeg[k] = true
      let prev = false
      for (let k = 240; k < candles.length; k++) {
        const fired = test(candles, k)
        if (fired && !prev && !inSeg[k]) fp++
        prev = fired
      }
      for (const l of legs) {
        let first = -1
        for (let k = l.peakIndex + 1; k < l.troughIndex; k++) if (test(candles, k)) { first = k; break }
        if (first < 0) continue
        hit++
        leads.push(l.troughIndex - first)
        vsPeak.push(candles[first].close / l.peak - 1)
        left.push(l.trough / candles[first].close - 1)
      }
    }
    const avg = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
    console.log(
      `${name.padEnd(40)} ${`${hit}/${allLegs.length}`.padStart(9)} ${String(fp).padStart(7)} ` +
      `${fm((hit / Math.max(1, hit + fp)) * 100, 0).padStart(6)}% ${fm(avg(leads), 1).padStart(9)} ` +
      `${fm(avg(vsPeak) * 100, 1).padStart(10)} ${fm(avg(left) * 100, 1).padStart(12)}`,
    )
  }

  fs.mkdirSync(path.join(ROOT, 'output/pump'), { recursive: true })
  fs.writeFileSync(
    path.join(ROOT, 'output/pump/dumps.json'),
    JSON.stringify({ window: { since, until }, W, MIN_DROP, CONF, legs: allLegs }, null, 2),
    'utf8',
  )
  console.log(`\n明细已写入 output/pump/dumps.json\n`)
}

main().catch((e) => { console.error('失败：', e instanceof Error ? e.message : e); process.exit(1) })

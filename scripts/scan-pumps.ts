/**
 * 暴涨区间复盘扫描器（1h 周期、近一年）。
 *
 * 1) 用「W 根内自最低点起涨幅 ≥ MIN_GAIN」客观标注每一次暴涨区间（带非极大抑制）；
 * 2) 为每次暴涨计算「确认入场 bar」（自低点起涨 CONF 的第一根阳线收盘）；
 * 3) 统计入场 bar 的特征（成交量倍数、ATR 扩张、布林带宽、距均线、突破 N 根新高…），
 *    并与全样本基线对照；
 * 4) 评估若干候选「入场规则」的捕获率（recall）与误报（precision）。
 *
 * 用法：npx tsx scripts/scan-pumps.ts [symbols...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Candle } from '../shared/types'
import { fetchKlines } from '../server/src/market/exchange'
import { atr, highest, lowest, rsi, sma, stdev } from '../server/src/indicators/ta'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const DEFAULT_SYMBOLS = [
  'AKE/USDT:USDT',
  '币安人生/USDT:USDT',
  '龙虾/USDT:USDT',
  'BANK/USDT:USDT',
  'LAB/USDT:USDT',
  'MYX/USDT:USDT',
]
const SYMBOLS = process.argv.slice(2).filter((a) => a.includes('/')) 
const symbols = SYMBOLS.length ? SYMBOLS : DEFAULT_SYMBOLS

const since = Date.UTC(2025, 9, 13)
const until = Date.UTC(2026, 9, 13)
const TF = '1h' as const

/** 暴涨定义：窗口 W 根内、自区间最低 low 起涨幅 ≥ MIN_GAIN */
const W = 72
const MIN_GAIN = 0.5
/** 确认入场：自低点起涨 15% 的那根收盘 */
const CONF = 0.15

interface Leg {
  symbol: string
  lowIndex: number
  lowTime: number
  low: number
  peakIndex: number
  peakTime: number
  peak: number
  gain: number
  bars: number
  confIndex: number
  confTime: number
  confPrice: number
}

type Feat = Record<string, number>

const fm = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : '—')
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
function median(a: number[]): number {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y)
  return v.length ? v[(v.length - 1) >> 1] : NaN
}

/** 计算每根 bar 的特征（全部对齐到下标） */
function features(c: Candle[]): Record<string, number[]> {
  const close = c.map((x) => x.close)
  const high = c.map((x) => x.high)
  const low = c.map((x) => x.low)
  const vol = c.map((x) => x.volume)
  const n = c.length
  const atr14 = atr(high, low, close, 14)
  const atrPct = atr14.map((a, i) => (a / close[i]) * 100)
  const atrPctAvg = sma(atrPct.map((v) => (Number.isFinite(v) ? v : 0)), 240)
  const vol96 = sma(vol, 96)
  const vol24 = sma(vol, 24)
  const ma20 = sma(close, 20)
  const ma50 = sma(close, 50)
  const sd20 = stdev(close, 20)
  const rsi14 = rsi(close, 14)
  const hi50 = highest(close, 50)
  const ampPct = c.map((x) => ((x.high - x.low) / x.close) * 100)
  const amp24 = sma(ampPct, 24)
  const amp240 = sma(ampPct, 240)

  const f: Record<string, number[]> = {
    ret6: new Array(n).fill(NaN),
    ret24: new Array(n).fill(NaN),
    volR96: new Array(n).fill(NaN),
    volR24: new Array(n).fill(NaN),
    atrPct: new Array(n).fill(NaN),
    atrExp: new Array(n).fill(NaN),
    bbWidth: new Array(n).fill(NaN),
    bbSqueeze: new Array(n).fill(NaN),
    rsi14: new Array(n).fill(NaN),
    distMa20: new Array(n).fill(NaN),
    distMa50: new Array(n).fill(NaN),
    brk50: new Array(n).fill(NaN),
    ampExp: new Array(n).fill(NaN),
    upRun: new Array(n).fill(NaN),
  }
  for (let i = 0; i < n; i++) {
    if (i >= 6) f.ret6[i] = close[i] / close[i - 6] - 1
    if (i >= 24) f.ret24[i] = close[i] / close[i - 24] - 1
    if (Number.isFinite(vol96[i]) && vol96[i] > 0) f.volR96[i] = vol[i] / vol96[i]
    if (Number.isFinite(vol24[i]) && vol24[i] > 0) f.volR24[i] = vol[i] / vol24[i]
    f.atrPct[i] = atrPct[i]
    if (Number.isFinite(atrPct[i]) && Number.isFinite(atrPctAvg[i]) && atrPctAvg[i] > 0) {
      f.atrExp[i] = atrPct[i] / atrPctAvg[i]
    }
    if (Number.isFinite(ma20[i]) && ma20[i] > 0 && Number.isFinite(sd20[i])) {
      f.bbWidth[i] = ((4 * sd20[i]) / ma20[i]) * 100
    }
    if (Number.isFinite(f.bbWidth[i]) && i >= 240) {
      const w = f.bbWidth.slice(i - 240, i).filter(Number.isFinite)
      f.bbSqueeze[i] = w.length ? f.bbWidth[i] / Math.max(1e-9, median(w)) : NaN
    }
    f.rsi14[i] = rsi14[i]
    if (Number.isFinite(ma20[i]) && ma20[i] > 0) f.distMa20[i] = close[i] / ma20[i] - 1
    if (Number.isFinite(ma50[i]) && ma50[i] > 0) f.distMa50[i] = close[i] / ma50[i] - 1
    if (i >= 1 && Number.isFinite(hi50[i - 1]) && hi50[i - 1] > 0) f.brk50[i] = close[i] / hi50[i - 1] - 1
    if (Number.isFinite(amp24[i]) && Number.isFinite(amp240[i]) && amp240[i] > 0) {
      f.ampExp[i] = amp24[i] / amp240[i]
    }
    let run = 0
    for (let j = i; j >= 0 && c[j].close >= c[j].open; j--) run++
    f.upRun[i] = run
  }
  return f
}

/** 检测暴涨区间（带非极大抑制） */
function detectLegs(symbol: string, c: Candle[]): Leg[] {
  const n = c.length
  const close = c.map((x) => x.close)
  const low = c.map((x) => x.low)
  const rollMin = lowest(low, W)
  const rise = close.map((v, i) =>
    i >= W - 1 && Number.isFinite(rollMin[i]) && rollMin[i] > 0 ? v / rollMin[i] - 1 : NaN,
  )
  const above = rise.map((v) => Number.isFinite(v) && v >= MIN_GAIN)
  const legs: Leg[] = []
  let i = 0
  while (i < n) {
    if (!above[i]) { i++; continue }
    let j = i
    while (j + 1 < n && above[j + 1]) j++
    let best = i
    for (let k = i; k <= j; k++) if (rise[k] > rise[best]) best = k
    // 区间最低点
    let li = best
    for (let k = best; k >= Math.max(0, best - W + 1); k--) if (low[k] < low[li]) li = k
    // 确认入场 bar：自低点起涨 CONF
    const target = low[li] * (1 + CONF)
    let ci = -1
    for (let k = li + 1; k <= best; k++) if (close[k] >= target) { ci = k; break }
    legs.push({
      symbol,
      lowIndex: li, lowTime: c[li].timestamp, low: low[li],
      peakIndex: best, peakTime: c[best].timestamp, peak: c[best].high,
      gain: c[best].high / low[li] - 1,
      bars: best - li,
      confIndex: ci, confTime: ci >= 0 ? c[ci].timestamp : NaN, confPrice: ci >= 0 ? close[ci] : NaN,
    })
    i = j + 1
  }
  /**
   * 去重叠：同一段行情常被相邻窗口重复识别（低点相同、高点不同）。
   * 按 lowIndex 排序后，只要与上一段 [lowIndex, peakIndex] 有交集就丢弃，
   * 只保留涨幅最大的那一段。
   */
  legs.sort((a, b) => a.lowIndex - b.lowIndex || b.gain - a.gain)
  const kept: Leg[] = []
  for (const l of legs) {
    const prev = kept[kept.length - 1]
    if (prev && l.lowIndex <= prev.peakIndex) {
      if (l.gain > prev.gain) kept[kept.length - 1] = l
      continue
    }
    kept.push(l)
  }
  return kept
}

/** 候选入场规则（fi = 特征表） */
const RULES: Array<{ name: string; test: (fi: Record<string, number[]>, i: number) => boolean }> = [
  { name: 'R1 破50根新高', test: (f, i) => f.brk50[i] > 0 },
  { name: 'R2 破50新高+量>3', test: (f, i) => f.brk50[i] > 0 && f.volR96[i] > 3 },
  { name: 'R3 破50新高+量>5', test: (f, i) => f.brk50[i] > 0 && f.volR96[i] > 5 },
  { name: 'R4 破50新高+ATR扩张>1.4', test: (f, i) => f.brk50[i] > 0 && f.atrExp[i] > 1.4 },
  { name: 'R5 量>5 且 6根涨幅>5%', test: (f, i) => f.volR96[i] > 5 && f.ret6[i] > 0.05 },
  { name: 'R6 破50新高+RSI>70', test: (f, i) => f.brk50[i] > 0 && f.rsi14[i] > 70 },
  { name: 'R7 距MA20>10%+量>3', test: (f, i) => f.distMa20[i] > 0.1 && f.volR96[i] > 3 },
  { name: 'R8 破50新高+量>2+24h涨>15%', test: (f, i) => f.brk50[i] > 0 && f.volR96[i] > 2 && f.ret24[i] > 0.15 },
  { name: 'R9 布林挤压<0.8 且 破50新高', test: (f, i) => f.bbSqueeze[i] < 0.8 && f.brk50[i] > 0 },
  { name: 'R10 量>10', test: (f, i) => f.volR96[i] > 10 },
  { name: 'R11 振幅扩张>1.5 且 6根涨>8%', test: (f, i) => f.ampExp[i] > 1.5 && f.ret6[i] > 0.08 },
  { name: 'R12 破50新高+量>2+ATR扩张>1.2', test: (f, i) => f.brk50[i] > 0 && f.volR96[i] > 2 && f.atrExp[i] > 1.2 },
  /* ---- 以「成交量倍数」为主的候选（复盘显示它区分度最高）---- */
  { name: 'R13 量>5', test: (f, i) => f.volR96[i] > 5 },
  { name: 'R14 量>8', test: (f, i) => f.volR96[i] > 8 },
  { name: 'R15 量>3 且 6根涨>3%', test: (f, i) => f.volR96[i] > 3 && f.ret6[i] > 0.03 },
  { name: 'R16 量>5 且 距MA20>3%', test: (f, i) => f.volR96[i] > 5 && f.distMa20[i] > 0.03 },
  { name: 'R17 量>3 且 连阳≥2', test: (f, i) => f.volR96[i] > 3 && f.upRun[i] >= 2 },
  { name: 'R18 量>4 且 6根涨>4% 且 距MA20>2%', test: (f, i) => f.volR96[i] > 4 && f.ret6[i] > 0.04 && f.distMa20[i] > 0.02 },
  { name: 'R19 量>6 且 6根涨>6%', test: (f, i) => f.volR96[i] > 6 && f.ret6[i] > 0.06 },
  { name: 'R20 带宽扩张>1.6 且 量>3 且 6根涨>4%', test: (f, i) => f.bbSqueeze[i] > 1.6 && f.volR96[i] > 3 && f.ret6[i] > 0.04 },
]

async function main(): Promise<void> {
  const perSymbol: Record<string, { candles: Candle[]; legs: Leg[]; feat: Record<string, number[]> }> = {}
  const allLegs: Leg[] = []

  for (const s of symbols) {
    const { candles } = await fetchKlines({
      exchange: 'binanceusdm', symbol: s, timeframe: TF, since, until, targetBars: 9000,
    })
    const legs = detectLegs(s, candles)
    perSymbol[s] = { candles, legs, feat: features(candles) }
    allLegs.push(...legs)
    console.log(`\n### ${s}   K线 ${candles.length} 根（${iso(candles[0].timestamp)} → ${iso(candles[candles.length - 1].timestamp)}）  暴涨区间 ${legs.length} 段`)
    for (const l of legs) {
      console.log(
        `   低 ${iso(l.lowTime)} ${fm(l.low, 6)}  →  高 ${iso(l.peakTime)} ${fm(l.peak, 6)}  ` +
        `涨幅 ${fm(l.gain * 100, 1)}%  历时 ${l.bars} 根  ` +
        (Number.isFinite(l.confTime) ? `确认入场 ${iso(l.confTime)} @ ${fm(l.confPrice, 6)}（自低点 +${fm(CONF * 100, 0)}%）` : '（无确认点）'),
      )
    }
  }

  /* ---- 特征对照：暴涨确认 bar vs 全样本 ---- */
  console.log(`\n\n================ 暴涨【确认入场 bar】特征 vs 全样本基线 ================`)
  const evFeat: Record<string, number[]> = {}
  const baseFeat: Record<string, number[]> = {}
  for (const s of symbols) {
    const { legs, feat } = perSymbol[s]
    for (const key of Object.keys(feat)) { evFeat[key] ??= []; baseFeat[key] ??= [] }
    for (const l of legs) {
      if (l.confIndex < 0) continue
      for (const key of Object.keys(feat)) {
        const v = feat[key][l.confIndex]
        if (Number.isFinite(v)) evFeat[key].push(v)
      }
    }
    for (const key of Object.keys(feat)) {
      for (const v of feat[key]) if (Number.isFinite(v)) baseFeat[key].push(v)
    }
  }
  const label: Record<string, string> = {
    ret6: '近6根涨幅', ret24: '近24根涨幅', volR96: '成交量/96均量', volR24: '成交量/24均量',
    atrPct: 'ATR%', atrExp: 'ATR%/240均值', bbWidth: '布林带宽%', bbSqueeze: '带宽/240中位',
    rsi14: 'RSI14', distMa20: '距MA20', distMa50: '距MA50', brk50: '相对50根新高',
    ampExp: '振幅/240均值', upRun: '连阳根数',
  }
  console.log(`${'特征'.padEnd(18)} ${'暴涨bar中位'.padStart(12)} ${'基线中位'.padStart(10)} ${'暴涨bar均值'.padStart(12)} ${'基线均值'.padStart(10)}`)
  const evList: Array<[string, number]> = []
  for (const key of Object.keys(label)) {
    const e = evFeat[key] ?? [], b = baseFeat[key] ?? []
    const ratio = median(b) !== 0 ? median(e) / median(b) : NaN
    evList.push([key, ratio])
    console.log(
      `${label[key].padEnd(18)} ${fm(median(e), 3).padStart(12)} ${fm(median(b), 3).padStart(10)} ` +
      `${fm(e.reduce((a, x) => a + x, 0) / Math.max(1, e.length), 3).padStart(12)} ${fm(b.reduce((a, x) => a + x, 0) / Math.max(1, b.length), 3).padStart(10)}`,
    )
  }

  /* ---- 规则评估：能否在暴涨区间内入场 ---- */
  console.log(`\n================ 候选入场规则（在【暴涨区间内、见顶之前】触发算捕获）================`)
  const rows: Array<{ name: string; hit: number; total: number; falseN: number; precision: number; missLead: number; entryVsLow: number; leftToPeak: number }> = []
  for (const r of RULES) {
    let hit = 0, falseEp = 0, total = 0
    const leads: number[] = [], vsLow: number[] = [], left: number[] = []
    for (const s of symbols) {
      const { candles, legs, feat } = perSymbol[s]
      const inLeg = new Array<boolean>(candles.length).fill(false)
      for (const l of legs) for (let k = l.lowIndex; k <= l.peakIndex; k++) inLeg[k] = true
      let prevFired = false
      for (let i = 240; i < candles.length; i++) {
        const fired = r.test(feat, i)
        // 误报按「连续触发段」计一次，否则同一段行情会被重复计数几十次
        if (fired && !prevFired && !inLeg[i]) falseEp++
        prevFired = fired
      }
      for (const l of legs) {
        total++
        let first = -1
        for (let k = l.lowIndex + 1; k < l.peakIndex; k++) if (r.test(feat, k)) { first = k; break }
        if (first < 0) continue
        hit++
        leads.push(l.peakIndex - first)
        vsLow.push(candles[first].close / l.low - 1)
        left.push(l.peak / candles[first].close - 1)
      }
    }
    rows.push({
      name: r.name, hit, total, falseN: falseEp,
      precision: hit + falseEp > 0 ? hit / (hit + falseEp) : NaN,
      missLead: leads.length ? leads.reduce((a, x) => a + x, 0) / leads.length : NaN,
      entryVsLow: vsLow.length ? vsLow.reduce((a, x) => a + x, 0) / vsLow.length : NaN,
      leftToPeak: left.length ? left.reduce((a, x) => a + x, 0) / left.length : NaN,
    })
  }
  rows.sort((a, b) => b.precision - a.precision || b.hit - a.hit)
  console.log(`${'规则'.padEnd(32)} ${'捕获率'.padStart(9)} ${'误报段'.padStart(7)} ${'精度'.padStart(7)} ${'距顶剩余根数'.padStart(12)} ${'入场时已涨'.padStart(10)} ${'入场后还能涨'.padStart(12)}`)
  for (const x of rows) {
    console.log(
      `${x.name.padEnd(32)} ${`${x.hit}/${x.total}`.padStart(9)} ${String(x.falseN).padStart(7)} ${fm(x.precision * 100, 0).padStart(6)}% ` +
      `${fm(x.missLead, 1).padStart(12)} ${fm(x.entryVsLow * 100, 1).padStart(10)} ${fm(x.leftToPeak * 100, 1).padStart(12)}`,
    )
  }

  fs.mkdirSync(path.join(ROOT, 'output/pump'), { recursive: true })
  fs.writeFileSync(
    path.join(ROOT, 'output/pump/scan.json'),
    JSON.stringify({ window: { since, until }, W, MIN_GAIN, CONF, legs: allLegs, rules: rows }, null, 2),
    'utf8',
  )
  console.log(`\n明细已写入 output/pump/scan.json\n`)
}

main().catch((e) => { console.error('失败：', e instanceof Error ? e.message : e); process.exit(1) })

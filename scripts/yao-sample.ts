/**
 * 妖币样本复盘：对点名的暴涨币做多维度剖析，归纳「妖性」的共性特征。
 *
 * 每个维度同时输出：
 *   · 全样本基线（所有 bar 的中位值）——用来对照「妖币启动前到底异于常态多少」
 *
 * 输出分两层：
 *   1) 每币一张简表：数据长度、暴涨段数（72 根内自低点 +50%）、每段的启动时刻/涨幅/历时
 *   2) 暴涨段「启动前窗口」特征统计：量能、波动、位置、形态共 12 个维度，与基线对比
 *
 * 用法：npx tsx scripts/yao-sample.ts
 */
import type { Candle } from '../shared/types'
import { fetchKlines } from '../server/src/market/exchange'
import { atr, highest, lowest, rsi, sma, stdev } from '../server/src/indicators/ta'

/** 用户点名的妖币样本 */
const SYMBOLS = [
  'LAB/USDT:USDT',
  'RIVER/USDT:USDT',
  'SIREN/USDT:USDT',
  'AGT/USDT:USDT',
  'AKE/USDT:USDT',
  'BTW/USDT:USDT',
  'TUT/USDT:USDT',
  'SOON/USDT:USDT',
  '币安人生/USDT:USDT',
  '龙虾/USDT:USDT',
]

const since = Date.UTC(2025, 9, 13)
const until = Date.UTC(2026, 9, 13)
const TF = '1h' as const

/** 暴涨定义：W 根内自最低点起涨幅 ≥ MIN_GAIN（与项目先前扫描一致） */
const W = 72
const MIN_GAIN = 0.5
// /** 预备役定义：更宽松，用于衡量「有过大行情」 */
const LEGS_SOFT_GAIN = 0.3

const fm = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : '—')
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
const median = (a: number[]): number => {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y)
  return v.length ? v[(v.length - 1) >> 1] : NaN
}

interface Leg {
  lowIndex: number
  lowTime: number
  peakIndex: number
  peakTime: number
  peak: number
  gain: number
  bars: number
}

/** 检测暴涨段（window = W 内自最低点涨幅 ≥ gain，含非极大抑制） */
function detectLegs(c: Candle[], gain = MIN_GAIN): Leg[] {
  const n = c.length
  const close = c.map((x) => x.close)
  const low = c.map((x) => x.low)
  const rollMin = lowest(low, W)
  const rise = close.map((v, i) =>
    i >= W - 1 && Number.isFinite(rollMin[i]) && rollMin[i] > 0 ? v / rollMin[i] - 1 : NaN,
  )
  const above = rise.map((v) => Number.isFinite(v) && v >= gain)
  const legs: Leg[] = []
  let i = 0
  while (i < n) {
    if (!above[i]) { i++; continue }
    let j = i
    while (j + 1 < n && above[j + 1]) j++
    let best = i
    for (let k = i; k <= j; k++) if (rise[k] > rise[best]) best = k
    let li = best
    for (let k = best; k >= Math.max(0, best - W + 1); k--) if (low[k] < low[li]) li = k
    let pi = li
    for (let k = li + 1; k <= j; k++) if (close[k] > close[pi] && (k - li) <= W) pi = k
    legs.push({
      lowIndex: li,
      lowTime: c[li].timestamp,
      peakIndex: pi,
      peakTime: c[pi].timestamp,
      peak: close[pi],
      gain: close[pi] / low[li] - 1,
      bars: pi - li,
    })
    i = j + 1
  }
  legs.sort((a, b) => a.lowIndex - b.lowIndex)
  const kept: Leg[] = []
  for (const l of legs) if (!kept.length || l.lowIndex > kept[kept.length - 1].lowIndex) kept.push(l)
  return kept
}

interface Features {
  volR96: number[]
  atrPct: number[]
  atrExp: number[]
  amp48: number[]
  pos48: number[]
  maGap: number[]
  dist200: number[]
  ddFromHigh: number[]
  rsi14: number[]
  ret6: number[]
  volPct: number[] // 本根成交量占近 96 根总量的比例
  price: number[]
}

function features(c: Candle[]): Features {
  const n = c.length
  const close = c.map((x) => x.close)
  const high = c.map((x) => x.high)
  const low = c.map((x) => x.low)
  const vol = c.map((x) => x.volume)
  const vol96 = sma(vol, 96)
  const volSum96 = new Array<number>(n).fill(NaN)
  let s = 0
  for (let i = 0; i < n; i++) {
    s += vol[i]
    if (i >= 96) s -= vol[i - 96]
    if (i >= 95) volSum96[i] = s
  }
  const atr14 = atr(high, low, close, 14)
  const atrPct = atr14.map((a, i) => (a / close[i]) * 100)
  const atrAvg = sma(atrPct.map((v) => (Number.isFinite(v) ? v : 0)), 240)
  const ma20 = sma(close, 20)
  const ma200 = sma(close, 200)
  const hi48 = highest(high, 48)
  const lo48 = lowest(low, 48)
  const hiAll = highest(high, 2400)
  const rsi14 = rsi(close, 14)

  const F: Features = {
    volR96: new Array(n).fill(NaN),
    atrPct: atrPct.slice(),
    atrExp: new Array(n).fill(NaN),
    amp48: new Array(n).fill(NaN),
    pos48: new Array(n).fill(NaN),
    maGap: new Array(n).fill(NaN),
    dist200: new Array(n).fill(NaN),
    ddFromHigh: new Array(n).fill(NaN),
    rsi14: rsi14.slice(),
    ret6: new Array(n).fill(NaN),
    volPct: new Array(n).fill(NaN),
    price: close.slice(),
  }
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(vol96[i]) && vol96[i] > 0) F.volR96[i] = vol[i] / vol96[i]
    if (Number.isFinite(vol96[i]) && vol96[i] > 0) F.volPct[i] = vol[i] / vol96[i]
    if (Number.isFinite(atrPct[i]) && Number.isFinite(atrAvg[i]) && atrAvg[i] > 0)
      F.atrExp[i] = atrPct[i] / atrAvg[i]
    if (Number.isFinite(hi48[i]) && Number.isFinite(lo48[i]) && lo48[i] > 0)
      F.amp48[i] = hi48[i] / lo48[i] - 1
    if (Number.isFinite(hi48[i]) && Number.isFinite(lo48[i]) && hi48[i] > lo48[i])
      F.pos48[i] = (close[i] - lo48[i]) / (hi48[i] - lo48[i])
    if (Number.isFinite(ma20[i]) && Number.isFinite(ma200[i]) && ma200[i] > 0)
      F.maGap[i] = Math.abs(ma20[i] / ma200[i] - 1)
    if (Number.isFinite(ma200[i]) && ma200[i] > 0) F.dist200[i] = close[i] / ma200[i] - 1
    if (Number.isFinite(hiAll[i]) && hiAll[i] > 0) F.ddFromHigh[i] = close[i] / hiAll[i] - 1
    if (i >= 6 && close[i - 6] > 0) F.ret6[i] = close[i] / close[i - 6] - 1
  }
  return F
}

/** 暴涨段低点前 K 根窗口内某特征的聚合（默认中位） */
function winStats(f: number[], legs: Leg[], K: number, agg: (a: number[]) => number = median): number {
  const vals: number[] = []
  for (const l of legs) {
    const from = Math.max(0, l.lowIndex - K)
    const slice = f.slice(from, l.lowIndex + 1)
    const v = agg(slice)
    if (Number.isFinite(v)) vals.push(v)
  }
  return agg(vals)
}

async function main(): Promise<void> {
  const rows: Array<{ sym: string; n: number; legs: Leg[]; soft: number; f: Features }> = []
  for (const s of SYMBOLS) {
    const { candles: c } = await fetchKlines({
      exchange: 'binanceusdm', symbol: s, timeframe: TF, since, until, targetBars: 9000,
    })
    const legs = detectLegs(c)
    const soft = detectLegs(c, LEGS_SOFT_GAIN).length
    rows.push({ sym: s, n: c.length, legs, soft, f: features(c) })
    console.log(
      `\n== ${s.padEnd(24)} ${c.length} 根 (${iso(c[0].timestamp)} ~ ${iso(c[c.length - 1].timestamp)}) · 暴涨段 ${legs.length} 个（≥30% 软口径 ${soft} 个）`,
    )
    for (const l of legs) {
      console.log(
        `   ${iso(l.lowTime)} → ${iso(l.peakTime)}  +${(l.gain * 100).toFixed(0)}% / ${l.bars}根(${(l.bars / 24).toFixed(1)}天)`,
      )
    }
  }

  /* ---------- 跨币聚合：暴涨段启动前特征 vs 全体基线 ---------- */
  console.log('\n\n======== 暴涨段「启动前 24 根窗口」特征（妖币共性）========')
  console.log('K=24 · 每格 = 该窗口内中位数，再跨段取中位')
  console.log('')
  const allLegs = rows.flatMap((r) => r.legs)
  console.log(`样本共 ${rows.length} 币 · ${allLegs.length} 段暴涨`)
  console.log('')
  const dims: Array<[string, (f: Features) => number[], (l: Leg) => number, string]> = [
    ['量能倍数 vol/96均', (f) => f.volR96, (l) => l.lowIndex, '启动前量能'],
    ['近6根涨幅 %', (f) => f.ret6, (l) => l.lowIndex, '启动前动量'],
    ['ATR% 扩张 (vs 240均)', (f) => f.atrExp, (l) => l.lowIndex, '波动扩张'],
    ['48根振幅 %', (f) => f.amp48, (l) => l.lowIndex, '区间窄幅'],
    ['收在48根区间位置', (f) => f.pos48, (l) => l.lowIndex, '0底部~1顶部'],
    ['MA20/MA200 粘合度', (f) => f.maGap, (l) => l.lowIndex, '均线粘合'],
    ['距 MA200 %', (f) => f.dist200, (l) => l.lowIndex, '位置'],
    ['距 2400根高点回撤 %', (f) => f.ddFromHigh, (l) => l.lowIndex, '深度回撤'],
    ['RSI14', (f) => f.rsi14, (l) => l.lowIndex, '超买超卖'],
  ]
  // 全局基线
  const baselines: Array<[string, number]> = []
  for (const [name, get] of dims.slice(0, 7)) {
    const all: number[] = []
    for (const r of rows) {
      for (let i = 240; i < r.n; i++) {
        const v = get(r.f)[i]
        if (Number.isFinite(v)) all.push(v)
      }
    }
    baselines.push([name, median(all)])
  }

  console.log('维度                          | 基线(全bar中位) | 妖币启动前K=24   | 对比')
  for (let d = 0; d < dims.length; d++) {
    const [name, get] = dims[d]
    const legVals: number[] = []
    for (const r of rows) {
      for (const l of r.legs) {
        const from = Math.max(0, l.lowIndex - 24)
        const v = median(get(r.f).slice(from, l.lowIndex + 1))
        if (Number.isFinite(v)) legVals.push(v)
      }
    }
    const base = baselines.find((b) => b[0] === name)
    const baseStr = base ? (base[1] * 100).toFixed(1) + (name.includes('RSI') || name.includes('位置') ? '' : '%') : ''
    console.log(
      `${name.padEnd(24)} | ${baseStr.padStart(14)}  | ${fm(median(legVals) * 100, 1).padStart(8)}  | ${base ? (median(legVals) / Math.max(1e-9, base[1])).toFixed(2) + '×' : ''}`,
    )
  }

  /* ---------- 启动 bar 的特征（E 放量） ---------- */
  console.log('\n======== 启动 bar 特征（低点后第一根击穿 +15% 的 bar）========')
  const boot: Array<{ sym: string; gain: number; volR: number; rsi: number }> = []
  const CONF = 0.15
  for (const r of rows) {
    for (const l of r.legs) {
      const c = r.f
      let bi = -1
      for (let k = l.lowIndex + 1; k <= l.peakIndex && k < r.n; k++) {
        if (c.price[k] / c.price[l.lowIndex] - 1 >= CONF) { bi = k; break }
      }
      if (bi >= 0) boot.push({ sym: r.sym, gain: l.gain, volR: c.volR96[bi] ?? NaN, rsi: c.rsi14[bi] ?? NaN })
    }
  }
  console.log(`启动 bar 放量中位：${fm(median(boot.map((b) => b.volR)), 2)}×96均量 · p25=${fm(
    [...boot.map((b) => b.volR)].filter(Number.isFinite).sort((a, b) => a - b)[Math.floor(boot.length * 0.25)], 2)} · max=${fm(Math.max(...boot.map((b) => b.volR)), 2)}`)
  console.log(`启动 bar RSI 中位：${fm(median(boot.map((b) => b.rsi)), 1)}`)

  /* ---------- 妖币 vs 后续：段后结局（暴涨后有延续吗） ---------- */
  console.log('\n======== 暴涨段之后：见顶回撤深度（妖币的「快涨快跌」特征）========')
  const after: number[] = []
  for (const r of rows) {
    for (const l of r.legs) {
      const from = l.peakIndex + 1
      const to = Math.min(r.n - 1, from + 168)
      if (to <= from) continue
      let worst = 1
      for (let k = from; k <= to; k++) {
        const dd = r.f.price[k] / l.peak - 1
        if (dd < worst) worst = dd
      }
      after.push(worst)
    }
  }
  console.log(`段后 168 根内最深回撤中位：${(median(after) * 100).toFixed(1)}% · p25=${fm([...after].sort((a, b) => a - b)[Math.floor(after.length * 0.25)] * 100, 1)}%`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
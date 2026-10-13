/**
 * 「埋伏型」入场可行性分析：验证「收缩/沉寂期 → 暴涨启动」的条件概率是否真高于基线。
 *
 * 与 scan-pumps.ts 的区别：那里的特征取在「暴涨确认 bar」，回答"启动时长什么样"；
 * 这里取在「暴涨启动**之前**的 K 根窗口」，回答"启动前能不能提前看出苗头"。
 *
 * 判定是纯统计的，不写策略：
 *   · 信号 = 某根 bar 处于「收缩/沉寂」状态（可叠加"首根放量"触发）
 *   · 命中 = 该根之后 K 根内出现暴涨区间的**最低点**（即启动点）
 *   · 精度 = 命中 / 信号段数；基线 = 随机一根 bar 在 K 根内撞上启动点的概率；lift = 精度/基线
 *   · 覆盖 = 有多少暴涨段在启动前 K 根内出现过该信号
 * 只有当精度明显高于基线（lift 足够大）时，埋伏型入场才值得写。
 *
 * 用法：npx tsx scripts/scan-ambush.ts [K]
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Candle } from '../shared/types'
import { fetchKlines } from '../server/src/market/exchange'
import { atr, highest, lowest, sma, stdev } from '../server/src/indicators/ta'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/** 样本内 6 币 + 样本外 14 币，一起统计（对照组越多，精度越可信） */
const SYMBOLS = [
  'AKE/USDT:USDT', '币安人生/USDT:USDT', '龙虾/USDT:USDT', 'BANK/USDT:USDT', 'LAB/USDT:USDT', 'MYX/USDT:USDT',
  'PENGU/USDT:USDT', 'WIF/USDT:USDT', 'POPCAT/USDT:USDT', 'TRUMP/USDT:USDT', 'FARTCOIN/USDT:USDT',
  'MOODENG/USDT:USDT', 'PNUT/USDT:USDT', 'ACT/USDT:USDT', 'GOAT/USDT:USDT', 'NEIRO/USDT:USDT',
  'BRETT/USDT:USDT', 'TURBO/USDT:USDT', 'BOME/USDT:USDT', 'DOGS/USDT:USDT',
]
const since = Date.UTC(2025, 9, 13)
const until = Date.UTC(2026, 9, 13)
const TF = '1h' as const

/** 暴涨定义：W 根内自最低点起涨 ≥ MIN_GAIN（与 scan-pumps 一致） */
const W = 72
const MIN_GAIN = 0.5
/** 预测窗：信号出现后多少根内启动算命中 */
const K = Number(process.argv[2] ?? 48)
/** 统计起点（留给 240 根均线的预热） */
const WARM = 240

const fm = (n: number, d = 1): string => (Number.isFinite(n) ? n.toFixed(d) : '—')

interface Leg { lowIndex: number }
function detectLegs(c: Candle[]): Leg[] {
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
    let li = best
    for (let k = best; k >= Math.max(0, best - W + 1); k--) if (low[k] < low[li]) li = k
    legs.push({ lowIndex: li })
    i = j + 1
  }
  legs.sort((a, b) => a.lowIndex - b.lowIndex)
  const kept: Leg[] = []
  for (const l of legs) if (!kept.length || l.lowIndex > kept[kept.length - 1].lowIndex) kept.push(l)
  return kept
}

async function main(): Promise<void> {
  /* ---------- 1) 逐币算特征 + 信号 ---------- */
  interface Pack { n: number; start: number; legLow: boolean[]; sig: Record<string, boolean[]> }
  const packs: Pack[] = []
  let totalBars = 0
  let totalLegs = 0

  const sigDefs: Array<{ name: string; test: (f: Record<string, number[]>, i: number) => boolean }> = [
    { name: 'S1 量枯竭 volR<0.5', test: (f, i) => f.volR[i] < 0.5 },
    { name: 'S2 波动压缩 atrPct<0.7×240均', test: (f, i) => f.atrPct[i] < 0.7 * f.atrAvg[i] },
    { name: 'S3 窄幅 48根振幅<35%', test: (f, i) => f.range48[i] < 0.35 },
    { name: 'S3a 窄幅 <20%', test: (f, i) => f.range48[i] < 0.2 },
    { name: 'S3b 窄幅 <25%', test: (f, i) => f.range48[i] < 0.25 },
    { name: 'S3b+低位 收在区间下40%', test: (f, i) => f.range48[i] < 0.25 && f.posInRange[i] < 0.4 },
    { name: 'S3b+高位 收在区间上40%', test: (f, i) => f.range48[i] < 0.25 && f.posInRange[i] > 0.6 },
    { name: 'S3b+缩量 volR<1', test: (f, i) => f.range48[i] < 0.25 && f.volR[i] < 1 },
    { name: 'S3b+站上MA200', test: (f, i) => f.range48[i] < 0.25 && f.above200[i] > 0 },
    { name: 'S3b+均线粘合 MA20/MA200 差<5%', test: (f, i) => f.range48[i] < 0.25 && f.maGap[i] < 0.05 },
    { name: 'E  首根放量 volR≥2 且 量>1.5×前根', test: (f, i) => f.volR[i] >= 2 && f.vol[i] > 1.5 * f.volPrev[i] },
    { name: 'S3b+E 窄幅后首根放量', test: (f, i) => f.range48[i] < 0.25 && f.volR[i + 1] >= 2 && f.vol[i + 1] > 1.5 * f.vol[i] },
  ]

  for (const s of SYMBOLS) {
    const { candles: c } = await fetchKlines({
      exchange: 'binanceusdm', symbol: s, timeframe: TF, since, until, targetBars: 9000,
    })
    const n = c.length
    const close = c.map((x) => x.close)
    const high = c.map((x) => x.high)
    const low = c.map((x) => x.low)
    const vol = c.map((x) => x.volume)
    const vol96 = sma(vol, 96)
    const atrPct = atr(high, low, close, 14).map((a, i) => (a / close[i]) * 100)
    const atrAvg = sma(atrPct.map((v) => (Number.isFinite(v) ? v : 0)), 240)
    const ma20 = sma(close, 20)
    const sd20 = stdev(close, 20)
    const bbW = close.map((_, i) =>
      Number.isFinite(ma20[i]) && ma20[i] > 0 && Number.isFinite(sd20[i]) ? ((4 * sd20[i]) / ma20[i]) * 100 : NaN,
    )
    const hi48 = highest(high, 48)
    const lo48 = lowest(low, 48)
    const ma200 = sma(close, 200)
    const f: Record<string, number[]> = {
      vol: vol.slice(),
      volR: vol.map((v, i) => (Number.isFinite(vol96[i]) && vol96[i] > 0 ? v / vol96[i] : NaN)),
      volPrev: vol.map((_, i) => (i > 0 ? vol[i - 1] : NaN)),
      atrPct,
      atrAvg,
      bbW,
      range48: close.map((v, i) =>
        Number.isFinite(hi48[i]) && Number.isFinite(lo48[i]) && v > 0 ? (hi48[i] - lo48[i]) / v : NaN,
      ),
      /** 收盘价在 48 根区间中的位置（0 = 区间最低，1 = 区间最高） */
      posInRange: close.map((v, i) =>
        Number.isFinite(hi48[i]) && Number.isFinite(lo48[i]) && hi48[i] > lo48[i]
          ? (v - lo48[i]) / (hi48[i] - lo48[i])
          : NaN,
      ),
      above200: close.map((v, i) => (Number.isFinite(ma200[i]) ? v / ma200[i] - 1 : NaN)),
      maGap: close.map((v, i) =>
        Number.isFinite(ma20[i]) && Number.isFinite(ma200[i]) && ma200[i] > 0
          ? Math.abs(ma20[i] / ma200[i] - 1)
          : NaN,
      ),
    }
    const legs = detectLegs(c)
    totalLegs += legs.length
    const legLow = new Array<boolean>(n).fill(false)
    for (const l of legs) if (l.lowIndex >= 0 && l.lowIndex < n) legLow[l.lowIndex] = true
    const sig: Record<string, boolean[]> = {}
    for (const d of sigDefs) {
      const a = new Array<boolean>(n).fill(false)
      for (let i = WARM; i < n - 1; i++) a[i] = d.test(f, i)
      sig[d.name] = a
    }
    packs.push({ n, start: WARM, legLow, sig })
    totalBars += Math.max(0, n - WARM - K)
  }

  /* ---------- 2) 基线：随机一根 bar 在 K 根内撞上启动点 ---------- */
  let baseHit = 0, baseTot = 0
  for (const p of packs) {
    // 后缀和：nextLeg[i] = [i, i+K] 内是否有启动点
    const suf = new Array<number>(p.n + 1).fill(0)
    for (let i = p.n - 1; i >= 0; i--) suf[i] = suf[i + 1] + (p.legLow[i] ? 1 : 0)
    for (let i = p.start; i < p.n - K; i++) {
      baseTot++
      if (suf[i + 1] - suf[Math.min(p.n, i + K + 1)] > 0) baseHit++
    }
  }
  const base = baseHit / Math.max(1, baseTot)

  console.log(`\n样本：${SYMBOLS.length} 个币 · 1h · ${totalBars} 根统计 bar · 暴涨区间 ${totalLegs} 段 · 预测窗 K=${K} 根`)
  console.log(`基线（随机一根 bar 在 K 根内撞上启动点）：${(base * 100).toFixed(2)}%\n`)
  console.log(`${'信号'.padEnd(34)} ${'信号段'.padStart(7)} ${'命中'.padStart(6)} ${'精度'.padStart(7)} ${'lift'.padStart(6)} ${'覆盖暴涨段'.padStart(11)}`)

  const out: Array<Record<string, unknown>> = []
  for (const d of sigDefs) {
    let episodes = 0, hits = 0, coveredLegs = 0
    for (const p of packs) {
      const a = p.sig[d.name]
      // 信号段（连续触发算一段），逐段判断其后 K 根内是否出现启动点
      for (let i = p.start; i < p.n - K; i++) {
        if (!a[i] || a[i - 1]) continue
        episodes++
        let hit = false
        for (let j = i + 1; j <= Math.min(p.n - 1, i + K); j++) if (p.legLow[j]) { hit = true; break }
        if (hit) hits++
      }
      // 覆盖：每个启动点前 K 根内是否出现过该信号
      const legIdx: number[] = []
      for (let i = 0; i < p.n; i++) if (p.legLow[i]) legIdx.push(i)
      for (const L of legIdx) {
        let seen = false
        for (let j = Math.max(p.start, L - K); j < L; j++) if (a[j]) { seen = true; break }
        if (seen) coveredLegs++
      }
    }
    const prec = hits / Math.max(1, episodes)
    const lift = base > 0 ? prec / base : NaN
    console.log(
      `${d.name.padEnd(34)} ${String(episodes).padStart(7)} ${String(hits).padStart(6)} ` +
      `${fm(prec * 100).padStart(6)}% ${fm(lift, 2).padStart(6)} ${`${coveredLegs}/${totalLegs}`.padStart(11)}`,
    )
    out.push({ name: d.name, episodes, hits, precision: prec, lift, covered: coveredLegs, totalLegs })
  }

  console.log(`\n判读标准：精度需明显高于基线（lift 越大越可信），且覆盖度不能太低（否则埋伏不到多少行情）。`)
  console.log(`若 lift < 2，说明"收缩/沉寂"在非暴涨币上同样常见，埋伏型入场不具备统计优势。`)
}

main().catch((e) => { console.error('失败：', e instanceof Error ? e.message : e); process.exit(1) })

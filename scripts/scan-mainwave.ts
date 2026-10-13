/**
 * 「主升浪」特征检验：先客观定义主升浪，再看它的**启动确认 bar** 有哪些可观测特征。
 *
 * 主升浪定义（与「2~3 天暴涨脉冲」区分开）：
 *   用 25% 回撤阈值的 zigzag 切出所有上涨波段 → 只保留**历时 ≥ MIN_BARS**（默认 240 根 = 10 天）
 *   的波段 → 每个币按涨幅取**前 3 波**，即"主升浪通常只有两三波"。
 * 启动确认 bar：波段低点之后，收盘首次 ≥ 低点 × (1+CONF) 的那一根（一个真能下单的时刻）。
 *
 * 对每个特征算：确认 bar 上的中位数 vs 全样本基线中位数；并对候选规则算
 * 精度 / 基线 / lift / 覆盖（口径同 scan-ambush.ts）。
 *
 * 用法：npx tsx scripts/scan-mainwave.ts [symbols...]
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Candle } from '../shared/types'
import { fetchKlines } from '../server/src/market/exchange'
import { atr, highest, lowest, sma, stdev } from '../server/src/indicators/ta'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const SYMBOLS = process.argv.slice(2).filter((a) => a.includes('/'))
const symbols = SYMBOLS.length
  ? SYMBOLS
  : ['AKE/USDT:USDT', '币安人生/USDT:USDT', '龙虾/USDT:USDT', 'BANK/USDT:USDT', 'LAB/USDT:USDT', 'MYX/USDT:USDT',
     'PENGU/USDT:USDT', 'WIF/USDT:USDT', 'POPCAT/USDT:USDT', 'TRUMP/USDT:USDT', 'FARTCOIN/USDT:USDT',
     'MOODENG/USDT:USDT', 'PNUT/USDT:USDT', 'ACT/USDT:USDT', 'GOAT/USDT:USDT', 'NEIRO/USDT:USDT',
     'BRETT/USDT:USDT', 'TURBO/USDT:USDT', 'BOME/USDT:USDT', 'DOGS/USDT:USDT']
const since = Date.UTC(2025, 9, 13)
const until = Date.UTC(2026, 9, 13)
const TF = '1h' as const

/** zigzag 回撤阈值 */
const ZIG = 0.25
/** 主升浪最短历时（根） */
const MIN_BARS = 240
/** 每币取涨幅前 N 波 */
const TOP_N = 3
/** 确认涨幅（自波段低点） */
const CONF = 0.25
/** 统计预热 */
const WARM = 240

const fm = (n: number, d = 1): string => (Number.isFinite(n) ? n.toFixed(d) : '—')
function median(a: number[]): number {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y)
  return v.length ? v[(v.length - 1) >> 1] : NaN
}

interface Wave { lowIndex: number; peakIndex: number; gain: number; bars: number; confIndex: number }

/** zigzag 切上涨波段 → 只留历时 ≥ MIN_BARS → 取涨幅前 TOP_N */
function mainWaves(c: Candle[]): Wave[] {
  const n = c.length
  const ups: Wave[] = []
  let d: 1 | -1 = 1
  let lo0 = 0
  let hi0 = 0
  for (let i = 1; i < n; i++) {
    if (d === 1) {
      if (c[i].high >= c[hi0].high) hi0 = i
      else if (c[i].low <= c[hi0].high * (1 - ZIG)) {
        ups.push({ lowIndex: lo0, peakIndex: hi0, gain: c[hi0].high / c[lo0].low - 1, bars: hi0 - lo0, confIndex: -1 })
        d = -1
        lo0 = i
      }
    } else {
      if (c[i].low <= c[lo0].low) lo0 = i
      else if (c[i].high >= c[lo0].low * (1 + ZIG)) {
        d = 1
        hi0 = i
      }
    }
  }
  if (d === 1 && hi0 > lo0) {
    ups.push({ lowIndex: lo0, peakIndex: hi0, gain: c[hi0].high / c[lo0].low - 1, bars: hi0 - lo0, confIndex: -1 })
  }
  const kept = ups.filter((w) => w.bars >= MIN_BARS)
  kept.sort((a, b) => b.gain - a.gain)
  const top = kept.slice(0, TOP_N)
  for (const w of top) {
    const target = c[w.lowIndex].low * (1 + CONF)
    for (let k = w.lowIndex + 1; k <= w.peakIndex; k++) if (c[k].close >= target) { w.confIndex = k; break }
  }
  return top
}

async function main(): Promise<void> {
  const sigDefs: Array<{ name: string; test: (f: Record<string, number[]>, i: number) => boolean }> = [
    { name: 'V1 量/96均量 ≥3', test: (f, i) => f.volR96[i] >= 3 },
    { name: 'V2 量/96均量 ≥1.5', test: (f, i) => f.volR96[i] >= 1.5 },
    { name: 'B1 破24根新高', test: (f, i) => f.brk24[i] > 0 },
    { name: 'B2 破50根新高', test: (f, i) => f.brk50[i] > 0 },
    { name: 'B3 破100根新高', test: (f, i) => f.brk100[i] > 0 },
    { name: 'T1 均线多头 MA20>MA50>MA200', test: (f, i) => f.align[i] > 0 },
    { name: 'T2 站上MA200', test: (f, i) => f.dist200[i] > 0 },
    { name: 'T3 MA50 上行(10根)', test: (f, i) => f.ma50Up[i] > 0 },
    { name: 'C1 破24新高 + 量≥1.5 + 多头排列', test: (f, i) => f.brk24[i] > 0 && f.volR96[i] >= 1.5 && f.align[i] > 0 },
    { name: 'C2 破50新高 + 量≥2 + 站上MA200', test: (f, i) => f.brk50[i] > 0 && f.volR96[i] >= 2 && f.dist200[i] > 0 },
    { name: 'C3 破24新高 + MA50上行 + 量≥1.2', test: (f, i) => f.brk24[i] > 0 && f.ma50Up[i] > 0 && f.volR96[i] >= 1.2 },
    { name: 'C4 窄幅<35% + 破24新高', test: (f, i) => f.range48[i] < 0.35 && f.brk24[i] > 0 },
  ]

  interface Pack { n: number; start: number; conf: boolean[]; f: Record<string, number[]>; sig: Record<string, boolean[]> }
  const packs: Pack[] = []
  const allWaves: Wave[] = []
  let totalBars = 0
  let coinTxt: string[] = []

  for (const s of symbols) {
    const { candles: c } = await fetchKlines({
      exchange: 'binanceusdm', symbol: s, timeframe: TF, since, until, targetBars: 9000,
    })
    const n = c.length
    const close = c.map((x) => x.close)
    const high = c.map((x) => x.high)
    const low = c.map((x) => x.low)
    const vol = c.map((x) => x.volume)
    const hi = (len: number): number[] => highest(high, len)
    const lo = (len: number): number[] => lowest(low, len)
    const ma20 = sma(close, 20), ma50 = sma(close, 50), ma200 = sma(close, 200)
    const vol96 = sma(vol, 96)
    const atrPct = atr(high, low, close, 14).map((a, i) => (a / close[i]) * 100)
    const atrAvg = sma(atrPct.map((v) => (Number.isFinite(v) ? v : 0)), 240)
    const sd20 = stdev(close, 20)
    const hi24 = hi(24), hi50 = hi(50), hi100 = hi(100), hi48 = hi(48), lo48 = lo(48)
    const f: Record<string, number[]> = {
      volR96: vol.map((v, i) => (Number.isFinite(vol96[i]) && vol96[i] > 0 ? v / vol96[i] : NaN)),
      brk24: close.map((v, i) => (i > 0 && Number.isFinite(hi24[i - 1]) && hi24[i - 1] > 0 ? v / hi24[i - 1] - 1 : NaN)),
      brk50: close.map((v, i) => (i > 0 && Number.isFinite(hi50[i - 1]) && hi50[i - 1] > 0 ? v / hi50[i - 1] - 1 : NaN)),
      brk100: close.map((v, i) => (i > 0 && Number.isFinite(hi100[i - 1]) && hi100[i - 1] > 0 ? v / hi100[i - 1] - 1 : NaN)),
      align: close.map((_, i) =>
        Number.isFinite(ma20[i]) && Number.isFinite(ma50[i]) && Number.isFinite(ma200[i]) && ma20[i] > ma50[i] && ma50[i] > ma200[i] ? 1 : 0,
      ),
      dist200: close.map((v, i) => (Number.isFinite(ma200[i]) && ma200[i] > 0 ? v / ma200[i] - 1 : NaN)),
      dist50: close.map((v, i) => (Number.isFinite(ma50[i]) && ma50[i] > 0 ? v / ma50[i] - 1 : NaN)),
      ma50Up: close.map((_, i) => (i >= 10 && Number.isFinite(ma50[i]) && Number.isFinite(ma50[i - 10]) && ma50[i] > ma50[i - 10] ? 1 : 0)),
      ret24: close.map((v, i) => (i >= 24 ? v / close[i - 24] - 1 : NaN)),
      ret72: close.map((v, i) => (i >= 72 ? v / close[i - 72] - 1 : NaN)),
      atrExp: atrPct.map((v, i) => (Number.isFinite(atrAvg[i]) && atrAvg[i] > 0 ? v / atrAvg[i] : NaN)),
      bbW: close.map((_, i) => (Number.isFinite(ma20[i]) && ma20[i] > 0 && Number.isFinite(sd20[i]) ? ((4 * sd20[i]) / ma20[i]) * 100 : NaN)),
      range48: close.map((v, i) => (Number.isFinite(hi48[i]) && Number.isFinite(lo48[i]) && v > 0 ? (hi48[i] - lo48[i]) / v : NaN)),
    }
    const waves = mainWaves(c)
    allWaves.push(...waves)
    coinTxt.push(`${s.split('/')[0]}: ${waves.map((w) => `+${fm(w.gain * 100, 0)}%/${w.bars}根`).join('  ') || '—'}`)
    const conf = new Array<boolean>(n).fill(false)
    for (const w of waves) if (w.confIndex >= 0) conf[w.confIndex] = true
    const sig: Record<string, boolean[]> = {}
    for (const d of sigDefs) {
      const a = new Array<boolean>(n).fill(false)
      for (let i = WARM; i < n; i++) a[i] = d.test(f, i)
      sig[d.name] = a
    }
    packs.push({ n, start: WARM, conf, f, sig })
    totalBars += Math.max(0, n - WARM)
  }

  console.log(`\n样本：${symbols.length} 币 · 1h · ${totalBars} 统计 bar`)
  console.log(`主升浪（回撤25% zigzag、历时≥${MIN_BARS}根、每币涨幅前${TOP_N}波）：共 ${allWaves.length} 波`)
  for (const t of coinTxt) console.log(`   ${t}`)

  /* ---- 特征中位数对照 ---- */
  const ev: Record<string, number[]> = {}, base: Record<string, number[]> = {}
  for (const p of packs) {
    for (const k of Object.keys(p.f)) { ev[k] ??= []; base[k] ??= [] }
    for (let i = 0; i < p.n; i++) {
      for (const k of Object.keys(p.f)) {
        const v = p.f[k][i]
        if (!Number.isFinite(v)) continue
        base[k].push(v)
        if (p.conf[i]) ev[k].push(v)
      }
    }
  }
  const label: Record<string, string> = {
    volR96: '成交量/96均量', brk24: '相对24根新高', brk50: '相对50根新高', brk100: '相对100根新高',
    align: '多头排列(0/1)', dist200: '距MA200', dist50: '距MA50', ma50Up: 'MA50上行(0/1)',
    ret24: '近24根涨幅', ret72: '近72根涨幅', atrExp: 'ATR%/240均', bbW: '布林带宽%', range48: '48根振幅',
  }
  console.log(`\n===== 主升浪【启动确认 bar】特征 vs 全样本基线 =====`)
  console.log(`${'特征'.padEnd(18)} ${'确认bar中位'.padStart(12)} ${'基线中位'.padStart(10)}`)
  for (const k of Object.keys(label)) {
    console.log(`${label[k].padEnd(18)} ${fm(median(ev[k] ?? []), 3).padStart(12)} ${fm(median(base[k] ?? []), 3).padStart(10)}`)
  }

  /* ---- 规则：精度/lift/覆盖（口径同 scan-ambush）---- */
  let baseHit = 0, baseTot = 0, totalWaves = 0
  for (const p of packs) {
    totalWaves += p.conf.filter(Boolean).length
    for (let i = p.start; i < p.n; i++) {
      baseTot++
      if (p.conf[i]) baseHit++
    }
  }
  const baseline = baseHit / Math.max(1, baseTot)
  console.log(`\n===== 候选规则（命中 = 该 bar 就是某个主升浪的启动确认 bar）=====`)
  console.log(`基线（随机一根 bar 就是启动确认 bar）：${(baseline * 100).toFixed(3)}%\n`)
  console.log(`${'规则'.padEnd(34)} ${'信号段'.padStart(7)} ${'命中'.padStart(6)} ${'精度'.padStart(7)} ${'lift'.padStart(6)} ${'覆盖'.padStart(8)}`)
  for (const d of sigDefs) {
    let episodes = 0, hits = 0, covered = 0
    for (const p of packs) {
      const a = p.sig[d.name]
      for (let i = p.start; i < p.n; i++) {
        if (!a[i] || a[i - 1]) continue
        episodes++
        // 命中口径：该段信号起始 bar 起、向后 8 根内出现启动确认 bar
        let hit = false
        for (let j = i; j <= Math.min(p.n - 1, i + 8); j++) if (p.conf[j]) { hit = true; break }
        if (hit) hits++
      }
      for (let i = p.start; i < p.n; i++) if (p.conf[i]) {
        let seen = false
        for (let j = Math.max(p.start, i - 8); j <= i; j++) if (a[j]) { seen = true; break }
        if (seen) covered++
      }
    }
    console.log(
      `${d.name.padEnd(34)} ${String(episodes).padStart(7)} ${String(hits).padStart(6)} ` +
      `${fm((hits / Math.max(1, episodes)) * 100).padStart(6)}% ${fm(hits / Math.max(1, episodes) / baseline, 1).padStart(6)} ` +
      `${`${covered}/${totalWaves}`.padStart(8)}`,
    )
  }
  console.log(`\n注：命中口径 = 信号出现后 8 根内即为启动确认 bar；覆盖 = 有多少主升浪在确认 bar 前 8 根内已被信号覆盖。`)
}

main().catch((e) => { console.error('失败：', e instanceof Error ? e.message : e); process.exit(1) })

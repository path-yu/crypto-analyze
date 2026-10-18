/**
 * 妖币雷达 —— 山寨币「妖币潜力」评分与全市场埋伏扫描。
 *
 * 评分模型来自 scripts/yao-sample.ts 对 10 只样本妖币（LAB/RIVER/SIREN/AGT/AKE/
 * BTW/TUT/SOON/币安人生/龙虾）一年 246 段暴涨的复盘，四个维度：
 *
 *   1. 弹性（30 分）    —— 妖币不是「涨一次」，是「反复暴涨」：
 *                         样本币一年内 ≥50% 暴涨段 13~42 次、≥30% 软口径 14~65 次。
 *   2. 新鲜度（20 分）   —— 最近一次暴涨距今越近，妖性越「活」。
 *   3. 埋伏位（30 分）   —— 启动前画像：距历史高点回撤深（中位 -46.6%）、
 *                         品种本身振幅大（48 根振幅中位 44.7%，基线 2.5×）、
 *                         量能枯竭、RSI 低位，且当前**没有**处于爆拉中（不追高）。
 *   4. 异动（20 分）     —— 启动 bar 共性：突然放量（中位 2.19×96 均量）+ 短窗口加速。
 *
 * 另设「流动性红线」：96 根均量×收盘价的日均成交额过低 → 直接淘汰（妖币若没有
 * 成交额承接，插桩也飞不起来；也避免出现在埋伏名单里）。
 *
 * 用法：
 *   npx tsx scripts/yao-radar.ts --coin LAB/USDT:USDT     单币体检
 *   npx tsx scripts/yao-radar.ts --top 30                  全市场扫描，打印前 30
 *   npx tsx scripts/yao-radar.ts --top 30 --resume         断点续扫（跳过已有结果）
 *
 * 结果实时写 reports/yao-radar.jsonl（每扫完一个品种append一行），可中断重跑。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Candle } from '../shared/types'
import { listInstruments, fetchKlines } from '../server/src/market/exchange'
import { atr, highest, lowest, rsi, sma } from '../server/src/indicators/ta'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'reports')
const OUT_FILE = path.join(OUT_DIR, 'yao-radar.jsonl')

const TF = '1h' as const
/** 扫描窗口：6000 根 1h ≈ 250 天（足以评估弹性与新鲜度） */
const TARGET_BARS = 6000
const W = 72
const GAIN = 0.5
const GAIN_SOFT = 0.3
/** 并发拉取数（binance 限流内安全） */
const CONCURRENCY = 6
/** 流动性红线：日均成交额（USDT）低于此值直接淘汰 */
const MIN_DAILY_NOTIONAL = 20_000

function median(a: number[]): number {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y)
  return v.length ? v[(v.length - 1) >> 1] : NaN
}

interface Leg { lowTime: number; peakTime: number; gain: number }

/** 检测暴涨段：W 根内自最低点涨幅 ≥ gain（含非极大抑制） */
function detectLegs(c: Candle[], gain: number): Leg[] {
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
    for (let k = li + 1; k <= j && k < n; k++) if (close[k] > close[pi]) pi = k
    legs.push({ lowTime: c[li].timestamp, peakTime: c[pi].timestamp, gain: close[pi] / low[li] - 1 })
    i = j + 1
  }
  legs.sort((a, b) => a.lowTime - b.lowTime)
  // 去重：与上一段低点相隔 < 48 根视为同一波
  const kept: Leg[] = []
  const TIME48 = 48 * 3600_000
  for (const l of legs) {
    if (!kept.length || l.lowTime - kept[kept.length - 1].lowTime > TIME48) kept.push(l)
  }
  return kept
}

export interface YaoScore {
  symbol: string
  label: string
  total: number
  elasticity: number
  freshness: number
  ambush: number
  motion: number
  hardLegs: number
  softLegs: number
  maxGain: number
  lastLegDaysAgo: number
  ddFromHigh: number
  amp48: number
  volR96Now: number
  rsiNow: number
  dailyNotional: number
  ret72: number
  maxVolR48: number
  ret24: number
  bars: number
  dropped?: string
}

/** 单币评分（candles 为 1h）。返回 null = 流动性淘汰 */
export function scoreCoin(symbol: string, label: string, c: Candle[]): YaoScore | null {
  const n = c.length
  if (n < 300) {
    return {
      symbol, label, total: 0, elasticity: 0, freshness: 0, ambush: 0, motion: 0,
      hardLegs: 0, softLegs: 0, maxGain: 0, lastLegDaysAgo: -1, ddFromHigh: 0, amp48: 0,
      volR96Now: 0, rsiNow: 0, dailyNotional: 0, ret72: 0, maxVolR48: 0, ret24: 0,
      bars: n, dropped: '历史不足 300 根',
    }
  }
  const close = c.map((x) => x.close)
  const high = c.map((x) => x.high)
  const low = c.map((x) => x.low)
  const vol = c.map((x) => x.volume)

  /* ---- 流动性 ---- */
  const vol96 = sma(vol, 96)
  const avgNotional = median(c.slice(Math.max(0, n - 96)).map((x, i) => x.close * vol96[n - 96 + i] ?? NaN))
  const lastClose = close[n - 1]
  const dailyNotional = (Number.isFinite(vol96[n - 1]) ? vol96[n - 1] : 0) * lastClose
  if (Number.isFinite(dailyNotional) && dailyNotional < MIN_DAILY_NOTIONAL) {
    return {
      symbol, label, total: 0, elasticity: 0, freshness: 0, ambush: 0, motion: 0,
      hardLegs: 0, softLegs: 0, maxGain: 0, lastLegDaysAgo: -1, ddFromHigh: 0, amp48: 0,
      volR96Now: 0, rsiNow: 0, dailyNotional, ret72: 0, maxVolR48: 0, ret24: 0,
      bars: n, dropped: `流动性不足（日均成交额 ≈ $${Math.round(dailyNotional).toLocaleString()}）`,
    }
  }

  /* ---- 弹性 ---- */
  const hard = detectLegs(c, GAIN)
  const soft = detectLegs(c, GAIN_SOFT)
  const maxGain = hard.reduce((m, l) => Math.max(m, l.gain), 0)
  let elasticity = 0
  if (hard.length >= 15) elasticity = 30
  else if (hard.length >= 10) elasticity = 26
  else if (hard.length >= 6) elasticity = 21
  else if (hard.length >= 3) elasticity = 15
  else if (hard.length >= 1) elasticity = 8
  if (maxGain >= 2) elasticity = Math.min(30, elasticity + 4)

  /* ---- 新鲜度 ---- */
  const lastLeg = soft[soft.length - 1]
  const lastLegDaysAgo = lastLeg ? (Date.now() - lastLeg.peakTime) / 86400_000 : -1
  let freshness = 0
  if (lastLegDaysAgo >= 0) {
    if (lastLegDaysAgo <= 7) freshness = 20
    else if (lastLegDaysAgo <= 14) freshness = 16
    else if (lastLegDaysAgo <= 30) freshness = 12
    else if (lastLegDaysAgo <= 60) freshness = 8
    else freshness = 4
  }

  /* ---- 埋伏位 ---- */
  const hi2400 = highest(high, Math.min(2400, n))
  const ddFromHigh = Number.isFinite(hi2400[n - 1]) && hi2400[n - 1] > 0 ? lastClose / hi2400[n - 1] - 1 : 0
  const hi48 = highest(high, 48)
  const lo48 = lowest(low, 48)
  const amp48 = Number.isFinite(hi48[n - 1]) && Number.isFinite(lo48[n - 1]) && lo48[n - 1] > 0
    ? hi48[n - 1] / lo48[n - 1] - 1
    : 0
  const volR96Now = Number.isFinite(vol96[n - 1]) && vol96[n - 1] > 0 ? vol[n - 1] / vol96[n - 1] : 1
  const rsiArr = rsi(close, 14)
  const rsiNow = rsiArr[n - 1]
  const atrPct = atr(high, low, close, 14).map((a, i) => (a / close[i]) * 100)
  const atrPctAvg240 = sma(atrPct.map((v) => (Number.isFinite(v) ? v : 0)), 240)

  let ambush = 0
  // 前段涨势状态：近 72 根涨幅——若正在暴涨中，不给埋伏分（避免追高）
  const rollMin72 = lowest(low, 72)
  const ret72 = Number.isFinite(rollMin72[n - 1]) && rollMin72[n - 1] > 0 ? lastClose / rollMin72[n - 1] - 1 : 0
  if (ret72 < 0.3) {
    if (ddFromHigh <= -0.3) ambush += 10
    else if (ddFromHigh <= -0.15) ambush += 6
    else if (ddFromHigh <= -0.05) ambush += 3
    if (amp48 >= 0.3) ambush += 5
    else if (amp48 >= 0.15) ambush += 3
    if (Number.isFinite(volR96Now) && volR96Now < 0.7) ambush += 5
    else if (volR96Now < 1) ambush += 3
    if (Number.isFinite(rsiNow) && rsiNow < 40) ambush += 5
    else if (rsiNow < 50) ambush += 3
    if (Number.isFinite(atrPct[n - 1]) && Number.isFinite(atrPctAvg240[n - 1]) && atrPctAvg240[n - 1] > 0 && atrPct[n - 1] / atrPctAvg240[n - 1] < 0.8) ambush += 5
  } // ret72 ≥ 30%：在爆拉途中，埋伏位 0 分

  /* ---- 异动 ---- */
  let maxVolR48 = 0
  for (let i = n - 48; i < n; i++) {
    if (Number.isFinite(vol96[i]) && vol96[i] > 0) maxVolR48 = Math.max(maxVolR48, vol[i] / vol96[i])
  }
  const ret24 = n >= 25 && close[n - 25] > 0 ? lastClose / close[n - 25] - 1 : 0
  let motion = 0
  if (maxVolR48 >= 3) motion += 10
  else if (maxVolR48 >= 2) motion += 6
  else if (maxVolR48 >= 1.5) motion += 3
  if (ret24 >= 0.1) motion += 5
  else if (ret24 >= 0.03) motion += 3
  if (ret24 > 0.5) motion += 5 // 已经起飞：异动打满，但埋伏位为 0 → 总分自然被压

  const total = elasticity + freshness + ambush + motion
  return {
    symbol, label,
    total: Math.round(total * 10) / 10,
    elasticity, freshness, ambush, motion,
    hardLegs: hard.length, softLegs: soft.length,
    maxGain, lastLegDaysAgo,
    ddFromHigh, amp48, volR96Now, rsiNow,
    dailyNotional, ret72, maxVolR48, ret24, bars: n,
  }
}

function fmtCoin(s: YaoScore): string {
  const dropped = s.dropped ? ` [淘汰：${s.dropped}]` : ''
  return (
    `${s.total.toFixed(1).padStart(5)} | ${s.symbol.padEnd(22)}` +
    ` 弹性${String(s.elasticity).padStart(2)} 新鲜${String(s.freshness).padStart(2)} 埋伏${String(s.ambush).padStart(2)} 异动${String(s.motion).padStart(2)}` +
    ` | ≥50%×${s.hardLegs} ≥30%×${s.softLegs} 最大+${Math.round(s.maxGain * 100)}%` +
    ` | 回撤${(s.ddFromHigh * 100).toFixed(0)}% 振幅${(s.amp48 * 100).toFixed(0)}% volR${s.volR96Now.toFixed(2)} RSI${Number.isFinite(s.rsiNow) ? s.rsiNow.toFixed(0) : '—'}` +
    ` | 成交$${Math.round(s.dailyNotional / 1000)}k` +
    ` | 近72根+${(s.ret72 * 100).toFixed(0)}% 近24根+${(s.ret24 * 100).toFixed(0)}%` +
    dropped,
  )
}

function loadDone(path_: string): Map<string, YaoScore> {
  const m = new Map<string, YaoScore>()
  if (!fs.existsSync(path_)) return m
  for (const line of fs.readFileSync(path_, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as YaoScore
      if (o.symbol) m.set(o.symbol, o)
    } catch { /* 忽略坏行 */ }
  }
  return m
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const get = (k: string): string | undefined => {
    const i = args.indexOf(`--${k}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const coin = get('coin')
  const top = Number(get('top') ?? 30)
  const resume = args.includes('--resume')

  if (coin) {
    console.log(`单币体检：${coin}\n`)
    const { candles: c } = await fetchKlines({ exchange: 'binanceusdm', symbol: coin, timeframe: TF, targetBars: 9000, since: Date.now() - 365 * 86400_000 })
    const s = scoreCoin(coin, coin, c)
    console.log(fmtCoin(s!))
    if (s) {
      const legs = detectLegs(c, GAIN)
      console.log('\n近一年 ≥50% 暴涨段：')
      for (const l of legs.slice(-12)) {
        console.log(
          `  ${new Date(l.lowTime).toISOString().slice(0, 16).replace('T', ' ')} → ` +
          `${new Date(l.peakTime).toISOString().slice(0, 16).replace('T', ' ')}  +${Math.round(l.gain * 100)}%`,
        )
      }
    }
    return
  }

  /* ---------- 全市场扫描 ---------- */
  const instruments = await listInstruments('binanceusdm')
  console.log(`市场合约 ${instruments.length} 个，开始扫描（并发 ${CONCURRENCY}，结果实时写 ${path.relative(ROOT, OUT_FILE)}）\n`)

  const done = resume ? loadDone(OUT_FILE) : new Map<string, YaoScore>()
  if (resume) console.log(`resume：已完成 ${done.size} 个，跳过\n`)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  if (!resume && fs.existsSync(OUT_FILE)) fs.rmSync(OUT_FILE)

  const results: YaoScore[] = [...done.values()]
  const queue = instruments.filter((i) => !done.has(i.symbol))
  let finished = done.size
  let idx = 0

  const worker = async (): Promise<void> => {
    while (idx < queue.length) {
      const inst = queue[idx++]
      let score: YaoScore | null = null
      for (let attempt = 0; attempt < 2 && !score; attempt++) {
        try {
          const { candles } = await fetchKlines({
            exchange: 'binanceusdm', symbol: inst.symbol, timeframe: TF,
            since: Date.now() - 300 * 86400_000, targetBars: TARGET_BARS,
          })
          score = scoreCoin(inst.symbol, inst.label, candles)
        } catch (err) {
          if (attempt === 0) await new Promise((r) => setTimeout(r, 2000))
          else console.warn(`拉取失败 ${inst.symbol}：${err instanceof Error ? err.message : err}`)
        }
      }
      if (!score) continue
      results.push(score)
      fs.appendFileSync(OUT_FILE, JSON.stringify(score) + '\n')
      finished++
      const pct = ((finished / instruments.length) * 100).toFixed(1)
      if (finished % 50 === 0 || finished === instruments.length) {
        console.log(`[${finished}/${instruments.length}] ${pct}%`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))

  results.sort((a, b) => b.total - a.total)
  console.log(`\n扫描完成：${results.length} 个有效品种（${instruments.length - results.length} 个被淘汰或失败）\n`)
  console.log('========= 妖币潜力 Top ' + Math.min(top, results.length) + ' =========')
  for (const s of results.slice(0, top)) console.log(fmtCoin(s))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
/**
 * PumpRadar —— 暴涨前哨：自建的「暴涨前」事件研究与捕获策略（独立第五轮+，不复用既有结论）。
 *
 * 流程：
 *   study     ① 拉取 9 个目标代币 1h 全历史
 *             ② 自定义暴涨事件：48h 内自窗口最低 low 涨幅 ≥ 50%，NMS 去重，每币取前 6 大
 *             ③ 定义「点火 bar」：事件内第一根收盘突破前 72 根最高价的 K 线
 *             ④ 逐 bar 计算特征（量能/波动/结构/资金流代理），全部按「该币自身分位」归一
 *             ⑤ 事件研究：每个特征分位阈值的 精度/lift/覆盖（信号后 48 根内出现点火 bar）
 *             ⑥ 以前 60% 事件为设计集，选出 lift>1.5 且覆盖≥40% 的特征，组成 N-of-M 评分门
 *   backtest  ⑦ 评分门触发 → 次根开盘进场，止损=结构低点下方，1% 风险仓位，
 *              吊灯 20% 追踪 + 96 根时间止损；设计集/验证集分开汇报
 *
 * 用法：npx tsx scripts/pump-radar.ts study|backtest
 * 输出：output/pumpradar/study.json / backtest.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { cum, ema, highest, lowest, sma, atr } from '../server/src/indicators/ta'
import { fetchKlines } from '../server/src/market/exchange'
import type { Candle } from '../../shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'output/pumpradar')

export const BASE = ['MYX', 'LAB', 'RAVE', 'TRB', 'BTR', 'SIREN', 'BANK', 'AKE', '币安人生']
export const SYMBOLS = BASE.map((b) => `${b}/USDT:USDT`)
export const TF = '1h' as const
export const SINCE = Date.UTC(2024, 6, 1)
export const UNTIL = Date.now()

/** 暴涨事件：48h 窗口内自最低点涨幅 */
const EV_WINDOW = 48
const EV_MIN_GAIN = 0.5
/** 点火定义：突破前 72 根最高价 */
const IGN_LOOKBACK = 72
/** 信号有效窗口：点火 bar 出现在信号后多少根内 */
const K = 48
/** 每币保留的最大事件数（按涨幅排序） */
const TOP_PER = 6
/** 统计预热 */
export const WARM = 240

const isF = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/* ------------------------------------------------------------------ */
/* 暴涨事件与点火 bar                                                    */
/* ------------------------------------------------------------------ */

interface PumpEvent {
  lowIdx: number // 启动低点
  peakIdx: number // 事件最高点
  gain: number // 峰值涨幅
  ignIdx: number // 点火 bar（突破前 72 根高点）
}

export function detectEvents(c: Candle[]): PumpEvent[] {
  const n = c.length
  const close = c.map((x) => x.close)
  const low = c.map((x) => x.low)
  const rollMin = lowest(low, EV_WINDOW)
  const gain = close.map((v, i) =>
    i >= EV_WINDOW && isF(rollMin[i]) && rollMin[i] > 0 ? v / rollMin[i] - 1 : NaN,
  )
  const above = gain.map((v) => isF(v) && v >= EV_MIN_GAIN)

  const raw: Array<{ lowIdx: number; peakIdx: number; gain: number }> = []
  let i = 0
  while (i < n) {
    if (!above[i]) {
      i++
      continue
    }
    let j = i
    while (j + 1 < n && above[j + 1]) j++
    let peak = i
    for (let k = i; k <= j; k++) if ((gain[k] ?? -1) > (gain[peak] ?? -1)) peak = k
    // 启动低点 = 峰值前 72 根内的最低点
    let li = peak
    for (let k = Math.max(0, peak - EV_WINDOW + 1); k <= peak; k++) if (low[k] < low[li]) li = k
    raw.push({ lowIdx: li, peakIdx: peak, gain: gain[peak] ?? 0 })
    i = j + 1
  }

  // NMS：按时间排序，启动点间隔 < 72 根的保留涨幅更大者
  raw.sort((a, b) => a.lowIdx - b.lowIdx)
  const kept: Array<{ lowIdx: number; peakIdx: number; gain: number }> = []
  for (const e of raw) {
    const last = kept[kept.length - 1]
    if (!last || e.lowIdx - last.lowIdx >= EV_WINDOW) kept.push(e)
    else if (e.gain > last.gain) kept[kept.length - 1] = e
  }
  kept.sort((a, b) => b.gain - a.gain)
  const top = kept.slice(0, TOP_PER).sort((a, b) => a.lowIdx - b.lowIdx)

  // 点火 bar：事件内第一根收盘突破前 IGN_LOOKBACK 根最高价
  const high = c.map((x) => x.high)
  const prevHigh: number[] = new Array(n).fill(NaN)
  const hh = highest(high, IGN_LOOKBACK)
  for (let k = 1; k < n; k++) prevHigh[k] = hh[k - 1]
  return top
    .map((e) => {
      let ignIdx = -1
      for (let k = e.lowIdx; k <= e.peakIdx; k++) {
        if (isF(prevHigh[k]) && close[k] > prevHigh[k]) {
          ignIdx = k
          break
        }
      }
      return { ...e, ignIdx }
    })
    .filter((e) => e.ignIdx - IGN_LOOKBACK >= 10)
}

/* ------------------------------------------------------------------ */
/* 特征（逐 bar，全部只用到当根及之前的数据）                             */
/* ------------------------------------------------------------------ */

interface Features {
  volPickup: number[] // 近 6 根均量 / 96 根均量
  rangeComp: number[] // 24 根振幅 / close（小=收缩）
  atrLift: number[] // ATR% / 其 240 均值
  deltaUp: number[] // CVD 代理高于 48 根前（1/0）
  upDown: number[] // 48 根主动买卖压力比（代理）
  mom48: number[] // 48 根动量
  posIn72: number[] // 收盘在 72 根区间中的位置
  aboveEma200: number[] // 站上 EMA200（1/0）
}

export function computeFeatures(c: Candle[]): Features & { cumDelta: number[]; deltaEma: number[] } {
  const n = c.length
  const close = c.map((x) => x.close)
  const high = c.map((x) => x.high)
  const low = c.map((x) => x.low)
  const open = c.map((x) => x.open)
  const vol = c.map((x) => x.volume)

  const vol96 = sma(vol, 96)
  const vol6 = sma(vol, 6)
  const volPickup = vol.map((_, i) => (isF(vol96[i]) && vol96[i] > 0 && isF(vol6[i]) ? vol6[i] / vol96[i] : NaN))

  const hi24 = highest(high, 24)
  const lo24 = lowest(low, 24)
  const rangeComp = close.map((v, i) =>
    isF(hi24[i]) && isF(lo24[i]) && v > 0 ? (hi24[i] - lo24[i]) / v : NaN,
  )

  const atrPct = atr(high, low, close, 14).map((a, i) => (isF(a) && close[i] > 0 ? (a / close[i]) * 100 : NaN))
  const atrAvg = sma(atrPct.map((v) => (isF(v) ? v : 0)), 240)
  const atrLift = atrPct.map((v, i) => (isF(v) && isF(atrAvg[i]) && atrAvg[i] > 0 ? v / atrAvg[i] : NaN))

  // CVD 代理：主动方向占比 × 量 → EMA 平滑 → 累积
  const delta = vol.map((v, i) => {
    const rng = high[i] - low[i]
    const dir = rng > 0 ? (close[i] - open[i]) / rng : 0
    return v * dir
  })
  const deltaEma = ema(delta, 48)
  const cumDelta = cum(deltaEma)

  const deltaUp = cumDelta.map((v, i) =>
    isF(v) && i >= 48 && isF(cumDelta[i - 48]) ? (v > cumDelta[i - 48] ? 1 : 0) : NaN,
  )

  // 48 根主动买卖压力比
  const upDown = close.map((_, i) => {
    if (i < 48) return NaN
    let up = 0
    let down = 0
    for (let k = i - 47; k <= i; k++) {
      const rng = high[k] - low[k]
      const d = rng > 0 ? (vol[k] * (close[k] - open[k])) / rng : 0
      if (d >= 0) up += d
      else down += -d
    }
    return down > 0 ? up / down : Number.POSITIVE_INFINITY
  })

  const mom48 = close.map((v, i) => (i >= 48 && close[i - 48] > 0 ? v / close[i - 48] - 1 : NaN))

  const hi72 = highest(high, 72)
  const lo72 = lowest(low, 72)
  const posIn72 = close.map((v, i) =>
    isF(hi72[i]) && isF(lo72[i]) && hi72[i] > lo72[i] ? (v - lo72[i]) / (hi72[i] - lo72[i]) : NaN,
  )

  const ema200 = ema(close, 200)
  const aboveEma200 = close.map((v, i) => (isF(ema200[i]) ? (v > ema200[i] ? 1 : 0) : NaN))

  return { volPickup, rangeComp, atrLift, deltaUp, upDown, mom48, posIn72, aboveEma200, cumDelta, deltaEma }
}

/* ------------------------------------------------------------------ */
/* 事件研究                                                             */
/* ------------------------------------------------------------------ */

const FEATURE_NAMES: Array<{ key: keyof Features; label: string; dir: 'high' | 'low' }> = [
  { key: 'volPickup', label: '量能抬升 6/96', dir: 'high' },
  { key: 'rangeComp', label: '24根振幅收缩', dir: 'low' },
  { key: 'atrLift', label: 'ATR 抬升', dir: 'high' },
  { key: 'deltaUp', label: 'CVD 高于48根前', dir: 'high' },
  { key: 'upDown', label: '买卖压力比偏高', dir: 'high' },
  { key: 'mom48', label: '48根动量偏高', dir: 'high' },
  { key: 'posIn72', label: '收盘位于72根区间高位', dir: 'high' },
  { key: 'aboveEma200', label: '站上EMA200', dir: 'high' },
]

/** 每个特征的「信号 → 48 根内点火」事件研究 */
function study(features: Features, tokens: Array<{ symbol: string; candles: Candle[]; events: PumpEvent[] }>) {
  interface Row {
    feature: string
    thresholds: string
    signals: number
    precision: number
    lift: number
    coverage: string
  }
  const rows: Row[] = []

  for (const f of FEATURE_NAMES) {
    // 信号序列：特征分位 ≥ 0.8（或 low 方向 ≤ 0.2）
    type Pack = { n: number; sig: boolean[]; ign: boolean[]; events: PumpEvent[] }
    const packs: Pack[] = []
    let baseline = 0
    let baseTot = 0

    for (const t of tokens) {
      const arr = features[f.key] as number[]
      const vals = arr.filter(isF).sort((a, b) => a - b)
      const q = (p: number): number => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : NaN)
      const th = f.dir === 'high' ? q(0.8) : q(0.2)
      const n = t.candles.length
      const sig = new Array<boolean>(n).fill(false)
      for (let i = WARM; i < n; i++) {
        const v = arr[i]
        if (!isF(v) || !isF(th)) continue
        sig[i] = f.dir === 'high' ? v >= th : v <= th
      }
      const ign = new Array<boolean>(n).fill(false)
      for (const e of t.events) if (e.ignIdx >= 0 && e.ignIdx < n) ign[e.ignIdx] = true

      // 后缀和：nextIgn[i] = [i, i+K] 内点火次数
      const suf = new Array<number>(n + 1).fill(0)
      for (let k = n - 1; k >= 0; k--) suf[k] = suf[k + 1] + (ign[k] ? 1 : 0)
      let hitBars = 0
      let tot = 0
      for (let k = WARM; k < n - K; k++) {
        tot++
        if (suf[k + 1] - suf[Math.min(n, k + K + 1)] > 0) hitBars++
      }
      baseline += hitBars
      baseTot += tot
      packs.push({ n, sig, ign, events: t.events })
    }

    const base = baseTot > 0 ? baseline / baseTot : 0
    let sigEpisodes = 0
    let hits = 0
    let covered = 0
    for (const p of packs) {
      // 连续 true 记为一次信号段
      let i = WARM
      const hitStarts: number[] = []
      while (i < p.n) {
        if (!p.sig[i]) {
          i++
          continue
        }
        let j = i
        while (j + 1 < p.n && p.sig[j + 1]) j++
        sigEpisodes++
        // 该段任意 bar 后 K 根内点火
        const suf = new Array<number>(p.n + 1).fill(0)
        for (let k = p.n - 1; k >= 0; k--) suf[k] = suf[k + 1] + (p.ign[k] ? 1 : 0)
        let hit = false
        for (let k = i; k <= j && !hit; k++) if (suf[k + 1] - suf[Math.min(p.n, k + K + 1)] > 0) hit = true
        if (hit) {
          hits++
          hitStarts.push(i)
        }
        i = j + 1
      }
      covered += p.events.filter((e) => e.ignIdx >= 0 && hitStarts.some((s) => s <= e.ignIdx && e.ignIdx - s <= K)).length
    }

    const precision = sigEpisodes > 0 ? hits / sigEpisodes : 0
    rows.push({
      feature: f.label,
      thresholds: `${f.dir === 'high' ? '≥' : '≤'} 自身分位 80%`,
      signals: sigEpisodes,
      precision: precision * 100,
      lift: base > 0 ? precision / base : 0,
      coverage: `${covered}/${tokens.reduce((a, t) => a + t.events.length, 0)}`,
    })
  }
  return { base: rows, baseLinePct: 0 }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

export async function loadData(): Promise<Array<{ symbol: string; candles: Candle[]; events: PumpEvent[] }>> {
  const out: Array<{ symbol: string; candles: Candle[]; events: PumpEvent[] }> = []
  for (const b of BASE) {
    const s = `${b}/USDT:USDT`
    try {
      const { candles } = await fetchKlines({
        exchange: 'binanceusdm',
        symbol: s,
        timeframe: TF,
        since: SINCE,
        until: UNTIL,
        targetBars: 20000,
        useCache: true,
      })
      if (candles.length < WARM + 100) {
        console.log(`  ${b}: 数据不足（${candles.length} 根），跳过`)
        continue
      }
      const events = detectEvents(candles)
      out.push({ symbol: s, candles, events })
      const best = events[0]
      console.log(
        `  ${b}: ${candles.length} 根 · 事件 ${events.length} 段` +
          (best ? ` · 最大 +${(best.gain * 100).toFixed(0)}%（${new Date(candles[best.lowIdx].timestamp).toISOString().slice(0, 10)} 起）` : ''),
      )
    } catch (err) {
      console.log(`  ${b}: 拉取失败（${err instanceof Error ? err.message : String(err)}），跳过`)
    }
  }
  return out
}

async function studyMain(): Promise<void> {
  console.log('===== ① 数据与暴涨事件 =====')
  const tokens = await loadData()
  if (tokens.length === 0) return

  console.log('\n===== ② 逐 token 点火时刻 =====')
  for (const t of tokens) {
    const c = t.candles
    const lst = t.events
      .map((e) => `${new Date(c[e.lowIdx].timestamp).toISOString().slice(5, 10)} +${(e.gain * 100).toFixed(0)}% 点火@${new Date(c[e.ignIdx].timestamp).toISOString().slice(5, 16).replace('T', ' ')}`)
      .join('；')
    console.log(`  ${t.symbol.split('/')[0]}: ${lst}`)
  }

  console.log('\n===== ③ 特征事件研究（信号后 48 根内点火）=====')
  console.log('特征 = 该币自身分位阈值；精度 = 命中信号段 / 信号段；lift = 精度 / 基线；覆盖 = 命中的暴涨段 / 全部暴涨段')
  const tokensWithFeatures = tokens.map((t) => ({ ...t, features: computeFeatures(t.candles) }))
  const { base: rows } = study(
    {
      volPickup: tokensWithFeatures.flatMap((t) => t.features.volPickup),
      rangeComp: tokensWithFeatures.flatMap((t) => t.features.rangeComp),
      atrLift: tokensWithFeatures.flatMap((t) => t.features.atrLift),
      deltaUp: tokensWithFeatures.flatMap((t) => t.features.deltaUp),
      upDown: tokensWithFeatures.flatMap((t) => t.features.upDown),
      mom48: tokensWithFeatures.flatMap((t) => t.features.mom48),
      posIn72: tokensWithFeatures.flatMap((t) => t.features.posIn72),
      aboveEma200: tokensWithFeatures.flatMap((t) => t.features.aboveEma200),
    },
    tokensWithFeatures.map((t) => ({ symbol: t.symbol, candles: t.candles, events: t.events })),
  )
  console.table(rows.map((r) => ({ 特征: r.feature, 阈值: r.thresholds, 信号段: r.signals, 精度: `${r.precision.toFixed(1)}%`, lift: r.lift.toFixed(2), 覆盖: r.coverage })))

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'study.json'), JSON.stringify({ rows, tokens: tokensWithFeatures.map((t) => ({ symbol: t.symbol, events: t.events })) }, null, 2), 'utf8')
  console.log(`\n已写出 ${path.join(OUT, 'study.json')}`)
}

/* ------------------------------------------------------------------ */
/* backtest：N-of-M 评分门策略（滚动分位，无未来数据）                     */
/* ------------------------------------------------------------------ */

/** 过去 window 根内 val 的分位（0~1，越小越靠前）；样本不足返回 NaN */
function rollingPctRank(series: number[], i: number, window: number): number {
  if (i < window) return NaN
  const v = series[i]
  if (!isF(v)) return NaN
  let cnt = 0
  for (let k = i - window; k < i; k++) if (isF(series[k]) && series[k] <= v) cnt++
  return cnt / window
}

interface BacktestTrade {
  symbol: string
  entryIdx: number
  exitIdx: number
  entry: number
  exit: number
  pnlPct: number
  reason: string
  /** 该笔进场后 96 根内是否出现点火 bar（设计集 / 验证集 / 无） */
  capture: 'design' | 'validate' | 'none'
}

async function backtestMain(): Promise<void> {
  console.log('===== ① 数据与事件 =====')
  const tokens = await loadData()

  interface Token {
    symbol: string
    candles: Candle[]
    events: PumpEvent[]
    features: Features & { cumDelta: number[]; deltaEma: number[] }
  }
  const prepared: Token[] = tokens.map((t) => ({ ...t, features: computeFeatures(t.candles) }))

  // 评分门（特征由 study 阶段的 lift 表选取：CVD 2.30 / 振幅收缩 1.86 / 量能抬升 1.58）
  const MIN_SCORE = Number(process.argv[3] ?? 2)

  const all: BacktestTrade[] = []
  const equityStart = 1000
  for (const t of prepared) {
    const f = t.features
    const n = t.candles.length
    const close = t.candles.map((x) => x.close)
    const low = t.candles.map((x) => x.low)

    // 逐 bar 评分（滚动分位，无未来数据）
    const score = new Array<number>(n).fill(0)
    for (let i = WARM; i < n; i++) {
      let s = 0
      if (isF(f.deltaUp[i]) && f.deltaUp[i] === 1) s++
      const rc = rollingPctRank(f.rangeComp, i, 240)
      if (isF(rc) && rc <= 0.3) s++
      const vp = rollingPctRank(f.volPickup, i, 240)
      if (isF(vp) && vp >= 0.7) s++
      if (isF(f.upDown[i]) && f.upDown[i] >= 1.2) s++
      score[i] = s
    }

    // 设计/验证事件切分：每币按时间前 60% 事件 = 设计集
    const evSorted = [...t.events].sort((a, b) => a.ignIdx - b.ignIdx)
    const cut = Math.max(1, Math.floor(evSorted.length * 0.6))
    const designIgn = new Set(evSorted.slice(0, cut).map((e) => e.ignIdx))
    const validateIgn = new Set(evSorted.slice(cut).map((e) => e.ignIdx))

    let equity = equityStart
    let pos: { qty: number; entry: number; stop: number; highMark: number; entryIdx: number; equityAtEntry: number } | null = null
    let barsHeld = 0

    for (let i = WARM + 24; i < n; i++) {
      if (pos) {
        barsHeld++
        pos.highMark = Math.max(pos.highMark, close[i])
        const exit = (px: number, reason: string): void => {
          // 入场手续费已在开仓时从权益扣除，这里只扣平仓手续费
          const fee = pos!.qty * px * 0.00055
          const pnl = pos!.qty * (px - pos!.entry) - fee
          equity += pnl
          all.push({
            symbol: t.symbol,
            entryIdx: pos!.entryIdx,
            exitIdx: i,
            entry: pos!.entry,
            exit: px,
            pnlPct: (pnl / pos!.equityAtEntry) * 100,
            reason,
            capture: 'none',
          })
          pos = null
          barsHeld = 0
        }
        if (low[i] <= pos.stop) {
          exit(pos.stop, 'StopLoss')
        } else if (close[i] < pos.highMark * 0.8) {
          exit(close[i], 'Trail20')
        } else if (barsHeld >= 96) {
          exit(close[i], 'TimeStop')
        }
        continue
      }

      // 入场：上一根收盘评分达标 → 本根开盘进场
      if (score[i - 1] >= MIN_SCORE) {
        const structLow = Math.min(...low.slice(Math.max(0, i - 24), i + 1)) * 0.995
        const entry = t.candles[i].open
        const riskFrac = Math.max(0.001, (entry - structLow) / entry)
        const notional = Math.min((equity * 0.01) / riskFrac, equity * 3)
        if (notional > 0 && Number.isFinite(notional)) {
          pos = {
            qty: notional / entry,
            entry,
            stop: structLow,
            highMark: entry,
            entryIdx: i,
            equityAtEntry: equity,
          }
          equity -= notional * 0.00055
        }
      }
    }

    // 标记 capture：进场后 96 根内出现点火 bar
    for (const tr of all) {
      if (tr.symbol !== t.symbol) continue
      if (tr.capture !== 'none') continue
      let hit: 'design' | 'validate' | 'none' = 'none'
      for (let k = tr.entryIdx; k <= Math.min(n - 1, tr.exitIdx + 96) && hit === 'none'; k++) {
        if (designIgn.has(k)) hit = 'design'
        else if (validateIgn.has(k)) hit = 'validate'
      }
      tr.capture = hit
    }
  }

  /* ---------- 汇总 ---------- */
  const summarize = (label: string, list: BacktestTrade[]): void => {
    if (list.length === 0) {
      console.log(`${label}: 无交易`)
      return
    }
    const wins = list.filter((t) => t.pnlPct > 0).length
    const pnl = list.map((t) => t.pnlPct).sort((a, b) => a - b)
    const med = pnl[pnl.length >> 1]
    const avg = pnl.reduce((a, b) => a + b, 0) / pnl.length
    const design = list.filter((t) => t.capture === 'design').length
    const validate = list.filter((t) => t.capture === 'validate').length
    const none = list.filter((t) => t.capture === 'none').length
    console.log(
      `${label}: ${list.length} 笔 · 胜 ${wins}（${((wins / list.length) * 100).toFixed(0)}%）· 单笔中位 ${med.toFixed(2)}% · 均值 ${avg.toFixed(2)}% · 最差 ${pnl[0].toFixed(1)}% · 最好 ${pnl[pnl.length - 1].toFixed(1)}%`,
    )
    console.log(`   捕获：设计集事件 ${design} · 验证集事件 ${validate} · 未捕获 ${none}`)
  }

  console.log(`\n===== 评分门（≥${MIN_SCORE}/4：CVD 走强 / 振幅收缩 / 量能抬升 / 买卖压力）=====`)
  summarize('全部交易', all)
  summarize('→ 设计集事件', all.filter((t) => t.capture === 'design'))
  summarize('→ 验证集事件（样本外）', all.filter((t) => t.capture === 'validate'))
  summarize('→ 未捕获（无效信号）', all.filter((t) => t.capture === 'none'))
  for (const r of ['StopLoss', 'Trail20', 'TimeStop'] as const) {
    const c = all.filter((t) => t.reason === r).length
    console.log(`   离场 ${r}: ${c}`)
  }

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'backtest.json'), JSON.stringify({ minScore: MIN_SCORE, trades: all }, null, 2), 'utf8')
  console.log(`\n已写出 ${path.join(OUT, 'backtest.json')}`)
}

const cmd = process.argv[2] ?? 'study'
// 作为模块被其他脚本导入时不执行主流程
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('pump-radar.ts')) {
  if (cmd === 'study') void studyMain()
  else if (cmd === 'backtest') void backtestMain()
  else console.log('用法：npx tsx scripts/pump-radar.ts study|backtest [minScore]')
}

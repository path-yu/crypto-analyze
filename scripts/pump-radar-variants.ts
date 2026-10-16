/**
 * PumpRadar 多版本对比：同一事件/特征体系，十种策略变体 × 9 个暴涨币。
 *
 * 维度：评分门收紧(≥4) / 趋势过滤(EMA200) / 点火放量确认 / 保本移动 / 分批止盈 /
 *       冷却期 / 连败暂停 / 风险预算(0.5%/1%/2%)
 *
 * 用法：npx tsx scripts/pump-radar-variants.ts
 * 输出：控制台对照表 + output/pumpradar/variants.json（含全部交易记录）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ema, sma } from '../server/src/indicators/ta'
import { fetchKlines } from '../server/src/market/exchange'
import type { Candle } from '../../shared/types'
import { loadData, computeFeatures, detectEvents, WARM, type PumpEvent } from './pump-radar'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'output/pumpradar')

const isF = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

interface Variant {
  key: string
  desc: string
  scoreMin: number
  ema200Filter: boolean
  ignVol: boolean
  breakevenAt: number
  partialAt: number
  cooldownBars: number
  lossStreak: number
  riskPct: number
  trailPct: number
  timeStop: number
}

const BASE_V = {
  ema200Filter: false,
  ignVol: false,
  breakevenAt: 0,
  partialAt: 0,
  cooldownBars: 0,
  lossStreak: 0,
  trailPct: 0.2,
  timeStop: 96,
}

const VARIANTS: Variant[] = [
  { key: 'V1 基线', desc: '评分≥3 · 风险1% · 吊灯20% · 时间96根', scoreMin: 3, ...BASE_V, riskPct: 0.01 },
  { key: 'V2 严门', desc: '评分≥4（更稀有）', scoreMin: 4, ...BASE_V, riskPct: 0.01 },
  { key: 'V3 趋势过滤', desc: 'V1 + 收盘>EMA200', scoreMin: 3, ...BASE_V, ema200Filter: true, riskPct: 0.01 },
  { key: 'V4 点火放量', desc: 'V1 + 信号bar量≥2×96均量', scoreMin: 3, ...BASE_V, ignVol: true, riskPct: 0.01 },
  { key: 'V5 保本分批', desc: 'V1 + 浮盈10%保本 + 浮盈20%平一半', scoreMin: 3, ...BASE_V, breakevenAt: 0.1, partialAt: 0.2, riskPct: 0.01 },
  { key: 'V6 冷却期', desc: 'V1 + 离场后冷却48根', scoreMin: 3, ...BASE_V, cooldownBars: 48, riskPct: 0.01 },
  { key: 'V7 连败暂停', desc: 'V1 + 3连败暂停240根', scoreMin: 3, ...BASE_V, lossStreak: 3, riskPct: 0.01 },
  { key: 'V8 组合防御', desc: 'V1 + EMA200 + 保本10% + 冷却48根', scoreMin: 3, ...BASE_V, ema200Filter: true, breakevenAt: 0.1, cooldownBars: 48, riskPct: 0.01 },
  { key: 'V9 低风险', desc: 'V1 + 风险0.5%/笔', scoreMin: 3, ...BASE_V, riskPct: 0.005 },
  { key: 'V10 高风险', desc: 'V1 + 风险2%/笔', scoreMin: 3, ...BASE_V, riskPct: 0.02 },
]

interface VariantTrade {
  symbol: string
  entryIdx: number
  exitIdx: number
  entry: number
  exit: number
  pnlPct: number
  reason: string
  capture: 'design' | 'validate' | 'none'
}
interface SimResult {
  retPct: number
  maxDdPct: number
  trades: VariantTrade[]
  winRate: number
  profitFactor: number
}

/** 过去 window 根内 val 的分位（0~1） */
function rollingPctRank(series: number[], i: number, window: number): number {
  if (i < window) return NaN
  const v = series[i]
  if (!isF(v)) return NaN
  let cnt = 0
  for (let k = i - window; k < i; k++) if (isF(series[k]) && series[k] <= v) cnt++
  return cnt / window
}

function simulate(
  candles: Candle[],
  events: PumpEvent[],
  features: ReturnType<typeof computeFeatures>,
  v: Variant,
): SimResult {
  const n = candles.length
  const close = candles.map((c) => c.close)
  const high = candles.map((c) => c.high)
  const low = candles.map((c) => c.low)
  const vol = candles.map((c) => c.volume)
  const ema200 = ema(close, 200)
  const vol96 = sma(vol, 96)
  const f = features

  // 逐 bar 评分（四个特征，与 study 阶段一致；滚动分位，无未来数据）
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

  // 设计/验证事件切分（每币按时间前 60% = 设计集）
  const evSorted = [...events].sort((a, b) => a.ignIdx - b.ignIdx)
  const cut = Math.max(1, Math.floor(evSorted.length * 0.6))
  const designIgn = new Set(evSorted.slice(0, cut).map((e) => e.ignIdx))
  const validateIgn = new Set(evSorted.slice(cut).map((e) => e.ignIdx))

  let equity = 1000
  let cash = equity
  let pos: {
    qty: number
    entry: number
    stop: number
    highMark: number
    entryIdx: number
    equityAtEntry: number
    partialDone: boolean
  } | null = null
  let cooldown = 0
  let lossStreak = 0
  let pauseUntil = -1
  let barsHeld = 0
  const equityCurve: number[] = []
  const trades: VariantTrade[] = []

  const closeTrade = (i: number, px: number, reason: string, partial = false): void => {
    const p = pos!
    const fee = p.qty * px * 0.00055
    const pnl = p.qty * (px - p.entry) - fee
    equity += pnl
    if (pnl < 0) lossStreak++
    else lossStreak = 0
    trades.push({
      symbol: '',
      entryIdx: p.entryIdx,
      exitIdx: i,
      entry: p.entry,
      exit: px,
      pnlPct: (pnl / p.equityAtEntry) * 100,
      reason,
      capture: 'none',
    })
    if (!partial) {
      pos = null
      cash = equity
      barsHeld = 0
      if (v.cooldownBars > 0) cooldown = v.cooldownBars
    }
  }

  for (let i = WARM + 24; i < n; i++) {
    if (pos) {
      barsHeld++
      pos.highMark = Math.max(pos.highMark, close[i])
      // 分批止盈：盘中触及 +partialAt → 平一半
      if (v.partialAt > 0 && !pos.partialDone && high[i] >= pos.entry * (1 + v.partialAt)) {
        closeTrade(i, pos.entry * (1 + v.partialAt), 'TP50', true)
        if (pos) {
          pos.partialDone = true
          pos.qty *= 0.5
          pos.highMark = Math.max(pos.highMark, pos.entry * (1 + v.partialAt))
        }
      }
      if (pos) {
        // 保本移动：浮盈触及 breakevenAt → 止损抬到入场价
        if (v.breakevenAt > 0 && pos.highMark >= pos.entry * (1 + v.breakevenAt) && pos.stop < pos.entry) {
          pos.stop = pos.entry
        }
        if (low[i] <= pos.stop) {
          closeTrade(i, pos.stop, 'StopLoss')
        } else if (close[i] < pos.highMark * (1 - v.trailPct)) {
          closeTrade(i, close[i], 'Trail20')
        } else if (v.timeStop > 0 && barsHeld >= v.timeStop) {
          closeTrade(i, close[i], 'TimeStop')
        }
      }
    }

    if (!pos) {
      if (cooldown > 0) {
        cooldown--
      } else if (i <= pauseUntil) {
        /* 连败暂停中 */
      } else {
        const prev = i - 1
        const volOk = !v.ignVol || (isF(vol96[prev]) && vol96[prev] > 0 && vol[prev] >= 2 * vol96[prev])
        const trendOk = !v.ema200Filter || !isF(ema200[prev]) || close[prev] > ema200[prev]
        if (score[prev] >= v.scoreMin && volOk && trendOk) {
          const structLow = Math.min(...low.slice(Math.max(0, i - 24), i + 1)) * 0.995
          const entry = candles[i].open
          const riskFrac = Math.max(0.001, (entry - structLow) / entry)
          const notional = Math.min((equity * v.riskPct) / riskFrac, equity * 3)
          if (notional > 0 && Number.isFinite(notional) && equity - notional * 0.00055 > 0) {
            pos = {
              qty: notional / entry,
              entry,
              stop: structLow,
              highMark: entry,
              entryIdx: i,
              equityAtEntry: equity,
              partialDone: false,
            }
            cash -= notional * 0.00055
          }
        }
      }
    }

    const mark = pos ? cash + pos.qty * (close[i] - pos.entry) : equity
    equityCurve.push(mark)
  }
  if (pos) closeTrade(n - 1, close[n - 1], 'EndOfData')

  let peak = 1000
  let maxDd = 0
  for (const e of equityCurve) {
    if (e > peak) peak = e
    if (peak > 0) maxDd = Math.max(maxDd, (peak - e) / peak)
  }
  const wins = trades.filter((t) => t.pnlPct > 0)
  const losses = trades.filter((t) => t.pnlPct <= 0)
  const grossWin = wins.reduce((a, t) => a + t.pnlPct, 0)
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlPct, 0))
  return {
    retPct: (equity / 1000 - 1) * 100,
    maxDdPct: maxDd * 100,
    trades,
    winRate: trades.length ? (wins.length / trades.length) * 100 : NaN,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Number.POSITIVE_INFINITY,
  }
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? 'main'
  // 样本外验证：另外 14 个高波动 meme 币（与前几轮的样本外集合一致）
  const OOS = [
    'PENGU/USDT:USDT', 'WIF/USDT:USDT', 'POPCAT/USDT:USDT', 'TRUMP/USDT:USDT', 'FARTCOIN/USDT:USDT',
    'MOODENG/USDT:USDT', 'PNUT/USDT:USDT', 'ACT/USDT:USDT', 'GOAT/USDT:USDT', 'NEIRO/USDT:USDT',
    'BRETT/USDT:USDT', 'TURBO/USDT:USDT', 'BOME/USDT:USDT', 'DOGS/USDT:USDT',
  ]
  console.log(`===== ① 数据与事件（${which === 'oos' ? '样本外 14 meme 币' : '目标 9 币'}）=====`)
  const tokens = which === 'oos'
    ? (await Promise.all(
        OOS.map(async (s) => {
          try {
            const { candles } = await fetchKlines({
              exchange: 'binanceusdm', symbol: s, timeframe: '1h',
              since: Date.UTC(2024, 6, 1), until: Date.now(), targetBars: 20000, useCache: true,
            })
            if (candles.length < WARM + 100) {
              console.log(`  ${s}: 数据不足（${candles.length} 根）`)
              return null
            }
            return { symbol: s, candles, events: detectEvents(candles) }
          } catch (err) {
            console.log(`  ${s}: 拉取失败（${err instanceof Error ? err.message : String(err)}）`)
            return null
          }
        }),
      )).filter((x): x is NonNullable<typeof x> => x !== null)
    : await loadData()
  const prepared = tokens.map((t) => ({ ...t, features: computeFeatures(t.candles) }))

  console.log(`\n===== ② 十种变体 × ${prepared.length} 币回测 =====`)
  const results: Array<{
    v: Variant
    per: Array<{ symbol: string; retPct: number; maxDdPct: number; trades: number; winRate: number }>
    agg: { med: number; mean: number; worst: number; best: number; positive: number; medDd: number; trades: number; winRate: number; pf: number; captures: number }
    trades: VariantTrade[]
  }> = []

  for (const v of VARIANTS) {
    const per: Array<{ symbol: string; retPct: number; maxDdPct: number; trades: number; winRate: number }> = []
    const trades: VariantTrade[] = []
    for (const t of prepared) {
      const r = simulate(t.candles, t.events, t.features, v)
      per.push({ symbol: t.symbol.split('/')[0], retPct: r.retPct, maxDdPct: r.maxDdPct, trades: r.trades.length, winRate: r.winRate })
      for (const tr of r.trades) trades.push({ ...tr, symbol: t.symbol })
    }
    const rets = per.map((p) => p.retPct).sort((a, b) => a - b)
    const dds = per.map((p) => p.maxDdPct).sort((a, b) => a - b)
    const med = rets.length ? rets[rets.length >> 1] : NaN
    // capture 标记
    for (const t of prepared) {
      const designIgn = new Set(t.events.slice(0, Math.max(1, Math.floor(t.events.length * 0.6))).map((e) => e.ignIdx))
      const validateIgn = new Set(t.events.slice(Math.max(1, Math.floor(t.events.length * 0.6))).map((e) => e.ignIdx))
      for (const tr of trades) {
        if (tr.symbol !== t.symbol || tr.capture !== 'none') continue
        let hit: 'design' | 'validate' | 'none' = 'none'
        for (let k = tr.entryIdx; k <= Math.min(t.candles.length - 1, tr.exitIdx + 96) && hit === 'none'; k++) {
          if (designIgn.has(k)) hit = 'design'
          else if (validateIgn.has(k)) hit = 'validate'
        }
        tr.capture = hit
      }
    }
    const captures = trades.filter((t) => t.capture !== 'none').length
    const winsAll = trades.filter((t) => t.pnlPct > 0).length
    const grossWin = trades.filter((t) => t.pnlPct > 0).reduce((a, t) => a + t.pnlPct, 0)
    const grossLoss = Math.abs(trades.filter((t) => t.pnlPct <= 0).reduce((a, t) => a + t.pnlPct, 0))
    results.push({
      v,
      per,
      agg: {
        med,
        mean: rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length),
        worst: rets.length ? rets[0] : NaN,
        best: rets.length ? rets[rets.length - 1] : NaN,
        positive: rets.filter((x) => x > 0).length,
        medDd: dds.length ? dds[dds.length >> 1] : NaN,
        trades: per.reduce((a, p) => a + p.trades, 0),
        winRate: trades.length ? (winsAll / trades.length) * 100 : NaN,
        pf: grossLoss > 0 ? grossWin / grossLoss : Number.POSITIVE_INFINITY,
        captures,
      },
      trades,
    })
  }

  console.log(
    `${'版本'.padEnd(12)} ${'中位'.padStart(7)} ${'均值'.padStart(7)} ${'最差'.padStart(7)} ${'最好'.padStart(8)} ${'为正'.padStart(5)} ${'中位回撤'.padStart(7)} ${'胜率'.padStart(6)} ${'盈亏比'.padStart(5)} ${'笔数'.padStart(5)} ${'捕获'.padStart(4)}`,
  )
  for (const r of results) {
    console.log(
      `${r.v.key.padEnd(12)} ${r.agg.med.toFixed(1).padStart(7)} ${r.agg.mean.toFixed(1).padStart(7)} ${r.agg.worst.toFixed(1).padStart(7)}` +
        ` ${r.agg.best.toFixed(1).padStart(8)} ${`${r.agg.positive}/9`.padStart(5)} ${r.agg.medDd.toFixed(1).padStart(7)}` +
        ` ${r.agg.winRate.toFixed(0).padStart(5)}% ${r.agg.pf.toFixed(2).padStart(5)} ${String(r.agg.trades).padStart(5)} ${String(r.agg.captures).padStart(4)}`,
    )
  }

  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(
    path.join(OUT, `variants-${which}.json`),
    JSON.stringify(results.map((r) => ({ key: r.v.key, desc: r.v.desc, agg: r.agg, per: r.per, trades: r.trades })), null, 2),
    'utf8',
  )
  console.log(`\n已写出 ${path.join(OUT, 'variants.json')}`)
}

void main()

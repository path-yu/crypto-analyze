/**
 * 第五轮：账户级风险框架 —— 同样的信号，不同的仓位方式。
 *
 * 前四轮（追涨 PumpHunter / 埋伏 PumpAmbush / 主升浪 MainWave / 选币）全部使用
 * 「固定 1000 名义仓位 + 1000 本金」= 单笔满仓，最差币 -100% 由此而来。
 * 本轮固定信号不动，只改仓位管理，回答一个问题：**「尽可能减少亏损」是信号问题还是仓位问题。**
 *
 * 信号（沿用前几轮结论中"可迁移"的两类）：
 *   A 埋伏（PumpAmbush 口径）：48 根振幅 < 35%（(hi-lo)/close）→ 次根开盘进场；
 *      每段收缩只进一次，区间扩张后重新武装；固定止损 8% + 吊灯 15%（收盘）+ 时间止损 72 根
 *   B 主升浪（MainWave 稀有化口径）：收盘 > 前 720 根最高（30 天）且 量 ≥ 2×96均量 →
 *      次根开盘进场；止损 8% + 突破失败（收盘跌回突破位）+ 吊灯 25%（收盘）+ 离场冷却 24 根
 *
 * 仓位：
 *   fixed  每笔固定 1000 名义（前四轮口径）
 *   risk1  每笔风险 = 当前权益的 1%（按 8% 止损距离反推名义 ≈ 权益 × 12.5%）
 *   risk2  每笔风险 = 当前权益的 2%
 *
 * 用法：npx tsx scripts/pump-risk.ts [in|oos|fresh|all]
 * 输出：控制台对照表 + output/pump/risk.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { highest, lowest, sma } from '../server/src/indicators/ta'
import { fetchKlines } from '../server/src/market/exchange'
import type { Candle } from '../../shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const IN = ['AKE/USDT:USDT', '币安人生/USDT:USDT', '龙虾/USDT:USDT', 'BANK/USDT:USDT', 'LAB/USDT:USDT', 'MYX/USDT:USDT']
const OOS = [
  'PENGU/USDT:USDT', 'WIF/USDT:USDT', 'POPCAT/USDT:USDT', 'TRUMP/USDT:USDT', 'FARTCOIN/USDT:USDT',
  'MOODENG/USDT:USDT', 'PNUT/USDT:USDT', 'ACT/USDT:USDT', 'GOAT/USDT:USDT', 'NEIRO/USDT:USDT',
  'BRETT/USDT:USDT', 'TURBO/USDT:USDT', 'BOME/USDT:USDT', 'DOGS/USDT:USDT',
]
const FRESH = [
  'API3/USDT:USDT', 'CTSI/USDT:USDT', 'V/USDT:USDT', 'HOLO/USDT:USDT', 'DDOG/USDT:USDT', 'PROM/USDT:USDT',
  'ZHIPU/USDT:USDT', 'SECZ/USDT:USDT', 'HK1810/USDT:USDT', 'GLM/USDT:USDT', 'WAL/USDT:USDT', 'O/USDT:USDT',
  'FIGHT/USDT:USDT', 'STEEM/USDT:USDT', 'KAVA/USDT:USDT', 'GIGGLE/USDT:USDT', 'ROBO/USDT:USDT', 'Q/USDT:USDT',
  'A/USDT:USDT', 'DEXE/USDT:USDT', 'SPX/USDT:USDT', 'FLUID/USDT:USDT',
]

const TF = '1h' as const
const SINCE = Date.UTC(2025, 9, 13)
const UNTIL = Date.UTC(2026, 9, 13)
const FEE = 0.00055
const START_EQUITY = 1000
const MAX_LEVERAGE = 3

// A 埋伏
const RANGE_W = 48
const RANGE_TH = 0.35
const TIME_STOP = 72
const TRAIL_A = 0.15
// B 主升浪
const BRK_W = 720
const BRK_VOL = 2
const COOLDOWN = 24
const TRAIL_B = 0.25
// 共用风控
const SL_PCT = 0.08

type Mode = 'fixed' | 'risk1' | 'risk2'
type Kind = 'ambush' | 'mainwave'
const RISK: Record<Mode, number> = { fixed: 0, risk1: 0.01, risk2: 0.02 }

interface TradeStat {
  entryIdx: number
  exitIdx: number
  pnlPct: number // 相当于当时权益的百分比
  reason: string
}
interface SimResult {
  symbol: string
  finite: boolean
  finalEquity: number
  retPct: number
  maxDdPct: number
  trades: number
  winRate: number
  worstTradePct: number
}

function simulate(
  candles: Candle[],
  kind: Kind,
  mode: Mode,
): SimResult {
  const n = candles.length
  const close = candles.map((c) => c.close)
  const high = candles.map((c) => c.high)
  const low = candles.map((c) => c.low)
  const vol = candles.map((c) => c.volume)

  const vol96 = sma(vol, 96)
  const hi48 = highest(high, RANGE_W)
  const lo48 = lowest(low, RANGE_W)
  const range48 = close.map((v, i) =>
    Number.isFinite(hi48[i]) && Number.isFinite(lo48[i]) && v > 0 ? (hi48[i] - lo48[i]) / v : NaN,
  )
  // 突破基准用「上一根」的 720 根最高，避免把当根自己算进突破基准
  const hiBrkRaw = highest(high, BRK_W)
  const hiBrk = [NaN, ...hiBrkRaw.slice(0, n - 1)]

  const warm = Math.max(RANGE_W, BRK_W) + 2
  let equity = START_EQUITY
  let cash = equity
  let pos: {
    qty: number
    entry: number
    stop: number
    brkLevel: number
    entryIdx: number
    highMark: number
    notional: number
    equityAtEntry: number
  } | null = null
  let armed = true
  let cooldown = 0
  const equityCurve: number[] = []
  const trades: TradeStat[] = []
  let barsHeld = 0

  const closeTrade = (i: number, exitPrice: number, reason: string): void => {
    const p = pos!
    const exitNotional = p.qty * exitPrice
    const fee = (p.notional + exitNotional) * FEE
    const pnl = p.qty * (exitPrice - p.entry) - fee
    equity += pnl
    trades.push({
      entryIdx: p.entryIdx,
      exitIdx: i,
      pnlPct: (pnl / p.equityAtEntry) * 100,
      reason,
    })
    pos = null
    cash = equity
    barsHeld = 0
    if (kind === 'mainwave') cooldown = COOLDOWN
  }

  for (let i = warm; i < n; i++) {
    const bar = candles[i]
    const prev = i - 1

    /* ---------- 持仓中：先看离场 ---------- */
    if (pos) {
      barsHeld++
      pos.highMark = Math.max(pos.highMark, close[i])
      // 1) 固定止损（bar 内触发，按止损价成交）
      if (low[i] <= pos.stop) {
        closeTrade(i, pos.stop, 'StopLoss')
      } else {
        // 2) 突破失败（仅主升浪）
        if (kind === 'mainwave' && close[i] < pos.brkLevel) {
          closeTrade(i, close[i], 'BreakFail')
        } else {
          // 3) 吊灯移动止损（收盘价口径）
          const trail = kind === 'ambush' ? TRAIL_A : TRAIL_B
          if (close[i] < pos.highMark * (1 - trail)) {
            closeTrade(i, close[i], 'Trail')
          } else if (kind === 'ambush' && barsHeld >= TIME_STOP) {
            // 4) 时间止损
            closeTrade(i, close[i], 'TimeStop')
          }
        }
      }
    }

    /* ---------- 空仓中：看入场（用上一根收盘的状态，本根开盘成交） ---------- */
    if (!pos && i > warm) {
      if (kind === 'ambush') {
        const signal = range48[prev] < RANGE_TH && armed
        if (signal) {
          const entry = bar.open
          const notional =
            mode === 'fixed'
              ? 1000
              : Math.min((equity * RISK[mode]) / SL_PCT, equity * MAX_LEVERAGE)
          if (Number.isFinite(notional) && notional > 0 && equity - notional * FEE > 0) {
            pos = {
              qty: notional / entry,
              entry,
              stop: entry * (1 - SL_PCT),
              brkLevel: Number.NaN,
              entryIdx: i,
              highMark: entry,
              notional,
              equityAtEntry: equity,
            }
            cash -= notional * FEE
            armed = false
          }
        }
      } else {
        const breakout = Number.isFinite(hiBrk[prev]) && close[prev] > hiBrk[prev] && vol96[prev] > 0 && vol[prev] >= BRK_VOL * vol96[prev]
        if (breakout && cooldown === 0) {
          const entry = bar.open
          const notional =
            mode === 'fixed'
              ? 1000
              : Math.min((equity * RISK[mode]) / SL_PCT, equity * MAX_LEVERAGE)
          if (Number.isFinite(notional) && notional > 0 && equity - notional * FEE > 0) {
            pos = {
              qty: notional / entry,
              entry,
              stop: entry * (1 - SL_PCT),
              brkLevel: hiBrk[prev],
              entryIdx: i,
              highMark: entry,
              notional,
              equityAtEntry: equity,
            }
            cash -= notional * FEE
          }
        }
      }
    }

    /* ---------- 状态推进 ---------- */
    if (!pos) {
      // A：区间收缩期间不再重复布仓（armed 已被入场消费），区间重新扩张后重新武装
      if (kind === 'ambush') {
        if (Number.isFinite(range48[i]) && range48[i] >= RANGE_TH) armed = true
      } else if (cooldown > 0) {
        cooldown--
      }
    }

    // 权益曲线（收盘 mark）
    const mark = pos ? cash + pos.qty * (close[i] - pos.entry) : equity
    equityCurve.push(mark)
  }

  // 收口：把最后一根仍在持有的仓位按最后收盘价了结
  if (pos) closeTrade(n - 1, close[n - 1], 'EndOfData')

  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1] : START_EQUITY
  let peak = START_EQUITY
  let maxDd = 0
  for (const e of equityCurve) {
    if (e > peak) peak = e
    if (peak > 0) maxDd = Math.max(maxDd, (peak - e) / peak)
  }
  const wins = trades.filter((t) => t.pnlPct > 0).length
  return {
    symbol: '',
    finite: true,
    finalEquity,
    retPct: (finalEquity / START_EQUITY - 1) * 100,
    maxDdPct: maxDd * 100,
    trades: trades.length,
    winRate: trades.length ? (wins / trades.length) * 100 : NaN,
    worstTradePct: trades.length ? Math.min(...trades.map((t) => t.pnlPct)) : NaN,
  }
}

interface Agg {
  med: number
  mean: number
  worst: number
  best: number
  positive: number
  valid: number
  trades: number
  medDd: number
  worstTrade: number
}
function agg(list: SimResult[]): Agg {
  const rets = list.map((r) => r.retPct).sort((a, b) => a - b)
  const dds = list.map((r) => r.maxDdPct).sort((a, b) => a - b)
  const wts = list.map((r) => r.worstTradePct).filter(Number.isFinite).sort((a, b) => a - b)
  return {
    med: rets.length ? rets[rets.length >> 1] : NaN,
    mean: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : NaN,
    worst: rets.length ? rets[0] : NaN,
    best: rets.length ? rets[rets.length - 1] : NaN,
    positive: rets.filter((v) => v > 0).length,
    valid: rets.length,
    trades: list.reduce((a, r) => a + r.trades, 0),
    medDd: dds.length ? dds[dds.length >> 1] : NaN,
    worstTrade: wts.length ? wts[0] : NaN,
  }
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? 'all'
  const sets: Array<{ name: string; symbols: string[] }> = []
  if (which === 'in' || which === 'all') sets.push({ name: '样本内6币', symbols: IN })
  if (which === 'oos' || which === 'all') sets.push({ name: '样本外14币', symbols: OOS })
  if (which === 'fresh' || which === 'all') sets.push({ name: '真·验证22币', symbols: FRESH })

  const out: Record<string, unknown> = {}
  for (const set of sets) {
    console.log(`\n===== ${set.name}：拉取数据 =====`)
    const data = new Map<string, Candle[]>()
    for (const s of set.symbols) {
      try {
        const { candles } = await fetchKlines({
          exchange: 'binanceusdm',
          symbol: s,
          timeframe: TF,
          since: SINCE,
          until: UNTIL,
          targetBars: 9000,
          useCache: true,
        })
        if (candles.length >= 300) data.set(s, candles)
      } catch {
        /* 历史不足 / 无该合约 → 跳过 */
      }
    }
    console.log(`可用 ${data.size}/${set.symbols.length} 个（≥300 根）`)

    const rows: Array<{ kind: Kind; mode: Mode; agg: Agg; per: Array<{ symbol: string; retPct: number; maxDdPct: number; trades: number; worstTradePct: number }> }> = []
    for (const kind of ['ambush', 'mainwave'] as Kind[]) {
      for (const mode of ['fixed', 'risk1', 'risk2'] as Mode[]) {
        const per: Array<{ symbol: string; retPct: number; maxDdPct: number; trades: number; worstTradePct: number }> = []
        for (const [s, candles] of data) {
          const r = simulate(candles, kind, mode)
          per.push({ symbol: s.split('/')[0], retPct: r.retPct, maxDdPct: r.maxDdPct, trades: r.trades, worstTradePct: r.worstTradePct })
        }
        rows.push({ kind, mode, agg: agg(per), per })
      }
    }

    console.log(`\n===== ${set.name}：仓位方式对照（信号相同，只改仓位）=====`)
    console.log(
      `${'信号/仓位'.padEnd(22)} ${'中位收益'.padStart(8)} ${'均值'.padStart(8)} ${'最差'.padStart(8)} ${'最好'.padStart(8)} ${'为正'.padStart(6)} ${'中位回撤'.padStart(8)} ${'最差单笔'.padStart(8)} ${'笔数'.padStart(5)}`,
    )
    for (const r of rows) {
      const key = `${r.kind === 'ambush' ? '埋伏' : '主升浪'} / ${r.mode === 'fixed' ? '固定1000名义' : r.mode === 'risk1' ? '风险1%/笔' : '风险2%/笔'}`
      console.log(
        `${key.padEnd(22)} ${r.agg.med.toFixed(1).padStart(8)} ${r.agg.mean.toFixed(1).padStart(8)} ${r.agg.worst.toFixed(1).padStart(8)}` +
          ` ${r.agg.best.toFixed(1).padStart(8)} ${`${r.agg.positive}/${r.agg.valid}`.padStart(6)}` +
          ` ${r.agg.medDd.toFixed(1).padStart(8)} ${r.agg.worstTrade.toFixed(1).padStart(8)} ${String(r.agg.trades).padStart(5)}`,
      )
    }
    out[set.name] = rows
  }

  fs.mkdirSync(path.join(ROOT, 'output/pump'), { recursive: true })
  fs.writeFileSync(path.join(ROOT, 'output/pump/risk.json'), JSON.stringify(out, null, 2), 'utf8')
  console.log('\n已写出 output/pump/risk.json')
}

void main()

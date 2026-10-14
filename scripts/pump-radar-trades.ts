/**
 * PumpRadar 交易记录导出与逐版本复盘。
 *
 * 读取 output/pumpradar/variants-main.json / variants-oos.json，
 * 结合本地 K 线把索引换算回时间与价格，输出：
 *   1) server/pine/PumpRadar/交易记录/<集合>/<版本>.csv —— 逐笔交易明细
 *   2) server/pine/PumpRadar/交易记录复盘.md —— 逐版本分析与复盘
 *
 * 用法：npx tsx scripts/pump-radar-trades.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetchKlines } from '../server/src/market/exchange'
import { BASE } from './pump-radar'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'output/pumpradar')
const DEST = path.join(ROOT, 'server/pine/PumpRadar/交易记录')

const isF = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const cst = (ts: number): string => new Date(ts + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')

interface RawTrade {
  symbol: string
  entryIdx: number
  exitIdx: number
  entry: number
  exit: number
  pnlPct: number
  reason: string
  capture: 'design' | 'validate' | 'none'
}
interface SetFile {
  key: string
  desc: string
  agg: {
    med: number
    mean: number
    worst: number
    best: number
    positive: number
    medDd: number
    trades: number
    winRate: number
    pf: number
    captures: number
  }
  per: Array<{ symbol: string; retPct: number; maxDdPct: number; trades: number; winRate: number }>
  trades: RawTrade[]
}

interface Detail {
  symbol: string
  entryTime: number
  exitTime: number
  entry: number
  exit: number
  bars: number
  pnlPct: number
  reason: string
  capture: string
}

async function loadCandles(symbols: string[]): Promise<Map<string, Candle[]>> {
  const map = new Map<string, Candle[]>()
  for (const s of symbols) {
    try {
      const { candles } = await fetchKlines({
        exchange: 'binanceusdm', symbol: s, timeframe: '1h',
        since: Date.UTC(2024, 6, 1), until: Date.now(), targetBars: 20000, useCache: true,
      })
      if (candles.length > 0) map.set(s, candles)
    } catch {
      /* ignore */
    }
  }
  return map
}

function toDetail(tr: RawTrade, candles: Candle[] | undefined): Detail | null {
  if (!candles) return null
  const e = candles[tr.entryIdx]
  const x = candles[tr.exitIdx]
  if (!e || !x) return null
  return {
    symbol: tr.symbol.split('/')[0],
    entryTime: e.timestamp,
    exitTime: x.timestamp,
    entry: tr.entry,
    exit: tr.exit,
    bars: tr.exitIdx - tr.entryIdx,
    pnlPct: tr.pnlPct,
    reason: tr.reason,
    capture: tr.capture,
  }
}

function csvEsc(v: unknown): string {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const REASON_LABEL: Record<string, string> = {
  StopLoss: '止损',
  Trail20: '吊灯离场',
  TimeStop: '时间止损',
  TP50: '分批止盈50%',
  BreakFail: '突破失败',
  ScriptClose: '脚本平仓',
  EndOfData: '数据结束',
}
const CAP_LABEL: Record<string, string> = { design: '设计集', validate: '验证集', none: '未捕获' }

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[s.length >> 1] : NaN
}

async function main(): Promise<void> {
  // 先收集两个集合里出现过的全部币种，再统一拉 K 线（含缓存）
  const symbols = new Set<string>()
  for (const f of ['variants-main.json', 'variants-oos.json']) {
    const fp = path.join(OUT, f)
    if (!fs.existsSync(fp)) continue
    const sets = JSON.parse(fs.readFileSync(fp, 'utf8')) as SetFile[]
    for (const s of sets) for (const t of s.trades) symbols.add(t.symbol)
  }
  const candleMap = await loadCandles([...symbols])
  const files: Array<{ file: string; label: string }> = [
    { file: 'variants-main.json', label: '目标9币' },
    { file: 'variants-oos.json', label: '样本外14币' },
  ]

  const md: string[] = []
  md.push('# PumpRadar 逐版本交易记录复盘')
  md.push('')
  md.push('> 数据：`scripts/pump-radar-variants.ts` 的回测输出（`output/pumpradar/variants-*.json`），')
  md.push('> 交易时间按 UTC+8 展示；单笔收益% 为「占当时权益」口径（风险预算已锁定单笔最大亏损）。')
  md.push('> 每个版本的逐笔明细 CSV 在 `交易记录/` 目录下，本报告只做汇总与分析。')
  md.push('')

  for (const { file, label } of files) {
    const fp = path.join(OUT, file)
    if (!fs.existsSync(fp)) continue
    const sets = JSON.parse(fs.readFileSync(fp, 'utf8')) as SetFile[]
    const setDir = path.join(DEST, label)
    fs.mkdirSync(setDir, { recursive: true })

    md.push(`---`)
    md.push('')
    md.push(`# ${label}（${sets[0]?.per.length ?? 0} 币）`)
    md.push('')

    for (const set of sets) {
      const details = set.trades
        .map((t) => toDetail(t, candleMap.get(t.symbol)))
        .filter((d): d is Detail => d !== null)
        .sort((a, b) => a.entryTime - b.entryTime || a.exitTime - b.exitTime)

      /* ---------- CSV ---------- */
      const csvName = `${set.key.replace(/\s+/g, '')}.csv`
      const lines = ['序号,币种,入场时间,入场价,出场时间,出场价,持仓根数,收益%(权益),离场原因,事件捕获']
      details.forEach((d, i) => {
        lines.push(
          [
            i + 1,
            d.symbol,
            cst(d.entryTime),
            d.entry,
            cst(d.exitTime),
            d.exit,
            d.bars,
            d.pnlPct.toFixed(2),
            REASON_LABEL[d.reason] ?? d.reason,
            CAP_LABEL[d.capture] ?? d.capture,
          ]
            .map(csvEsc)
            .join(','),
        )
      })
      fs.writeFileSync(path.join(setDir, csvName), '\uFEFF' + lines.join('\n'), 'utf8')

      /* ---------- 分析 ---------- */
      const pnls = details.map((d) => d.pnlPct)
      const wins = details.filter((d) => d.pnlPct > 0)
      const losses = details.filter((d) => d.pnlPct <= 0)
      const sorted = [...details].sort((a, b) => b.pnlPct - a.pnlPct)
      const byToken = new Map<string, Detail[]>()
      for (const d of details) {
        const arr = byToken.get(d.symbol) ?? []
        arr.push(d)
        byToken.set(d.symbol, arr)
      }
      const reasonCount: Record<string, number> = {}
      for (const d of details) reasonCount[REASON_LABEL[d.reason] ?? d.reason] = (reasonCount[REASON_LABEL[d.reason] ?? d.reason] ?? 0) + 1
      // 月度净贡献（按单笔收益%求和的近似值）
      const monthMap = new Map<string, number>()
      for (const d of details) {
        const m = cst(d.exitTime).slice(0, 7)
        monthMap.set(m, (monthMap.get(m) ?? 0) + d.pnlPct)
      }
      const months = [...monthMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))

      md.push(`## ${set.key} —— ${set.desc}`)
      md.push('')
      md.push(`> 逐笔明细：[交易记录/${label}/${csvName}](${label}/${csvName})，共 ${details.length} 笔`)
      md.push('')
      md.push(`| 指标 | 值 |`)
      md.push(`|---|---:|`)
      md.push(`| 中位单笔收益 | ${median(pnls).toFixed(2)}% |`)
      md.push(`| 平均单笔收益 | ${(pnls.reduce((a, b) => a + b, 0) / Math.max(1, pnls.length)).toFixed(2)}% |`)
      md.push(`| 胜率 | ${details.length ? ((wins.length / details.length) * 100).toFixed(1) : '0'}%（${wins.length}/${details.length}） |`)
      md.push(`| 最好 / 最差单笔 | +${(sorted[0]?.pnlPct ?? 0).toFixed(1)}% / ${(sorted[sorted.length - 1]?.pnlPct ?? 0).toFixed(1)}% |`)
      md.push(`| 盈利笔合计 / 亏损笔合计 | +${wins.reduce((a, d) => a + d.pnlPct, 0).toFixed(0)}% / ${losses.reduce((a, d) => a + d.pnlPct, 0).toFixed(0)}% |`)
      md.push(`| 离场原因 | ${Object.entries(reasonCount).map(([k, v]) => `${k} ${v}`).join(' · ')} |`)
      md.push('')

      md.push(`### 逐币汇总`)
      md.push('')
      md.push(`| 币种 | 笔数 | 胜率 | 单笔中位 | 单笔合计 | 最好单笔 | 最差单笔 |`)
      md.push(`|---|---:|---:|---:|---:|---:|---:|`)
      for (const [sym, arr] of [...byToken.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const w = arr.filter((d) => d.pnlPct > 0).length
        const s = [...arr.map((d) => d.pnlPct)].sort((a, b) => a - b)
        md.push(
          `| ${sym} | ${arr.length} | ${((w / arr.length) * 100).toFixed(0)}% | ${median(arr.map((d) => d.pnlPct)).toFixed(2)}% | ${arr.reduce((a, d) => a + d.pnlPct, 0).toFixed(1)}% | +${s[s.length - 1].toFixed(1)}% | ${s[0].toFixed(1)}% |`,
        )
      }
      md.push('')

      md.push(`### 月度净贡献（单笔收益% 求和，近似）`)
      md.push('')
      md.push(`| 月份 | ${months.map(([m]) => m).join(' | ')} |`)
      md.push(`|---|${months.map(() => '---:').join('|')}|`)
      md.push(`| 净贡献% | ${months.map(([, v]) => v.toFixed(0)).join(' | ')} |`)
      md.push('')

      md.push(`### 最好 5 笔 / 最差 5 笔`)
      md.push('')
      md.push(`| # | 币种 | 入场 → 出场 | 收益 | 离场 | 捕获 |`)
      md.push(`|---|---|---|---:|---|---|`)
      const row = (d: Detail, i: number): string =>
        `| ${i} | ${d.symbol} | ${cst(d.entryTime)} → ${cst(d.exitTime)} | ${d.pnlPct > 0 ? '+' : ''}${d.pnlPct.toFixed(1)}% | ${REASON_LABEL[d.reason] ?? d.reason} | ${CAP_LABEL[d.capture] ?? d.capture} |`
      sorted.slice(0, 5).forEach((d, i) => md.push(row(d, i + 1)))
      md.push('| … | | | | | |')
      sorted.slice(-5).forEach((d, i) => md.push(row(d, i)))
      md.push('')

      const capCount: Record<string, number> = {}
      for (const d of details) capCount[CAP_LABEL[d.capture] ?? d.capture] = (capCount[CAP_LABEL[d.capture] ?? d.capture] ?? 0) + 1
      md.push(`### 事件捕获`)
      md.push('')
      md.push(`| 类型 | 笔数 | 单笔中位 |`)
      md.push(`|---|---:|---:|`)
      for (const k of ['design', 'validate', 'none']) {
        const arr = details.filter((d) => (CAP_LABEL[d.capture] ?? d.capture) === (CAP_LABEL[k] ?? k))
        md.push(`| ${CAP_LABEL[k] ?? k} | ${arr.length} | ${arr.length ? median(arr.map((d) => d.pnlPct)).toFixed(2) : '—'}% |`)
      }
      void capCount
      md.push('')
    }
  }

  fs.mkdirSync(DEST, { recursive: true })
  fs.writeFileSync(path.join(DEST, '..', '交易记录复盘.md'), md.join('\n'), 'utf8')
  console.log(`已写出 ${path.join(DEST, '..', '交易记录复盘.md')} 与 ${DEST}/*.csv`)
}

void main()

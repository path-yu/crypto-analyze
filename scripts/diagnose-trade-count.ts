#!/usr/bin/env node
/**
 * 交易数量差异诊断。
 *
 * 用途：当本程序的交易笔数与 TradingView 不一致时，
 * 逐项排查到底是「策略实现有问题」还是「行情数据覆盖不足」。
 *
 * 用法：
 *   pnpm exec tsx scripts/diagnose-trade-count.ts
 *   pnpm exec tsx scripts/diagnose-trade-count.ts --symbol BTC/USDT:USDT --tv-trades 79
 *   pnpm exec tsx scripts/diagnose-trade-count.ts --since 2026-01-01 --until 2026-10-12
 *
 * 核心结论通常是：
 *   交易所（Gate 等）只提供「最近 10000 根」K 线，
 *   当目标区间的所需根数超过该上限时，回测只能覆盖尾部一段，
 *   交易样本自然变少 —— 这属于数据覆盖问题，不是策略逻辑错误。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExchangeId, Timeframe } from '../shared/types'
import { TIMEFRAME_MS } from '../shared/types'
import { runBacktestService } from '../server/src/service/backtestService'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/* ------------------------------ 参数解析 ------------------------------ */

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = argv[i + 1]
      if (v && !v.startsWith('--')) {
        out[k] = v
        i++
      } else out[k] = 'true'
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
}

/** 交易所单次「最近 N 根」上限（与 server/src/market/exchange.ts 保持一致） */
const LOOKBACK: Record<ExchangeId, number> = {
  binanceusdm: 20_000, okx: 20_000, bybit: 20_000, bitget: 20_000, gate: 10_000,
}

const MAX_BARS_PER_RUN = 60_000

function fmtDays(ms: number): string {
  return (ms / 86400_000).toFixed(0)
}

/* ------------------------------- 主流程 ------------------------------- */

async function main() {
  const exchange = (args.exchange ?? 'gate') as ExchangeId
  const symbol = args.symbol ?? 'BTC/USDT:USDT'
  const tvTrades = args['tv-trades'] ? Number(args['tv-trades']) : 79

  const sinceMs = args.since
    ? Date.parse(`${args.since}T00:00:00+08:00`)
    : Date.parse('2026-01-01T00:00:00+08:00')
  const untilMs = args.until
    ? Date.parse(`${args.until}T23:59:59+08:00`)
    : Date.parse('2026-10-12T23:59:59+08:00')

  console.log()
  console.log(`${C.bold}${C.cyan}  交易数量差异诊断${C.reset}`)
  console.log()
  console.log(`  标的        ${symbol}`)
  console.log(`  交易所      ${exchange}（可回溯上限 ${LOOKBACK[exchange].toLocaleString()} 根）`)
  console.log(`  目标区间    ${new Date(sinceMs).toISOString().slice(0, 10)} → ${new Date(untilMs).toISOString().slice(0, 10)}（${fmtDays(untilMs - sinceMs)} 天）`)
  console.log(`  TradingView ${tvTrades} 笔`)
  console.log()

  /* ------------------- 第 1 步：数据覆盖能力分析 ------------------- */

  console.log(`${C.bold}  第 1 步 · 数据覆盖分析${C.reset}`)
  console.log(`  ${'周期'.padEnd(6)} ${'区间需要'.padStart(10)} ${'可提供'.padStart(9)} ${'覆盖率'.padStart(8)}   结论`)
  console.log('  ' + '─'.repeat(64))

  const tfs: Timeframe[] = ['5m', '15m', '30m', '1h', '2h', '4h', '1d']
  const coverage: { tf: Timeframe; need: number; can: number; ratio: number; full: boolean }[] = []

  for (const tf of tfs) {
    const ms = TIMEFRAME_MS[tf]
    const need = Math.floor((untilMs - sinceMs) / ms)
    const can = LOOKBACK[exchange]
    const ratio = need > 0 ? Math.min(1, can / need) : 1
    const overEngine = need > MAX_BARS_PER_RUN
    const full = need <= can && !overEngine

    let verdict: string
    if (overEngine) verdict = `${C.dim}超过引擎单次上限 ${MAX_BARS_PER_RUN} 根${C.reset}`
    else if (full) verdict = `${C.green}✓ 可完整覆盖${C.reset}`
    else if (ratio >= 0.7) verdict = `${C.yellow}△ 缺 ${(100 - ratio * 100).toFixed(0)}%${C.reset}`
    else verdict = `${C.red}✗ 仅覆盖 ${(ratio * 100).toFixed(0)}%${C.reset}`

    coverage.push({ tf, need, can, ratio, full })
    console.log(
      `  ${tf.padEnd(6)} ${String(need).padStart(10)} ${String(Math.min(can, MAX_BARS_PER_RUN)).padStart(9)} ${(ratio * 100).toFixed(1).padStart(7)}%   ${verdict}`,
    )
  }
  console.log()

  const best = coverage.filter((c) => c.full)
  if (best.length === 0) {
    console.log(`  ${C.yellow}没有任何周期能完整覆盖该区间。${C.reset}`)
  } else {
    console.log(`  ${C.green}能完整覆盖该区间的周期：${best.map((b) => b.tf).join(' / ')}${C.reset}`)
  }
  console.log()

  /* ------------------- 第 2 步：实际回测各周期 ------------------- */

  console.log(`${C.bold}  第 2 步 · 各周期实际回测${C.reset}`)
  console.log(`  ${'周期'.padEnd(6)} ${'K线数'.padStart(8)} ${'交易数'.padStart(8)} ${'实际起点'.padStart(12)} ${'收益'.padStart(10)}`)
  console.log('  ' + '─'.repeat(64))

  const results: { tf: Timeframe; bars: number; trades: number; from: string; ret: number }[] = []

  for (const tf of tfs) {
    const cov = coverage.find((c) => c.tf === tf)
    if (cov && cov.need > MAX_BARS_PER_RUN) {
      console.log(`  ${tf.padEnd(6)} ${C.dim}跳过（超过引擎单次上限）${C.reset}`)
      continue
    }
    try {
      const r = await runBacktestService({
        exchange, symbol, timeframe: tf,
        since: sinceMs, until: untilMs,
        params: {
          sensitivity: 18, atrLength: 14, atrSmoothing: 'RMA', atrMultiplier: 3.5,
          tradeDirection: 'Both', initialCapital: 1000,
        },
        useCache: true,
      })
      const from = new Date(r.candles[0].timestamp + 8 * 3600e3).toISOString().slice(0, 10)
      const ret = r.report.totalReturnPercent
      results.push({ tf, bars: r.candles.length, trades: r.trades.length, from, ret })
      const mark = r.trades.length === tvTrades ? `${C.green} ← 与 TV 一致${C.reset}` : ''
      console.log(
        `  ${tf.padEnd(6)} ${String(r.candles.length).padStart(8)} ${String(r.trades.length).padStart(8)} ${from.padStart(12)} ${(ret.toFixed(2) + '%').padStart(10)}${mark}`,
      )
    } catch (err) {
      console.log(`  ${tf.padEnd(6)} ${C.red}失败：${(err as Error).message.slice(0, 40)}${C.reset}`)
    }
  }
  console.log()

  /* ------------------- 第 3 步：结论 ------------------- */

  console.log(`${C.bold}  第 3 步 · 结论${C.reset}`)

  const exact = results.find((r) => r.trades === tvTrades)
  if (exact) {
    console.log(`  ${C.green}找到与 TradingView 交易数完全一致的配置：${exact.tf}（${exact.trades} 笔）${C.reset}`)
    console.log(`  ${C.dim}说明策略逻辑与 TradingView 吻合，之前的差异来自周期/数据区间不同。${C.reset}`)
  } else {
    const oneHourLike = results.filter((r) => r.tf === '1h')
    console.log(`  未找到交易数恰好等于 ${tvTrades} 的配置。`)
    console.log()
    console.log(`  ${C.bold}差异原因排查：${C.reset}`)
    console.log()

    // 覆盖不足？
    const insufficient = coverage.filter((c) => !c.full && c.need <= MAX_BARS_PER_RUN)
    if (insufficient.length > 0) {
      console.log(`  ${C.yellow}① 行情数据覆盖不足（最可能）${C.reset}`)
      console.log(`     ${exchange} 只提供「最近 ${LOOKBACK[exchange].toLocaleString()} 根」K 线，`)
      console.log(`     而目标区间在这些周期下需要更多根数：`)
      for (const c of insufficient) {
        if (c.ratio < 1) {
          console.log(`       · ${c.tf.padEnd(4)} 需要 ${String(c.need).padStart(6)} 根，只能拿到 ${String(c.can).padStart(6)} 根（覆盖 ${(c.ratio * 100).toFixed(0)}%）`)
        }
      }
      console.log(`     ${C.dim}→ 回测被迫只跑尾部一段，交易样本自然比 TradingView 少。${C.reset}`)
      console.log(`     ${C.dim}TradingView 用的是交易所完整历史（Bybit/Binance 可回溯数年），不受此限制。${C.reset}`)
      console.log()
    }

    console.log(`  ${C.bold}② 其他可能因素${C.reset}`)
    console.log(`     · 周期不同：TradingView 可能用的是 15m/30m，本程序用的是更大周期`)
    console.log(`     · 数据源不同：${exchange} 与 TradingView 所选交易所的 K 线高低点存在细微差异，`)
    console.log(`       会改变止损/止盈触发时机，进而影响交易笔数`)
    console.log(`     · 仓位模型不同：TradingView 固定手数，本程序按「权益×仓位%×杠杆」`)
    console.log()
    console.log(`  ${C.bold}③ 如何验证策略逻辑本身正确${C.reset}`)
    console.log(`     · 在 TradingView 与本地用「相同的周期 + 相同的标的 + 相同区间」`)
    console.log(`     · 且区间不超过 ${LOOKBACK[exchange].toLocaleString()} 根上限，此时交易笔数应接近`)
    console.log(`     · 或运行单元测试：pnpm test（确定性用例，覆盖各种入场/出场分支）`)
    console.log()
  }

  /* ------------------- 建议 ------------------- */

  if (best.length > 0) {
    const b = best[0]
    console.log(`  ${C.cyan}建议${C.reset}：想完整覆盖 ${new Date(sinceMs).toISOString().slice(0, 10)} → ${new Date(untilMs).toISOString().slice(0, 10)}，`)
    console.log(`         请使用 ${b.tf} 或更大周期（当前 ${exchange} 上限下）。`)
  } else {
    const widest = coverage.reduce((a, b) => (a.can / a.need > b.can / b.need ? a : b))
    console.log(`  ${C.cyan}建议${C.reset}：缩短回测区间，或改用更大周期（如 ${widest.tf}）。`)
  }
  console.log()
}

main().catch((err) => {
  console.error(`\n${C.red}诊断异常：${C.reset}`, err instanceof Error ? err.message : err)
  process.exit(1)
})

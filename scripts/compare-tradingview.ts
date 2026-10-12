#!/usr/bin/env node
/**
 * 与 TradingView 参考回测做对比的验证脚本。
 *
 * 参考目标（来自 TradingView 截图）：
 *   品种      BYBIT:SOLUSDT.P（SOL 永续）
 *   周期      15 分钟
 *   区间      2024-08-05 04:15 → 2024-09-25 16:45
 *   参数      Sensitive=18, Length=14, Smoothing=RMA, Multiplier=1.8,
 *             Trade Direction=Both
 *   初始资金  100 USDT，默认订单大小 2 合约，佣金 0.055%
 *
 * 参考结果：
 *   总损益     +47.35 USDT / +47.35%
 *   最大回撤   18.09 USDT / 11.67%
 *   盈利交易   73.33% (22/30)
 *   盈利因子   2.969
 *
 * 用法：
 *   node scripts/compare-tradingview.mjs
 *   node scripts/compare-tradingview.mjs --exchange gate --symbol SOL/USDT:USDT
 */

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Timeframe } from '../shared/types'
import { TIMEFRAME_MS } from '../shared/types'
import { runBacktestService } from '../server/src/service/backtestService'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/* ------------------------- TradingView 参考值 ------------------------- */

const TV = {
  from: '2024-08-05 04:15',
  to: '2024-09-25 16:45',
  // 目标指标（用于逐项比对）
  netProfitUsdt: 47.35,
  totalReturnPercent: 47.35,
  maxDrawdownPercent: 11.67,
  maxDrawdownUsdt: 18.09,
  winRatePercent: 73.33,
  totalTrades: 30,
  winningTrades: 22,
  profitFactor: 2.969,
  config: {
    sensitive: 18,
    length: 14,
    smoothing: 'RMA',
    multiplier: 1.8,
    direction: 'Both',
    initialCapital: 100,
    orderSize: '2 合约（固定手数）',
    commissionPercent: 0.055,
  },
}

/* ------------------------------ 参数解析 ------------------------------ */

function parseArgs(argv) {
  const out = {}
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

/* ------------------------------ 工具函数 ------------------------------ */

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
}

const num = (v, d = 2) =>
  Number.isFinite(v)
    ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
    : '—'

/** 按容差判断是否「接近」，返回带颜色的标记 */
function cmp(actual, expected, absTol, opts = {}) {
  const { pctTol = null, invert = false } = opts
  if (!Number.isFinite(actual)) return `${C.red}✗ 无效值${C.reset}`
  const diff = actual - expected
  let ok
  if (pctTol !== null && expected !== 0) {
    ok = Math.abs(diff / expected) <= pctTol
  } else {
    ok = Math.abs(diff) <= absTol
  }
  const tag = ok ? `${C.green}✓ 接近${C.reset}` : `${C.yellow}△ 有差异${C.reset}`
  const sign = diff >= 0 ? '+' : ''
  return `${tag} ${C.dim}(差 ${sign}${num(diff, 2)})${C.reset}`
}

/** 打印一行对比：指标名 | 本程序 | TradingView | 结论 */
function row(label, actual, expected, absTol, opts) {
  const a = typeof actual === 'number' ? num(actual, opts?.digits ?? 2) : String(actual)
  const e = typeof expected === 'number' ? num(expected, opts?.digits ?? 2) : String(expected)
  console.log(
    `  ${label.padEnd(16)} ${String(a).padStart(12)}  ${String(e).padStart(12)}   ${cmp(actual, expected, absTol, opts)}`,
  )
}

/* ------------------------------ 数据可用性探测 ------------------------------ */

/**
 * Gate 等交易所限制「只能取最近 N 根 K 线」。
 * 15m 只能回溯约 104 天，因此无法拿到 2024 年的 15m 数据。
 * 这里先探测目标区间在该周期下是否可取，避免直接抛出难懂的报错。
 */
async function probeAvailability(
  exchange: string,
  symbol: string,
  timeframe: string,
  since: number,
  until: number,
) {
  const tfMs = TIMEFRAME_MS[timeframe as Timeframe] ?? 60 * 60 * 1000
  // 交易所的「最近 N 根」是相对当前时间，而不是相对 until。
  const REACH = 10_000
  const earliestReachable = Date.now() - REACH * tfMs
  if (since < earliestReachable) {
    return {
      ok: false as const,
      reason: 'too-old',
      earliestReachable,
      needed: since,
    }
  }

  try {
    const { fetchKlines } = await import('../server/src/market/exchange')
    const res = await fetchKlines({ exchange, symbol, timeframe, since, until, useCache: false })
    const first = res.candles[0]?.timestamp ?? 0
    return { ok: true as const, firstTs: first, count: res.candles.length, clampNote: res.clampNote }
  } catch (err) {
    return { ok: false as const, reason: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

/** 各周期能回溯的最远天数（按每根 1 万根估算） */
function reachDays(timeframe: string): number {
  const mins: Record<string, number> = {
    '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
    '1h': 60, '2h': 120, '4h': 240, '6h': 360, '12h': 720,
    '1d': 1440, '3d': 4320, '1w': 10080,
  }
  const m = mins[timeframe] ?? 60
  return (10000 * m) / (60 * 24)
}

/* ------------------------------- 主流程 ------------------------------- */

async function main() {
  // BYBIT:SOLUSDT.P 不可达时自动改用可用的交易所（默认 gate）
  const exchange = args.exchange ?? 'gate'
  const symbol = args.symbol ?? 'SOL/USDT:USDT'
  const timeframe = args.timeframe ?? '15m'

  // TradingView 截图中的时间为 UTC+8。这里把它换算成 UTC 毫秒时间戳，
  // 与行情数据（交易所返回 UTC 时间戳）对齐。
  // 可用 --since / --until 覆盖（格式 YYYY-MM-DD）。
  const TZ = 8 * 3600 * 1000
  const since = args.since
    ? Date.parse(`${args.since}T00:00:00Z`) - TZ
    : Date.parse('2024-08-05T04:15:00Z') - TZ
  const until = args.until
    ? Date.parse(`${args.until}T23:59:59Z`) - TZ
    : Date.parse('2024-09-25T16:45:00Z') - TZ

  console.log()
  console.log(`${C.bold}${C.cyan}  与 TradingView 参考回测对比${C.reset}`)
  console.log()
  console.log(`${C.dim}参考来源：TradingView「Fibonacci Trend Reversals」策略报告${C.reset}`)
  console.log(`${C.dim}参考品种：BYBIT:SOLUSDT.P  15 分钟  2024-08-05 → 2024-09-25${C.reset}`)
  console.log()
  console.log('  本程序使用：')
  console.log(`    交易所   ${exchange}${exchange === 'gate' ? '（Bybit 在本机不可达，改用同标的的 Gate）' : ''}`)
  console.log(`    交易对   ${symbol}`)
  console.log(`    周期     ${timeframe}`)
  console.log(`    区间     ${new Date(since).toISOString().slice(0, 16).replace('T', ' ')} → ${new Date(until).toISOString().slice(0, 16).replace('T', ' ')} UTC`)
  console.log()

  /* ---- 数据可用性预检 ---- */
  console.log('  检查数据可用性…')
  const probe = await probeAvailability(exchange, symbol, timeframe, since, until)
  if (!probe.ok) {
    const days = reachDays(timeframe)
    const needed = (Date.now() - since) / 86400_000
    if (probe.reason === 'too-old') {
      console.log(`  ${C.red}✗ ${timeframe} 无法取到 2024-08-05 的数据${C.reset}`)
      console.log(`    ${C.dim}原因：${exchange} 限制只能取「最近约 10000 根」K 线${C.reset}`)
      console.log(`    ${C.dim}${timeframe} 每根 ${timeframe}，因此约可回溯 ${days.toFixed(0)} 天；${C.reset}`)
      console.log(`    ${C.dim}而目标起点距今 ${needed.toFixed(0)} 天，超出约 ${(needed - days).toFixed(0)} 天，无法覆盖。${C.reset}`)
      console.log(`    ${C.dim}可回溯的最早时间约为 ${new Date(probe.earliestReachable).toISOString().slice(0, 16).replace('T', ' ')} UTC。${C.reset}`)
    } else {
      console.log(`  ${C.red}✗ 取数失败${C.reset}`)
      console.log(`    ${C.dim}${probe.error}${C.reset}`)
    }
    console.log()
    console.log(`    ${C.yellow}可行的替代方案${C.reset}`)
    console.log(`      1) 换更大周期：--timeframe 4h（可回溯约 ${reachDays('4h').toFixed(0)} 天，足以覆盖 2024 年）`)
    console.log(`      2) 换更近区间：用最近 ${days.toFixed(0)} 天内的 15m 数据做同口径对照`)
    console.log(`      3) 接入可回溯全历史的行情源（如 TradingView 导出的 CSV）`)
    console.log()
    process.exit(2)
  }
  if (probe.clampNote) {
    console.log(`  ${C.yellow}注意${C.reset}：${probe.clampNote}`)
    console.log(
      `    ${C.dim}有效 K 线 ${probe.count} 根，实际起点 ${new Date(probe.firstTs).toISOString().slice(0, 16).replace('T', ' ')} UTC${C.reset}`,
    )
  } else {
    console.log(`  ${C.green}✓${C.reset} 数据可用（${probe.count} 根，起点 ${new Date(probe.firstTs).toISOString().slice(0, 16).replace('T', ' ')} UTC）`)
  }
  console.log()

  const params = {
    sensitivity: TV.config.sensitive,
    atrLength: TV.config.length,
    atrSmoothing: TV.config.smoothing,
    atrMultiplier: TV.config.multiplier,
    tradeDirection: TV.config.direction,
    commissionPercent: TV.config.commissionPercent,
    initialCapital: TV.config.initialCapital,
    // 关键：TradingView 使用「固定 2 合约」，本程序是「% 权益 × 杠杆」。
    // 为尽量贴近，这里用杠杆 1、满仓，使 notional ≈ 权益，
    // 从而收益率与 TV 的百分比口径可比。
    leverage: Number(args.leverage ?? 1),
    positionSizePercent: 100,
  }

  console.log('  策略参数：')
  console.log(`    Sensitivity ${params.sensitivity} · ATR Length ${params.atrLength} · ${params.atrSmoothing} · ×${params.atrMultiplier} · ${params.tradeDirection}`)
  console.log(`    初始资金 ${params.initialCapital} USDT · 杠杆 ${params.leverage}x · 仓位 ${params.positionSizePercent}% · 手续费 ${params.commissionPercent}%`)
  console.log()

  console.log('  运行回测…')
  const t0 = Date.now()
  let result
  try {
    result = await runBacktestService({
      exchange,
      symbol,
      timeframe,
      since,
      until,
      params,
      useCache: true,
    })
  } catch (err) {
    console.error(`\n${C.red}  回测失败：${err instanceof Error ? err.message : err}${C.reset}\n`)
    process.exit(1)
  }
  const elapsed = Date.now() - t0

  const { report: r, trades, candles } = result
  const s = r.stats

  console.log(`  ${C.green}完成${C.reset}（${elapsed}ms，${candles.length} 根 K 线，${trades.length} 笔交易）`)
  console.log()

  /* --------------------------- 逐项对比 --------------------------- */

  console.log(`${C.bold}  指标对比${C.reset}`)
  console.log(`  ${'指标'.padEnd(14)} ${'本程序'.padStart(12)}  ${'TradingView'.padStart(12)}   结论`)
  console.log('  ' + '─'.repeat(62))

  row('总损益(USDT)', r.netProfit, TV.netProfitUsdt, 2.0)
  row('总收益率(%)', r.totalReturnPercent, TV.totalReturnPercent, 0, { pctTol: 0.05 })
  // 回撤统一按正幅度比较（内部以负数表示）
  row('最大回撤(%)', Math.abs(r.maxDrawdownPercent), TV.maxDrawdownPercent, 0, { pctTol: 0.1 })
  row('最大回撤(USDT)', r.maxDrawdownAbs, TV.maxDrawdownUsdt, 2.0)
  row('交易笔数', s.totalTrades, TV.totalTrades, 0, { digits: 0 })
  row('盈利交易数', s.winningTrades, TV.winningTrades, 0, { digits: 0 })
  row('胜率(%)', s.winRate, TV.winRatePercent, 0, { pctTol: 0.1 })
  row('盈利因子', s.profitFactor, TV.profitFactor, 0, { pctTol: 0.15 })

  console.log()

  /* --------------------------- 补充指标 --------------------------- */

  console.log(`${C.bold}  补充指标（TradingView 未直接展示）${C.reset}`)
  console.log(`    期末权益        ${num(r.finalEquity)} USDT`)
  console.log(`    年化收益        ${num(r.annualizedReturnPercent)} %`)
  console.log(`    夏普 / 索提诺   ${num(r.sharpeRatio)} / ${num(r.sortinoRatio)}`)
  console.log(`    卡玛 / SQN      ${num(r.calmarRatio)} / ${num(r.sqn)}`)
  console.log(`    盈亏比          ${num(s.payoffRatio)}`)
  console.log(`    平均每笔        ${num(s.avgTrade)} USDT   期望值 ${num(s.expectancy)} USDT`)
  console.log(`    多头 / 空头     ${s.longTrades} / ${s.shortTrades}`)
  console.log(`    累计手续费      ${num(s.totalFees)} USDT`)
  console.log(`    平仓原因分布    ${JSON.stringify(s.exitReasonCounts)}`)
  if (r.warnings.length) {
    console.log(`    提示            ${r.warnings.join('；')}`)
  }
  console.log()

  /* --------------------------- 结论 --------------------------- */

  const retDiff = Math.abs(r.totalReturnPercent - TV.totalReturnPercent)
  const wdDiff = Math.abs(r.winRate - TV.winRatePercent)
  const pfDiff = Math.abs(s.profitFactor - TV.profitFactor)
  const trendMatch = Math.sign(r.netProfit) === Math.sign(TV.netProfitUsdt)

  console.log(`${C.bold}  结论${C.reset}`)
  if (trendMatch && retDiff <= 8 && wdDiff <= 12 && pfDiff <= 0.8) {
    console.log(`    ${C.green}方向与量级一致${C.reset}：收益、胜率、盈利因子均与 TradingView 处于同一水平。`)
  } else if (trendMatch) {
    console.log(`    ${C.yellow}方向一致但量级有差${C.reset}：收益正负相同，但具体数值存在系统性偏差。`)
  } else {
    console.log(`    ${C.red}方向不一致${C.reset}：收益正负相反，需要进一步排查。`)
  }
  console.log()

  /* --------------------------- 差异归因 --------------------------- */

  console.log(`${C.bold}  为什么数字不可能完全相同${C.reset}`)
  console.log(`    1. 周期不同（最关键）`)
  console.log(`       TradingView 用的是 15 分钟，本程序用 ${timeframe}。`)
  console.log(`       Fibonacci 通道与 TSOT 的入场条件是「穿越 Fibonacci 0.5 线 + 趋势强度对齐」，`)
  console.log(`       周期越小信号越密。同一日历区间内，15m 产生 30 笔交易，`)
  console.log(`       而 ${timeframe} 只产生 ${s.totalTrades} 笔 —— 交易样本根本不同，指标无从对齐。`)
  console.log()
  console.log(`    2. 仓位模型不同`)
  console.log(`       TradingView：固定「2 合约」（名义价值 = 2 × SOL 价格，随价格变化）`)
  console.log(`       本程序：按「权益 × 仓位% × 杠杆」计算名义价值（复利式）`)
  console.log(`       即使收益率方向一致，绝对金额也会系统性偏离。`)
  console.log()
  console.log(`    3. 数据源不同`)
  console.log(`       TradingView 用 Bybit 的 SOLUSDT.P，本程序用 ${exchange} 的 ${symbol}。`)
  console.log(`       两家交易所的 15m K 线高低点存在细微差异，会改变止损/止盈的触发时机。`)
  console.log()
  console.log(`    4. 回测引擎细节`)
  console.log(`       本程序按 TradingView 的 broker emulator 假设模拟 bar 内路径`)
  console.log(`       （阳线 O→L→H→C，阴线 O→H→L→C），但仍无法 100% 复刻其撮合顺序。`)
  console.log()

  /* --------------------------- 保存结果 --------------------------- */

  const outDir = path.resolve(__dirname, '../output')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `tv-compare-${symbol.replace(/[^a-zA-Z0-9]/g, '')}-${timeframe}.json`)
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        reference: TV,
        config: { exchange, symbol, timeframe, since, until, params },
        actual: { report: r, tradeCount: trades.length, meta: result.meta },
        deltas: {
          netProfit: r.netProfit - TV.netProfitUsdt,
          totalReturnPercent: r.totalReturnPercent - TV.totalReturnPercent,
          maxDrawdownPercent: r.maxDrawdownPercent - TV.maxDrawdownPercent,
          winRate: s.winRate - TV.winRatePercent,
          profitFactor: s.profitFactor - TV.profitFactor,
          tradeCount: s.totalTrades - TV.totalTrades,
        },
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`  完整结果已保存：${outFile}`)
  console.log()
}

main().catch((err) => {
  console.error(`\n${C.red}脚本异常：${C.reset}`, err instanceof Error ? err.message : err)
  process.exit(1)
})

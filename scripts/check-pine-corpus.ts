/**
 * Pine 语料批量体检（PineTS 版）：递归扫描目录下的每个 .pine，
 * 先做「转译 + input 扫描」，无语法错误者再拿合成 K 线**真跑一遍**，
 * 汇总诊断与运行期异常，用于判断哪些脚本可以在现行实现下工作。
 *
 * 用法：npx tsx scripts/check-pine-corpus.ts [目录] [合成 K 线数量]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Candle, PineDiagnostic } from '../shared/types'
import { runPineTsSignals } from '../server/src/pine/pinetsAdapter'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const dir = path.isAbsolute(process.argv[2] ?? '')
  ? (process.argv[2] as string)
  : path.resolve(ROOT, process.argv[2] ?? 'server/pine')

const bars = Number(process.argv[3] ?? 600)

/** 确定性合成 K 线（含趋势段与震荡段） */
function synthCandles(n = bars): Candle[] {
  const out: Candle[] = []
  let price = 100
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 18) * 6 + Math.sin(i / 5.5) * 1.5
    const drift = i < n / 3 ? 0.05 : i < (2 * n) / 3 ? -0.06 : 0.03
    const open = price
    const close = 100 + wave + drift * i
    const high = Math.max(open, close) + 0.4 + Math.abs(Math.sin(i / 3)) * 0.6
    const low = Math.min(open, close) - 0.4 - Math.abs(Math.cos(i / 4)) * 0.6
    out.push({ timestamp: Date.UTC(2024, 0, 1) + i * 3_600_000, open, high, low, close, volume: 800 + (i % 13) * 37 })
    price = close
  }
  return out
}

/** 递归收集 .pine（跳过迁移期的 `.v6.pine` 对照件，它们与主文件成对出现） */
function collectPineFiles(root: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(d, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.name.endsWith('.pine')) out.push(abs)
    }
  }
  walk(root)
  return out.sort()
}

interface Row {
  rel: string
  kind: string
  errors: PineDiagnostic[]
  runtime?: string
  trades?: number
  warnings: string[]
}

const files = collectPineFiles(dir)
const candles = synthCandles()
const rows: Row[] = []
const errorKinds = new Map<string, { count: number; files: Set<string> }>()

for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/')
  const source = fs.readFileSync(abs, 'utf8')
  const run = await runPineTsSignals(source, candles, { tickerId: 'BINANCE:BTC/USDT:USDT', timeframe: '1h' })
  const errors = run.diagnostics.filter((d) => d.severity === 'error')
  const row: Row = { rel, kind: run.meta.kind, errors, warnings: run.warnings }
  for (const e of errors) {
    // 归一化：去掉引号里的具体名字，便于聚类
    const key = e.message.replace(/"[^"]*"/g, '"…"')
    const slot = errorKinds.get(key) ?? { count: 0, files: new Set<string>() }
    slot.count += 1
    slot.files.add(rel)
    errorKinds.set(key, slot)
  }
  if (!errors.length) {
    row.trades = run.signals.filter((s) => s.canLong || s.canShort).length
  }
  rows.push(row)
}

console.log(`\n===== Pine 语料体检（PineTS）：${dir} （${files.length} 个脚本，${bars} 根合成 K 线） =====\n`)
let ok = 0
for (const r of rows) {
  if (r.errors.length === 0) {
    ok += 1
    const tag = r.kind === 'strategy' ? `可交易信号 ${r.trades} 根` : 'indicator'
    console.log(`✔ ${r.rel}  [${r.kind}] ${tag}${r.warnings.length ? `  告警 ${r.warnings.length}` : ''}`)
  } else {
    console.log(`✘ ${r.rel}  [${r.kind}]  (${r.errors.length} 条)`)
    for (const e of r.errors.slice(0, 3)) console.log(`    L${e.line}:C${e.column} ${e.message}`)
    if (r.errors.length > 3) console.log(`    … 其余 ${r.errors.length - 3} 条略`)
  }
}

console.log(`\n----- 错误聚类 -----`)
for (const [msg, info] of [...errorKinds.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`${String(info.count).padStart(3)}×  ${msg}`)
  console.log(`       [${[...info.files].slice(0, 6).join(', ')}${info.files.size > 6 ? ` 等 ${info.files.size} 个` : ''}]`)
}
console.log(`\n结果：PineTS 可执行 ${ok}/${files.length}\n`)

/**
 * Pine 语料批量体检：对目录下的每个 .pine 执行「编译 → 逐 bar 运行」，
 * 汇总诊断与运行期异常，用于找出编译器缺失的语法/内置特性。
 *
 * 用法：npx tsx scripts/check-pine-corpus.ts [目录]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Candle, PineDiagnostic } from '../shared/types'
import { compilePine } from '../server/src/pine/compile'
import { runPineProgram } from '../server/src/pine/execute'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const dir = path.isAbsolute(process.argv[2] ?? '')
  ? (process.argv[2] as string)
  : path.resolve(ROOT, process.argv[2] ?? 'server/pine/tv')

/** 确定性合成 K 线（600 根，含趋势段与震荡段） */
function synthCandles(n = 600): Candle[] {
  const out: Candle[] = []
  let price = 100
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 18) * 6 + Math.sin(i / 5.5) * 1.5
    const drift = i < n / 3 ? 0.05 : i < (2 * n) / 3 ? -0.06 : 0.03
    const open = price
    const close = 100 + wave + drift * i
    const high = Math.max(open, close) + 0.4 + Math.abs(Math.sin(i / 3)) * 0.6
    const low = Math.min(open, close) - 0.4 - Math.abs(Math.cos(i / 4)) * 0.6
    out.push({
      timestamp: Date.UTC(2024, 0, 1) + i * 3_600_000,
      open,
      high,
      low,
      close,
      volume: 800 + (i % 13) * 37,
    })
    price = close
  }
  return out
}

const FLAT = { flat: true, positionSize: 0, prevPositionSize: 0, avgPrice: Number.NaN, side: null }

interface Row {
  file: string
  errors: PineDiagnostic[]
  runtime?: string
}

const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.pine'))
  .sort()

const rows: Row[] = []
const errorKinds = new Map<string, { count: number; files: Set<string> }>()

for (const file of files) {
  const source = fs.readFileSync(path.join(dir, file), 'utf8')
  const comp = compilePine(source, { sourceName: file })
  const errors = comp.diagnostics.filter((d) => d.severity === 'error')
  const row: Row = { file, errors }
  for (const e of errors) {
    // 归一化：去掉引号里的具体名字，便于聚类
    const key = e.message.replace(/"[^"]*"/g, '"…"')
    const slot = errorKinds.get(key) ?? { count: 0, files: new Set<string>() }
    slot.count += 1
    slot.files.add(file)
    errorKinds.set(key, slot)
  }
  if (errors.length === 0) {
    try {
      const candles = synthCandles()
      const program = runPineProgram(comp.ts, candles, { timeframe: '1h' })
      for (let i = 0; i < candles.length; i++) program.step(i, FLAT as never)
    } catch (e) {
      row.runtime = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    }
  }
  rows.push(row)
}

console.log(`\n===== Pine 语料体检：${dir} （${files.length} 个脚本） =====\n`)
let okCompile = 0
let okRun = 0
for (const r of rows) {
  if (r.errors.length === 0) {
    okCompile += 1
    if (!r.runtime) {
      okRun += 1
      console.log(`✔ ${r.file}`)
    } else {
      console.log(`△ ${r.file}  编译通过，运行期异常：${r.runtime}`)
    }
  } else {
    console.log(`✘ ${r.file}  (${r.errors.length} 个编译错误)`)
    for (const e of r.errors.slice(0, 4)) {
      console.log(`    L${e.line}:C${e.column} ${e.message}`)
    }
    if (r.errors.length > 4) console.log(`    … 其余 ${r.errors.length - 4} 条略`)
  }
}

console.log(`\n----- 错误聚类 -----`)
const sorted = [...errorKinds.entries()].sort((a, b) => b[1].count - a[1].count)
for (const [msg, info] of sorted) {
  console.log(`${String(info.count).padStart(3)}×  ${msg}   [${[...info.files].join(', ')}]`)
}
console.log(
  `\n结果：编译通过 ${okCompile}/${files.length}，编译 + 运行通过 ${okRun}/${files.length}\n`,
)
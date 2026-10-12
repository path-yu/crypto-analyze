/**
 * 从 TradingView 抓取公开（开源）Pine 策略源码到 server/pine/tv/ 目录。
 *
 * 两条公开接口：
 *   1. /pubscripts-suggest-json/?search=…   —— 搜索列表（含 scriptIdPart / access / version）
 *   2. pine-facade.tradingview.com/pine-facade/get/<id>/<version> —— 详情（含完整 source）
 * 仅抓取 access===1（开源）且 source 非空的脚本。
 *
 * 用法：node scripts/fetch-tv-scripts.mjs [查询词] [抓取数量]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'pine', 'tv')
const query = process.argv[2] ?? 'btc strategy'
const want = Number(process.argv[3] ?? 15)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 用 curl 取 JSON：Node 内置 fetch 不走系统代理，直连 TradingView 会超时 */
function getJson(url) {
  const out = execFileSync('curl.exe', ['-s', '-m', '30', '-A', UA, '-H', 'Accept: application/json', url], {
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  })
  return JSON.parse(out)
}

const slugify = (s) =>
  s
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 48)
    .toLowerCase() || 'script'

const list = await getJson(
  `https://www.tradingview.com/pubscripts-suggest-json/?search=${encodeURIComponent(query)}&lang=en`,
)
const open = list.results.filter((r) => r.access === 1 && r.type === 2)
console.log(`搜索 "${query}"：共 ${list.results.length} 条，其中开源候选 ${open.length} 条`)

fs.mkdirSync(OUT_DIR, { recursive: true })
let saved = 0
let idx = 0
const manifest = []
for (const item of open) {
  if (saved >= want) break
  idx += 1
  const id = encodeURIComponent(item.scriptIdPart)
  const version = item.version || '1'
  try {
    const detail = await getJson(
      `https://pine-facade.tradingview.com/pine-facade/get/${id}/${version}?no_4xx=true`,
    )
    const source = detail.source ?? ''
    if (!source.trim()) {
      console.log(`- 跳过（无源码）：${item.scriptName}`)
      continue
    }
    const file = `${String(idx).padStart(2, '0')}-${slugify(item.title ?? item.scriptName)}.pine`
    fs.writeFileSync(path.join(OUT_DIR, file), source.replace(/\r\n/g, '\n'), 'utf8')
    const ver = /@version=(\d+)/.exec(source)?.[1] ?? '?'
    const lines = source.split('\n').length
    manifest.push({ file, name: item.scriptName, author: item.author?.username, version: ver, lines })
    saved += 1
    console.log(`✔ ${file}  (v${ver}, ${lines} 行, ${item.scriptName})`)
  } catch (e) {
    console.log(`- 失败：${item.scriptName} → ${e.message}`)
  }
  await sleep(250)
}

fs.writeFileSync(
  path.join(OUT_DIR, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
  'utf8',
)
console.log(`\n完成：写入 ${saved} 个脚本到 ${OUT_DIR}`)
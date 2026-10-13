/**
 * 清理 .cache/klines 缓存目录。
 *
 * 默认每个「数据源 + 品种 + 周期」只保留最新的 3 个文件；
 * 传 --all 则清空全部缓存（下次回测会自动重新下载）。
 *
 * 用法：
 *   pnpm clean:cache
 *   pnpm clean:cache --all
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.cache/klines')
const keep = process.argv.includes('--all') ? 0 : 3

if (!fs.existsSync(dir)) {
  console.log('缓存目录不存在，无需清理')
  process.exit(0)
}

/** 按文件名前缀（数据源_品种_周期_）分组 */
const groups = new Map()
for (const name of fs.readdirSync(dir)) {
  const m = /^(.*)_\d+_\d+\.json$/.exec(name)
  const key = m ? m[1] : '(其他)'
  if (!groups.has(key)) groups.set(key, [])
  const file = path.join(dir, name)
  const stat = fs.statSync(file)
  groups.get(key).push({ file, size: stat.size, mtime: stat.mtimeMs })
}

let removed = 0
let freed = 0
for (const files of groups.values()) {
  files.sort((a, b) => b.mtime - a.mtime)
  for (const f of files.slice(keep)) {
    try {
      fs.unlinkSync(f.file)
      removed++
      freed += f.size
    } catch {
      /* 忽略单个文件失败 */
    }
  }
}

console.log(`已清理 ${removed} 个缓存文件，释放 ${(freed / 1048576).toFixed(1)} MB`)
for (const [key, files] of groups) {
  console.log(`  ${key}: 保留 ${Math.min(keep, files.length)} / ${files.length}`)
}

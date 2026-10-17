/**
 * 已保存 Pine 脚本的本地存储（**实时读写文件，无索引、无缓存**）。
 *
 * 每份脚本一个文件夹，源码就放在目录里的同名文件：
 *
 * ```
 * server/pine/Signal Suite/
 *   Signal Suite.pine   原始 Pine 源码
 * ```
 *
 * 列表接口每次请求都直接扫描 `server/pine/` 下的脚本目录并读文件 ——
 * 因此在应用之外（IDE / git / 其它进程）对 `.pine` 的任何修改，
 * 下一次 `GET /api/pine/scripts` 立刻就能看到，不存在「索引里还是旧源码」的问题。
 *
 * 脚本 id 用 `dir:<目录名>`：目录名就是脚本身份，同名保存 = 就地覆盖同一份文件。
 * 测试可用环境变量改写脚本库位置：`PINE_LIB_DIR`。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SavedPineScript } from '../../../shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** server/src/pine → 上三级 = 项目根 */
const PROJECT_ROOT = path.resolve(__dirname, '../../..')
/** 脚本库根目录（与内置示例 test.pine / tv/*.pine 同目录） */
const DEFAULT_LIB_DIR = path.join(PROJECT_ROOT, 'server/pine')

/** 脚本名长度上限（下拉菜单里要能一眼看完） */
const MAX_NAME_LEN = 60
/** 目录名长度上限（Windows 路径整体长度也有限制） */
const MAX_DIR_LEN = 60

function libDir(): string {
  return process.env.PINE_LIB_DIR ?? DEFAULT_LIB_DIR
}

/** 项目内相对路径（用于界面提示）；不在项目内时返回绝对路径 */
function relToRoot(abs: string): string {
  const rel = path.relative(PROJECT_ROOT, abs)
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : abs
}

/* ------------------------------------------------------------------ */
/* 名称与目录                                                          */
/* ------------------------------------------------------------------ */

/** 规范化脚本名；非法时抛错，由路由层转成 400 */
export function normalizeScriptName(name: unknown): string {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new Error('脚本名不能为空')
  if (trimmed.length > MAX_NAME_LEN) {
    throw new Error(`脚本名过长（上限 ${MAX_NAME_LEN} 个字符）`)
  }
  return trimmed
}

/**
 * 脚本名 → 目录名：去掉文件系统非法字符，保留中英文与数字，
 * 空白折叠成单个下划线，去掉首尾的点与空格（Windows 不允许）。
 */
export function slugifyScriptName(name: string): string {
  const slug = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, MAX_DIR_LEN)
  // Windows 不允许目录名以点或空格结尾；首尾的下划线也一并去掉，纯符号名回落到默认值
  const cleaned = slug.replace(/^[_.\s-]+/, '').replace(/[_.\s-]+$/, '')
  return cleaned || 'pine-script'
}

/** 该目录是否是我们写出的脚本目录（存在同名 .pine） */
function isScriptDir(dir: string): boolean {
  const abs = path.join(libDir(), dir)
  try {
    if (!fs.statSync(abs).isDirectory()) return false
  } catch {
    return false
  }
  return fs.existsSync(path.join(abs, `${dir}.pine`))
}

/**
 * 选定落盘目录：已有同名脚本目录就沿用（同名即更新），
 * 否则用 slug；与既有文件 / 其它目录冲突时递增后缀（`-2`、`-3`…）。
 */
function pickDir(name: string): string {
  const base = slugifyScriptName(name)
  if (isScriptDir(base)) return base
  let candidate = base
  let i = 2
  while (fs.existsSync(path.join(libDir(), candidate))) candidate = `${base}-${i++}`
  return candidate
}

/* ------------------------------------------------------------------ */
/* 实时扫盘                                                            */
/* ------------------------------------------------------------------ */

/** 扫描 `server/pine/` 下所有「目录名与 .pine 同名」的脚本目录 */
function scanScriptDirs(): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(libDir(), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && isScriptDir(e.name))
    .map((e) => e.name)
}

/** 读一份脚本的源码与时间戳（每次调用都读盘，不缓存） */
function readScriptFile(dir: string): { source: string; mtime: number; birth: number } | null {
  const abs = path.join(libDir(), dir, `${dir}.pine`)
  try {
    const st = fs.statSync(abs)
    const source = fs.readFileSync(abs, 'utf8')
    return { source, mtime: st.mtimeMs, birth: st.birthtimeMs || st.mtimeMs }
  } catch {
    return null
  }
}

/** 磁盘路径信息（供界面提示） */
function pathInfoOf(dir: string, hasTs: boolean): Pick<SavedPineScript, 'pinePath' | 'tsPath' | 'tsBytes'> {
  const pineAbs = path.join(libDir(), dir, `${dir}.pine`)
  const tsAbs = path.join(libDir(), dir, `${dir}.ts`)
  const info: Pick<SavedPineScript, 'pinePath' | 'tsPath' | 'tsBytes'> = {
    pinePath: relToRoot(pineAbs),
  }
  if (hasTs) {
    try {
      info.tsBytes = fs.statSync(tsAbs).size
      info.tsPath = relToRoot(tsAbs)
    } catch {
      /* .ts 不存在则只报源码路径 */
    }
  }
  return info
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 全部脚本：**每次请求实时扫描目录 + 读盘**，按修改时间倒序（最近保存的在前）。
 *
 * 不读也不写任何索引文件 —— 在应用之外改了 `.pine`，刷新列表即可看到新内容。
 * `id` 固定为 `dir:<目录名>`，`name` 用目录名（目录名由脚本名 slug 而来）。
 */
export function listPineScripts(): SavedPineScript[] {
  const out: SavedPineScript[] = []
  for (const dir of scanScriptDirs()) {
    const file = readScriptFile(dir)
    if (!file) continue
    out.push({
      id: `dir:${dir}`,
      name: dir,
      source: file.source,
      dir,
      ...pathInfoOf(dir, true),
      createdAt: file.birth,
      updatedAt: file.mtime,
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 保存（同名即更新）：写 `server/pine/<目录>/<目录>.pine`。
 *
 * `ts` 仅为兼容旧调用方保留：非空时同时写入 `<目录>.ts`（PineTS 之后不再产出）。
 */
export function savePineScript(name: string, source: string, ts?: string): SavedPineScript {
  const dir = pickDir(name)
  const absDir = path.join(libDir(), dir)
  fs.mkdirSync(absDir, { recursive: true })

  const pineAbs = path.join(absDir, `${dir}.pine`)
  fs.writeFileSync(pineAbs, source, 'utf8')

  const hasTs = typeof ts === 'string' && ts.trim().length > 0
  if (hasTs) fs.writeFileSync(path.join(absDir, `${dir}.ts`), ts as string, 'utf8')

  const st = fs.statSync(pineAbs)
  return {
    id: `dir:${dir}`,
    name: dir,
    source,
    dir,
    ...pathInfoOf(dir, hasTs),
    createdAt: st.birthtimeMs || st.mtimeMs,
    updatedAt: st.mtimeMs,
  }
}

/**
 * 删除；返回是否真的删掉了。
 *
 * `id` 形如 `dir:<目录名>`（列表现场生成）。清理目录下由我们生成的
 * `<目录>.pine` / `<目录>.ts`，目录空了就一并删掉；目录里还有别的东西则保留。
 */
export function deletePineScript(id: string): boolean {
  if (!id.startsWith('dir:')) return false
  const dir = id.slice(4)
  // 只允许删除脚本库里的一级目录，挡住 `..` 与路径分隔符
  if (!dir || dir === '.' || dir === '..' || dir.includes('/') || dir.includes('\\')) return false

  const absDir = path.join(libDir(), dir)
  let removed = false
  for (const fileName of [`${dir}.pine`, `${dir}.ts`]) {
    const file = path.join(absDir, fileName)
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file)
        removed = true
      }
    } catch {
      /* 单个文件删不掉就跳过 */
    }
  }
  try {
    if (fs.existsSync(absDir) && fs.readdirSync(absDir).length === 0) fs.rmdirSync(absDir)
  } catch {
    /* 目录非空占用，保留 */
  }
  return removed
}

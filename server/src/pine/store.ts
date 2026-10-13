/**
 * 已保存 Pine 脚本的本地存储。
 *
 * 每份脚本单独一个文件夹，源码与编译产物放在一起，便于直接进 git：
 *
 * ```
 * server/pine/Signal Suite/
 *   Signal Suite.pine   原始 Pine 源码
 *   Signal Suite.ts     编译器生成的 TypeScript
 * ```
 *
 * 索引落在 `.cache/pine-scripts.json`（记录 id / 名称 / 时间 / 目录名）。
 * 索引只在保存时更新，因此还支持**反向发现**：扫描 `server/pine/` 下的各
 * 脚本目录里的 `<目录>.pine`，把仓库里已有的脚本也列出来（换机器 / 重新
 * clone 后依然能在下拉菜单里看到，不依赖 .cache）。
 *
 * 测试可用环境变量改写位置：`PINE_LIB_DIR`、`PINE_STORE_FILE`。
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
/** 索引文件（与 K 线缓存同目录，已在 .gitignore 中） */
const DEFAULT_STORE_FILE = path.join(PROJECT_ROOT, '.cache/pine-scripts.json')

/** 脚本名长度上限（下拉菜单里要能一眼看完） */
const MAX_NAME_LEN = 60
/** 目录名长度上限（Windows 路径整体长度也有限制） */
const MAX_DIR_LEN = 60

function libDir(): string {
  return process.env.PINE_LIB_DIR ?? DEFAULT_LIB_DIR
}

function storeFile(): string {
  return process.env.PINE_STORE_FILE ?? DEFAULT_STORE_FILE
}

/** 项目内相对路径（用于界面提示）；不在项目内时返回绝对路径 */
function relToRoot(abs: string): string {
  const rel = path.relative(PROJECT_ROOT, abs)
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : abs
}

/* ------------------------------------------------------------------ */
/* 索引读写                                                            */
/* ------------------------------------------------------------------ */

/**
 * 索引里的记录：源码不重复存一份，以 `server/pine/<目录>/<目录>.pine` 为准，
 * 索引只保留 id / 名称 / 时间 / 目录名等元信息。
 */
type StoredRecord = Omit<SavedPineScript, 'source'> & { source?: string }

/** 读取全部记录；文件不存在或损坏时视为空，不让存储层的异常影响接口 */
function readAll(): StoredRecord[] {
  let raw: string
  try {
    raw = fs.readFileSync(storeFile(), 'utf8')
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s): s is StoredRecord =>
        !!s && typeof s === 'object' && typeof (s as StoredRecord).id === 'string',
    )
  } catch {
    return []
  }
}

/** 原子落盘：先写临时文件再改名，避免中途崩溃留下半截 JSON */
function writeAll(list: StoredRecord[]): void {
  const file = storeFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  // 已有落盘目录的记录不再重复存源码（以 <目录>.pine 为准）；
  // 没有目录的历史记录必须保留源码，否则索引一写就把正文弄丢了。
  const slim = list.map(({ source, ...rest }) => (rest.dir ? rest : { ...rest, source }))
  fs.writeFileSync(tmp, JSON.stringify(slim, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function newId(): string {
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 规范化脚本名；非法时抛错，由路由层转成 400 */
export function normalizeScriptName(name: unknown): string {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new Error('脚本名不能为空')
  if (trimmed.length > MAX_NAME_LEN) {
    throw new Error(`脚本名过长（上限 ${MAX_NAME_LEN} 个字符）`)
  }
  return trimmed
}

/* ------------------------------------------------------------------ */
/* 目录名                                                              */
/* ------------------------------------------------------------------ */

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
 * 选定落盘目录：同名脚本沿用原目录；否则用 slug，
 * 与既有文件 / 其他脚本目录冲突时递增后缀（`-2`、`-3`…）。
 */
function pickDir(name: string, existingDir?: string): string {
  if (existingDir && isScriptDir(existingDir)) return existingDir

  const base = slugifyScriptName(name)
  let candidate = base
  let i = 2
  while (
    fs.existsSync(path.join(libDir(), candidate)) &&
    !(isScriptDir(candidate) && candidate === base)
  ) {
    candidate = `${base}-${i++}`
  }
  return candidate
}

/* ------------------------------------------------------------------ */
/* 反向发现：扫描 server/pine/<目录>/<目录>.pine                        */
/* ------------------------------------------------------------------ */

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

function readScriptFile(dir: string): { source: string; mtime: number } | null {
  const abs = path.join(libDir(), dir, `${dir}.pine`)
  try {
    return { source: fs.readFileSync(abs, 'utf8'), mtime: fs.statSync(abs).mtimeMs }
  } catch {
    return null
  }
}

/** 磁盘路径信息（供界面提示与索引记录复用） */
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
 * 全部脚本：索引记录（最近保存的在前）+ 目录里发现但索引未登记的脚本。
 * 索引优先，发现出来的记录 id 用 `dir:<目录名>` 保持稳定。
 */
export function listPineScripts(): SavedPineScript[] {
  const indexed = readAll()
  const knownDirs = new Set(indexed.map((s) => s.dir).filter((d): d is string => !!d))
  const out: SavedPineScript[] = []

  for (const rec of indexed) {
    // 目录被手工删掉时，仍按索引返回（源码存在索引里，可直接另存回去）
    const dir = rec.dir
    const file = dir ? readScriptFile(dir) : null
    const source = file?.source ?? rec.source ?? ''
    out.push({
      ...rec,
      dir,
      source,
      ...(dir ? pathInfoOf(dir, true) : {}),
      updatedAt: file ? Math.max(rec.updatedAt, file.mtime) : rec.updatedAt,
    })
  }

  for (const dir of scanScriptDirs()) {
    if (knownDirs.has(dir)) continue
    const file = readScriptFile(dir)
    if (!file) continue
    out.push({
      id: `dir:${dir}`,
      name: dir,
      source: file.source,
      dir,
      ...pathInfoOf(dir, true),
      createdAt: file.mtime,
      updatedAt: file.mtime,
    })
  }

  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 保存（同名即更新）。
 *
 * 写入 `server/pine/<目录>/<目录>.pine`；`ts` 非空时同时写入 `<目录>.ts`。
 * 返回落盘后的记录（含相对路径与编译产物大小）。
 */
export function savePineScript(name: string, source: string, ts?: string): SavedPineScript {
  const now = Date.now()
  const list = readAll()
  const existing = list.find((s) => s.name === name)
  const dir = pickDir(name, existing?.dir)

  const absDir = path.join(libDir(), dir)
  fs.mkdirSync(absDir, { recursive: true })
  fs.writeFileSync(path.join(absDir, `${dir}.pine`), source, 'utf8')

  const hasTs = typeof ts === 'string' && ts.trim().length > 0
  if (hasTs) {
    fs.writeFileSync(path.join(absDir, `${dir}.ts`), ts as string, 'utf8')
  }

  const record: SavedPineScript = {
    id: existing?.id ?? newId(),
    name,
    source,
    dir,
    ...pathInfoOf(dir, hasTs),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  const next = existing
    ? list.map((s) => (s.id === existing.id ? record : s))
    : [...list, record]
  writeAll(next)
  return record
}

/**
 * 删除；返回是否真的删掉了。
 *
 * 同时清理该脚本目录下由我们生成的 `<目录>.pine` / `<目录>.ts`，
 * 目录空了就一并删掉；目录里还有别的东西则保留，避免误删。
 */
export function deletePineScript(id: string): boolean {
  const wantedDir = id.startsWith('dir:') ? id.slice(4) : readAll().find((s) => s.id === id)?.dir

  let removed = false
  if (wantedDir) {
    const absDir = path.join(libDir(), wantedDir)
    for (const fileName of [`${wantedDir}.pine`, `${wantedDir}.ts`]) {
      const file = path.join(absDir, fileName)
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file)
          removed = true
        }
      } catch {
        /* 单个文件删不掉就跳过，不影响索引清理 */
      }
    }
    try {
      if (fs.existsSync(absDir) && fs.readdirSync(absDir).length === 0) fs.rmdirSync(absDir)
    } catch {
      /* 目录非空或占用，保留 */
    }
  }

  const list = readAll()
  const next = list.filter((s) => s.id !== id)
  if (next.length !== list.length) {
    writeAll(next)
    return true
  }
  // 索引里没有（例如是扫描发现的目录）：文件被删掉也算删除成功
  return removed
}

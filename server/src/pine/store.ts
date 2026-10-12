/**
 * 已保存 Pine 脚本的本地存储。
 *
 * 落在 `.cache/pine-scripts.json`（与 K 线缓存同目录，已在 .gitignore 中），
 * 保存即落盘，重启服务后仍在；同名脚本再次保存按「更新」处理，
 * 换个名字保存即新增一份，无需在界面上区分「新建 / 覆盖」。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SavedPineScript } from '../../../shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** server/src/pine → 上三级 = 项目根 */
const STORE_FILE = path.resolve(__dirname, '../../../.cache/pine-scripts.json')

/** 脚本名长度上限（下拉菜单里要能一眼看完） */
const MAX_NAME_LEN = 60

/** 读取全部脚本；文件不存在或损坏时视为空，不让存储层的异常影响接口 */
function readAll(): SavedPineScript[] {
  let raw: string
  try {
    raw = fs.readFileSync(STORE_FILE, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s): s is SavedPineScript =>
        !!s && typeof s === 'object' && typeof (s as SavedPineScript).id === 'string',
    )
  } catch {
    return []
  }
}

/** 原子落盘：先写临时文件再改名，避免中途崩溃留下半截 JSON */
function writeAll(list: SavedPineScript[]): void {
  const dir = path.dirname(STORE_FILE)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${STORE_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8')
  fs.renameSync(tmp, STORE_FILE)
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

/** 全部已保存脚本，最近保存的排在前面 */
export function listPineScripts(): SavedPineScript[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 保存（同名即更新），返回落盘后的记录 */
export function savePineScript(name: string, source: string): SavedPineScript {
  const now = Date.now()
  const list = readAll()
  const existing = list.find((s) => s.name === name)
  const record: SavedPineScript = existing
    ? { ...existing, source, updatedAt: now }
    : { id: newId(), name, source, createdAt: now, updatedAt: now }
  const next = existing ? list.map((s) => (s.id === existing.id ? record : s)) : [...list, record]
  writeAll(next)
  return record
}

/** 删除；返回是否真的删掉了 */
export function deletePineScript(id: string): boolean {
  const list = readAll()
  const next = list.filter((s) => s.id !== id)
  if (next.length === list.length) return false
  writeAll(next)
  return true
}
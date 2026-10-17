/**
 * Vela 指标清单（manifest）加载器。
 *
 * `VelaWorkspace` 的 `indicators` 选项接受「内联数组 / URL / 异步 loader」三选一。
 * 这里用异步 loader：每次打开工作区都去后端拉一次已保存脚本列表
 * （`server/pine/<目录>/<目录>.pine` 会被反向发现），这样通过 IDE 新建、
 * `git pull` 或文件管理器拷进来的脚本也能在清单里看到，不必重启前端。
 *
 * 拉取失败不静默吞掉 —— 打 `console.warn` 便于排查（与「脚本下拉列表」的既有约定一致）。
 */

import { fetchPineScripts } from '../api'

/** Vela manifest 条目（内联脚本形式） */
export interface PineManifestEntry {
  name: string
  script: string
  language: string
  /** 一律 false：是否默认叠加到图上由用户自己决定 */
  enabled: boolean
}

/**
 * 清单缓存。
 *
 * Vela 在**每次工作区实例化**时都会调一次这个 loader —— 原先每次实时刷新都
 * 重建工作区，于是 `GET /api/pine/scripts` 被反复调用（实测累计 4319 次）。
 * 现在工作区只在结构变化时重建，这里再加一层缓存兜底：同一份清单在 TTL 内
 * 直接复用，保存/删除脚本时调用 `invalidatePineManifest()` 主动失效。
 */
const MANIFEST_TTL_MS = 60_000
let cache: { at: number; list: PineManifestEntry[] } | null = null

/** 脚本列表发生变化（保存 / 删除 / 手动刷新）时调用，下次取用即重新拉取 */
export function invalidatePineManifest(): void {
  cache = null
}

export async function loadPineManifest(): Promise<PineManifestEntry[]> {
  if (cache && Date.now() - cache.at < MANIFEST_TTL_MS) return cache.list
  try {
    const list = await fetchPineScripts()
    const entries = list
      .filter((s) => typeof s.source === 'string' && s.source.trim().length > 0)
      .map((s) => ({ name: s.name, script: s.source, language: 'pine', enabled: false }))
    cache = { at: Date.now(), list: entries }
    return entries
  } catch (err) {
    console.warn('[vela] 拉取 Pine 脚本清单失败，指标清单将为空：', err)
    return []
  }
}

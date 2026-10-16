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

export async function loadPineManifest(): Promise<PineManifestEntry[]> {
  try {
    const list = await fetchPineScripts()
    return list
      .filter((s) => typeof s.source === 'string' && s.source.trim().length > 0)
      .map((s) => ({ name: s.name, script: s.source, language: 'pine', enabled: false }))
  } catch (err) {
    console.warn('[vela] 拉取 Pine 脚本清单失败，指标清单将为空：', err)
    return []
  }
}

/**
 * 编译缓存：以「源文件名 + 源码」为 key 的 LRU（上限 32）。
 *
 * 编译（lexer → parser → check → codegen）是纯函数且开销可观，
 * 同一份源码在编辑器里反复回测时只需编译一次。
 */

import type { CompileResult } from './compile'
import { compilePine } from './compile'

const MAX_ENTRIES = 32

const cache = new Map<string, CompileResult>()

export function compilePineCached(source: string, opts: { sourceName?: string } = {}): CompileResult {
  const key = `${opts.sourceName ?? ''}\u0000${source}`
  const hit = cache.get(key)
  if (hit) {
    // LRU：命中后移到队尾（Map 保持插入顺序）
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }

  const result = compilePine(source, opts)
  cache.set(key, result)
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return result
}

/** 清空缓存（测试用） */
export function clearPineCache(): void {
  cache.clear()
}
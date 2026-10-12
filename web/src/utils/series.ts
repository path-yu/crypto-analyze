/** 序列处理工具 */

/** 等间距抽稀到 maxPoints 以内，始终保留首尾点 */
export function downsample<T>(arr: readonly T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr.slice()
  const step = (arr.length - 1) / (maxPoints - 1)
  const out: T[] = []
  for (let i = 0; i < maxPoints; i++) {
    out.push(arr[Math.round(i * step)])
  }
  return out
}

/** 分位数 */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/** 按区间统计频数直方图 */
export function histogram(
  values: readonly number[],
  binCount: number,
): { from: number; to: number; count: number; mid: number }[] {
  if (values.length === 0) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return [{ from: min, to: max, count: values.length, mid: min }]
  const width = (max - min) / binCount
  const bins = Array.from({ length: binCount }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    count: 0,
    mid: min + (i + 0.5) * width,
  }))
  for (const v of values) {
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor((v - min) / width)))
    bins[idx].count++
  }
  return bins
}

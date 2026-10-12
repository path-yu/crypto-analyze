/**
 * Pine Script `ta.*` 内置函数的 TypeScript 等价实现。
 *
 * 约定：所有函数返回与输入等长的数组，窗口不足的位置填 `NaN`（对应 Pine 的 `na`）。
 * 窗口长度语义与 Pine 一致 —— `ta.highest(src, n)` 表示当前 bar 在内的最近 n 根。
 */

export const NA = Number.NaN

/** 判断一个值是否为有效数字（非 na） */
export function isNa(v: number | null | undefined): boolean {
  return v === null || v === undefined || Number.isNaN(v)
}

/* ------------------------------------------------------------------ */
/* 简单均线族                                                           */
/* ------------------------------------------------------------------ */

/** ta.sma —— 简单移动平均，前 length-1 个位置为 na */
export function sma(src: readonly number[], length: number): number[] {
  const out = new Array<number>(src.length).fill(NA)
  if (length <= 0) return out
  let sum = 0
  for (let i = 0; i < src.length; i++) {
    sum += src[i]
    if (i >= length) sum -= src[i - length]
    if (i >= length - 1) out[i] = sum / length
  }
  return out
}

/** ta.ema —— 指数移动平均，首值用前 length 个数据的 SMA 播种（与 Pine 一致） */
export function ema(src: readonly number[], length: number): number[] {
  const out = new Array<number>(src.length).fill(NA)
  if (length <= 0) return out
  const alpha = 2 / (length + 1)
  let seed = 0
  let emaPrev = NA
  for (let i = 0; i < src.length; i++) {
    if (i < length) {
      seed += src[i]
      if (i === length - 1) {
        emaPrev = seed / length
        out[i] = emaPrev
      }
      continue
    }
    emaPrev = alpha * src[i] + (1 - alpha) * emaPrev
    out[i] = emaPrev
  }
  return out
}

/** ta.rma —— Wilder 平滑（RSI/ATR 使用），alpha = 1/length，首值同样用 SMA 播种 */
export function rma(src: readonly number[], length: number): number[] {
  const out = new Array<number>(src.length).fill(NA)
  if (length <= 0) return out
  const alpha = 1 / length
  let seed = 0
  let prev = NA
  for (let i = 0; i < src.length; i++) {
    if (i < length) {
      seed += src[i]
      if (i === length - 1) {
        prev = seed / length
        out[i] = prev
      }
      continue
    }
    prev = alpha * src[i] + (1 - alpha) * prev
    out[i] = prev
  }
  return out
}

/** ta.wma —— 线性加权移动平均 */
export function wma(src: readonly number[], length: number): number[] {
  const out = new Array<number>(src.length).fill(NA)
  if (length <= 0) return out
  const denom = (length * (length + 1)) / 2
  for (let i = length - 1; i < src.length; i++) {
    let acc = 0
    for (let k = 0; k < length; k++) {
      acc += src[i - length + 1 + k] * (k + 1)
    }
    out[i] = acc / denom
  }
  return out
}

/* ------------------------------------------------------------------ */
/* rolling highest / lowest                                            */
/* ------------------------------------------------------------------ */

/**
 * ta.highest —— 当前 bar 在内最近 length 根的滚动最大值。
 * 使用单调双端队列，整体 O(n)。
 */
export function highest(src: readonly number[], length: number): number[] {
  return rollingExtreme(src, length, true)
}

/** ta.lowest */
export function lowest(src: readonly number[], length: number): number[] {
  return rollingExtreme(src, length, false)
}

/**
 * ta.pivothigh —— 左 leftbars 根、右 rightbars 根内**严格**最高的点。
 * 与 TradingView 一致：值出现在「右侧窗口走完」的确认 bar 上，取的是 pivot bar 自己的价位。
 */
export function pivothigh(src: readonly number[], leftbars: number, rightbars: number): number[] {
  return pivotExtreme(src, leftbars, rightbars, true)
}

/** ta.pivotlow —— 与 pivothigh 对称 */
export function pivotlow(src: readonly number[], leftbars: number, rightbars: number): number[] {
  return pivotExtreme(src, leftbars, rightbars, false)
}

function pivotExtreme(
  src: readonly number[],
  leftbars: number,
  rightbars: number,
  isMax: boolean,
): number[] {
  const n = src.length
  const out = new Array<number>(n).fill(NA)
  const l = Math.max(0, Math.floor(leftbars))
  const r = Math.max(0, Math.floor(rightbars))
  for (let i = l + r; i < n; i++) {
    const j = i - r
    const v = src[j]
    if (!Number.isFinite(v)) continue
    let ok = true
    // 任一邻居相等即不算 pivot（TradingView 亦按严格不等判定）
    for (let k = j - l; k <= j + r && ok; k++) {
      if (k === j) continue
      const o = src[k]
      if (!Number.isFinite(o) || (isMax ? o >= v : o <= v)) ok = false
    }
    if (ok) out[i] = v
  }
  return out
}

function rollingExtreme(src: readonly number[], length: number, isMax: boolean): number[] {
  const n = src.length
  const out = new Array<number>(n).fill(NA)
  if (length <= 0) return out
  // 双端队列存下标，队列内 src 值单调（max 递减 / min 递增）
  const dq = new Int32Array(n)
  let head = 0
  let tail = 0 // 指向下一个可写位置
  for (let i = 0; i < n; i++) {
    const v = src[i]
    // 弹出队尾不如当前值的元素
    while (tail > head && (isMax ? src[dq[tail - 1]] <= v : src[dq[tail - 1]] >= v)) tail--
    dq[tail++] = i
    // 弹出队首超窗元素
    while (dq[head] <= i - length) head++
    if (i >= length - 1) out[i] = src[dq[head]]
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 百分位（Nearest Rank）                                               */
/* ------------------------------------------------------------------ */

/**
 * ta.percentile_nearest_rank(source, length, percentage)
 *
 * 采用 Nearest-Rank 方法：把窗口内 length 个值升序排列，
 * 取 0-based 下标 `ceil(percentage/100 * length) - 1` 处的值。
 * 例如 length=13、percentage=75 → ceil(9.75)-1 = 9，即第 10 小的值。
 */
export function percentileNearestRank(
  src: readonly number[],
  length: number,
  percentage: number,
): number[] {
  const n = src.length
  const out = new Array<number>(n).fill(NA)
  if (length <= 0) return out

  const rank = Math.max(0, Math.min(length - 1, Math.ceil((percentage / 100) * length) - 1))
  // 维护一个升序数组（窗口内元素），插入/删除用二分 + splice
  const sorted: number[] = []
  const ring = new Array<number>(length).fill(NA)
  let cursor = 0
  let filled = 0

  for (let i = 0; i < n; i++) {
    if (filled === length) {
      const old = ring[cursor]
      const pos = lowerBound(sorted, old)
      if (pos < sorted.length && sorted[pos] === old) sorted.splice(pos, 1)
    }
    const v = src[i]
    ring[cursor] = v
    cursor = (cursor + 1) % length
    if (filled < length) filled++
    const ins = lowerBound(sorted, v)
    sorted.splice(ins, 0, v)
    if (filled === length) out[i] = sorted[rank]
  }
  return out
}

/** 返回第一个 >= target 的下标 */
function lowerBound(arr: readonly number[], target: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/* ------------------------------------------------------------------ */
/* True Range / ATR                                                    */
/* ------------------------------------------------------------------ */

/**
 * ta.tr(true) —— 真实波幅。
 * handlenan=false 时：tr = max(high-low, |high-prevClose|, |low-prevClose|)
 * 第一根 bar 没有 prevClose，Pine 用 high-low。
 */
export function trueRange(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
): number[] {
  const n = high.length
  const out = new Array<number>(n).fill(NA)
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      out[i] = high[i] - low[i]
      continue
    }
    const prevClose = close[i - 1]
    out[i] = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - prevClose),
      Math.abs(low[i] - prevClose),
    )
  }
  return out
}

/** 按指定的平滑方式计算 ATR */
export function atr(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  length: number,
  smoothing: 'RMA' | 'SMA' | 'EMA' | 'WMA' = 'RMA',
): number[] {
  const tr = trueRange(high, low, close)
  switch (smoothing) {
    case 'SMA':
      return sma(tr, length)
    case 'EMA':
      return ema(tr, length)
    case 'WMA':
      return wma(tr, length)
    case 'RMA':
    default:
      return rma(tr, length)
  }
}

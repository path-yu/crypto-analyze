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

/**
 * ta.alma —— Arnaud Legoux 移动平均。
 * m = offset*(length-1)，s = length/sigma，权重为高斯核（按窗口归一化）。
 */
export function alma(
  src: readonly number[],
  length: number,
  offset = 0.85,
  sigma = 6,
): number[] {
  const out = new Array<number>(src.length).fill(NA)
  const len = Math.floor(length)
  if (len <= 0) return out
  const m = offset * (len - 1)
  const s = len / sigma
  const w = new Array<number>(len)
  let norm = 0
  for (let i = 0; i < len; i++) {
    const v = Math.exp(-((i - m) ** 2) / (2 * s * s))
    w[i] = v
    norm += v
  }
  for (let i = len - 1; i < src.length; i++) {
    let acc = 0
    let bad = false
    for (let k = 0; k < len; k++) {
      const v = src[i - len + 1 + k]
      if (isNa(v)) {
        bad = true
        break
      }
      acc += v * w[k]
    }
    if (!bad) out[i] = acc / norm
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

/* ------------------------------------------------------------------ */
/* 交叉 / 一阶差分 / 波动率                                             */
/* ------------------------------------------------------------------ */

/** ta.crossover —— a[0] > b[0] 且 a[1] <= b[1]（任一为 na 记 false） */
export function crossover(a: readonly number[], b: readonly number[]): boolean[] {
  return crossImpl(a, b, true)
}

/** ta.crossunder —— a[0] < b[0] 且 a[1] >= b[1] */
export function crossunder(a: readonly number[], b: readonly number[]): boolean[] {
  return crossImpl(a, b, false)
}

/** ta.cross —— 任意方向的穿越 */
export function cross(a: readonly number[], b: readonly number[]): boolean[] {
  const n = Math.max(a.length, b.length)
  const out = new Array<boolean>(n).fill(false)
  for (let i = 1; i < n; i++) {
    const a0 = a[i]
    const a1 = a[i - 1]
    const b0 = b[i]
    const b1 = b[i - 1]
    if (isNa(a0) || isNa(a1) || isNa(b0) || isNa(b1)) continue
    out[i] = (a0 > b0 && a1 <= b1) || (a0 < b0 && a1 >= b1)
  }
  return out
}

function crossImpl(a: readonly number[], b: readonly number[], up: boolean): boolean[] {
  const n = Math.max(a.length, b.length)
  const out = new Array<boolean>(n).fill(false)
  for (let i = 1; i < n; i++) {
    const a0 = a[i]
    const a1 = a[i - 1]
    const b0 = b[i]
    const b1 = b[i - 1]
    if (isNa(a0) || isNa(a1) || isNa(b0) || isNa(b1)) continue
    out[i] = up ? a0 > b0 && a1 <= b1 : a0 < b0 && a1 >= b1
  }
  return out
}

/** ta.change —— src[0] - src[length]（length 默认 1） */
export function change(src: readonly number[], length = 1): number[] {
  const n = src.length
  const out = new Array<number>(n).fill(NA)
  for (let i = length; i < n; i++) out[i] = src[i] - src[i - length]
  return out
}

/**
 * ta.rising —— 最近 length 根是否严格递增（v4 裸 `rising` 同源）。
 * 任一处出现 na 视为不满足。
 */
export function rising(src: readonly number[], length: number): boolean[] {
  return monotonicImpl(src, length, true)
}

/** ta.falling —— 最近 length 根是否严格递减 */
export function falling(src: readonly number[], length: number): boolean[] {
  return monotonicImpl(src, length, false)
}

function monotonicImpl(src: readonly number[], length: number, up: boolean): boolean[] {
  const n = src.length
  const out = new Array<boolean>(n).fill(false)
  const len = Math.max(1, Math.floor(length))
  for (let i = len; i < n; i++) {
    let ok = true
    for (let k = 0; k < len; k++) {
      const a = src[i - k]
      const b = src[i - k - 1]
      if (isNa(a) || isNa(b) || (up ? a <= b : a >= b)) {
        ok = false
        break
      }
    }
    out[i] = ok
  }
  return out
}

/**
 * ta.stoch / v3 `stoch(series, high, low, length)` —— 随机指标 %K：
 *   100 * (src - lowest(low, len)) / (highest(high, len) - lowest(low, len))
 */
export function stoch(
  src: readonly number[],
  high: readonly number[],
  low: readonly number[],
  length: number,
): number[] {
  const hi = highest(high, length)
  const lo = lowest(low, length)
  const n = src.length
  const out = new Array<number>(n).fill(NA)
  for (let i = 0; i < n; i++) {
    const h = hi[i]
    const l = lo[i]
    if (isNa(h) || isNa(l) || isNa(src[i])) continue
    const range = h - l
    out[i] = range === 0 ? 50 : ((src[i] - l) / range) * 100
  }
  return out
}

/** ta.mom —— 动量：src[0] - src[length]（与 change 同为差分，保留名字以贴合 Pine） */
export function mom(src: readonly number[], length = 10): number[] {
  return change(src, length)
}

/** ta.roc —— 变动率（百分比） */
export function roc(src: readonly number[], length = 10): number[] {
  const n = src.length
  const out = new Array<number>(n).fill(NA)
  for (let i = length; i < n; i++) {
    const prev = src[i - length]
    out[i] = prev === 0 ? NA : ((src[i] - prev) / prev) * 100
  }
  return out
}

/** ta.stdev —— 总体标准差（Pine 默认 biased=true 即除以 n） */
export function stdev(src: readonly number[], length: number, biased = true): number[] {
  const n = src.length
  const out = new Array<number>(n).fill(NA)
  if (length <= 0) return out
  for (let i = length - 1; i < n; i++) {
    let sum = 0
    let bad = false
    for (let k = i - length + 1; k <= i; k++) {
      if (isNa(src[k])) {
        bad = true
        break
      }
      sum += src[k]
    }
    if (bad) continue
    const mean = sum / length
    let acc = 0
    for (let k = i - length + 1; k <= i; k++) acc += (src[k] - mean) ** 2
    out[i] = Math.sqrt(acc / (biased ? length : Math.max(1, length - 1)))
  }
  return out
}

/** ta.variance —— 总体方差 */
export function variance(src: readonly number[], length: number, biased = true): number[] {
  const n = src.length
  const out = new Array<number>(n).fill(NA)
  if (length <= 0) return out
  for (let i = length - 1; i < n; i++) {
    let sum = 0
    let bad = false
    for (let k = i - length + 1; k <= i; k++) {
      if (isNa(src[k])) {
        bad = true
        break
      }
      sum += src[k]
    }
    if (bad) continue
    const mean = sum / length
    let acc = 0
    for (let k = i - length + 1; k <= i; k++) acc += (src[k] - mean) ** 2
    out[i] = acc / (biased ? length : Math.max(1, length - 1))
  }
  return out
}

/** ta.dev —— 平均绝对偏差 */
export function dev(src: readonly number[], length: number): number[] {
  const n = src.length
  const out = new Array<number>(n).fill(NA)
  if (length <= 0) return out
  for (let i = length - 1; i < n; i++) {
    let sum = 0
    let bad = false
    for (let k = i - length + 1; k <= i; k++) {
      if (isNa(src[k])) {
        bad = true
        break
      }
      sum += src[k]
    }
    if (bad) continue
    const mean = sum / length
    let acc = 0
    for (let k = i - length + 1; k <= i; k++) acc += Math.abs(src[k] - mean)
    out[i] = acc / length
  }
  return out
}

/* ------------------------------------------------------------------ */
/* RSI / HMA                                                           */
/* ------------------------------------------------------------------ */

/** na 感知的 Wilder 平滑（前段 na 不参与累计） */
function rmaSkipNa(src: readonly number[], length: number): number[] {
  const out = new Array<number>(src.length).fill(NA)
  if (length <= 0) return out
  const alpha = 1 / length
  let count = 0
  let seed = 0
  let prev = NA
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    if (isNa(v)) continue
    if (count < length) {
      seed += v
      count++
      if (count === length) {
        prev = seed / length
        out[i] = prev
      }
      continue
    }
    prev = alpha * v + (1 - alpha) * prev
    out[i] = prev
  }
  return out
}

/** ta.rsi —— 相对强弱指标（Wilder 平滑，与 Pine 一致） */
export function rsi(src: readonly number[], length: number): number[] {
  const n = src.length
  const ups = new Array<number>(n).fill(NA)
  const downs = new Array<number>(n).fill(NA)
  for (let i = 1; i < n; i++) {
    const d = src[i] - src[i - 1]
    if (isNa(d)) continue
    ups[i] = Math.max(d, 0)
    downs[i] = Math.max(-d, 0)
  }
  const ru = rmaSkipNa(ups, length)
  const rd = rmaSkipNa(downs, length)
  const out = new Array<number>(n).fill(NA)
  for (let i = 0; i < n; i++) {
    if (isNa(ru[i]) || isNa(rd[i])) continue
    out[i] = rd[i] === 0 ? 100 : 100 - 100 / (1 + ru[i] / rd[i])
  }
  return out
}

/**
 * ta.hma —— Hull 移动平均：wma(2*wma(src, n/2) - wma(src, n), sqrt(n))。
 * 内层 wma 的前段为 na，外层按第一个有效值切片计算后回填（避免 na 污染整条序列）。
 */
export function hma(src: readonly number[], length: number): number[] {
  const n = src.length
  const out = new Array<number>(n).fill(NA)
  const half = Math.max(1, Math.floor(length / 2))
  const sqrtLen = Math.max(1, Math.round(Math.sqrt(length)))
  const a = wma(src, half)
  const b = wma(src, length)
  const diff = a.map((v, i) => (isNa(v) || isNa(b[i]) ? NA : 2 * v - b[i]))
  const start = diff.findIndex((v) => !isNa(v))
  if (start < 0) return out
  const tail = wma(diff.slice(start), sqrtLen)
  for (let i = 0; i < tail.length; i++) out[start + i] = tail[i]
  return out
}

/* ------------------------------------------------------------------ */
/* 线性回归 / 条件序列 / SuperTrend / SAR                                */
/* ------------------------------------------------------------------ */

/**
 * ta.mfi —— 资金流量指数：100 - 100/(1 + 正向资金流/负向资金流)。
 * 资金流 = hlc3 * volume，正负按 hlc3 与上一根的涨跌切分，各自做 RMA 平滑。
 */
export function mfi(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  volume: readonly number[],
  length: number,
): number[] {
  const n = high.length
  const pos = new Array<number>(n).fill(NA)
  const neg = new Array<number>(n).fill(NA)
  for (let i = 1; i < n; i++) {
    const hlc3 = (high[i] + low[i] + close[i]) / 3
    const prev = (high[i - 1] + low[i - 1] + close[i - 1]) / 3
    const flow = hlc3 * volume[i]
    if (isNa(flow) || isNa(prev)) continue
    pos[i] = hlc3 > prev ? flow : 0
    neg[i] = hlc3 < prev ? flow : 0
  }
  const rp = rmaSkipNa(pos, length)
  const rn = rmaSkipNa(neg, length)
  const out = new Array<number>(n).fill(NA)
  for (let i = 0; i < n; i++) {
    if (isNa(rp[i]) || isNa(rn[i])) continue
    out[i] = rn[i] === 0 ? 100 : 100 - 100 / (1 + rp[i] / rn[i])
  }
  return out
}

/**
 * ta.linreg —— 最近 length 根的最小二乘拟合在 offset 处的取值。
 * x 取 0..length-1，返回值 = intercept + slope * (length - 1 - offset)（与 TradingView 一致）。
 */
export function linreg(src: readonly number[], length: number, offset = 0): number[] {
  const n = src.length
  const out = new Array<number>(n).fill(NA)
  const len = Math.floor(length)
  if (len <= 0) return out
  const off = Math.floor(offset)
  for (let i = len - 1; i < n; i++) {
    let sumX = 0
    let sumY = 0
    let sumXY = 0
    let sumX2 = 0
    let bad = false
    for (let k = 0; k < len; k++) {
      const y = src[i - len + 1 + k]
      if (isNa(y)) {
        bad = true
        break
      }
      sumX += k
      sumY += y
      sumXY += k * y
      sumX2 += k * k
    }
    if (bad) continue
    const denom = len * sumX2 - sumX * sumX
    const slope = denom === 0 ? 0 : (len * sumXY - sumX * sumY) / denom
    const intercept = (sumY - slope * sumX) / len
    out[i] = intercept + slope * (len - 1 - off)
  }
  return out
}

/** 条件序列的真值判定：na / 0 / false 视为假 */
function truthy(v: number | boolean | null | undefined): boolean {
  if (typeof v === 'boolean') return v
  return typeof v === 'number' && Number.isFinite(v) && v !== 0
}

/** ta.barssince —— 距 cond 上次为真的 bar 数（从未为真为 na，当前为真为 0） */
export function barssince(cond: readonly (number | boolean)[]): number[] {
  const n = cond.length
  const out = new Array<number>(n).fill(NA)
  let last = -1
  for (let i = 0; i < n; i++) {
    if (truthy(cond[i])) last = i
    if (last >= 0) out[i] = i - last
  }
  return out
}

/**
 * ta.valuewhen —— cond 第 occurrence 次为真时的 src 值（occurrence=0 为最近一次）。
 * 参数顺序按内部约定 `(src, cond, occurrence)`，便于复用 seriesAt 包装器。
 */
export function valuewhen(
  src: readonly number[],
  cond: readonly (number | boolean)[],
  occurrence = 0,
): number[] {
  // 参数未解析成序列（标量）时直接返回 na，避免 `new Array(NaN)` 抛 RangeError
  if (!Array.isArray(src) || !Array.isArray(cond)) return []
  const n = Math.max(src.length, cond.length)
  const out = new Array<number>(n).fill(NA)
  const hits: number[] = []
  const occ = Math.max(0, Math.floor(occurrence))
  for (let i = 0; i < n; i++) {
    if (truthy(cond[i])) hits.push(i)
    const idx = hits.length - 1 - occ
    if (idx >= 0) out[i] = src[hits[idx]]
  }
  return out
}

/**
 * ta.supertrend —— 返回 [supertrend, direction]（direction：-1 = 上升趋势，1 = 下降趋势），
 * 与 TradingView 的 ta.supertrend 输出顺序一致。
 */
export function supertrend(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  factor: number,
  atrPeriod: number,
): [number[], number[]] {
  const n = high.length
  const atrArr = atr(high, low, close, atrPeriod, 'RMA')
  const st = new Array<number>(n).fill(NA)
  const dir = new Array<number>(n).fill(NA)
  let upperPrev = NA
  let lowerPrev = NA
  let stPrev = NA
  for (let i = 0; i < n; i++) {
    const mid = (high[i] + low[i]) / 2
    const a = atrArr[i]
    let upper = mid + factor * a
    let lower = mid - factor * a
    if (i > 0) {
      if (!(lower > lowerPrev || close[i - 1] < lowerPrev)) lower = lowerPrev
      if (!(upper < upperPrev || close[i - 1] > upperPrev)) upper = upperPrev
    }
    let d: number
    if (i === 0 || isNa(atrArr[i - 1])) d = 1
    else if (stPrev === upperPrev) d = close[i] > upper ? -1 : 1
    else d = close[i] < lower ? 1 : -1
    const value = d === -1 ? lower : upper
    st[i] = value
    dir[i] = d
    upperPrev = upper
    lowerPrev = lower
    stPrev = value
  }
  return [st, dir]
}

/**
 * ta.dmi —— 返回 [+DI, -DI, ADX]（与 TradingView 的 ta.dmi 输出顺序一致）。
 */
export function dmi(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  diLength: number,
  adxSmoothing: number,
): [number[], number[], number[]] {
  const n = high.length
  const plusDM = new Array<number>(n).fill(NA)
  const minusDM = new Array<number>(n).fill(NA)
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1]
    const down = low[i - 1] - low[i]
    plusDM[i] = up > down && up > 0 ? up : 0
    minusDM[i] = down > up && down > 0 ? down : 0
  }
  const trur = rmaSkipNa(trueRange(high, low, close), diLength)
  const ru = rmaSkipNa(plusDM, diLength)
  const rd = rmaSkipNa(minusDM, diLength)
  const plus = new Array<number>(n).fill(NA)
  const minus = new Array<number>(n).fill(NA)
  const dx = new Array<number>(n).fill(NA)
  for (let i = 0; i < n; i++) {
    if (isNa(trur[i]) || trur[i] === 0 || isNa(ru[i]) || isNa(rd[i])) continue
    plus[i] = (100 * ru[i]) / trur[i]
    minus[i] = (100 * rd[i]) / trur[i]
    const sum = plus[i] + minus[i]
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plus[i] - minus[i])) / sum
  }
  const adx = rmaSkipNa(dx, adxSmoothing)
  return [plus, minus, adx]
}

/** ta.sar —— 抛物线转向（Parabolic SAR）标准实现 */
export function sar(
  high: readonly number[],
  low: readonly number[],
  start: number,
  inc: number,
  max: number,
): number[] {
  const n = high.length
  const out = new Array<number>(n).fill(NA)
  let af = start
  let ep = high[0] ?? NA
  let isLong = true
  let prevSar = low[0] ?? NA
  for (let i = 0; i < n; i++) {
    let sarV = i === 0 ? low[i] : prevSar + af * (ep - prevSar)
    if (isLong) {
      if (i > 0) sarV = Math.min(sarV, low[i - 1], i > 1 ? low[i - 2] : low[i - 1])
      if (low[i] < sarV) {
        isLong = false
        sarV = ep
        ep = low[i]
        af = start
      } else if (high[i] > ep) {
        ep = high[i]
        af = Math.min(af + inc, max)
      }
    } else {
      if (i > 0) sarV = Math.max(sarV, high[i - 1], i > 1 ? high[i - 2] : high[i - 1])
      if (high[i] > sarV) {
        isLong = true
        sarV = ep
        ep = high[i]
        af = start
      } else if (low[i] < ep) {
        ep = low[i]
        af = Math.min(af + inc, max)
      }
    }
    out[i] = sarV
    prevSar = sarV
  }
  return out
}

/* ------------------------------------------------------------------ */
/* MACD                                                                */
/* ------------------------------------------------------------------ */

/**
 * ta.macd 的 na 感知 EMA：跳过源序列里的 na（Pine 的 ta.ema 同样忽略 na），
 * 使 `ema(macdLine, signalLength)` 在 macdLine 前段为 na 时仍能正常起步。
 */
function emaSkipNa(src: readonly number[], length: number): number[] {
  const out = new Array<number>(src.length).fill(NA)
  if (length <= 0) return out
  const alpha = 2 / (length + 1)
  let count = 0
  let seed = 0
  let prev = NA
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    if (isNa(v)) continue
    if (count < length) {
      seed += v
      count++
      if (count === length) {
        prev = seed / length
        out[i] = prev
      }
      continue
    }
    prev = alpha * v + (1 - alpha) * prev
    out[i] = prev
  }
  return out
}

/**
 * ta.macd —— 返回 [macdLine, signalLine, histLine]。
 * macdLine = ema(src, fast) - ema(src, slow)；signal = ema(macdLine, signal)；
 * hist = macdLine - signal（与 TradingView 的 ta.macd 输出顺序一致）。
 */
export function macd(
  src: readonly number[],
  fastLength: number,
  slowLength: number,
  signalLength: number,
): [number[], number[], number[]] {
  const fast = ema(src, fastLength)
  const slow = ema(src, slowLength)
  const macdLine = fast.map((v, i) => (isNa(v) || isNa(slow[i]) ? NA : v - slow[i]))
  const signalLine = emaSkipNa(macdLine, signalLength)
  const histLine = macdLine.map((v, i) => (isNa(v) || isNa(signalLine[i]) ? NA : v - signalLine[i]))
  return [macdLine, signalLine, histLine]
}

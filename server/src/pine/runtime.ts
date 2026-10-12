/**
 * Pine Script 运行时 —— 注入 vm 沙箱的 `__pine` 对象。
 *
 * 设计原则（方案 §3 / §5.4）：
 *   · **脚本是信号的唯一来源**：运行时只提供 Pine 内置语义（na、比较、ta.*、
 *     math/str/color/input/box/label…），不做任何撮合；
 *   · **产物零 import**：编译生成的 TS 只依赖本文件暴露的 `__pine`。
 */

import type { Candle } from '../../../shared/types'
import * as taLib from '../indicators/ta'

/* ------------------------------------------------------------------ */
/* na 与比较                                                           */
/* ------------------------------------------------------------------ */

/** Pine 的 `na`：null / undefined / NaN 都视为 na */
export function isNa(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))
}

/** `nz(x)` / `nz(x, y)`：na 时回落到 y（默认 0） */
export function nz(v: unknown, fallback = 0): number {
  return typeof v === 'number' && !Number.isNaN(v) ? v : fallback
}

/** Pine 的比较运算符在任一操作数为 na 时恒为 false */
const eq = (a: unknown, b: unknown): boolean => (isNa(a) || isNa(b) ? false : a === b)
const neq = (a: unknown, b: unknown): boolean => (isNa(a) || isNa(b) ? false : a !== b)
const lt = (a: unknown, b: unknown): boolean =>
  isNa(a) || isNa(b) ? false : (a as number) < (b as number)
const le = (a: unknown, b: unknown): boolean =>
  isNa(a) || isNa(b) ? false : (a as number) <= (b as number)
const gt = (a: unknown, b: unknown): boolean =>
  isNa(a) || isNa(b) ? false : (a as number) > (b as number)
const ge = (a: unknown, b: unknown): boolean =>
  isNa(a) || isNa(b) ? false : (a as number) >= (b as number)

/* ------------------------------------------------------------------ */
/* 历史引用 / 环形缓冲                                                  */
/* ------------------------------------------------------------------ */

/** 序列历史引用：`arr[index - k]`，越界返回 na */
export function at(arr: readonly unknown[], index: number, k: number): unknown {
  const j = index - k
  return j >= 0 && j < arr.length ? arr[j] : Number.NaN
}

export interface Ring {
  buf: unknown[]
  cap: number
  n: number
}

/** 创建环形缓冲（容量 = 最大引用深度 + 1） */
export function makeRing(cap: number): Ring {
  const size = Math.max(1, cap | 0)
  return { buf: new Array(size).fill(Number.NaN), cap: size, n: 0 }
}

/** 每根 K 线推入一个当前值 */
export function push(ring: Ring, v: unknown): void {
  ring.buf[ring.n % ring.cap] = v
  ring.n++
}

/** 读 `ring[k]`：k=0 为当前值，越界返回 na */
export function hist(ring: Ring, k: number): unknown {
  if (!(k >= 0) || k >= ring.n) return Number.NaN
  return ring.buf[(ring.n - 1 - k) % ring.cap]
}

/* ------------------------------------------------------------------ */
/* 数组助手（Pine 的 array.* 方法）                                     */
/* ------------------------------------------------------------------ */

export function arrRemove(arr: unknown[], i: number): void {
  if (i >= 0 && i < arr.length) arr.splice(i, 1)
}

export function arrClear(arr: unknown[]): void {
  arr.length = 0
}

/* ------------------------------------------------------------------ */
/* 颜色                                                                */
/* ------------------------------------------------------------------ */

const NAMED_COLORS: Record<string, string> = {
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  white: '#ffffff',
  black: '#000000',
  gray: '#808080',
  grey: '#808080',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  lime: '#00ff00',
  aqua: '#00ffff',
  fuchsia: '#ff00ff',
  maroon: '#800000',
  navy: '#000080',
  olive: '#808000',
  silver: '#c0c0c0',
  teal: '#008080',
}

function toRgbHex(c: unknown): string | null {
  if (typeof c !== 'string') return null
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase()
  if (/^#[0-9a-fA-F]{8}$/.test(c)) return c.slice(0, 7).toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`.toLowerCase()
  }
  return NAMED_COLORS[c.toLowerCase()] ?? null
}

/** `color.new(c, transp)`：透明度 0（不透明）～100（全透明） */
function newColor(c: unknown, transp = 0): string {
  const rgb = toRgbHex(c)
  if (!rgb) return typeof c === 'string' ? c : '#00000000'
  const t = Number.isFinite(transp) ? Math.max(0, Math.min(100, transp as number)) : 0
  const alpha = Math.round(((100 - t) / 100) * 255)
  return rgb + alpha.toString(16).padStart(2, '0')
}

/** `color.rgb(r, g, b, transp?)` */
function rgb(r: number, g: number, b: number, transp = 0): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(Number.isFinite(v) ? v : 0)))
  const alpha = Math.round(((100 - Math.max(0, Math.min(100, transp))) / 100) * 255)
  const hex = (v: number) => clamp(v).toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(b)}${alpha.toString(16).padStart(2, '0')}`
}

/** `color.from_gradient` 等低频 API 的占位（返回中性灰） */
function fromGradient(): string {
  return '#808080ff'
}

/* ------------------------------------------------------------------ */
/* 字符串                                                              */
/* ------------------------------------------------------------------ */

/** `format.mintick` 的哨兵值 —— 由 str.tostring 解析为按 mintick 精度格式化 */
const MINTICK = '__pine_format_mintick__'

function mintickDigits(tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return 8
  if (tickSize >= 1) return 0
  return Math.min(12, Math.max(0, Math.ceil(-Math.log10(tickSize))))
}

/* ------------------------------------------------------------------ */
/* 运行时工厂                                                          */
/* ------------------------------------------------------------------ */

export interface PineRuntimeOptions {
  /** 覆盖 input.* 默认值的输入项（键 = 顶层变量名） */
  inputs?: Record<string, unknown>
  /** syminfo.mintick（下单精度），由请求的 tickSize 注入 */
  tickSize?: number
}

export interface PineRuntime {
  candles: {
    open: number[]
    high: number[]
    low: number[]
    close: number[]
    volume: number[]
    timestamp: number[]
  }
  ctx: { mintick: number }
  na: typeof isNa
  isNa: typeof isNa
  nz: typeof nz
  eq: typeof eq
  neq: typeof neq
  lt: typeof lt
  le: typeof le
  gt: typeof gt
  ge: typeof ge
  at: typeof at
  makeRing: typeof makeRing
  push: typeof push
  hist: typeof hist
  arrRemove: typeof arrRemove
  arrClear: typeof arrClear
  ta: typeof taLib
  math: Record<string, unknown>
  str: { tostring: (v: unknown, fmt?: unknown) => string }
  color: Record<string, unknown>
  input: Record<string, (name: string, def: unknown, opts?: unknown) => unknown>
  chart: { fg_color: string; bg_color: string }
  format: { mintick: string; price: string; percent: string; volume: string }
  session: { isfirstbar: boolean; islastbar: boolean }
  syminfo: { mintick: number }
  plot: (store: Record<string, unknown[]>, series: unknown, title: string, index: number) => void
  mark: (
    markers: unknown[],
    series: unknown,
    title: string,
    location: string,
    index: number,
  ) => void
  barColor: (store: unknown[], color: unknown, index: number) => void
  box: Record<string, (...args: unknown[]) => unknown>
  label: Record<string, (...args: unknown[]) => unknown>
}

/**
 * 依据 K 线构造一份运行时。
 *
 * 每次编译产物执行前都新建一份，保证 `plots/markers/barColor` 等图元状态互不串扰。
 */
export function createRuntime(
  candles: readonly Candle[],
  opts: PineRuntimeOptions = {},
): PineRuntime {
  const inputs = opts.inputs ?? {}
  const tick = Number.isFinite(opts.tickSize) ? (opts.tickSize as number) : 0
  const digits = mintickDigits(tick)

  const n = candles.length
  const open = new Array<number>(n)
  const high = new Array<number>(n)
  const low = new Array<number>(n)
  const close = new Array<number>(n)
  const volume = new Array<number>(n)
  const timestamp = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    const c = candles[i]
    open[i] = c.open
    high[i] = c.high
    low[i] = c.low
    close[i] = c.close
    volume[i] = c.volume
    timestamp[i] = c.timestamp
  }

  const pick = (name: string, def: unknown): unknown =>
    name in inputs && inputs[name] !== undefined ? inputs[name] : def

  const inputNs: PineRuntime['input'] = {
    int: (name, def) => {
      const v = pick(name, def)
      const num = typeof v === 'string' ? Number(v) : v
      return typeof num === 'number' && Number.isFinite(num) ? Math.trunc(num) : def
    },
    float: (name, def) => {
      const v = pick(name, def)
      const num = typeof v === 'string' ? Number(v) : v
      return typeof num === 'number' && Number.isFinite(num) ? num : def
    },
    bool: (name, def) => {
      const v = pick(name, def)
      if (typeof v === 'boolean') return v
      if (typeof v === 'string') return v.toLowerCase() === 'true'
      if (typeof v === 'number') return v !== 0
      return def
    },
    color: (name, def) => pick(name, def),
    string: (name, def) => {
      const v = pick(name, def)
      return typeof v === 'string' ? v : def
    },
    source: (name, def) => pick(name, def),
    time: (name, def) => pick(name, def),
  }

  const mathNs: Record<string, unknown> = {
    abs: Math.abs,
    max: Math.max,
    min: Math.min,
    round: (v: number, precision = 0) => {
      const p = Math.pow(10, precision)
      return Math.round(v * p) / p
    },
    floor: Math.floor,
    ceil: Math.ceil,
    pow: Math.pow,
    sqrt: Math.sqrt,
    sign: Math.sign,
    log: Math.log,
    log10: Math.log10,
    exp: Math.exp,
    todegrees: (r: number) => (r * 180) / Math.PI,
    toradians: (d: number) => (d * Math.PI) / 180,
    avg: (...xs: number[]) => (xs.length ? xs.reduce((a, b) => a + nz(b), 0) / xs.length : Number.NaN),
    sum: (...xs: number[]) => xs.reduce((a, b) => a + nz(b), 0),
  }

  const colorNs: Record<string, unknown> = {
    new: newColor,
    rgb,
    from_gradient: fromGradient,
    red: NAMED_COLORS.red,
    green: NAMED_COLORS.green,
    blue: NAMED_COLORS.blue,
    white: NAMED_COLORS.white,
    black: NAMED_COLORS.black,
    gray: NAMED_COLORS.gray,
    yellow: NAMED_COLORS.yellow,
    orange: NAMED_COLORS.orange,
    purple: NAMED_COLORS.purple,
    lime: NAMED_COLORS.lime,
    aqua: NAMED_COLORS.aqua,
    fuchsia: NAMED_COLORS.fuchsia,
    maroon: NAMED_COLORS.maroon,
    navy: NAMED_COLORS.navy,
    olive: NAMED_COLORS.olive,
    silver: NAMED_COLORS.silver,
    teal: NAMED_COLORS.teal,
  }

  // box / label：执行但不影响回测的存根（方案 §9.6）。
  // 构造函数返回不透明对象，`set_*` 全部为空操作，`delete` 同样无副作用 ——
  // 保证脚本忠实执行（`not na(bx)` 判定仍成立），又不影响回测。
  const noop = (): undefined => undefined
  const stubNs = (): Record<string, (...args: unknown[]) => unknown> => {
    const ns: Record<string, (...args: unknown[]) => unknown> = { new: () => ({}), delete: noop }
    for (const key of [
      'set_left',
      'set_right',
      'set_top',
      'set_bottom',
      'set_lefttop',
      'set_rightbottom',
      'set_xy',
      'set_x',
      'set_y',
      'set_bgcolor',
      'set_border_color',
      'set_border_width',
      'set_text',
      'set_textcolor',
      'set_text_color',
      'set_text_size',
      'set_style',
      'set_color',
      'set_size',
      'set_tooltip',
      'set_text_align',
      'copy',
    ]) {
      ns[key] = noop
    }
    return ns
  }
  const boxNs = stubNs()
  const labelNs = stubNs()

  return {
    candles: { open, high, low, close, volume, timestamp },
    ctx: { mintick: tick },
    na: isNa,
    isNa,
    nz,
    eq,
    neq,
    lt,
    le,
    gt,
    ge,
    at,
    makeRing,
    push,
    hist,
    arrRemove,
    arrClear,
    ta: taLib,
    math: mathNs,
    str: {
      tostring: (v: unknown, fmt?: unknown): string => {
        if (isNa(v)) return 'NaN'
        if (typeof v === 'string') return v
        if (typeof v === 'boolean') return v ? 'true' : 'false'
        const num = v as number
        if (fmt === MINTICK) {
          const d = digits
          return d > 0 ? num.toFixed(d) : String(num)
        }
        if (typeof fmt === 'string' && fmt.startsWith('#.')) {
          const d = Number(fmt.slice(2))
          if (Number.isFinite(d)) return num.toFixed(d)
        }
        return String(num)
      },
    },
    color: colorNs,
    input: inputNs,
    chart: { fg_color: '#131722', bg_color: '#ffffff' },
    format: { mintick: MINTICK, price: MINTICK, percent: '#.##%', volume: '#.##' },
    session: { isfirstbar: false, islastbar: false },
    syminfo: { mintick: tick },
    plot: (store, series, title, index) => {
      let arr = store[title]
      if (!arr) {
        arr = new Array<unknown>(n).fill(Number.NaN)
        store[title] = arr
      }
      arr[index] = series
    },
    mark: (markers, series, title, location, index) => {
      if (isNa(series)) return
      markers.push({ index, title, location, value: series })
    },
    barColor: (store, color, index) => {
      store[index] = color
    },
    box: boxNs,
    label: labelNs,
  }
}
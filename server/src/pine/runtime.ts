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

/**
 * 统一下标历史读取：容器既可以是整条数组（内置序列 / 预计算数组），
 * 也可以是环形缓冲（逐 bar 标量）。用于用户函数形参的历史引用透传。
 */
export function histOf(container: unknown, index: number, k: number): unknown {
  if (Array.isArray(container)) return at(container, index, k)
  if (container && typeof container === 'object' && 'buf' in (container as Record<string, unknown>)) {
    return hist(container as Ring, k)
  }
  return Number.NaN
}

/** 时间的 UTC 分量（timestamp / dayofweek 共用） */
function utcParts(ms: number): { y: number; mo: number; d: number; h: number; wd: number } {
  const t = new Date(ms)
  return {
    y: t.getUTCFullYear(),
    mo: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    h: t.getUTCHours(),
    wd: t.getUTCDay(),
  }
}

/**
 * Pine 的 `dayofweek(time)` / `dayofweek(dayofweek, timezone)`：
 * 返回 1（周日）..7（周六）。
 */
export function dayOfWeekOf(...args: unknown[]): number {
  const first = args[0]
  if (typeof first === 'number') return utcParts(first).wd + 1
  const ms = args.find((a) => typeof a === 'number')
  if (typeof ms === 'number') return utcParts(ms).wd + 1
  return Number.NaN
}

/** `year(time)` / `month(time)` / `hour(time)` … 一族日期分量（v5 起为 `year(time)` 形式） */
export function timePartOf(part: string, ...args: unknown[]): number {
  const ms = args.find((a) => typeof a === 'number')
  if (typeof ms !== 'number') return Number.NaN
  const p = utcParts(ms)
  switch (part) {
    case 'year':
      return p.y
    case 'month':
      return p.mo
    case 'dayofmonth':
      return p.d
    case 'hour':
      return p.h
    case 'minute':
      return new Date(ms).getUTCMinutes()
    case 'second':
      return new Date(ms).getUTCSeconds()
    case 'dayofweek':
      return p.wd + 1
    case 'weekofyear': {
      const start = Date.UTC(p.y, 0, 1)
      return Math.floor((ms - start) / (7 * 86_400_000)) + 1
    }
    default:
      return Number.NaN
  }
}

/**
 * 逐 bar 标量的序列写入：把当前 bar 的值写到下标 `i`（中间缺位补 na）。
 * 保证 `arr[i] ≡ bar i 的值`，这样数组可以当作真正的序列交给 `*At` 变体计算。
 */
export function serSet(arr: unknown[], i: number, v: unknown): void {
  if (!(i >= 0)) return
  while (arr.length < i) arr.push(Number.NaN)
  arr[i] = v
}

/**
 * Pine 的 `timestamp()`：位置参数 (年, 月, 日[, 时, 分, 秒]) 或单个日期字符串。
 * 年/月/日按 UTC 解释（回测窗口比较用，与交易所时区存在整小时级偏差，已记入文档）。
 * 以 `pine` 前缀命名，避免与 createRuntime 内的 K 线时间戳数组同名。
 */
export function pineTimestamp(...args: unknown[]): number {
  if (args.length === 1 && typeof args[0] === 'string') {
    const t = Date.parse(args[0])
    return Number.isFinite(t) ? t : Number.NaN
  }
  const nums = args.map((a) => Number(a))
  const y = nums[0]
  const mo = nums[1]
  const d = nums[2]
  const h = nums[3] ?? 0
  const mi = nums[4] ?? 0
  const s = nums[5] ?? 0
  if (![y, mo, d, h, mi, s].every((v) => Number.isFinite(v))) return Number.NaN
  return Date.UTC(y, mo - 1, d, h, mi, s)
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

/**
 * Pine 周期文本 → 秒。
 *
 * 约定与 TradingView 一致：纯数字表示**分钟**（"60" = 1 小时），
 * 另有 "15S"（秒）、"4h"（小时）、"1D"（日）、"1W"（周）、"1M"（月，大写）。
 * 解析失败时回落到 fallback（通常是当前图表周期）。
 */
function timeframeTextToSeconds(text: unknown, fallbackSec: number): number {
  const raw = String(text ?? '').trim()
  if (!raw) return fallbackSec
  const m = /^(\d*)([smhdwSMDW])?$/.exec(raw)
  if (!m) return fallbackSec
  const mult = m[1] ? Number(m[1]) : 1
  const unit = m[2]
  if (!unit) return mult * 60
  const unitSec: Record<string, number> = {
    s: 1,
    S: 1,
    m: 60,
    h: 3600,
    d: 86400,
    D: 86400,
    w: 604800,
    W: 604800,
    M: 2592000,
  }
  const sec = unitSec[unit]
  return sec === undefined ? fallbackSec : mult * sec
}

/** 秒 → Pine 周期文本，与 timeframeTextToSeconds 可往返 */
function secondsToTimeframeText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (!Number.isFinite(s) || s <= 0) return '1'
  if (s % 2592000 === 0) return `${s / 2592000}M`
  if (s % 604800 === 0) return `${s / 604800}W`
  if (s % 86400 === 0) return `${s / 86400}D`
  if (s < 60) return `${s}S`
  return `${Math.round(s / 60)}`
}

/* ------------------------------------------------------------------ */
/* 运行时工厂                                                          */
/* ------------------------------------------------------------------ */

export interface PineRuntimeOptions {
  /** 覆盖 input.* 默认值的输入项（键 = 顶层变量名） */
  inputs?: Record<string, unknown>
  /** syminfo.mintick（下单精度），由请求的 tickSize 注入 */
  tickSize?: number
  /** 当前 K 线周期（如 '1h'），供 timeframe.period 读取 */
  timeframe?: string
}

/** `*At` 变体的统一签名：序列参数用整条数组传入，另给当前 bar 下标 */
type AtFn = (...args: never[]) => unknown

/**
 * 交叉的「直接取值」签名：`(当前A, 上一根A, 当前B, 上一根B) => boolean`。
 * 用于操作数拿不到整条序列的场景（`var` 变量、条件赋值的顶层标量），
 * 由生成代码先用环形缓冲取出四个数值再判定穿越。
 */
export type CrossValsFn = (
  curA: unknown,
  prevA: unknown,
  curB: unknown,
  prevB: unknown,
) => boolean

/**
 * 「多序列 → 元组/序列」的 ta 函数，返回第 tupleIdx 项在当前 bar 的取值。
 * 供 dmi / mfi 这类固定以内置 OHLC(V) 为源的函数复用。
 */
function atOfTuple(
  fn: (...args: never[]) => readonly (number | boolean)[] | readonly (number | boolean)[][],
  seriesArgs: unknown[],
  index: number,
  scalarArgs: number[],
  tupleIdx: number,
): unknown {
  if (!Number.isFinite(index) || index < 0) return Number.NaN
  if (!seriesArgs.every((a) => Array.isArray(a))) return Number.NaN
  const i = Math.floor(index)
  const sliced = seriesArgs.map((a) => (a as number[]).slice(0, i + 1))
  const res = (fn as (...a: unknown[]) => unknown)(...sliced, ...scalarArgs)
  const arr = Array.isArray(res) && tupleIdx > 0 ? (res as unknown[])[tupleIdx] : res
  if (!Array.isArray(arr)) return Number.NaN
  return i < arr.length ? (arr as number[])[i] : Number.NaN
}

/**
 * `ta.*` 的「当前 bar 标量」变体集合（codegen 在 `step` 内调用）。
 *
 * 序列参数为整条数组（内置序列 / 预计算数组 / 逐 bar 标量跟踪数组），
 * 第二个参数固定为当前 bar 下标，之后是该函数的其余标量参数。
 */
export interface TaAtFns {
  smaAt: AtFn
  emaAt: AtFn
  rmaAt: AtFn
  wmaAt: AtFn
  highestAt: AtFn
  lowestAt: AtFn
  hmaAt: AtFn
  almaAt: AtFn
  rsiAt: AtFn
  changeAt: AtFn
  momAt: AtFn
  rocAt: AtFn
  stdevAt: AtFn
  varianceAt: AtFn
  devAt: AtFn
  risingAt: AtFn
  fallingAt: AtFn
  stochAt: AtFn
  linregAt: AtFn
  barssinceAt: AtFn
  valuewhenAt: AtFn
  sarAt: AtFn
  dmiAt: AtFn
  mfiAt: AtFn
  pivothighAt: AtFn
  pivotlowAt: AtFn
  atrAt: AtFn
  trAt: AtFn
  crossoverAt: AtFn
  crossunderAt: AtFn
  crossAt: AtFn
  /** 直接给「当前/上一根」四个数值的交叉判断（见 CrossValsFn） */
  crossoverVals: CrossValsFn
  crossunderVals: CrossValsFn
  crossVals: CrossValsFn
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
  histOf: typeof histOf
  serSet: typeof serSet
  timestamp: typeof pineTimestamp
  dayofweek: typeof dayOfWeekOf
  timePart: typeof timePartOf
  arrRemove: typeof arrRemove
  arrClear: typeof arrClear
  ta: typeof taLib & TaAtFns
  math: Record<string, unknown>
  str: Record<string, (...args: never[]) => unknown>
  color: Record<string, unknown>
  input: Record<string, (name: string, def: unknown, opts?: unknown) => unknown>
  chart: { fg_color: string; bg_color: string }
  format: { mintick: string; price: string; percent: string; volume: string }
  session: { isfirstbar: boolean; islastbar: boolean }
  timeframe: {
    period: string
    multiplier: number
    isseconds: boolean
    isintraday: boolean
    isminutes: boolean
    isdaily: boolean
    isweekly: boolean
    ismonthly: boolean
    /** 不传参取当前周期秒数；传入周期文本（"240" / "1D"…）取该周期的秒数 */
    in_seconds: (tf?: unknown) => number
    /** 秒数 → 周期文本（与 in_seconds 可往返） */
    from_seconds: (seconds: unknown) => string
  }
  syminfo: { mintick: number } & Record<string, unknown>
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
  line: Record<string, (...args: unknown[]) => unknown>
  table: Record<string, (...args: unknown[]) => unknown>
  polyline: Record<string, (...args: unknown[]) => unknown>
  linefill: Record<string, (...args: unknown[]) => unknown>
  array: Record<string, (...args: unknown[]) => unknown>
  matrix: Record<string, (...args: never[]) => unknown>
  cast: Record<string, (v: unknown) => unknown>
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
  // timeframe.*：period 用请求里的真实周期，衍生字段按同一份周期换算
  const tfText = opts.timeframe && opts.timeframe.trim() ? opts.timeframe.trim() : '1h'
  const tfSec = timeframeTextToSeconds(tfText, 3600)
  const tfMatch = /^(\d*)([smhdwSMDW])?$/.exec(tfText)
  const tfUnitRaw = tfMatch?.[2] ?? ''
  const tfMult = tfMatch?.[1] ? Number(tfMatch[1]) : 1
  const timeframeNs = {
    period: tfText,
    multiplier: tfMult,
    isseconds: tfUnitRaw === 's' || tfUnitRaw === 'S',
    isintraday: ['s', 'S', 'm', 'h'].includes(tfUnitRaw) || tfUnitRaw === '',
    isminutes: tfUnitRaw === 'm' || tfUnitRaw === '',
    isdaily: tfUnitRaw === 'd' || tfUnitRaw === 'D',
    isweekly: tfUnitRaw === 'w' || tfUnitRaw === 'W',
    ismonthly: tfUnitRaw === 'M',
    /** `timeframe.in_seconds()` 取当前周期；`timeframe.in_seconds("240")` 取指定周期的秒数 */
    in_seconds: (tf?: unknown) =>
      tf === undefined || tf === null || tf === ''
        ? tfSec
        : timeframeTextToSeconds(tf, tfSec),
    /** `timeframe.from_seconds(14400)` → "240"（分钟数写法，与 in_seconds 可往返） */
    from_seconds: (seconds: unknown) => secondsToTimeframeText(Number(seconds)),
  }

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

  /**
   * 取颜色的某一通道：0=r 1=g 2=b 3=a(0..255)。
   * 同时兼容 `#RRGGBB(AA)`、`rgb()/rgba()` 字符串与 {r,g,b,a} 对象三种表示。
   */
  const colorChannel = (c: unknown, idx: number): number => {
    if (c && typeof c === 'object') {
      const o = c as Record<string, number>
      const v = o[['r', 'g', 'b', 'a'][idx]]
      return Number.isFinite(v) ? v : 0
    }
    const s = String(c ?? '')
    const hex = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(s)
    if (hex) {
      const v = parseInt(hex[1], 16)
      const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255, hex[2] ? parseInt(hex[2], 16) : 255]
      return ch[idx]
    }
    const nums = s.match(/[\d.]+/g)
    if (nums && nums.length >= 3) {
      const a = nums[3] === undefined ? 255 : Math.round(Number(nums[3]) * 255)
      return [Number(nums[0]), Number(nums[1]), Number(nums[2]), a][idx]
    }
    return 0
  }

  const colorNs: Record<string, unknown> = {
    new: newColor,
    rgb,
    from_gradient: fromGradient,
    // 通道提取：color.r/g/b 返回 0..255，color.t 返回 0..1 的透明度
    r: (c: unknown) => colorChannel(c, 0),
    g: (c: unknown) => colorChannel(c, 1),
    b: (c: unknown) => colorChannel(c, 2),
    t: (c: unknown) => colorChannel(c, 3) / 255,
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

  // 绘图命名空间：执行但不影响回测的存根（方案 §9.6）。
  // 用 Proxy 兜住任意方法名，脚本里的任何图元 API 都不会中断执行：
  //   · `new` 返回不透明对象（`not na(bx)` 判定仍成立）
  //   · `get_*` 返回 na（坐标类读取在回测里无意义）
  //   · `delete` 与 `set_*` 为空操作
  const noop = (): undefined => undefined
  const stubNs = (): Record<string, (...args: unknown[]) => unknown> =>
    new Proxy({} as Record<string, (...args: unknown[]) => unknown>, {
      get: (_target, prop) => {
        if (prop === 'new') return () => ({})
        if (typeof prop !== 'string') return undefined
        if (prop.startsWith('get_')) return () => Number.NaN
        return noop
      },
    })
  const boxNs = stubNs()
  const labelNs = stubNs()
  // 其余绘图命名空间同样是「执行但不出图」的存根：回测只吃信号，不吃图元
  const lineNs = stubNs()
  const tableNs = stubNs()
  const polylineNs = stubNs()
  const linefillNs = stubNs()

  /** 越界读取按 Pine 的 na 语义返回 NaN，而不是抛错 */
  const arrAt = (arr: unknown, i: number): unknown =>
    Array.isArray(arr) && Number.isFinite(i) && i >= 0 && i < arr.length ? arr[i] : Number.NaN

  /** 类型转换函数：float(x) / int(x) / bool(x) / string(x) / color(x) */
  const castNs = {
    float: (v: unknown): number => {
      const n = Number(v)
      return Number.isFinite(n) ? n : Number.NaN
    },
    int: (v: unknown): number => {
      const n = Number(v)
      return Number.isFinite(n) ? Math.trunc(n) : Number.NaN
    },
    bool: (v: unknown): boolean => (isNa(v) ? false : Boolean(v)),
    string: (v: unknown): string => (isNa(v) ? '' : String(v)),
    color: (v: unknown): unknown => v,
  }

  /**
   * Pine 数组命名空间（`array.*`）。
   *
   * 与 JS 数组的差别都在这里抹平：`array.new<T>(size, init)` 按 init 填满、
   * 越界读返回 na、`array.remove` 返回被删元素、空数组的 pop/shift 返回 na。
   * v4/v5 的遗留构造器（array.new_float 等）由 codegen 归一化成 `new`。
   */
  const arrayNs = {
    new: (size?: unknown, init?: unknown): unknown[] => {
      const n = Math.floor(Number(size))
      if (!Number.isFinite(n) || n <= 0) return []
      return new Array<unknown>(n).fill(init === undefined ? Number.NaN : init)
    },
    from: (...vals: unknown[]): unknown[] => vals.slice(),
    get: (arr: unknown, i: unknown): unknown => arrAt(arr, Math.floor(Number(i))),
    set: (arr: unknown, i: unknown, v: unknown): void => {
      const k = Math.floor(Number(i))
      if (Array.isArray(arr) && Number.isFinite(k) && k >= 0) arr[k] = v
    },
    size: (arr: unknown): number => (Array.isArray(arr) ? arr.length : 0),
    push: (arr: unknown, ...vals: unknown[]): void => {
      if (Array.isArray(arr)) arr.push(...vals)
    },
    pop: (arr: unknown): unknown => (Array.isArray(arr) && arr.length ? arr.pop() : Number.NaN),
    shift: (arr: unknown): unknown => (Array.isArray(arr) && arr.length ? arr.shift() : Number.NaN),
    unshift: (arr: unknown, v: unknown): void => {
      if (Array.isArray(arr)) arr.unshift(v)
    },
    last: (arr: unknown): unknown => (Array.isArray(arr) ? arrAt(arr, arr.length - 1) : Number.NaN),
    first: (arr: unknown): unknown => arrAt(arr, 0),
    remove: (arr: unknown, i: unknown): unknown => {
      const k = Math.floor(Number(i))
      if (!Array.isArray(arr) || !Number.isFinite(k) || k < 0 || k >= arr.length) return Number.NaN
      return arr.splice(k, 1)[0]
    },
    clear: (arr: unknown): void => {
      if (Array.isArray(arr)) arr.length = 0
    },
    includes: (arr: unknown, v: unknown): boolean => (Array.isArray(arr) ? arr.includes(v) : false),
    indexof: (arr: unknown, v: unknown): number => (Array.isArray(arr) ? arr.indexOf(v) : -1),
    lastindexof: (arr: unknown, v: unknown): number => (Array.isArray(arr) ? arr.lastIndexOf(v) : -1),
    reverse: (arr: unknown): unknown[] => (Array.isArray(arr) ? arr.reverse() : []),
    slice: (arr: unknown, a: unknown, b?: unknown): unknown[] =>
      Array.isArray(arr)
        ? arr.slice(Math.floor(Number(a)), b === undefined ? undefined : Math.floor(Number(b)))
        : [],
    concat: (a: unknown, b: unknown): unknown => (Array.isArray(a) && Array.isArray(b) ? a.concat(b) : a),
    sum: (arr: unknown): number =>
      Array.isArray(arr)
        ? arr.reduce<number>((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0)
        : 0,
    avg: (arr: unknown): number =>
      Array.isArray(arr) && arr.length
        ? arr.reduce<number>((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0) / arr.length
        : Number.NaN,
    /** 取值排序后的下标序列；order 传 'ascending' / 'descending' */
    sort_indices: (arr: unknown, order?: unknown): number[] => {
      if (!Array.isArray(arr)) return []
      const idx = arr.map((_, i) => i)
      const desc = order === 'descending'
      idx.sort((x, y) => {
        const a = Number.isFinite(Number(arr[x])) ? Number(arr[x]) : 0
        const b = Number.isFinite(Number(arr[y])) ? Number(arr[y]) : 0
        return desc ? b - a : a - b
      })
      return idx
    },
  }

  /** `ta.*` 的当前 bar 变体：先按前缀算整条数组，再取下标 */
  const seriesAt =
    <A extends unknown[]>(fn: (src: readonly number[], ...rest: A) => readonly (number | boolean)[]) =>
    (arr: unknown, index: number, ...rest: A): unknown => {
      if (!Array.isArray(arr) || !Number.isFinite(index) || index < 0) return Number.NaN
      const out = fn(arr.slice(0, Math.floor(index) + 1), ...rest)
      return index < out.length ? out[index] : Number.NaN
    }

  const atrAt = (
    high: unknown,
    low: unknown,
    close: unknown,
    index: number,
    length: unknown,
    smoothing?: unknown,
  ): number => {
    if (!Array.isArray(high) || !Array.isArray(low) || !Array.isArray(close)) return Number.NaN
    if (!Number.isFinite(index) || index < 0) return Number.NaN
    const i = Math.floor(index)
    const out = taLib.atr(
      high.slice(0, i + 1),
      low.slice(0, i + 1),
      close.slice(0, i + 1),
      Number(length),
      (smoothing as 'RMA' | 'SMA' | 'EMA' | 'WMA' | undefined) ?? 'RMA',
    )
    return i < out.length ? out[i] : Number.NaN
  }

  const trAt = (high: unknown, low: unknown, close: unknown, index: number): number => {
    if (!Array.isArray(high) || !Array.isArray(low) || !Array.isArray(close)) return Number.NaN
    if (!Number.isFinite(index) || index < 0) return Number.NaN
    const i = Math.floor(index)
    const out = taLib.trueRange(high.slice(0, i + 1), low.slice(0, i + 1), close.slice(0, i + 1))
    return i < out.length ? out[i] : Number.NaN
  }

  /**
   * 交叉的当前 bar 变体：`crossunderAt(a, b, i, offA, offB)` 语义为
   *   a[i-offA] < b[i-offB] 且 a[i-offA-1] >= b[i-offB-1]
   * 偏移量用于支持 v4 的 `crossunder(a[1], b[1])` 写法。
   */
  const crossAt =
    (kind: 'crossover' | 'crossunder' | 'cross') =>
    (a: unknown, b: unknown, index: number, offA = 0, offB = 0): boolean => {
      if (!Array.isArray(a) || !Array.isArray(b)) return false
      const i = Math.floor(index) - Math.floor(Number(offA) || 0)
      const j = Math.floor(index) - Math.floor(Number(offB) || 0)
      const a0 = at(a, i, 0)
      const a1 = at(a, i, 1)
      const b0 = at(b, j, 0)
      const b1 = at(b, j, 1)
      if (isNa(a0) || isNa(a1) || isNa(b0) || isNa(b1)) return false
      const up = (a0 as number) > (b0 as number) && (a1 as number) <= (b1 as number)
      const down = (a0 as number) < (b0 as number) && (a1 as number) >= (b1 as number)
      if (kind === 'crossover') return up
      if (kind === 'crossunder') return down
      return up || down
    }

  /**
   * 交叉的「直接取值」变体：四个数值由调用方提供（数组或环形缓冲取出的当前/上一根值）。
   * 判定口径与 crossAt 完全一致：na 一律为 false。
   */
  const crossVals =
    (kind: 'crossover' | 'crossunder' | 'cross') =>
    (curA: unknown, prevA: unknown, curB: unknown, prevB: unknown): boolean => {
      if (isNa(curA) || isNa(prevA) || isNa(curB) || isNa(prevB)) return false
      const a0 = Number(curA)
      const a1 = Number(prevA)
      const b0 = Number(curB)
      const b1 = Number(prevB)
      const up = a0 > b0 && a1 <= b1
      const down = a0 < b0 && a1 >= b1
      if (kind === 'crossover') return up
      if (kind === 'crossunder') return down
      return up || down
    }

  const taNs: typeof taLib & TaAtFns = {
    ...taLib,
    smaAt: seriesAt(taLib.sma),
    emaAt: seriesAt(taLib.ema),
    rmaAt: seriesAt(taLib.rma),
    wmaAt: seriesAt(taLib.wma),
    highestAt: seriesAt(taLib.highest),
    lowestAt: seriesAt(taLib.lowest),
    hmaAt: seriesAt(taLib.hma),
    almaAt: seriesAt(taLib.alma),
    rsiAt: seriesAt(taLib.rsi),
    changeAt: seriesAt(taLib.change),
    momAt: seriesAt(taLib.mom),
    rocAt: seriesAt(taLib.roc),
    stdevAt: seriesAt(taLib.stdev),
    varianceAt: seriesAt(taLib.variance),
    devAt: seriesAt(taLib.dev),
    risingAt: seriesAt(taLib.rising),
    fallingAt: seriesAt(taLib.falling),
    stochAt: seriesAt(taLib.stoch),
    linregAt: seriesAt(taLib.linreg),
    barssinceAt: seriesAt(taLib.barssince),
    valuewhenAt: seriesAt(taLib.valuewhen),
    sarAt: (high: unknown, low: unknown, index: number, start: number, inc: number, max: number) => {
      if (!Array.isArray(high) || !Array.isArray(low)) return Number.NaN
      if (!Number.isFinite(index) || index < 0) return Number.NaN
      const i = Math.floor(index)
      const out = taLib.sar(high.slice(0, i + 1), low.slice(0, i + 1), start, inc, max)
      return i < out.length ? out[i] : Number.NaN
    },
    /** dmi / mfi 的元组或标量结果按下标取（i 落在 tupleIdx 指定的那一项上） */
    dmiAt: (
      high: unknown,
      low: unknown,
      close: unknown,
      index: number,
      diLength: number,
      adxSmoothing: number,
      tupleIdx = 0,
    ) => atOfTuple(taLib.dmi, [high, low, close], index, [diLength, adxSmoothing], tupleIdx),
    mfiAt: (
      high: unknown,
      low: unknown,
      close: unknown,
      index: number,
      _series: unknown,
      length: number,
    ) => atOfTuple(taLib.mfi, [high, low, close, volume], index, [length], 0),
    pivothighAt: seriesAt(taLib.pivothigh),
    pivotlowAt: seriesAt(taLib.pivotlow),
    atrAt,
    trAt,
    crossoverAt: crossAt('crossover'),
    crossunderAt: crossAt('crossunder'),
    crossAt: crossAt('cross'),
    crossoverVals: crossVals('crossover'),
    crossunderVals: crossVals('crossunder'),
    crossVals: crossVals('cross'),
  }

  /** 矩阵：以「行数列数 + 一维数据」表示的极简实现（回测常用算子） */
  const matrixNs = (() => {
    const rowsOf = (m: unknown): unknown[][] => (Array.isArray(m) ? (m as unknown[][]) : [])
    const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : Number.NaN)
    const callable = (...args: unknown[]): unknown => {
      const [m, r, c] = args
      const a = rowsOf(m)
      const ri = Math.floor(Number(r))
      const ci = Math.floor(Number(c))
      return Number.isFinite(ri) && Number.isFinite(ci) ? num(a[ri]?.[ci]) : Number.NaN
    }
    const ns: Record<string, (...args: never[]) => unknown> = {
      new: (...args: unknown[]): unknown[][] => {
        const r = Math.max(0, Math.floor(Number(args[0] ?? 0)))
        const c = Math.max(0, Math.floor(Number(args[1] ?? 0)))
        const init = args[2] ?? Number.NaN
        return Array.from({ length: r }, () => new Array<unknown>(c).fill(init))
      },
      rows: (m: unknown): number => rowsOf(m).length,
      columns: (m: unknown): number => rowsOf(m)[0]?.length ?? 0,
      get: callable,
      set: (...args: unknown[]): void => {
        const a = rowsOf(args[0])
        const ri = Math.floor(Number(args[1]))
        const ci = Math.floor(Number(args[2]))
        if (a[ri]) a[ri][ci] = args[3]
      },
      fill: (...args: unknown[]): unknown => {
        const a = rowsOf(args[0])
        for (const row of a) row.fill(args[1])
        return a
      },
      row: (m: unknown, r: unknown): unknown[] => rowsOf(m)[Math.floor(Number(r))] ?? [],
      col: (m: unknown, c: unknown): unknown[] =>
        rowsOf(m).map((row) => row[Math.floor(Number(c))]),
      sum: (m: unknown): number =>
        rowsOf(m).reduce<number>((s, row) => s + row.reduce<number>((x, v) => x + (num(v) || 0), 0), 0),
      avg: (m: unknown): number => {
        const a = rowsOf(m)
        const total = a.length * (a[0]?.length ?? 0)
        const s = rowsOf(m).reduce<number>((acc, row) => acc + row.reduce<number>((x, v) => x + (num(v) || 0), 0), 0)
        return total ? s / total : Number.NaN
      },
      min: (m: unknown): number => Math.min(...rowsOf(m).flat().map(num)),
      max: (m: unknown): number => Math.max(...rowsOf(m).flat().map(num)),
      transpose: (m: unknown): unknown[][] => {
        const a = rowsOf(m)
        return (a[0] ?? []).map((_, c) => a.map((row) => row[c]))
      },
      multiply: (x: unknown, y: unknown): unknown[][] => {
        const a = rowsOf(x)
        const b = rowsOf(y)
        return a.map((row) =>
          (b[0] ?? []).map((_, c) =>
            row.reduce<number>((s, v, k) => s + num(v) * num(b[k]?.[c]), 0),
          ),
        )
      },
      is_valid: (m: unknown): boolean => Array.isArray(m),
      is_square: (m: unknown): boolean => {
        const a = rowsOf(m)
        return a.length > 0 && a.length === (a[0]?.length ?? -1)
      },
      is_identity: (m: unknown): boolean =>
        rowsOf(m).every((row, i) => row.every((v, j) => num(v) === (i === j ? 1 : 0))),
      is_zero: (m: unknown): boolean => rowsOf(m).every((row) => row.every((v) => num(v) === 0)),
      is_antisymmetric: (m: unknown): boolean => {
        const a = rowsOf(m)
        return a.every((row, i) => row.every((v, j) => num(v) === -num(a[j]?.[i])))
      },
      is_symmetric: (m: unknown): boolean => {
        const a = rowsOf(m)
        return a.every((row, i) => row.every((v, j) => num(v) === num(a[j]?.[i])))
      },
      is_diagonal: (m: unknown): boolean => {
        const a = rowsOf(m)
        return a.every((row, i) => row.every((v, j) => (i === j ? true : num(v) === 0)))
      },
      is_triangular: (): boolean => true,
      is_stochastic: (m: unknown): boolean =>
        rowsOf(m).every((row) => row.every((v) => num(v) >= 0 && num(v) <= 1)),
    }
    // 其余矩阵算子（逆/特征/分解等）：回测不消费，统一返回 na 占位
    return new Proxy(ns, {
      get: (target, prop) => {
        if (typeof prop !== 'string') return undefined
        if (prop in target) return target[prop]
        return (...args: unknown[]): unknown => {
          void args
          return Number.NaN
        }
      },
    }) as Record<string, (...args: never[]) => unknown>
  })()

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
    histOf,
    serSet,
    timestamp: pineTimestamp,
    dayofweek: dayOfWeekOf,
    timePart: timePartOf,
    arrRemove,
    arrClear,
    ta: taNs,
    matrix: matrixNs,
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
      upper: (s: unknown): string => String(s ?? '').toUpperCase(),
      lower: (s: unknown): string => String(s ?? '').toLowerCase(),
      contains: (s: unknown, sub: unknown): boolean => String(s ?? '').includes(String(sub ?? '')),
      startswith: (s: unknown, sub: unknown): boolean => String(s ?? '').startsWith(String(sub ?? '')),
      endswith: (s: unknown, sub: unknown): boolean => String(s ?? '').endsWith(String(sub ?? '')),
      replace: (s: unknown, a: unknown, b: unknown): string =>
        String(s ?? '').replace(String(a ?? ''), String(b ?? '')),
      replace_all: (s: unknown, a: unknown, b: unknown): string =>
        String(s ?? '').split(String(a ?? '')).join(String(b ?? '')),
      split: (s: unknown, sep: unknown): string[] => String(s ?? '').split(String(sep ?? '')),
      length: (s: unknown): number => String(s ?? '').length,
      trim: (s: unknown): string => String(s ?? '').trim(),
      substring: (s: unknown, from: unknown, to?: unknown): string => {
        const str = String(s ?? '')
        const a = Math.max(0, Math.floor(Number(from)))
        const b = to === undefined ? str.length : Math.floor(Number(to))
        return str.slice(a, b)
      },
      tonumber: (s: unknown): number => {
        const num = Number(String(s ?? '').trim())
        return Number.isFinite(num) ? num : Number.NaN
      },
      toint: (s: unknown): number => {
        const num = Number(String(s ?? '').trim())
        return Number.isFinite(num) ? Math.trunc(num) : Number.NaN
      },
      tochar: (n: unknown): string => String.fromCharCode(Math.floor(Number(n))),
      char: (n: unknown): string => String.fromCharCode(Math.floor(Number(n))),
      reverse: (s: unknown): string => [...String(s ?? '')].reverse().join(''),
      repeat: (s: unknown, count: unknown): string =>
        String(s ?? '').repeat(Math.max(0, Math.floor(Number(count)))),
      /** str.format("a {0} b", x) → 位置占位符替换 */
      format: (template: unknown, ...args: unknown[]): string =>
        String(template ?? '').replace(/\{(\d+)\}/g, (m, i) => {
          const v = args[Number(i)]
          return v === undefined || isNa(v) ? m : String(v)
        }),
    },
    color: colorNs,
    input: inputNs,
    chart: { fg_color: '#131722', bg_color: '#ffffff' },
    format: { mintick: MINTICK, price: MINTICK, percent: '#.##%', volume: '#.##' },
    session: { isfirstbar: false, islastbar: false },
    timeframe: timeframeNs,
    syminfo: {
      mintick: tick,
      pointvalue: 1,
      ticker: '',
      tickerid: '',
      root: '',
      basecurrency: '',
      currency: 'USD',
      type: 'crypto',
      session: '24x7',
      timezone: 'UTC',
      description: '',
      prefix: '',
      isin: '',
      main_tickerid: '',
    },
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
    line: lineNs,
    table: tableNs,
    polyline: polylineNs,
    linefill: linefillNs,
    array: arrayNs,
    cast: castNs,
  }
}
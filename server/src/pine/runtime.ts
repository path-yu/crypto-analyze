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

/** 周期文本 → 分桶规则（`60` = 60 分钟、`D` / `1D`、`W`、`M`；裸数字按分钟） */
function parseTfSpec(tf: string): { fixed?: number; week?: boolean; month?: boolean } | null {
  const m = /^(\d*)([SmhdWMD]?)$/.exec(tf.trim())
  if (!m || tf.trim() === '') return null
  const mult = m[1] ? Number(m[1]) : 1
  const unit = m[2] || 'm'
  if (!Number.isFinite(mult) || mult <= 0) return null
  if (unit === 'M') return { month: true }
  if (unit === 'W') return { week: true }
  const unitMs: Record<string, number> = { S: 1000, s: 1000, m: 60_000, h: 3_600_000, D: 86_400_000, d: 86_400_000 }
  const ms = unitMs[unit]
  if (!ms) return null
  return { fixed: ms * mult }
}

/** 某一时刻所属 HTF 分桶的键（桶内所有 bar 共享同一个键） */
function bucketKeyOf(ms: number, spec: { fixed?: number; week?: boolean; month?: boolean }): number {
  if (spec.month) {
    const d = new Date(ms)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  }
  if (spec.week) {
    // Pine 的 W 以周一为起点（epoch 日 0 是周四 → +3 天对齐到周一）
    const day = Math.floor(ms / 86_400_000)
    return (Math.floor((day + 3) / 7) * 7 - 3) * 86_400_000
  }
  const fixed = spec.fixed as number
  return Math.floor(ms / fixed) * fixed
}

/** HTF 数据集：按周期重采样出的 OHLCV 序列 + 每根 LTF bar 所属的桶下标 */
export interface HtfData {
  open: number[]
  high: number[]
  low: number[]
  close: number[]
  volume: number[]
  time: number[]
  hl2: number[]
  hlc3: number[]
  ohlc4: number[]
  /** 每根 LTF bar 所属桶的下标（用于「上一根已收盘 HTF bar」对齐） */
  bucketOf: number[]
  time_close: number[]
  time_tradingday: number[]
}

/** 判断 UTC 时刻是否落在已知的 HTF 分桶规则内（供 codegen 校验字面量周期） */
export { parseTfSpec as pineTfSpec }

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
 * 行内序列读取（`f(...)[k]`）：先把当根 bar 的调用结果写入数组，再按 k 回看。
 * 与 serSet 共用「下标对齐」语义，缺位一律为 na。
 */
export function serRead(arr: unknown[], index: number, k: number, value: unknown): unknown {
  serSet(arr, index, value)
  return at(arr, index, k)
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
  serRead: typeof serRead
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
    in_seconds: () => number
    from_seconds: (sec: unknown) => string
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
  map: Record<string, (...args: never[]) => unknown>
  /** HTF（`security()`）重采样序列访问器：`__pine.htf('D').close` */
  htf: (tf: unknown) => HtfData
  /** HTF 对齐取值（`lookahead_off` 语义） */
  htfAt: (arr: unknown, index: number, tf: unknown) => unknown
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
  const tfMatch = /^(\d*)([smhdW])$/.exec(tfText)
  const tfUnitSec: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, W: 604800 }
  const tfUnit = tfMatch ? tfMatch[2] : 'h'
  const tfMult = tfMatch && tfMatch[1] ? Number(tfMatch[1]) : 1
  const timeframeNs = {
    period: tfText,
    multiplier: tfMult,
    isseconds: tfUnit === 's',
    isintraday: tfUnit === 's' || tfUnit === 'm' || tfUnit === 'h',
    in_seconds: () => tfMult * (tfUnitSec[tfUnit] ?? 3600),
    /** `timeframe.from_seconds(240)` → 「4h」这类周期字符串（Pine 的常见返回形式） */
    from_seconds: (sec: unknown): string => {
      const s = Math.floor(Number(sec))
      if (!Number.isFinite(s) || s <= 0) return ''
      if (s === 604800) return '1W'
      if (s === 2592000) return '1M'
      if (s === 86400) return '1D'
      if (s % 86400 === 0) return `${s / 86400}D`
      if (s % 3600 === 0) return `${s / 3600}h`
      if (s % 60 === 0) return String(s / 60)
      return `${s}S`
    },
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

  /** HTF 重采样数据集（按周期缓存；`bucketOf[i]` = 第 i 根 LTF bar 所属桶） */
  const htfCache = new Map<string, HtfData | null>()
  const emptyHtf: HtfData = {
    open: [], high: [], low: [], close: [], volume: [], time: [],
    hl2: [], hlc3: [], ohlc4: [], bucketOf: [], time_close: [], time_tradingday: [],
  }
  const htfData = (tf: string): HtfData | null => {
    if (htfCache.has(tf)) return htfCache.get(tf) ?? null
    const spec = parseTfSpec(tf)
    if (!spec) {
      htfCache.set(tf, null)
      return null
    }
    const d: HtfData = {
      open: [], high: [], low: [], close: [], volume: [], time: [],
      hl2: [], hlc3: [], ohlc4: [], bucketOf: new Array<number>(n),
      time_close: [], time_tradingday: [],
    }
    const keyToIdx = new Map<number, number>()
    for (let i = 0; i < n; i++) {
      const key = bucketKeyOf(timestamp[i], spec)
      const idx = keyToIdx.get(key)
      if (idx === undefined) {
        const j = d.open.length
        keyToIdx.set(key, j)
        d.open.push(open[i])
        d.high.push(high[i])
        d.low.push(low[i])
        d.close.push(close[i])
        d.volume.push(volume[i])
        d.time.push(key)
        d.bucketOf[i] = j
      } else {
        d.high[idx] = Math.max(d.high[idx], high[i])
        d.low[idx] = Math.min(d.low[idx], low[i])
        d.close[idx] = close[i]
        d.volume[idx] += volume[i]
        d.bucketOf[i] = idx
      }
    }
    for (let j = 0; j < d.open.length; j++) {
      d.hl2.push((d.high[j] + d.low[j]) / 2)
      d.hlc3.push((d.high[j] + d.low[j] + d.close[j]) / 3)
      d.ohlc4.push((d.open[j] + d.high[j] + d.low[j] + d.close[j]) / 4)
      d.time_close.push(j + 1 < d.open.length ? d.time[j + 1] : d.time[j] + (spec.fixed ?? 86_400_000))
      d.time_tradingday.push(d.time[j])
    }
    htfCache.set(tf, d)
    return d
  }

  /** `security()` 的 HTF 序列访问器：`__pine.htf('D').close` */
  const htf = (tf: unknown): HtfData => htfData(String(tf)) ?? emptyHtf

  /**
   * HTF 对齐取值：取「当前 bar 所属桶的上一根**已收盘** HTF bar」的值
   * （对应 `lookahead_off`，与 TradingView 的非重绘语义一致）。
   */
  const htfAt = (arr: unknown, index: number, tf: unknown): unknown => {
    if (!Array.isArray(arr) || !(index >= 0)) return Number.NaN
    const d = htfData(String(tf))
    if (!d) return Number.NaN
    const j = (d.bucketOf[Math.floor(index)] ?? 0) - 1
    return j >= 0 && j < arr.length ? arr[j] : Number.NaN
  }

  /**
   * `ta.*` 的当前 bar 变体：按当前 bar 取值。
   *
   * 两条路径：
   *   1. 已知窗口的算子（sma / highest / linreg / change …）：只取「最近 window 个元素」
   *      重算并取末位 —— 变长数组下也是 O(window)，总代价 O(n·window)；
   *   2. 递归算子（ema / rma / rsi / hma …）：整数组结果缓存，固定长度数组只算一次。
   *
   * 因果型 ta 函数在「整条数组」与「前缀切片」上的第 i 个值一致，
   * 因此缓存/切片两条路都与逐 bar 语义等价。
   */
  const seriesAt = (
    fn: (src: readonly number[], ...rest: never[]) => readonly (number | boolean)[],
    window?: { arg: number; extra?: number },
  ) => {
    const cache = new WeakMap<object, Map<string, { len: number; out: readonly (number | boolean)[] }>>()
    return (arr: unknown, index: number, ...rest: never[]): unknown => {
      if (!Array.isArray(arr) || !Number.isFinite(index) || index < 0) return Number.NaN
      const i = Math.floor(index)
      if (window) {
        const lenRaw = Number(rest[window.arg])
        if (Number.isFinite(lenRaw) && lenRaw >= 1) {
          const need = Math.floor(lenRaw) + (window.extra ?? 0)
          const from = Math.max(0, i + 1 - need)
          const out = fn(arr.slice(from, i + 1), ...rest)
          return out.length ? out[out.length - 1] : Number.NaN
        }
      }
      const key = JSON.stringify(rest)
      const byKey = cache.get(arr)
      const hit = byKey?.get(key)
      let out = hit && hit.len === arr.length ? hit.out : undefined
      if (!out) {
        out = fn(arr, ...rest)
        const m = byKey ?? new Map<string, { len: number; out: readonly (number | boolean)[] }>()
        m.set(key, { len: arr.length, out })
        if (!byKey) cache.set(arr, m)
      }
      return i < out.length ? out[i] : Number.NaN
    }
  }

  /** 单序列算子的窗口声明（`arg` = 长度参数在 rest 中的下标；`extra` = 额外需要的历史点数） */
  const WINDOW_LEN = { arg: 0, extra: 0 }
  const WINDOW_LEN1 = { arg: 0, extra: 1 }

  /**
   * 多序列输入的 `*At` 变体（`atrAt` / `trAt` / `sarAt`）：
   * 参数形态为「若干整条数组 + 当前 bar 下标 + 其余标量」，同样带整数组结果缓存。
   */
  const multiAt = (
    fn: (...args: never[]) => readonly (number | boolean)[],
    arrayCount: number,
  ) => {
    const cache = new WeakMap<object, Map<string, { len: number; out: readonly (number | boolean)[] }>>()
    return (...args: unknown[]): unknown => {
      const index = Number(args[arrayCount])
      if (!Number.isFinite(index) || index < 0) return Number.NaN
      const arrs = args.slice(0, arrayCount)
      if (!arrs.every((a) => Array.isArray(a))) return Number.NaN
      const rest = args.slice(arrayCount + 1)
      const key = JSON.stringify(rest)
      const first = arrs[0] as object
      const len = (arrs[0] as unknown[]).length
      const byKey = cache.get(first)
      const hit = byKey?.get(key)
      let out = hit && hit.len === len ? hit.out : undefined
      if (!out) {
        out = fn(...(arrs as never[]), ...(rest as never[]))
        const m = byKey ?? new Map<string, { len: number; out: readonly (number | boolean)[] }>()
        m.set(key, { len, out })
        if (!byKey) cache.set(first, m)
      }
      const i = Math.floor(index)
      return i < out.length ? out[i] : Number.NaN
    }
  }

  const atrAt = multiAt(
    (high, low, close, length, smoothing) =>
      taLib.atr(
        high as unknown as number[],
        low as unknown as number[],
        close as unknown as number[],
        Number(length),
        (smoothing as 'RMA' | 'SMA' | 'EMA' | 'WMA') ?? 'RMA',
      ),
    3,
  )

  const trAt = multiAt(
    (high, low, close) =>
      taLib.trueRange(
        high as unknown as number[],
        low as unknown as number[],
        close as unknown as number[],
      ),
    3,
  )

  const sarAt = multiAt(
    (high, low, start, inc, max) =>
      taLib.sar(
        high as unknown as number[],
        low as unknown as number[],
        Number(start),
        Number(inc),
        Number(max),
      ),
    2,
  )

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

  const taNs: typeof taLib & TaAtFns = {
    ...taLib,
    smaAt: seriesAt(taLib.sma, WINDOW_LEN),
    emaAt: seriesAt(taLib.ema),
    rmaAt: seriesAt(taLib.rma),
    wmaAt: seriesAt(taLib.wma, WINDOW_LEN),
    highestAt: seriesAt(taLib.highest, WINDOW_LEN),
    lowestAt: seriesAt(taLib.lowest, WINDOW_LEN),
    hmaAt: seriesAt(taLib.hma),
    almaAt: seriesAt(taLib.alma),
    rsiAt: seriesAt(taLib.rsi),
    changeAt: seriesAt(taLib.change, WINDOW_LEN1),
    momAt: seriesAt(taLib.mom, WINDOW_LEN1),
    rocAt: seriesAt(taLib.roc, WINDOW_LEN1),
    stdevAt: seriesAt(taLib.stdev, WINDOW_LEN),
    varianceAt: seriesAt(taLib.variance, WINDOW_LEN),
    devAt: seriesAt(taLib.dev, WINDOW_LEN),
    risingAt: seriesAt(taLib.rising, WINDOW_LEN1),
    fallingAt: seriesAt(taLib.falling, WINDOW_LEN1),
    stochAt: seriesAt(taLib.stoch),
    linregAt: seriesAt(taLib.linreg, WINDOW_LEN),
    barssinceAt: seriesAt(taLib.barssince),
    valuewhenAt: seriesAt(taLib.valuewhen),
    sarAt,
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
      trace: (m: unknown): number => {
        const a = rowsOf(m)
        return a.reduce<number>((s, row, i) => s + num(row[i]), 0)
      },
      /** 行列式（高斯消元，复杂度 O(n³)） */
      det: (m: unknown): number => {
        const a = rowsOf(m).map((row) => row.map(num))
        const n = a.length
        if (n === 0 || a.some((row) => row.length !== n)) return Number.NaN
        let det = 1
        for (let c = 0; c < n; c++) {
          let pivot = c
          for (let r = c + 1; r < n; r++) {
            if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r
          }
          if (a[pivot][c] === 0) return 0
          if (pivot !== c) {
            const tmp = a[pivot]
            a[pivot] = a[c]
            a[c] = tmp
            det = -det
          }
          det *= a[c][c]
          for (let r = c + 1; r < n; r++) {
            const f = a[r][c] / a[c][c]
            for (let k = c; k < n; k++) a[r][k] -= f * a[c][k]
          }
        }
        return det
      },
      /** 逆矩阵（Gauss-Jordan；奇异矩阵返回 na 占位） */
      inv: (m: unknown): unknown => {
        const a = rowsOf(m).map((row) => row.map(num))
        const n = a.length
        if (n === 0 || a.some((row) => row.length !== n)) return Number.NaN
        const aug = a.map((row, i) => [
          ...row,
          ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
        ])
        for (let c = 0; c < n; c++) {
          let pivot = c
          for (let r = c + 1; r < n; r++) {
            if (Math.abs(aug[r][c]) > Math.abs(aug[pivot][c])) pivot = r
          }
          if (aug[pivot][c] === 0) return Number.NaN
          const tmp = aug[pivot]
          aug[pivot] = aug[c]
          aug[c] = tmp
          const pv = aug[c][c]
          for (let k = 0; k < 2 * n; k++) aug[c][k] /= pv
          for (let r = 0; r < n; r++) {
            if (r === c) continue
            const f = aug[r][c]
            if (f === 0) continue
            for (let k = 0; k < 2 * n; k++) aug[r][k] -= f * aug[c][k]
          }
        }
        return aug.map((row) => row.slice(n))
      },
      /** 秩（对行阶梯形非零行计数） */
      rank: (m: unknown): number => {
        const a = rowsOf(m).map((row) => row.map(num))
        const rows = a.length
        const cols = a[0]?.length ?? 0
        let rank = 0
        for (let c = 0; c < cols && rank < rows; c++) {
          let pivot = -1
          for (let r = rank; r < rows; r++) {
            if (a[r][c] !== 0) {
              pivot = r
              break
            }
          }
          if (pivot < 0) continue
          const tmp = a[pivot]
          a[pivot] = a[rank]
          a[rank] = tmp
          for (let r = rank + 1; r < rows; r++) {
            const f = a[r][c] / a[rank][c]
            if (f === 0) continue
            for (let k = c; k < cols; k++) a[r][k] -= f * a[rank][k]
          }
          rank++
        }
        return rank
      },
      /** 整数幂（快速幂） */
      pow: (m: unknown, n: unknown): unknown => {
        let e = Math.floor(Number(n))
        if (!Number.isFinite(e) || e < 0) return Number.NaN
        const multiply = ns.multiply as (x: unknown, y: unknown) => unknown
        let base: unknown = m
        let out: unknown = null
        while (e > 0) {
          if (e & 1) out = out === null ? base : multiply(out, base)
          base = multiply(base, base)
          e >>= 1
        }
        if (out === null) {
          const a = rowsOf(m)
          out = a.map((row, i) => row.map((_, j) => (i === j ? 1 : 0)))
        }
        return out
      },
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

  /** `map.*`：以 JS Map 承载（Pine 的 map 保持插入序、键唯一） */
  const mapNs = (() => {
    const asMap = (m: unknown): Map<unknown, unknown> => (m instanceof Map ? m : new Map())
    const ns: Record<string, (...args: never[]) => unknown> = {
      new: (): Map<unknown, unknown> => new Map(),
      put: (m: unknown, k: unknown, v: unknown): void => {
        asMap(m).set(k, v)
      },
      get: (m: unknown, k: unknown): unknown => {
        const map = asMap(m)
        return map.has(k) ? map.get(k) : Number.NaN
      },
      contains: (m: unknown, k: unknown): boolean => asMap(m).has(k),
      remove: (m: unknown, k: unknown): void => {
        asMap(m).delete(k)
      },
      clear: (m: unknown): void => {
        asMap(m).clear()
      },
      size: (m: unknown): number => asMap(m).size,
      keys: (m: unknown): unknown[] => [...asMap(m).keys()],
      values: (m: unknown): unknown[] => [...asMap(m).values()],
      copy: (m: unknown): Map<unknown, unknown> => new Map(asMap(m)),
      /** 反向查键：第一个值相等的键，找不到返回 na */
      keyof: (m: unknown, v: unknown): unknown => {
        for (const [k, val] of asMap(m)) {
          if (Object.is(val, v) || (Number.isNaN(Number(v)) && Number.isNaN(Number(val)))) return k
        }
        return Number.NaN
      },
      /** 反向查键（起点版本，Pine v6 的 map.keyof(map, value, occurrence)） */
      keyof_occurrence: (m: unknown, v: unknown, occ: unknown): unknown => {
        const want = Math.max(0, Math.floor(Number(occ) || 0))
        let seen = 0
        for (const [k, val] of asMap(m)) {
          if (Object.is(val, v)) {
            if (seen === want) return k
            seen++
          }
        }
        return Number.NaN
      },
    }
    // v4/v5 的遗留构造器（`map.new_float_float()` 等）与未实现算子
    return new Proxy(ns, {
      get: (target, prop) => {
        if (typeof prop !== 'string') return undefined
        if (prop in target) return target[prop]
        if (prop.startsWith('new')) return (): Map<unknown, unknown> => new Map()
        return (): unknown => Number.NaN
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
    serRead,
    timestamp: pineTimestamp,
    dayofweek: dayOfWeekOf,
    timePart: timePartOf,
    arrRemove,
    arrClear,
    ta: taNs,
    matrix: matrixNs,
    map: mapNs,
    htf,
    htfAt,
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
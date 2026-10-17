/**
 * PineTS 适配层：`pine 源码 → PineSignal[]`。
 *
 * 背景：本仓库原先自带一套手写的 Pine v4 编译器（`compilePine` / `runPineProgram`），
 * 逐 bar 回调 `step(index, ctx)`。改用 PineTS 后运行模型变成**批量**：
 * `await pineTS.run(source)` 一次性跑完全部 K 线，并在返回体的 `strategy` 里留下
 * 一份券商账本（开/平仓成交明细）。本文件负责把这份账本折算成引擎逐 bar 消费的
 * `PineSignal[]`，口径如下（P0 已用 `scripts/pinets-parity.ts` 逐笔验证）：
 *
 *   · 开仓 → `canLong / canShort`（方向取 `sign(size)`，Pine 约定负数 = 空头）
 *   · 平仓 → `forceClose`（引擎按 `strategy.close` 语义在下一根开盘平仓）
 *   · 单价 `entryQty` 只回填**脚本显式写了 `qty=`** 的情况；依赖
 *     `default_qty_type/value` 的脚本交给引擎按自身口径定仓（与旧编译器一致）
 *
 * 两个必须知道的坑（踩过的）：
 *   1. **信号 bar 比成交 bar 早 1 根**：本引擎在信号 bar 的**下一根开盘**成交，
 *      而 PineTS 在 fill bar 成交，所以取 `entry_bar_index + PINE_ENTRY_OFFSET`。
 *   2. **保证金强平残单**：PineTS 券商模拟器会因保证金不足，在成交当根就强平，
 *      留下 `entry_bar_index === exit_bar_index` 的微型残单，必须按 `exit_id` 过滤。
 *      脚本侧加 `margin_long=0, margin_short=0` 可以从根上避免（推荐）。
 *
 * 另：PineTS 是单标的模拟器，`request.security(其它标的, …)` 会返回 na；
 *  `timeframe.period` 需要调用方显式把 `tickerId` / `timeframe` 传给构造函数，
 *  否则为空字符串（脚本里 `request.security(sym, timeframe.period, …)` 会直接报错）。
 */

import { Indicator, PineTS } from 'pinets'
import type { Candle, PineCompileMeta, PineDiagnostic } from '../../../shared/types'

/** 每根 K 线一份的信号快照 —— 与 `StrategySignalCore` 对齐 */
export interface PineSignal {
  /** Pine 无对应概念，固定为 NaN（保持与 fib/supertrend/order-block 的信号形状兼容） */
  imbaTrendLine: number
  tsotTrendValue: number
  canLong: boolean
  canShort: boolean
  atrLongStop: number
  atrShortStop: number
  obStopLoss: number
  obTakeProfit: number
  obRisk: number
  /**
   * `strategy.entry(..., qty=…)` 指定的下单量（张数 / 币数）。
   * NaN = 脚本未指定，由引擎按「仓位比例 × 杠杆」决定。
   */
  entryQty?: number
  /** `strategy.close(...)` / `strategy.close_all()` → 引擎下一根开盘市价平仓 */
  forceClose?: boolean
}

/** 空的信号快照 */
export function emptyPineSignal(): PineSignal {
  return {
    imbaTrendLine: Number.NaN,
    tsotTrendValue: Number.NaN,
    canLong: false,
    canShort: false,
    atrLongStop: Number.NaN,
    atrShortStop: Number.NaN,
    obStopLoss: Number.NaN,
    obTakeProfit: Number.NaN,
    obRisk: Number.NaN,
    entryQty: Number.NaN,
  }
}

/** 信号 bar 相对 PineTS 成交 bar 的偏移（本引擎在信号 bar 下一根开盘成交） */
export const PINE_ENTRY_OFFSET = -1

/** 图上标记（`plotshape` 等） */
export interface PineMarker {
  time: number
  value: number
  text?: string
}

export interface RunPineTsOptions {
  /** PineTS 需要的 `tickerId`（如 `BINANCE:BTC/USDT:USDT`）；不传则 `timeframe.period` 为空 */
  tickerId?: string
  /** 图表周期（如 `1h`），必须传，否则 `timeframe.period` 为空 */
  timeframe?: string
  /** 覆盖脚本内 `input.*` 默认值（键 = input 的 title / varId / id，由 PineTS 解析） */
  inputs?: Record<string, number | boolean | string>
}

/** `analyzePine()` 的结果：不跑行情，只给出元信息与语法/版本诊断 */
export interface PineAnalysis {
  meta: PineCompileMeta
  diagnostics: PineDiagnostic[]
}

export interface PineTsRunResult {
  /** 逐 bar 信号（长度 = candles.length） */
  signals: PineSignal[]
  /** 脚本声明 / input / plot 标题等元信息（供编辑器展示） */
  meta: PineCompileMeta
  /** 命名 `plot(title=…)` 的逐 bar 值；元素为 null 表示该根 na */
  plots: Record<string, (number | null)[]>
  /** `plotshape` / `plotchar` 的非空标记 */
  markers: PineMarker[]
  /** `barcolor` 的逐 bar 颜色（PineTS 不产出时为全 null） */
  barColor: (string | null)[]
  /** 语法 / 运行期诊断（error 级即视为失败） */
  diagnostics: PineDiagnostic[]
  /** PineTS 运行期告警 */
  warnings: string[]
}

/* ------------------------------------------------------------------ */
/* 内部的 PineTS 返回体形状                                            */
/* ------------------------------------------------------------------ */

interface PineTsPlotPoint {
  value?: unknown
}
interface PineTsPlotSeries {
  title?: string
  data?: PineTsPlotPoint[]
}
interface PineTsLedgerTrade {
  entry_id?: string
  entry_price?: number
  entry_bar_index?: number
  size?: number
  exit_price?: number
  exit_bar_index?: number
  exit_id?: string
  status?: string
  profit?: number
}
interface PineTsContext {
  plots?: Record<string, PineTsPlotSeries>
  strategy?: { opentrades?: PineTsLedgerTrade[]; closedtrades?: PineTsLedgerTrade[] }
  warnings?: unknown[]
  alerts?: { title?: unknown; message?: unknown }[]
}

/** 脚本是否**显式**指定了下单量（`strategy.entry(..., qty=…)`） */
const expliciQtyRe = /strategy\.entry\((?:[^()]|\([^()]*\))*qty\s*=/s

/** PineTS 券商的「保证金强平」微型残单：与真实成交同 bar，属于账本噪声 */
function isMarginCallNoise(t: PineTsLedgerTrade): boolean {
  if (!/margin call/i.test(t.exit_id ?? '')) return false
  return t.entry_bar_index === t.exit_bar_index
}

function emptyMeta(): PineCompileMeta {
  return { kind: 'indicator', config: {}, inputs: [], plotTitles: [], alerts: [] }
}

/**
 * 把 PineTS 抛出的异常折算成一条带行列号的诊断。
 *
 * PineTS 的错误消息形如：
 *   `Failed to transpile Pine Script version 6: <msg> at 80:1`
 *   `Unsupported Pine Script version 4. Only version 5 and above are supported.`
 * 末尾的 `行:列` 能解析就解析，解析不到则退回第 1 行。
 */
function toDiagnostic(err: unknown): PineDiagnostic {
  const message = err instanceof Error ? err.message : String(err)
  const m = /at\s+(\d+):(\d+)\s*$/.exec(message.trim())
  const line = m ? Number(m[1]) : 1
  const column = m ? Number(m[2]) : 1
  const clean = m ? message.slice(0, message.length - m[0].length).trim().replace(/:\s*$/, '') : message
  // PineTS 对「中文出现在代码区」只报 Unexpected character 'X'，看不出原因。
  // Pine 标识符必须是 ASCII（TradingView 同样如此），中文几乎都来自把内置变量
  // 写成了中文（如 成交量→volume）。这里补一句可操作的提示。
  const unexpected = /Unexpected character '(.+?)'/.exec(clean)
  if (unexpected && /[\u4e00-\u9fff]/.test(unexpected[1])) {
    return {
      line,
      column,
      severity: 'error',
      message:
        `${clean} —— Pine 的变量名只能用英文字母、数字和下划线（TradingView 同样不允许中文标识符）。` +
        `「${unexpected[1]}」是中文标识符：请改回对应的英文内置变量（如 成交量→volume、收盘价→close）或自定义英文名`,
    }
  }
  return { line, column, severity: 'error', message: clean }
}

/** PineTS 的 input 类型 → 本项目 `PineCompileMeta.inputs[].type` 的窄联合 */
function narrowInputType(t: string): 'int' | 'float' | 'bool' | 'color' | 'string' {
  if (t === 'int') return 'int'
  if (t === 'float') return 'float'
  if (t === 'bool') return 'bool'
  if (t === 'color') return 'color'
  // source / enum / price / time / session / symbol / timeframe / text_area 没有对应项，
  // 统一落到 'string'（前端目前只统计 input 个数，不依赖该字段做类型分支）
  return 'string'
}

/** 从 `plot` 序列里读出逐 bar 数值（na → null） */
function readPlotValues(series: PineTsPlotSeries | undefined, length: number): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(length).fill(null)
  const data = series?.data ?? []
  for (let i = 0; i < Math.min(length, data.length); i++) {
    const v = data[i]?.value
    if (typeof v === 'number' && Number.isFinite(v)) out[i] = v
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 只做「转译 + input 扫描」，不跑行情。
 *
 * 用于编辑器的实时校验（`POST /api/pine/compile`）：能拿到 input / plot 标题等
 * 元信息，也能把 PineTS 的语法、版本错误折算成诊断。**不会抛异常**。
 */
export function analyzePine(
  source: string,
  inputs?: Record<string, number | boolean | string>,
): PineAnalysis {
  
  const indicator = new Indicator(source, inputs as Record<string, unknown> | undefined)
  try {
    indicator.prepare()
  } catch (err) {
    return { meta: emptyMeta(), diagnostics: [toDiagnostic(err)] }
  }
  return { meta: readMeta(indicator, source), diagnostics: [] }
}

/** 读取脚本元信息（声明类型 / 声明参数 / input 列表） */
function readMeta(indicator: Indicator, source: string): PineCompileMeta {
  const config: Record<string, string | number | boolean> = {}
  try {
    for (const prop of indicator.getPropsMeta()) {
      if (!prop.mutable) continue
      const v = (indicator.prop as Record<string, unknown>)[prop.name]
      if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') {
        config[prop.name] = v
      }
    }
  } catch {
    /* prop 读取失败不影响主流程 */
  }
  const inputMeta = indicator.getInputsMeta().map((it) => ({
    name: it.name,
    type: narrowInputType(it.type),
    title: it.title ?? it.name,
    ...(it.group ? { group: it.group } : {}),
    ...(Number.isFinite(it.minval) ? { minval: it.minval as number } : {}),
    ...(Number.isFinite(it.maxval) ? { maxval: it.maxval as number } : {}),
    ...(Number.isFinite(it.step) ? { step: it.step as number } : {}),
    default: it.defval,
  }))
  return {
    kind: indicator.getDeclarationType() ?? 'indicator',
    config,
    inputs: inputMeta,
    // 只做「转译」时拿不到 plot 的真实标题（要跑一遍才有），这里用轻量扫描给出近似值；
    // runPineTsSignals() 会用运行结果里的真标题覆盖它。
    plotTitles: scanPlotTitles(source),
    alerts: [],
  }
}

/** 从源码里粗略扫出 `plot*(…)` 的标题（供编辑器的信息行展示；非精确解析） */
function scanPlotTitles(source: string): string[] {
  const out: string[] = []
  const callRe = /\b(?:plot|plotshape|plotchar|plotarrow|plotcandle|plotbar)\s*\(/g
  for (const m of source.matchAll(callRe)) {
    const rest = source.slice(m.index + m[0].length)
    // 取到本行结束或第一个右括号为止，再从参数里挑 title= / 首个字符串字面量
    const args = rest.split(')')[0] ?? ''
    const named = /title\s*=\s*"([^"]*)"/.exec(args)
    const positional = /"([^"]*)"/.exec(args)
    const title = named?.[1] ?? positional?.[1]
    out.push(title && title.length ? title : `#${out.length}`)
  }
  return out
}

/**
 * 用 PineTS 跑一遍 Pine 脚本，产出引擎可消费的信号 + 绘图数据。
 *
 * 不会抛异常（除了极端情况）：语法错误 / 版本不支持 / 运行期异常都会折叠成
 * `diagnostics` 里的 error 级诊断返回，此时 `signals` 为全空信号。
 */
export async function runPineTsSignals(
  source: string,
  candles: readonly Candle[],
  opts: RunPineTsOptions = {},
): Promise<PineTsRunResult> {
  const emptySignals = candles.map(() => emptyPineSignal())
  const base: PineTsRunResult = {
    signals: emptySignals,
    meta: emptyMeta(),
    plots: {},
    markers: [],
    barColor: new Array<string | null>(candles.length).fill(null),
    diagnostics: [],
    warnings: [],
  }

  // 1) 先做「转译 + input 扫描」：能拿到 input 列表，也能尽早暴露语法/版本错误
  const indicator = new Indicator(source, opts.inputs as Record<string, unknown> | undefined)
  try {
    indicator.prepare()
  } catch (err) {
    return { ...base, diagnostics: [toDiagnostic(err)] }
  }

  // 2) 批量执行。tickerId / timeframe 必须显式给，否则 timeframe.period 为空
  let res: PineTsContext
  try {
    const pineTS = new PineTS(
      candles.map((c) => ({ ...c, openTime: c.timestamp })),
      opts.tickerId,
      opts.timeframe,
    )
    res = (await pineTS.run(indicator)) as PineTsContext
  } catch (err) {
    return { ...base, diagnostics: [toDiagnostic(err)] }
  }

  const warnings = (res.warnings ?? []).map((w) => String(w))

  /* ---- 元信息 ---- */
  const meta = readMeta(indicator, source)

  /* ---- 绘图数据 ---- */
  const plots: Record<string, (number | null)[]> = {}
  const plotTitles: string[] = []
  let barColor: (string | null)[] = new Array<string | null>(candles.length).fill(null)
  const markers: PineMarker[] = []

  for (const [key, series] of Object.entries(res.plots ?? {})) {
    const title = series?.title ?? key
    if (key === '__labels__' || key === '__lines__') {
      for (const point of series?.data ?? []) {
        const raw = point as unknown as { time?: number; value?: unknown }
        const time = typeof raw.time === 'number' ? raw.time : Number.NaN
        const items = Array.isArray(raw.value) ? raw.value : []
        for (const item of items) {
          const o = item as Record<string, unknown>
          const v = typeof o.price === 'number' ? o.price : typeof o.y === 'number' ? o.y : Number.NaN
          if (Number.isFinite(time) && Number.isFinite(v)) {
            markers.push({
              time,
              value: v,
              ...(typeof o.text === 'string' ? { text: o.text } : {}),
            })
          }
        }
      }
      continue
    }
    if (key.startsWith('__')) {
      if (/bar.?color/i.test(key)) barColor = readPlotValues(series, candles.length) as never
      continue
    }
    plotTitles.push(String(title))
    plots[String(title)] = readPlotValues(series, candles.length)
  }

  /* ---- 券商账本 → 逐 bar 信号 ---- */
  const signals = candles.map(() => emptyPineSignal())
  const merged: PineTsLedgerTrade[] = [
    ...(res.strategy?.closedtrades ?? []).filter((t) => !isMarginCallNoise(t)),
    ...(res.strategy?.opentrades ?? []),
  ]
  const last = candles.length - 1
  const hasExplicitQty = expliciQtyRe.test(source)

  const mark = (i: number, field: 'canLong' | 'canShort' | 'forceClose'): void => {
    if (i < 0 || i > last) return
    ;(signals[i] as unknown as Record<string, boolean>)[field] = true
  }

  for (const t of merged) {
    const isLong = (t.size ?? 1) >= 0
    const entryIdx = Math.max(0, Math.min(last, (t.entry_bar_index ?? 0) + PINE_ENTRY_OFFSET))
    mark(entryIdx, isLong ? 'canLong' : 'canShort')
    if (hasExplicitQty) {
      const qty = Math.abs(t.size ?? Number.NaN)
      if (Number.isFinite(qty) && qty > 0) {
        ;(signals[entryIdx] as unknown as Record<string, number>).entryQty = qty
      }
    }
    // 已平仓的用 exit_bar_index；仍持仓（status = open）的用最后一根收尾
    const exitIdx =
      t.status === 'open' || t.exit_bar_index === undefined
        ? last
        : Math.max(0, Math.min(last, t.exit_bar_index + PINE_ENTRY_OFFSET))
    mark(exitIdx, 'forceClose')
  }

  /*
   * 盘中止损通道：脚本 `plot(…, title="STOP")` 的逐 bar 止损价 → 信号 obStopLoss。
   *
   * PineTS 账本只记录开/平仓成交，适配器原本只能给出 forceClose（下一根开盘平仓），
   * 于是「止损」在瀑布行情里会被跳空穿透（真实案例：Q 一笔 −36.8%，止损位只差 12%）。
   * 引擎本身支持盘中止损（持仓期逐 bar 用 `p <= stopLevel` 判定并按止损价成交），
   * 所以这里把脚本画出来的止损位透传给引擎，由引擎在持仓期间**只收紧**地维护。
   */
  const stopPlot = plots['STOP'] ?? plots['Stop'] ?? plots['__stop']
  if (stopPlot) {
    for (let i = 0; i < signals.length; i++) {
      const v = stopPlot[i]
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) signals[i].obStopLoss = v
    }
  }

  return {
    signals,
    meta: {
      ...meta,
      plotTitles,
      alerts: (res.alerts ?? []).map((a) => ({
        title: String(a.title ?? ''),
        message: String(a.message ?? ''),
      })),
    },
    plots,
    markers,
    barColor,
    diagnostics: [],
    warnings,
  }
}

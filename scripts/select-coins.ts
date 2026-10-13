/**
 * 「选币步骤」：从全部 USDT 永续里筛出一个「值得埋伏 / 跟随」的池子，
 * 再检验 MainWave 在「池子」上是否显著优于「随机全宇宙」。
 *
 * 三段式：
 *   stage1  拉全部合约 → 逐个取 1d 一年数据 → 算流动性 / 上市时长 / 主升浪倾向指标 → output/select/metrics.json
 *   stage2  用硬门槛（流动性、上市时长）过滤 + 主升浪倾向打分 → 取 top N → 随机对半分成 A/B → output/select/pool.json
 *   eval    用脚本默认参数跑 MainWave，对比【池A】/【池B(留出验证)】/【随机全宇宙基线 FRESH】/【被淘汰的掉队组】
 *
 * 用法：
 *   $env:HTTPS_PROXY="http://127.0.0.1:7890"; npx tsx scripts/select-coins.ts list
 *   npx tsx scripts/select-coins.ts stage1
 *   npx tsx scripts/select-coins.ts stage2
 *   npx tsx scripts/select-coins.ts eval
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Candle, StrategyParams } from '../shared/types'
import { runBacktestService } from '../server/src/service/backtestService'
import { fetchKlines, listInstruments } from '../server/src/market/exchange'
import { sma } from '../server/src/indicators/ta'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'output/select')
const MW_FILE = 'server/pine/MainWave/MainWave.pine'

/** 与前面几轮共用的一年窗口 */
const since1y = Date.UTC(2025, 9, 13)
const until1y = Date.UTC(2026, 9, 13)

/** 随机全宇宙基线：本任务开始前就已固定的 22 个随机币（seed 20261013，从未参与调参） */
const FRESH = [
  'API3/USDT:USDT', 'CTSI/USDT:USDT', 'V/USDT:USDT', 'HOLO/USDT:USDT', 'DDOG/USDT:USDT', 'PROM/USDT:USDT',
  'ZHIPU/USDT:USDT', 'SECZ/USDT:USDT', 'HK1810/USDT:USDT', 'GLM/USDT:USDT', 'WAL/USDT:USDT', 'O/USDT:USDT',
  'FIGHT/USDT:USDT', 'STEEM/USDT:USDT', 'KAVA/USDT:USDT', 'GIGGLE/USDT:USDT', 'ROBO/USDT:USDT', 'Q/USDT:USDT',
  'A/USDT:USDT', 'DEXE/USDT:USDT', 'SPX/USDT:USDT', 'FLUID/USDT:USDT',
]
/** 前面几轮已用过的币（调参），选池时必须排除，避免污染 */
const USED = new Set([
  'AKE/USDT:USDT', '币安人生/USDT:USDT', '龙虾/USDT:USDT', 'BANK/USDT:USDT', 'LAB/USDT:USDT', 'MYX/USDT:USDT',
  'PENGU/USDT:USDT', 'WIF/USDT:USDT', 'POPCAT/USDT:USDT', 'TRUMP/USDT:USDT', 'FARTCOIN/USDT:USDT',
  'MOODENG/USDT:USDT', 'PNUT/USDT:USDT', 'ACT/USDT:USDT', 'GOAT/USDT:USDT', 'NEIRO/USDT:USDT',
  'BRETT/USDT:USDT', 'TURBO/USDT:USDT', 'BOME/USDT:USDT', 'DOGS/USDT:USDT',
  ...FRESH,
])

const TF_DAILY = '1d' as const

/* ----------------------------- 指标 ----------------------------- */

interface Metrics {
  symbol: string
  bars: number
  firstTs: number
  ageDays: number
  /** 日均成交额（USDT/天），用 close×volume 近似 */
  avgQuoteVol: number
  /** 日频年化波动率 */
  annVol: number
  /** 回撤 25% zigzag 切出的、历时 ≥10 天且涨幅 ≥40% 的上涨波段数 */
  numWaves: number
  /** 上述波段的涨幅中位数（%）—— 用中位而非最大，避免被单次极端插针带偏 */
  medWaveGain: number
  /** 上述波段中的最大涨幅（%），仅用于展示，不参与打分 */
  maxWave: number
  /** 收盘在 MA200（日线）上方的天数占比 */
  above200: number
  /** 效率比 = |期末−期初| / Σ|逐日变动|，衡量趋势的"平滑/持续"程度（1=单边，≈0=来回震荡） */
  efficiency: number
  /** 一年内创 100 日新高的天数占比 */
  newHigh100: number
  /** 一年内 30 日区间涨幅的最大值（%），仅用于展示，不参与打分 */
  maxRunup30: number
}

/** 计算指标前跳过的日线根数：新上币首日常有 0.001→3.5 这类插针，会伪造出上万倍区间 */
const WARM_DAYS = 30

const fm = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : '—')

function median(a: number[]): number {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y)
  return v.length ? v[(v.length - 1) >> 1] : NaN
}

/** 日频 zigzag：回撤 25% 视为波段结束 */
function zigzagWaves(c: Candle[], zig: number, minBars: number, minGain: number): Array<{ gain: number; bars: number }> {
  const out: Array<{ gain: number; bars: number }> = []
  let dir: 1 | -1 = 1
  let lo = 0
  let hi = 0
  const push = (): void => {
    const gain = c[hi].high / c[lo].low - 1
    if (hi - lo >= minBars && gain >= minGain) out.push({ gain, bars: hi - lo })
  }
  for (let i = 1; i < c.length; i++) {
    if (dir === 1) {
      if (c[i].high >= c[hi].high) hi = i
      else if (c[i].low <= c[hi].high * (1 - zig)) {
        push()
        dir = -1
        lo = i
      }
    } else {
      if (c[i].low <= c[lo].low) lo = i
      else if (c[i].high >= c[lo].low * (1 + zig)) {
        dir = 1
        hi = i
      }
    }
  }
  if (dir === 1 && hi > lo) push()
  return out
}

function computeMetrics(symbol: string, full: Candle[]): Metrics {
  // 丢掉上市首段（新上币插针会伪造出上万倍区间）
  const c = full.slice(WARM_DAYS)
  const n = c.length
  const close = c.map((x) => x.close)
  const high = c.map((x) => x.high)
  const low = c.map((x) => x.low)
  const quoteVol = c.map((x) => x.close * x.volume)

  const avgQuoteVol = quoteVol.reduce((a, b) => a + b, 0) / Math.max(1, n)

  // 年化波动率（日频对数收益 × √365）
  const lr: number[] = []
  for (let i = 1; i < n; i++) if (close[i - 1] > 0 && close[i] > 0) lr.push(Math.log(close[i] / close[i - 1]))
  const mean = lr.reduce((a, b) => a + b, 0) / Math.max(1, lr.length)
  const varr = lr.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lr.length - 1)
  const annVol = Math.sqrt(varr) * Math.sqrt(365)

  // 效率比：趋势越平滑越接近 1
  let pathLen = 0
  for (let i = 1; i < n; i++) pathLen += Math.abs(close[i] - close[i - 1])
  const efficiency = pathLen > 0 ? Math.abs(close[n - 1] - close[0]) / pathLen : NaN

  const waves = zigzagWaves(c, 0.25, 10, 0.4)
  const gains = waves.map((w) => w.gain * 100).sort((a, b) => a - b)
  const medWaveGain = gains.length ? gains[(gains.length - 1) >> 1] : 0

  const ma200 = sma(close, 200)
  let above = 0
  let valid = 0
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(ma200[i]) || ma200[i] <= 0) continue
    valid++
    if (close[i] > ma200[i]) above++
  }
  const above200 = valid ? above / valid : NaN

  // 100 日新高占比
  let nh = 0
  let nhValid = 0
  for (let i = 100; i < n; i++) {
    let isHigh = true
    for (let j = i - 100; j < i; j++) if (high[j] >= high[i]) { isHigh = false; break }
    nhValid++
    if (isHigh) nh++
  }
  const newHigh100 = nhValid ? nh / nhValid : NaN

  // 30 日最大区间涨幅（仅展示）
  let maxRunup30 = NaN
  for (let i = 30; i < n; i++) {
    let lo30 = Infinity
    for (let j = i - 30; j <= i; j++) lo30 = Math.min(lo30, low[j])
    const r = high[i] / lo30 - 1
    if (!Number.isFinite(maxRunup30) || r > maxRunup30) maxRunup30 = r
  }

  return {
    symbol, bars: n,
    firstTs: c[0]?.timestamp ?? 0,
    ageDays: n,
    avgQuoteVol,
    annVol,
    numWaves: waves.length,
    medWaveGain,
    maxWave: waves.length ? Math.max(...waves.map((w) => w.gain * 100)) : 0,
    above200,
    efficiency,
    newHigh100,
    maxRunup30: Number.isFinite(maxRunup30) ? maxRunup30 * 100 : NaN,
  }
}

/* ----------------------------- 统计工具 ----------------------------- */

interface Stat { med: number; mean: number; worst: number; best: number; win: number; valid: number; trades: number }
function stat(rets: number[], trades: number): Stat {
  const s = rets.filter(Number.isFinite).sort((a, b) => a - b)
  return {
    med: s.length ? s[(s.length - 1) >> 1] : NaN,
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN,
    worst: s.length ? Math.min(...s) : NaN,
    best: s.length ? Math.max(...s) : NaN,
    win: s.filter((x) => x > 0).length,
    valid: s.length,
    trades,
  }
}

/* ----------------------------- 主流程 ----------------------------- */

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'list'
  fs.mkdirSync(OUT_DIR, { recursive: true })

  if (mode === 'list') {
    const all = await listInstruments('binanceusdm')
    console.log(`binanceusdm USDT 永续合约：${all.length} 个`)
    const fresh = all.filter((i) => !USED.has(i.symbol))
    console.log(`排除已用过的 ${USED.size} 个后，候选 ${fresh.length} 个`)
    console.log(`示例：${fresh.slice(0, 15).map((i) => i.base).join(', ')} ...`)
    fs.writeFileSync(path.join(OUT_DIR, 'instruments.json'), JSON.stringify(all.map((i) => i.symbol), null, 2), 'utf8')
    return
  }

  if (mode === 'stage1') {
    const all = await listInstruments('binanceusdm')
    const syms = all.map((i) => i.symbol).filter((s) => !USED.has(s))
    console.log(`开始为 ${syms.length} 个候选币拉取 1d 一年数据（走磁盘缓存，已拉过的会很快）...`)
    const metrics: Metrics[] = []
    let done = 0
    let failed = 0
    for (const s of syms) {
      try {
        const { candles } = await fetchKlines({
          exchange: 'binanceusdm', symbol: s, timeframe: TF_DAILY, since: since1y, until: until1y, targetBars: 400,
        })
        if (candles.length < WARM_DAYS + 150) continue
        metrics.push(computeMetrics(s, candles))
      } catch {
        failed++
      }
      done++
      if (done % 25 === 0) console.log(`  进度 ${done}/${syms.length}（失败 ${failed}）`)
    }
    metrics.sort((a, b) => b.avgQuoteVol - a.avgQuoteVol)
    fs.writeFileSync(path.join(OUT_DIR, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8')
    console.log(`\n完成：成功 ${metrics.length} 个，失败/数据不足 ${failed} 个 → output/select/metrics.json`)
    console.log(`日均成交额中位：${fm(median(metrics.map((m) => m.avgQuoteVol)), 0)} USDT`)
    console.log(`有 ≥1 波主升浪(numWaves≥1) 的币：${metrics.filter((m) => m.numWaves >= 1).length} / ${metrics.length}`)
    return
  }

  if (mode === 'stage2') {
    const metrics = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'metrics.json'), 'utf8')) as Metrics[]

    /* 硬门槛：历史长度 + 流动性 */
    const MIN_AGE = 150            // 跳掉上市首 30 天后仍需 ≥150 天历史（≈上市半年）
    const GATE_VOL = 300_000       // 日均成交额 ≥ 30 万 USDT
    const gate = metrics.filter(
      (m) => m.bars >= MIN_AGE && Number.isFinite(m.avgQuoteVol) && m.avgQuoteVol >= GATE_VOL,
    )
    console.log(`候选 ${metrics.length} → 过门槛（≥${MIN_AGE}天 且 日均额≥${GATE_VOL / 10000}万）：${gate.length}`)

    /*
     * 打分：**百分位排名**而非 z-score。
     * 极值（如某币单日 13 倍、年化波动 10 倍）会把 z-score 的均值/方差彻底带偏，
     * 使 95% 的币挤在 0 附近；百分位排名对极值天然免疫。
     * 打分哲学也改了：不追「历史暴涨最猛」，而是偏「可持续的平滑趋势」——
     * 暴涨最猛的币往往是低流动性 meme，在 1h 上制造大量假突破。
     */
    const percentile = (vals: number[]): number[] => {
      const idx = vals.map((v, i) => ({ v: Number.isFinite(v) ? v : -Infinity, i })).sort((a, b) => a.v - b.v)
      const out = new Array<number>(vals.length).fill(0)
      idx.forEach((o, r) => { out[o.i] = vals.length > 1 ? r / (vals.length - 1) : 0 })
      return out
    }
    const pAbove = percentile(gate.map((m) => m.above200))                 // 长期在 MA200 上方
    const pEff = percentile(gate.map((m) => m.efficiency))                 // 趋势平滑/持续
    const pWave = percentile(gate.map((m) => Math.min(m.numWaves, 4)))      // 1~4 波都算「够」，再多不加分
    const pGain = percentile(gate.map((m) => m.medWaveGain))               // 波段涨幅中位数
    const scored = gate
      .map((m, i) => ({
        ...m,
        score: 0.30 * pAbove[i] + 0.30 * pEff[i] + 0.20 * pWave[i] + 0.20 * pGain[i],
      }))
      .sort((a, b) => b.score - a.score)

    const TOPN = 40
    const pool = scored.slice(0, TOPN)

    /* 随机对半（种子固定，可复现） → A 调参/观察，B 严格留出验证 */
    const seed = 20261013
    let s0 = seed
    const rand = (): number => {
      s0 = (s0 * 1103515245 + 12345) & 0x7fffffff
      return s0 / 0x7fffffff
    }
    const idx = pool.map((_, i) => i)
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[idx[i], idx[j]] = [idx[j], idx[i]]
    }
    const A = idx.slice(0, TOPN / 2).map((i) => pool[i])
    const B = idx.slice(TOPN / 2).map((i) => pool[i])

    /* 掉队对照组：过了门槛但打分靠后的 40 个（用来看「打分是否真有区分度」）*/
    const tail = scored.slice(-TOPN)
    /* 中位带对照：等距取全宇宙打分居中的 40 个（检验「收益随打分单调变化」）*/
    const midStart = Math.floor((scored.length - TOPN) / 2)
    const mid = scored.slice(midStart, midStart + TOPN)
    /*
     * ★ 最关键的对照：从「同一门槛集合」里随机抽 40 个（排除已选出的 top40）。
     * 它与选池共享完全相同的宇宙与门槛，唯一区别就是「有没有被选币规则选中」——
     * 排除掉「选池只是恰好抽到了好币」和「品种类型混淆」两种可能。
     */
    const rest = scored.slice(TOPN)
    const restIdx = rest.map((_, i) => i)
    for (let i = restIdx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[restIdx[i], restIdx[j]] = [restIdx[j], restIdx[i]]
    }
    const randControl = restIdx.slice(0, TOPN).map((i) => rest[i])

    fs.writeFileSync(
      path.join(OUT_DIR, 'pool.json'),
      JSON.stringify({
        gateCount: gate.length,
        TOPN,
        poolA: A.map((m) => m.symbol),
        poolB: B.map((m) => m.symbol),
        randControl: randControl.map((m) => m.symbol),
        midBand: mid.map((m) => m.symbol),
        tailControl: tail.map((m) => m.symbol),
        scored: pool,
      }, null, 2),
      'utf8',
    )

    console.log(`\n===== 选出的池子 top${TOPN}（按"可持续趋势"打分排序）=====`)
    console.log(`${'排名'.padStart(4)} ${'币'.padEnd(12)} ${'得分'.padStart(6)} ${'MA200上方'.padStart(9)} ${'效率比'.padStart(7)} ${'波段数'.padStart(6)} ${'波段涨幅中位%'.padStart(12)} ${'日均额(万)'.padStart(10)} ${'半区'.padStart(5)}`)
    pool.forEach((m, i) => {
      const half = A.includes(m) ? 'A' : 'B'
      console.log(
        `${String(i + 1).padStart(4)} ${m.symbol.split('/')[0].padEnd(12)} ${fm(m.score, 3).padStart(6)} ` +
        `${fm(m.above200, 2).padStart(9)} ${fm(m.efficiency, 2).padStart(7)} ${String(m.numWaves).padStart(6)} ` +
        `${fm(m.medWaveGain, 0).padStart(12)} ${fm(m.avgQuoteVol / 10000, 0).padStart(10)} ${half.padStart(5)}`,
      )
    })
    console.log(`\n掉队对照组（同样过门槛、但打分最低的 ${TOPN} 个，首位：${tail.slice(0, 5).map((m) => m.symbol.split('/')[0]).join(', ')}...）`)
    console.log(`\n池A（${A.length}）: ${A.map((m) => m.symbol.split('/')[0]).join(' ')}`)
    console.log(`池B（${B.length}）: ${B.map((m) => m.symbol.split('/')[0]).join(' ')}`)
    return
  }

  if (mode === 'eval') {
    const pool = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'pool.json'), 'utf8')) as {
      poolA: string[]; poolB: string[]; randControl: string[]; midBand: string[]; tailControl: string[]
    }
    const source = fs.readFileSync(path.join(ROOT, MW_FILE), 'utf8')

    const runSet = async (symbols: string[]): Promise<Stat & { per: number[] }> => {
      const rets: number[] = []
      let trades = 0
      for (const s of symbols) {
        const params: Partial<StrategyParams> = {
          strategy: 'pine', initialCapital: 1000, commissionPercent: 0.055,
          leverage: 3, positionSizePercent: 100, slippageTicks: 0, useScriptPositionSize: true,
        }
        try {
          const res = await runBacktestService({
            exchange: 'binanceusdm', symbol: s, timeframe: '1h', since: since1y, until: until1y, params,
            pine: { source, name: MW_FILE, inputs: {} },
          })
          rets.push(res.report.totalReturnPercent)
          trades += res.report.stats.totalTrades
        } catch {
          rets.push(NaN)
        }
      }
      return { ...stat(rets, trades), per: rets }
    }

    const groups: Array<{ title: string; syms: string[] }> = [
      { title: '★ 随机全宇宙基线（FRESH 22，从 745 个合约随机、未参与调参）', syms: FRESH },
      { title: '★ 选池 A 半区（40 个里的一半，调参/观察）', syms: pool.poolA },
      { title: '★ 选池 B 半区（严格留出验证，从未看过结果）', syms: pool.poolB },
      { title: '★ 同门槛随机对照（同宇宙同门槛，随机抽 40，未被选中）', syms: pool.randControl },
      { title: '对照：全宇宙打分居中带（等距取 40 个）', syms: pool.midBand },
      { title: '对照：过门槛但打分最低的掉队组', syms: pool.tailControl },
    ]

    const results: Record<string, Stat> = {}
    console.log('\n===== MainWave（脚本默认参数）在六个集合上的表现 =====')
    for (const g of groups) {
      const r = await runSet(g.syms)
      results[g.title] = r
      console.log(
        `\n${g.title}\n  中位 ${fm(r.med, 1)}%  均值 ${fm(r.mean, 1)}%  最差 ${fm(r.worst, 1)}%  最好 ${fm(r.best, 1)}%  ` +
        `为正 ${r.win}/${r.valid}  笔数 ${r.trades}`,
      )
      const lines = g.syms.map((s, i) => {
        const v = r.per[i]
        return v
      })
      console.log(`  ${lines.map((v, i) => `${g.syms[i].split('/')[0]}:${Number.isFinite(v) ? v.toFixed(0) : '—'}`).join('  ')}`)
    }

    fs.writeFileSync(
      path.join(OUT_DIR, 'eval.json'),
      JSON.stringify({ groups, results }, null, 2),
      'utf8',
    )
    return
  }

  /*
   * stack：把两个已被单独验证为正的杠杆**叠加**看能否相乘——
   *   杠杆①「选池」（§11）：选池中位 +7.0% vs 同门槛随机 -0.6%
   *   杠杆②「入场稀有化」（§10.6）：突破窗口 20 天→60 天是中位唯一单调有效的改进
   * 在【池A】上挑窗口、在【池B(留出)】上确认，另附同门槛随机对照。
   */
  if (mode === 'stack') {
    const pool = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'pool.json'), 'utf8')) as {
      poolA: string[]; poolB: string[]; randControl: string[]
    }
    const source = fs.readFileSync(path.join(ROOT, MW_FILE), 'utf8')
    const groups: Array<{ title: string; syms: string[] }> = [
      { title: '池A', syms: pool.poolA },
      { title: '池B(留出)', syms: pool.poolB },
      { title: '同门槛随机', syms: pool.randControl },
    ]
    const runSet = async (symbols: string[], inputs: Record<string, number>): Promise<Stat> => {
      const rets: number[] = []
      let trades = 0
      for (const s of symbols) {
        const params: Partial<StrategyParams> = {
          strategy: 'pine', initialCapital: 1000, commissionPercent: 0.055,
          leverage: 3, positionSizePercent: 100, slippageTicks: 0, useScriptPositionSize: true,
        }
        try {
          const res = await runBacktestService({
            exchange: 'binanceusdm', symbol: s, timeframe: '1h', since: since1y, until: until1y, params,
            pine: { source, name: MW_FILE, inputs },
          })
          rets.push(res.report.totalReturnPercent)
          trades += res.report.stats.totalTrades
        } catch {
          rets.push(NaN)
        }
      }
      return stat(rets, trades)
    }

    console.log('\n===== 杠杆叠加：选池 × 突破窗口（入场稀有化）=====')
    console.log(`${'突破窗口'.padEnd(16)} | ${'池A 中位/均值/为正'.padStart(22)} | ${'池B 中位/均值/为正'.padStart(22)} | ${'随机对照 中位/均值/为正'.padStart(24)}`)
    const rows: Array<Record<string, unknown>> = []
    for (const bl of [720, 960, 1440]) {
      const inputs = { brkLen: bl }
      const out: Record<string, Stat> = {}
      const cells: string[] = []
      for (const g of groups) {
        const r = await runSet(g.syms, inputs)
        out[g.title] = r
        cells.push(`${fm(r.med, 1).padStart(6)} ${fm(r.mean, 1).padStart(7)} ${String(r.win + '/' + r.valid).padStart(6)}`)
      }
      console.log(
        `${`${bl}根(${Math.round(bl / 24)}天)`.padEnd(16)} | ${cells[0].padStart(22)} | ${cells[1].padStart(22)} | ${cells[2].padStart(24)}`,
      )
      rows.push({ brkLen: bl, ...out })
    }
    fs.writeFileSync(path.join(OUT_DIR, 'stack.json'), JSON.stringify(rows, null, 2), 'utf8')
    return
  }

  console.log(`未知模式：${mode}（可用 list / stage1 / stage2 / eval / stack）`)
}

main().catch((e) => { console.error('失败：', e instanceof Error ? e.message : e); process.exit(1) })

/**
 * 测试 ccxt 官方示例（OKX BTC/USD 15m 拉 K 线 + asciichart 画图）能否在当前环境运行。
 *
 * 与原示例的差异（其余逻辑保持一致）：
 *   1. 原示例 `import ccxt from '../../js/ccxt.js'` 指向 **ccxt 源码仓库**里的构建产物，
 *      本仓库并没有那份文件，这里改用项目依赖的 npm 包 `ccxt`；
 *   2. `asciichart / as-table / ololog / ansicolor` 是可选展示依赖，未安装时
 *      自动退化为内置迷你走势图与纯文本输出，不影响核心链路的验证。
 *
 * 用法：
 *   pnpm exec tsx scripts/test-ccxt-example.ts                 # 默认 okx / BTC/USD / 15m
 *   pnpm exec tsx scripts/test-ccxt-example.ts okx ETH/USDT 1h
 *   pnpm exec tsx scripts/test-ccxt-example.ts binance BTC/USDT 1h
 */

import { execSync } from 'node:child_process'
import ccxt from 'ccxt'

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 30_000)
/** 与原示例一致：下标 4 为收盘价 */
const CLOSE_INDEX = 4

const [exchangeId = 'okx', symbol = 'BTC/USDT', timeframe = '15m'] = process.argv.slice(2)

/**
 * 读取 Windows 的 WinINET 系统代理。
 *
 * 浏览器（Chrome/Edge）走的就是这里配置的代理，而 **Node 默认完全不用它** ——
 * 这正是「浏览器能打开交易所接口、ccxt 却超时」最常见的原因：
 * 直连时 DNS 可能被劫持到 169.254.x.x，或 TLS 握手被重置。
 */
function winInetProxy(): string | null {
  if (process.platform !== 'win32') return null
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const m = /ProxyServer\s+REG_SZ\s+(.+)/.exec(out)
    if (!m) return null
    const raw = m[1].trim()
    // 可能是 "127.0.0.1:7890"，也可能是 "http=host:port;https=host:port"
    const httpsPart = /https=([^;]+)/.exec(raw)
    const value = (httpsPart ? httpsPart[1] : (/http=([^;]+)/.exec(raw)?.[1] ?? raw)).trim()
    return value ? (value.startsWith('http') ? value : `http://${value}`) : null
  } catch {
    return null
  }
}

/** 代理优先级：环境变量 > Windows 系统代理（与浏览器保持一致） */
function resolveProxy(): string | null {
  return (
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy ??
    winInetProxy()
  )
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）—— 通常是网络无法访问该交易所`)), ms),
    ),
  ])
}

/** 可选依赖：缺失时返回 null，不影响主流程 */
async function tryImport(name: string): Promise<any | null> {
  try {
    const mod = await import(name)
    return mod?.default ?? mod
  } catch {
    return null
  }
}

/** 无依赖的迷你走势图（8 级字符），替代 asciichart 的降级方案 */
function sparkline(values: readonly number[]): string {
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
  if (values.length === 0) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return values
    .map((v) => blocks[Math.min(blocks.length - 1, Math.floor(((v - min) / span) * blocks.length))])
    .join('')
}

async function main(): Promise<void> {
  console.log(`ccxt ${ccxt.version} · 交易所 ${exchangeId} · ${symbol} ${timeframe}\n`)

  /* ---------- 1) 创建交易所实例 ---------- */
  const Ctor = (ccxt as unknown as Record<string, unknown>)[exchangeId]
  if (typeof Ctor !== 'function') {
    throw new Error(`ccxt 不支持交易所 "${exchangeId}"`)
  }
  const proxy = resolveProxy()
  // 注意：ccxt 不允许同时设置 httpProxy 与 httpsProxy，这里统一用 httpsProxy
  const exchange = new (Ctor as new (cfg?: object) => ccxt.Exchange)({
    enableRateLimit: true,
    ...(proxy ? { httpsProxy: proxy } : {}),
  })
  console.log(
    `[1/4] 创建实例 ✓  ${exchange.id}${proxy ? `（已套用代理 ${proxy}）` : '（直连，未检测到代理）'}`,
  )

  // ccxt 使用 httpsProxy 前需要显式加载代理模块（依赖 https-proxy-agent）
  if (proxy) {
    const loader = (exchange as unknown as { loadProxyModules?: () => Promise<void> })
      .loadProxyModules
    if (typeof loader === 'function') await loader.call(exchange)
  }

  /* ---------- 2) 拉取 K 线（原示例的核心调用） ---------- */
  const t0 = Date.now()
  const ohlcv = await withTimeout(
    exchange.fetchOHLCV(symbol, timeframe),
    TIMEOUT_MS,
    'fetchOHLCV',
  )
  const cost = Date.now() - t0
  if (!Array.isArray(ohlcv) || ohlcv.length === 0) {
    throw new Error('fetchOHLCV 返回空数据')
  }
  console.log(`[2/4] fetchOHLCV ✓  ${ohlcv.length} 根，用时 ${cost}ms`)

  /* ---------- 3) 校验数据结构 [ts, open, high, low, close, volume] ---------- */
  const row = ohlcv[ohlcv.length - 1]
  const shapeOK = row.length >= 6 && row.slice(1, 6).every((v) => Number.isFinite(v))
  if (!shapeOK) throw new Error(`返回结构异常：${JSON.stringify(row).slice(0, 120)}`)
  console.log(`[3/4] 数据结构 ✓  [timestamp, open, high, low, close, volume]`)

  /* ---------- 4) 提取收盘价并绘图（含可选依赖降级） ---------- */
  const lastPrice = ohlcv[ohlcv.length - 1][CLOSE_INDEX] as number
  const series = ohlcv.map((x) => x[CLOSE_INDEX] as number)

  const asciichart = await tryImport('asciichart')
  const ansicolor = await tryImport('ansicolor')
  const asTable = await tryImport('as-table')
  const ololog = await tryImport('ololog')

  const missing = [
    ['asciichart', asciichart],
    ['ansicolor', ansicolor],
    ['as-table', asTable],
    ['ololog', ololog],
  ]
    .filter(([, mod]) => !mod)
    .map(([name]) => name)

  let chart: string
  if (asciichart) {
    chart = asciichart.plot(series, { height: 15, padding: '            ' })
  } else {
    chart = '    ' + sparkline(series.slice(-120))
  }

  const rate = `₿ = $${lastPrice}`
  console.log('[4/4] 绘图 ✓\n')
  console.log(chart)
  console.log(`\n${rate}`)

  if (asTable) {
    const rows = [
      { 项目: 'K 线数', 值: String(ohlcv.length) },
      { 项目: '首价', 值: String(series[0]) },
      { 项目: '末价', 值: String(lastPrice) },
      { 项目: '最高', 值: String(Math.max(...series)) },
      { 项目: '最低', 值: String(Math.min(...series)) },
    ]
    console.log('\n' + asTable(rows))
  }
  if (ololog?.configure) {
    ololog.configure({ locate: false }).info('（ololog 可用，原样输出这条日志）')
  }
  if (ansicolor?.nice) {
    console.log(ansicolor.green('（ansicolor 可用：这行应为绿色）'))
  }

  console.log('\n=========== 结论 ===========')
  console.log(`原示例的核心链路可以运行：ccxt ${ccxt.version} → ${exchange.id} → ${symbol} ${timeframe}`)
  if (missing.length > 0) {
    console.log(
      `未安装的展示依赖：${missing.join(', ')}（已用内置降级方案替代）。` +
        `\n如需 1:1 运行原示例：pnpm add -D ${missing.join(' ')}`,
    )
  }
  if (typeof (ccxt as unknown as { okx?: unknown }).okx === 'function') {
    console.log('提示：原示例的 `import ccxt from "../../js/ccxt.js"` 只在 ccxt 源码仓库内有效，')
    console.log('      在本项目里应写成 `import ccxt from "ccxt"`（或用 unplugin 的 ccxt.js）。')
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const raw = err instanceof Error ? err.message : String(err)
    const msg =
      err instanceof Error ? `${raw}\n${err.stack?.split('\n').slice(1, 3).join('\n') ?? ''}` : raw
    console.error('\n=========== 运行失败 ===========')
    console.error(msg)
    console.error('\n排查建议：')

    if (/timed? ?out|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed|getaddrinfo/i.test(raw)) {
      const proxy = resolveProxy()
      console.error(
        proxy
          ? `  · 走的是代理 ${proxy}，但连接仍失败：确认代理进程在运行、端口正确（或改用 HTTPS_PROXY=... 指定）`
          : '  · 疑似网络不可达：若浏览器能打开该交易所而这里不行，多半是代理问题 ——\n' +
            '    Node 默认不使用 Windows 系统代理，可显式指定：\n' +
            '      HTTPS_PROXY=http://127.0.0.1:7890 pnpm exec tsx scripts/test-ccxt-example.ts okx BTC/USDT 15m',
      )
      console.error('  · 也可换一家可达的交易所对比，例如 gate / bybit / bitget')
      console.error('  · 或放宽超时：TIMEOUT_MS=60000')
    }
    if (/does not have market symbol|BadSymbol/i.test(raw)) {
      console.error(
        '  · 交易对在该交易所不存在：OKX 现货没有 BTC/USD，请用 BTC/USDT；\n' +
          '    想跑原始 BTC/USD 可换 bitstamp / kraken / coinbase 等交易所',
      )
    }
    process.exit(1)
  })

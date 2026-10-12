/**
 * 用本机 Chrome 的无头模式 + CDP 做一次真实界面验证：
 *   - 打开应用、等待自动回测完成
 *   - 收集 console 错误 / 未捕获异常 / 失败请求
 *   - 逐个切换标签页并截图
 *
 * 用法： node scripts/ui-check.mjs [url]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../output/screenshots')
const URL_TARGET = process.argv[2] ?? 'http://127.0.0.1:8787/'
const PORT = 9333

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p))
if (!chromePath) {
  console.error('未找到 Chrome/Edge')
  process.exit(1)
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-check-'))

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--mute-audio',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1680,1400',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* 还没起来 */
    }
    await sleep(400)
  }
  throw new Error('Chrome 调试端口未就绪')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.handlers = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (p) {
          this.pending.delete(msg.id)
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
        }
      } else if (msg.method) {
        const hs = this.handlers.get(msg.method)
        if (hs) for (const h of hs) h(msg.params)
      }
    })
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, [])
    this.handlers.get(method).push(fn)
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`${method} 超时`))
        }
      }, 180_000)
    })
  }
}

const consoleErrors = []
const consoleWarns = []
const exceptions = []
const failedRequests = []
const responsesBad = []

async function main() {
  const wsUrl = await findTarget()
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const cdp = new Cdp(ws)

  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')
    if (p.type === 'error') consoleErrors.push(text)
    else if (p.type === 'warning') consoleWarns.push(text)
  })
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails
    exceptions.push(`${d.text} ${d.exception?.description ?? ''}`.trim())
  })
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') consoleErrors.push(`[${p.entry.source}] ${p.entry.text}`)
  })
  cdp.on('Network.loadingFailed', (p) => {
    failedRequests.push(`${p.type} ${p.errorText} ${p.blockedReason ?? ''}`)
  })
  cdp.on('Network.responseReceived', (p) => {
    if (p.response.status >= 400) responsesBad.push(`${p.response.status} ${p.response.url}`)
  })

  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Network.enable')
  await cdp.send('Page.enable')

  console.log(`打开 ${URL_TARGET}`)
  await cdp.send('Page.navigate', { url: URL_TARGET })

  // 等待回测完成：页面上出现「总收益率」KPI
  let ready = false
  for (let i = 0; i < 150; i++) {
    await sleep(2000)
    const r = await cdp.send('Runtime.evaluate', {
      expression: `document.body ? document.body.innerText : ''`,
      returnByValue: true,
    })
    const text = r.result.value ?? ''
    if (text.includes('总收益率') && text.includes('夏普比率')) {
      ready = true
      console.log(`回测完成（等待 ${(i + 1) * 2}s）`)
      break
    }
    if (text.includes('回测失败') || text.includes('请求失败')) {
      console.log('页面出现错误提示：', text.slice(0, 400))
      break
    }
  }
  if (!ready) console.log('警告：未在超时内检测到回测结果 KPI')

  // 等待 K 线画布出现。
  // 开发模式下 Vite 按模块逐个加载（未打包），KLineChart 比生产构建晚不少，
  // 单次采样容易只拿到 canvas=0，因此这里轮询等待。
  let canvasCount = 0
  for (let i = 0; i < 30; i++) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelectorAll('canvas').length`,
      returnByValue: true,
    })
    canvasCount = r.result.value ?? 0
    if (canvasCount > 0) {
      if (i > 0) console.log(`K 线画布已出现（额外等待 ${i * 2}s）`)
      break
    }
    await sleep(2000)
  }
  if (canvasCount === 0) console.log('警告：未检测到任何 canvas 元素')

  // 页面文本摘要
  const body = await cdp.send('Runtime.evaluate', {
    expression: `document.body ? document.body.innerText.slice(0, 4000) : ''`,
    returnByValue: true,
  })
  fs.writeFileSync(path.join(OUT_DIR, 'page-text.txt'), body.result.value ?? '', 'utf8')

  // 关键 DOM 断言
  const checks = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      klineCanvas: document.querySelectorAll('canvas').length,
      papers: document.querySelectorAll('.MuiPaper-root').length,
      tabs: [...document.querySelectorAll('[role=tab]')].map(e=>e.textContent),
      bodyLen: (document.body?.innerText||'').length,
      hasChart: !!document.querySelector('canvas'),
    })`,
    returnByValue: true,
  })
  console.log('DOM 检查:', checks.result.value)

  async function shot(name, tabLabel) {
    if (tabLabel) {
      const clicked = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const t = [...document.querySelectorAll('[role=tab]')].find(e => e.textContent.includes(${JSON.stringify(
            tabLabel,
          )}));
          if (t) { t.click(); return true } return false
        })()`,
        returnByValue: true,
      })
      if (!clicked.result.value) console.log(`  (未找到标签 ${tabLabel})`)
      await sleep(2500)
    }
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    })
    const file = path.join(OUT_DIR, `${name}.png`)
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`  截图 ${file}`)
  }

  await shot('01-chart')
  await shot('02-equity', '收益分析')
  await shot('03-analysis', '交易分析')
  await shot('04-trades', '交易明细')
  await shot('05-report', '回测报告')

  console.log('\n=========== 验证结果 ===========')
  console.log('未捕获异常:', exceptions.length, exceptions.slice(0, 5))
  console.log('console.error:', consoleErrors.length, consoleErrors.slice(0, 8))
  console.log('console.warn:', consoleWarns.length, consoleWarns.slice(0, 5))
  console.log('失败请求:', failedRequests.length, failedRequests.slice(0, 5))
  console.log('4xx/5xx 响应:', responsesBad.length, responsesBad.slice(0, 5))
  console.log('================================')

  ws.close()
  chrome.kill()
  await sleep(500)
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }

  const ok = exceptions.length === 0 && consoleErrors.length === 0
  process.exit(ok ? 0 : 2)
}

main().catch((err) => {
  console.error('验证失败:', err)
  chrome.kill()
  process.exit(1)
})

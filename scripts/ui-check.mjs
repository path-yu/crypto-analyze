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

  // 视口尺寸：--size=2160x1050（用于验证宽屏响应式布局）
  const sizeArg = process.argv.find((a) => a.startsWith('--size='))
  if (sizeArg) {
    const [w, h] = sizeArg.slice('--size='.length).split('x').map(Number)
    if (w > 0 && h > 0) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      })
      console.log(`视口设为 ${w}×${h}`)
    }
  }

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
  // 开发模式下 Vite 按模块逐个加载（未打包），Vela 的渲染画布比生产构建晚不少，
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

  // 可选：切到 Volume Order Block 策略并重跑一遍（node scripts/ui-check.mjs <url> --ob）
  if (process.argv.includes('--ob')) {
    const click = async (expression, note) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
      if (!r.result.value) console.log(`  (失败) ${note}`)
      return r.result.value === true
    }

    console.log('切换到 Volume Order Block 策略…')
    // MUI 的 Select 由 mousedown 触发展开，需要手动派发鼠标事件
    await click(
      `(() => {
        const fire = (el, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        const label = [...document.querySelectorAll('label')].find(e => e.textContent.trim() === '策略');
        const combo = label && label.parentElement.querySelector('[role=combobox]');
        if (!combo) return false;
        fire(combo, 'mousedown'); fire(combo, 'mouseup'); fire(combo, 'click');
        return true;
      })()`,
      '打开策略下拉',
    )
    await sleep(900)
    await click(
      `(() => {
        const fire = (el, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        const opt = [...document.querySelectorAll('[role=option]')].find(e => e.textContent.includes('Volume Order Block'));
        if (!opt) return false;
        fire(opt, 'mousedown'); fire(opt, 'mouseup'); fire(opt, 'click');
        return true;
      })()`,
      '选择订单块策略',
    )
    await sleep(800)
    await click(
      `(() => {
        const btn = [...document.querySelectorAll('button')].find(e => e.textContent.includes('开始回测'));
        if (!btn) return false;
        btn.click();
        return true;
      })()`,
      '点击开始回测',
    )

    // 等待顶部标题切换为 Volume Order Block
    let switched = false
    for (let i = 0; i < 90; i++) {
      await sleep(2000)
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(document.body?.innerText || '').includes('Volume Order Block')`,
        returnByValue: true,
      })
      if (r.result.value) {
        switched = true
        console.log(`订单块回测完成（等待 ${(i + 1) * 2}s）`)
        break
      }
    }
    if (!switched) console.log('警告：未检测到订单块策略的回测结果')

    const obText = await cdp.send('Runtime.evaluate', {
      expression: `(document.body?.innerText || '').replace(/\\n+/g, ' | ').slice(0, 1200)`,
      returnByValue: true,
    })
    console.log('页面摘要:', obText.result.value)
  }

  await shot('01-chart')

  // 验证「点 K 线 → 打开该笔交易明细」：在图表主体区派发一次真实鼠标点击
  const chartBox = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const cs = [...document.querySelectorAll('canvas')]
        .map((c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
        .filter((r) => r.w > 200 && r.h > 100);
      if (cs.length === 0) return null;
      const main = cs.sort((a, b) => b.w * b.h - a.w * a.h)[0];
      return { x: Math.round(main.x + main.w * 0.5), y: Math.round(main.y + main.h * 0.35) };
    })()`,
    returnByValue: true,
  })
  if (chartBox.result.value) {
    const { x, y } = chartBox.result.value
    // 诊断：统计图表容器上真实收到的鼠标/指针事件（用于定位「点选无反应」）
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        window.__clickProbe = { mouse: 0, pointer: 0 };
        document.addEventListener('mousedown', () => { window.__clickProbe.mouse++ }, true);
        document.addEventListener('pointerdown', () => { window.__clickProbe.pointer++ }, true);
        return true;
      })()`,
      returnByValue: true,
    })
    let openedAny = false
    // 沿时间轴扫一批位置：单笔交易只覆盖少量 K 线，点得足够密才能命中
    const ratios = Array.from({ length: 24 }, (_, i) => (i + 0.5) / 24)
    for (const ratio of ratios) {
      const cx = Math.round(x + (ratio - 0.5) * 900)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: cx, y, button: 'left', clickCount: 1 })
      }
      await sleep(220)
      const opened = await cdp.send('Runtime.evaluate', {
        expression: `Boolean(document.querySelector('[role=dialog]'))`,
        returnByValue: true,
      })
      if (opened.result.value) {
        openedAny = true
        await shot('07-chart-trade-detail')
        await cdp.send('Runtime.evaluate', {
          expression: `document.querySelector('.MuiBackdrop-root')?.click()`,
          returnByValue: true,
        })
        await sleep(400)
        break
      }
    }
    const probe = await cdp.send('Runtime.evaluate', {
      expression: `window.__clickProbe ? JSON.stringify(window.__clickProbe) : 'no-probe'`,
      returnByValue: true,
    })
    console.log('图表点选是否打开交易明细:', openedAny, '· 事件计数:', probe.result.value)
  }
  await shot('02-equity', '收益分析')

  // 布局检查：横向溢出 / 越界元素 / 关键容器宽度
  const layout = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const vw = window.innerWidth;
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right) };
      };
      const container = document.querySelector('.MuiContainer-root');
      const grid = container && container.firstElementChild;
      const cols = grid ? [...grid.children].map(rect) : [];
      const overflow = [...document.querySelectorAll('body *')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > vw + 1;
        })
        .slice(0, 10)
        .map((el) => el.tagName + '|' + String(el.className || '').slice(0, 40) + '|right=' + Math.round(el.getBoundingClientRect().right) + '|w=' + Math.round(el.getBoundingClientRect().width));
      return JSON.stringify({
        innerWidth: vw,
        innerHeight: window.innerHeight,
        docScrollWidth: document.documentElement.scrollWidth,
        overflowX: document.documentElement.scrollWidth - vw,
        cols,
        overflow,
      });
    })()`,
    returnByValue: true,
  })
  console.log('布局检查:', layout.result.value)

  await shot('03-analysis', '交易分析')
  await shot('04-trades', '交易明细')

  // 打开第一行的单笔交易弹窗：确认弹窗布局正常、成交明细表没有横向滚动
  const openedDialog = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const rows = [...document.querySelectorAll('tbody tr')].filter((r) => r.querySelector('td'));
      if (rows.length === 0) return false;
      rows[0].click();
      return true;
    })()`,
    returnByValue: true,
  })
  if (openedDialog.result.value) {
    await sleep(900)
    await shot('06-trade-detail')
    const dialogCheck = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const dlg = document.querySelector('[role=dialog]');
        if (!dlg) return { ok: false, reason: 'no-dialog' };
        const overflowing = [...dlg.querySelectorAll('*')]
          .filter((e) => e.scrollWidth - e.clientWidth > 2)
          .map((e) => (typeof e.className === 'string' ? e.className.slice(0, 40) : e.tagName));
        return { ok: overflowing.length === 0, overflowing: overflowing.slice(0, 5) };
      })()`,
      returnByValue: true,
    })
    console.log('交易明细弹窗检查:', dialogCheck.result.value)
  } else {
    console.log('  (交易明细表暂无数据行，跳过弹窗检查)')
  }

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

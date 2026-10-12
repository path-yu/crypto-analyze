/** 临时：在一批视口宽度下测量横向溢出与关键容器布局 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p))
if (!CHROME) throw new Error('未找到 Chrome/Edge')

const PORT = 9335
const url = process.argv[2] ?? 'http://127.0.0.1:8787/'
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-sweep-'))

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  let wsUrl = null
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null
    } catch {
      /* retry */
    }
    if (!wsUrl) await sleep(400)
  }
  if (!wsUrl) throw new Error('调试端口未就绪')

  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })

  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
      }
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params }))
      setTimeout(() => {
        if (pending.has(mid)) {
          pending.delete(mid)
          reject(new Error(`${method} 超时`))
        }
      }, 120_000)
    })

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true })
    return r.result.value
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.navigate', { url })
  await sleep(6000)
  // 切到「收益分析」标签，让图表都挂载
  await evaluate(`(() => {
    const t = [...document.querySelectorAll('[role=tab]')].find(e => e.textContent.includes('收益分析'));
    if (t) t.click();
    return !!t;
  })()`)
  await sleep(3000)

  const widths = [1536, 1600, 1680, 1728, 1800, 1920, 2048, 2304, 2560, 2880, 3200, 3440, 3840]
  const heights = { 3440: 1440, 3840: 1600 }

  for (const w of widths) {
    const h = heights[w] ?? 1000
    await send('Emulation.setDeviceMetricsOverride', {
      width: w,
      height: h,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(900)
    const out = await evaluate(`(() => {
      const vw = window.innerWidth;
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right) };
      };
      const container = document.querySelector('.MuiContainer-root');
      const grid = container && container.firstElementChild;
      const cols = grid ? [...grid.children].map(rect) : [];
      const over = [...document.querySelectorAll('body *')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > vw + 1;
        })
        .slice(0, 6)
        .map((el) => el.tagName + '|' + String(el.className || '').slice(0, 36) + '|right=' + Math.round(el.getBoundingClientRect().right) + '|w=' + Math.round(el.getBoundingClientRect().width));
      return JSON.stringify({
        vw,
        vh: window.innerHeight,
        scrollW: document.documentElement.scrollWidth,
        overX: document.documentElement.scrollWidth - vw,
        cols: cols.map((c) => c.w),
        over,
      });
    })()`)
    console.log(String(w).padStart(5), out)
  }

  ws.close()
  chrome.kill()
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* 临时目录留给系统清理 */
  }
}

main().catch((err) => {
  console.error(err)
  chrome.kill()
  process.exit(1)
})

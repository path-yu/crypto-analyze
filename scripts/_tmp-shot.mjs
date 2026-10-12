/** 临时：在指定视口下截取「收益分析」主列（不缩放，便于看清细节） */
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

const PORT = 9337
const url = process.argv[2] ?? 'http://127.0.0.1:8787/'
const W = Number(process.argv[3] ?? 1536)
const H = Number(process.argv[4] ?? 830)
const OUT = path.resolve('output/screenshots/equity-main.png')
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'))

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
  const evaluate = async (expression, awaitPromise = false) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })).result.value

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url })
  await sleep(7000)
  await evaluate(`(() => {
    const t = [...document.querySelectorAll('[role=tab]')].find(e => e.textContent.includes('收益分析'));
    if (t) t.click();
    return !!t;
  })()`)
  await sleep(3000)

  // 主列顶部（KPI 起始）在文档中的位置
  const geom = await evaluate(`(() => {
    const container = document.querySelector('.MuiContainer-root');
    const grid = container && container.firstElementChild;
    const main = grid && grid.children[1];
    const r = main.getBoundingClientRect();
    return JSON.stringify({ left: Math.round(r.left), width: Math.round(r.width), scrollY: Math.round(window.scrollY), docTop: Math.round(r.top + window.scrollY) });
  })()`)
  const g = JSON.parse(geom)
  console.log('主列:', geom)

  const cap = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: g.left, y: g.docTop, width: g.width, height: 1100, scale: 1 },
  })
  fs.writeFileSync(OUT, Buffer.from(cap.data, 'base64'))
  console.log('已保存', OUT)

  ws.close()
  chrome.kill()
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

main().catch((err) => {
  console.error(err)
  chrome.kill()
  process.exit(1)
})

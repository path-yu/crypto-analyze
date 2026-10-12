/** 临时：逐个标签页检查「右侧被裁掉」的元素（容器内横向溢出 / 越界） */
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

const PORT = 9336
const url = process.argv[2] ?? 'http://127.0.0.1:8787/'
const W = Number(process.argv[3] ?? 1536)
const H = Number(process.argv[4] ?? 830)
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-overflow-'))

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
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url })
  await sleep(7000)

  const tabs = ['K 线与交易', '收益分析', '交易分析', '交易明细', '回测报告']
  for (const tab of tabs) {
    await evaluate(`(() => {
      const t = [...document.querySelectorAll('[role=tab]')].find(e => e.textContent.includes(${JSON.stringify(tab)}));
      if (t) t.click();
      return !!t;
    })()`)
    await sleep(2500)

    const out = await evaluate(`(() => {
      const vw = window.innerWidth;
      const tabPanel = document.querySelector('[role=tabpanel]') || document.body;
      // 页面级越界元素
      const pageOver = [...document.querySelectorAll('body *')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1; })
        .slice(0, 5)
        .map((el) => el.tagName + '|' + String(el.className || '').slice(0, 32) + '|right=' + Math.round(el.getBoundingClientRect().right));
      // 容器内横向滚动（内容比容器宽）
      const innerScroll = [...tabPanel.querySelectorAll('*')]
        .filter((el) => el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0)
        .slice(0, 6)
        .map((el) => el.tagName + '|' + String(el.className || '').slice(0, 32) + '|scrollW=' + el.scrollWidth + '|clientW=' + el.clientWidth);
      return JSON.stringify({
        tab: ${JSON.stringify(tab)},
        docOverX: document.documentElement.scrollWidth - vw,
        pageOver,
        innerScroll,
      });
    })()`)
    console.log(out)
  }

  // 滚到底部：检查左侧吸顶面板底部是否仍可见（决定「开始回测」按钮能否点到）
  const afterScroll = (
    await send('Runtime.evaluate', {
      expression: `(async () => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise(r => setTimeout(r, 800));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('开始回测'));
    const panel = document.querySelector('.MuiPaper-root');
    const r = (el) => el ? el.getBoundingClientRect() : null;
    const b = r(btn), p = r(panel);
    return JSON.stringify({
      vh: window.innerHeight,
      scrollY: Math.round(window.scrollY),
      docHeight: document.documentElement.scrollHeight,
      panelBottom: p ? Math.round(p.bottom) : null,
      btnTop: b ? Math.round(b.top) : null,
      btnVisible: b ? b.top >= 0 && b.bottom <= window.innerHeight : null,
    });
  })()`,
      returnByValue: true,
      awaitPromise: true,
    })
  ).result.value
  console.log('滚动到底部后:', afterScroll)

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

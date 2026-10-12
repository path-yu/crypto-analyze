#!/usr/bin/env node
/**
 * 一键启动前后端开发环境。
 *
 *   node scripts/dev.mjs               # 同时启动后端(8787) + 前端(5273)
 *   node scripts/dev.mjs --port 9000   # 自定义后端端口
 *   node scripts/dev.mjs --web-port 6000
 *   node scripts/dev.mjs --no-open     # 不自动打开浏览器
 *   node scripts/dev.mjs --build       # 用生产构建(dist)+后端，单端口访问
 *
 * 特性：
 *   - 启动前检查端口占用，被占用时给出明确提示而不是静默失败
 *   - 等待后端 /api/health 就绪后再拉起前端，避免首屏请求打到未就绪的后端
 *   - 带颜色的前缀日志，Ctrl+C 时优雅关闭两个子进程（Windows 亦可用）
 */

import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/* ------------------------------ 参数解析 ------------------------------ */

function parseArgs(argv) {
  const out = { port: 8787, webPort: 5273, open: true, build: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port' && argv[i + 1]) out.port = Number(argv[++i])
    else if (a === '--web-port' && argv[i + 1]) out.webPort = Number(argv[++i])
    else if (a === '--no-open') out.open = false
    else if (a === '--build') out.build = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log(`
用法: node scripts/dev.mjs [选项]

选项:
  --port <n>       后端端口（默认 8787）
  --web-port <n>   前端端口（默认 5273）
  --no-open        不自动打开浏览器
  --build          先构建前端，再用单端口生产模式运行
  -h, --help       显示帮助
`)
  process.exit(0)
}

/* ------------------------------ 工具函数 ------------------------------ */

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
}

const log = (msg) => console.log(`${C.dim}[dev]${C.reset} ${msg}`)
const warn = (msg) => console.log(`${C.yellow}[dev] 警告${C.reset} ${msg}`)
const fail = (msg) => console.log(`${C.red}[dev] 错误${C.reset} ${msg}`)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 检查某端口是否已被占用 */
function isPortBusy(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', (err) => resolve(err.code === 'EADDRINUSE'))
    srv.once('listening', () => srv.close(() => resolve(false)))
    srv.listen(port, '127.0.0.1')
  })
}

/** 轮询后端健康检查接口，直到就绪或超时 */
async function waitForHealthy(port, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      })
      if (res.ok) return true
    } catch {
      /* 未就绪，继续等 */
    }
    await sleep(500)
  }
  return false
}

/** 自动打开默认浏览器（失败不影响主流程） */
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // 用 start 时第一个参数是窗口标题，必须给空字符串占位
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref()
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref()
    }
    return true
  } catch {
    return false
  }
}

/* --------------------------- 子进程 & 输出转发 --------------------------- */

const children = []

/**
 * 启动一个子进程并把它的输出按前缀着色转发到当前终端。
 * Windows 上直接调用 .bin 下的 .cmd 需要 shell，因此统一走 npm 脚本更稳。
 */
function start(name, color, command, argv, extraEnv = {}) {
  const child = spawn(command, argv, {
    cwd: ROOT,
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const prefix = `${color}[${name}]${C.reset} `
  const pipe = (stream, isErr) => {
    let buf = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      buf += chunk
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (line.length) console.log((isErr ? `${C.red}${prefix}` : prefix) + line)
      }
    })
    stream.on('end', () => {
      if (buf.length) console.log((isErr ? `${C.red}${prefix}` : prefix) + buf)
    })
  }
  pipe(child.stdout, false)
  pipe(child.stderr, true)

  child.on('error', (err) => fail(`${name} 启动失败: ${err.message}`))
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      warn(`${name} 已退出（code=${code}${signal ? `, signal=${signal}` : ''}）`)
    }
  })

  children.push({ name, child })
  return child
}

let shuttingDown = false

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  console.log()
  log('正在关闭…')
  for (const { child } of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    try {
      if (process.platform === 'win32') {
        // Windows 下需连同子进程树一起结束，否则 tsx/vite 的后代仍会占用端口
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('SIGHUP', () => shutdown(0))

/* ------------------------------- 主流程 ------------------------------- */

async function main() {
  const serverPort = args.port
  const webPort = args.webPort
  const apiTarget = `http://127.0.0.1:${serverPort}`

  console.log()
  console.log(`${C.cyan}  Fibonacci Trend Reversals · 开发环境启动器${C.reset}`)
  console.log()

  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    fail('未找到 node_modules，请先执行: npm install')
    process.exit(1)
  }
  if (!fs.existsSync(path.join(ROOT, 'web', 'node_modules')) &&
      !fs.existsSync(path.join(ROOT, 'node_modules', 'vite'))) {
    fail('缺少前端依赖，请先执行: npm install')
    process.exit(1)
  }

  // ---- 端口检查 ----
  for (const [label, port] of [
    ['后端', serverPort],
    ...(args.build ? [] : [['前端', webPort]]),
  ]) {
    if (await isPortBusy(port)) {
      fail(`${label}端口 ${port} 已被占用。可换端口: --port ${port + 1}` +
        (args.build ? '' : ` / --web-port ${webPort + 1}`))
      process.exit(1)
    }
  }

  // ---- 生产模式：先构建，单端口访问 ----
  if (args.build) {
    log('正在构建前端（生产模式）…')
    const built = spawnSync('npm', ['run', 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    if (built.status !== 0) {
      fail('构建失败，已中止')
      process.exit(built.status ?? 1)
    }
    log(`构建完成。启动单端口服务 http://127.0.0.1:${serverPort}`)
    start('server', C.cyan, 'npm', ['run', 'start'], {
      PORT: String(serverPort),
      NODE_ENV: 'production',
    })
    if (await waitForHealthy(serverPort)) {
      log(`已就绪 → ${C.green}http://127.0.0.1:${serverPort}${C.reset}`)
      if (args.open) openBrowser(`http://127.0.0.1:${serverPort}`)
    } else {
      warn('后端健康检查超时，仍尝试继续')
    }
    console.log()
    log('按 Ctrl+C 停止服务')
    return
  }

  // ---- 开发模式：后端 + 前端双进程 ----
  log(`启动后端 (port ${serverPort})…`)
  start('server', C.cyan, 'npm', ['run', 'dev:server'], { PORT: String(serverPort) })

  const healthy = await waitForHealthy(serverPort)
  if (healthy) {
    log(`后端就绪 → ${C.green}${apiTarget}/api/health${C.reset}`)
  } else {
    warn('后端健康检查超时（可能正在拉取行情），继续启动前端')
  }

  log(`启动前端 (port ${webPort})…`)
  start('web', C.magenta, 'npm', ['run', 'dev:web'], {
    API_TARGET: apiTarget,
  })

  // 等 vite 打印出地址再打开浏览器
  await sleep(2500)
  // 用 localhost 而非 127.0.0.1：Vite 在部分环境下只绑定 IPv6(::1)，
  // 写成 127.0.0.1 会连不上。
  const webUrl = `http://localhost:${webPort}/`
  console.log()
  log(`前端地址 → ${C.green}${webUrl}${C.reset}`)
  log(`后端接口 → ${C.cyan}${apiTarget}/api/health${C.reset}`)
  console.log()
  log('按 Ctrl+C 停止全部服务')
  if (args.open) openBrowser(webUrl)
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err))
  shutdown(1)
})

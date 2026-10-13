/**
 * HTTP 服务入口。
 *  - /api/* 提供行情与回测接口
 *  - 生产模式下同时托管 web/dist 静态资源
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import { apiRouter } from './routes/api'
import { resolveProxyUrl } from './market/exchange'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8787)

const app = express()

app.use(cors())
app.use(express.json({ limit: '2mb' }))

// 轻量请求日志
app.use((req, _res, next) => {
  if (req.path.startsWith('/api')) {
    const started = Date.now()
    _res.on('finish', () => {
      console.log(
        `[api] ${req.method} ${req.originalUrl} -> ${_res.statusCode} (${Date.now() - started}ms)`,
      )
    })
  }
  next()
})

app.use('/api', apiRouter)

// 托管前端构建产物
const webDist = path.resolve(__dirname, '../../web/dist')
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist))
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'))
  })
} else {
  app.get('/', (_req, res) => {
    res
      .status(200)
      .type('html')
      .send(
        '<h1>Crypto Fib Trend Reversals</h1><p>前端尚未构建。请在项目根目录运行 <code>pnpm dev</code> 启动 Vite 开发服务器，或 <code>pnpm build</code> 生成 web/dist。</p>',
      )
  })
}

app.listen(PORT, () => {
  const proxy = resolveProxyUrl()
  console.log(`\n  ● 回测服务已启动: http://127.0.0.1:${PORT}`)
  console.log(`  ● 健康检查:      http://127.0.0.1:${PORT}/api/health`)
  console.log(
    proxy
      ? `  ● 行情代理:      ${proxy}（ccxt 走代理；Binance 归档直连）`
      : '  ● 行情代理:      未检测到（直连，可用 HTTPS_PROXY 指定）',
  )
  console.log('')
})

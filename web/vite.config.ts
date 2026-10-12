import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const dir = path.dirname(fileURLToPath(import.meta.url))
const API_TARGET = process.env.API_TARGET ?? 'http://127.0.0.1:8787'

export default defineConfig({
  root: dir,
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(dir, '../shared'),
      '@': path.resolve(dir, 'src'),
    },
    // 强制 react / react-dom 只有一份实例。
    // 依赖树变化后 Vite 重新预打包时若残留半旧半新的产物，MUI 的 createSvgIcon
    // 会读到 null 的 React internals，报 "Invalid hook call"。
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: true,
    port: 5273,
    strictPort: false,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        timeout: 300_000,
        proxyTimeout: 300_000,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
})

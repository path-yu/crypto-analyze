import { fetchPineExamples, type PineExample } from './api'

export type { PineExample }

/** 兜底示例：后端 /api/pine/examples 不可用时使用的一段最小可编译脚本 */
const FALLBACK: PineExample[] = [
  {
    name: '最小示例 · EMA 均线',
    file: 'inline.pine',
    source: [
      '//@version=6',
      'indicator("EMA", overlay=true)',
      'len = input.int(20, title="EMA length")',
      'ema = ta.ema(close, len)',
      'plot(ema, title="EMA")',
    ].join('\n'),
  },
]

/** 拉取内置示例脚本；失败时回退到内联示例，保证「载入示例」始终可用 */
export async function loadPineExamples(): Promise<PineExample[]> {
  try {
    const list = await fetchPineExamples()
    if (list.length) return list
  } catch {
    /* 忽略，回退到内置示例 */
  }
  return FALLBACK
}
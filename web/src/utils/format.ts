/** 数值 / 时间格式化工具。时区统一按 UTC+8 展示。 */

const TZ_OFFSET_MS = 8 * 3600 * 1000

export function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return '—'
  // 无穷大：常见于「零亏损」时的盈利因子 / 盈亏比，用 ∞ 比 — 更有信息量
  if (v === Infinity) return '∞'
  if (v === -Infinity) return '-∞'
  if (!Number.isFinite(v)) return '—'
  return v.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function money(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const sign = v < 0 ? '-' : ''
  return `${sign}$${num(Math.abs(v), digits)}`
}

export function pct(v: number | null | undefined, digits = 2, withSign = true): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const sign = withSign && v > 0 ? '+' : ''
  return `${sign}${num(v, digits)}%`
}

export function compact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1e9) return `${sign}${num(abs / 1e9, 2)}B`
  if (abs >= 1e6) return `${sign}${num(abs / 1e6, 2)}M`
  if (abs >= 1e3) return `${sign}${num(abs / 1e3, 2)}K`
  return `${sign}${num(abs, 2)}`
}

/** 价格按有效位数自动决定小数位 */
export function price(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  if (abs >= 1000) return num(v, 2)
  if (abs >= 10) return num(v, 3)
  if (abs >= 1) return num(v, 4)
  if (abs >= 0.01) return num(v, 6)
  return num(v, 8)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts + TZ_OFFSET_MS)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}`
}

export function dateOnly(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts + TZ_OFFSET_MS)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function timeOnly(ts: number | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts + TZ_OFFSET_MS)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
export function weekdayName(w: number): string {
  return WEEKDAYS[w] ?? '—'
}

/** KLineChart 横轴标签格式 */
export function klineAxisTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** 按时间跨度挑选合适的横轴格式 */
export function axisTimeLabel(ts: number, spanMs: number): string {
  const d = new Date(ts + TZ_OFFSET_MS)
  if (spanMs > 200 * 86400_000) {
    return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}`
  }
  if (spanMs > 3 * 86400_000) {
    return `${d.getUTCMonth() + 1}/${pad(d.getUTCDate())}`
  }
  if (spanMs > 12 * 3600_000) {
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  }
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}`
}

export const EXIT_REASON_LABEL: Record<string, string> = {
  TP1: '第一目标止盈',
  TP2: '第二目标止盈',
  StopLoss: '止损',
  BreakEven: '保本离场',
  Reverse: '反手平仓',
  TrendSwitch: '趋势反转平仓',
  Liquidation: '强制平仓',
  EndOfData: '回测结束平仓',
}

/**
 * 把后端/ccxt 抛出的原始错误翻译成用户能看懂、能行动的提示。
 * 原文本作为细节附在后面，方便排查。
 */
export function humanizeError(raw: string): string {
  const t = raw.trim()

  if (/Connect Timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed|socket hang up/i.test(t)) {
    return (
      '无法连接到交易所的公开行情接口（网络超时或被地域限制）。\n' +
      '程序已尝试自动切换到其他数据源；若仍然失败，请检查本机网络、代理或防火墙设置后重试。'
    )
  }
  if (/too long ago|Maximum \d+ points|time range|Invalid param value/i.test(t)) {
    return '所选时间范围超出了交易所允许的回溯上限。请缩短回测区间，或改用更大的 K 线周期。'
  }
  if (/全部交易所均无法获取/.test(t)) {
    return `所有可用数据源都失败了，暂时无法获取行情。\n\n${t}`
  }
  if (/仅获取到 \d+ 根 K 线|不足以计算指标/.test(t)) {
    return '获取到的 K 线数量不足，无法计算指标。请扩大回测区间或改用更小的周期。'
  }
  if (/不存在合约|不支持的交易对/.test(t)) {
    return `该交易所不存在所选合约。请从合约下拉列表中重新选择。\n\n${t}`
  }
  if (/服务返回了非 JSON/.test(t)) {
    return '后端返回了无法解析的响应，服务可能未正常启动或已崩溃。请查看终端日志。'
  }
  return t
}

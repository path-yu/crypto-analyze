/**
 * KLineChart 自定义指标与覆盖物注册（模块副作用，只执行一次）。
 *
 *  - 指标 IMBA_FIB：在主图叠加「斐波那契 0.5 回撤趋势线」（Pine 中的 imba_trend_line）
 *  - 指标 TSOT：独立副图绘制趋势强度直方图
 *  - 覆盖物 tradeMarker：一笔完整交易的入场/离场标注
 *      · 方向三角 + 盈亏标签
 *      · 入场价线 / 出场价线（横贯该笔持仓区间，含价格文字）
 *      · 极淡的盈亏区域填充
 *      · 可选的止损 / TP1 / TP2 参考虚线
 */

import { registerIndicator, registerOverlay, type OverlayFigure } from 'klinecharts'

import { price as fmtPrice } from '../utils/format'

/** 中国市场习惯：涨红跌绿 */
export const UP = '#ff4d4f'
export const DOWN = '#3ddc97'
export const NEUTRAL = '#8a94a6'
/** 入场价线颜色（与主题 primary 一致） */
export const ENTRY = '#5b8cff'

export interface TradeMarkerData {
  side: 'long' | 'short'
  profitable: boolean
  label: string
  stopLoss: number
  takeProfit1: number
  takeProfit2: number
  entryPrice: number
  exitPrice: number
  showLevels: boolean
}

/** 价格线文字标签的统一样式 */
function tagStyles(color: string): Record<string, unknown> {
  return {
    color,
    size: 9.5,
    weight: '600',
    backgroundColor: 'rgba(10,13,20,0.78)',
    paddingLeft: 3,
    paddingRight: 3,
    paddingTop: 1,
    paddingBottom: 1,
    borderColor: color,
    borderSize: 0.5,
  }
}

let registered = false

export function registerCustomCharts(): void {
  if (registered) return
  registered = true

  /* ---------------- 主图：IMBA 斐波那契趋势线 ---------------- */
  registerIndicator<{ imba?: number; bull?: number }>({
    name: 'IMBA_FIB',
    shortName: 'IMBA',
    series: 'price',
    precision: 2,
    figures: [
      {
        key: 'imba',
        title: 'IMBA: ',
        type: 'line',
        styles: ({ data, defaultStyles }) => {
          const bull = Number(data.current?.bull ?? 0) === 1
          return {
            color: bull ? '#5b8cff' : '#ff7a7a',
            size: 1.5,
            style: 'solid',
            smooth: false,
            ...(bull ? {} : {}),
            ...(defaultStyles ? {} : {}),
          }
        },
      },
    ],
    calc: (dataList) =>
      dataList.map((k) => {
        const v = (k as Record<string, unknown>).imbaTrendLine
        if (typeof v !== 'number' || !Number.isFinite(v)) return {}
        const bull = (k as Record<string, unknown>).imbaBull ? 1 : 0
        return { imba: v, bull }
      }),
  })

  /* ---------------- 主图：SuperTrend 上下轨（KivancOzbilgic） ---------------- */
  registerIndicator<{ up?: number; dn?: number }>({
    name: 'SUPERTREND',
    shortName: 'SuperTrend',
    series: 'price',
    precision: 2,
    figures: [
      {
        key: 'up',
        title: 'Up: ',
        type: 'line',
        styles: () => ({ color: '#3ddc97', size: 1.5, style: 'solid', smooth: false }),
      },
      {
        key: 'dn',
        title: 'Dn: ',
        type: 'line',
        styles: () => ({ color: '#ff4d4f', size: 1.5, style: 'solid', smooth: false }),
      },
    ],
    calc: (dataList) =>
      dataList.map((k) => {
        const up = (k as Record<string, unknown>).supertrendUp
        const dn = (k as Record<string, unknown>).supertrendDn
        return {
          up: typeof up === 'number' && Number.isFinite(up) ? up : undefined,
          dn: typeof dn === 'number' && Number.isFinite(dn) ? dn : undefined,
        }
      }),
  })

  /* ---------------- 副图：TSOT 趋势强度 ---------------- */
  registerIndicator<{ tsot?: number }>({
    name: 'TSOT',
    shortName: 'TSOT',
    precision: 0,
    figures: [
      {
        key: 'tsot',
        title: 'TSOT: ',
        type: 'bar',
        baseValue: 0,
        styles: ({ data }) => {
          const v = Number(data.current?.tsot ?? 0)
          const color = v > 0 ? UP : v < 0 ? DOWN : NEUTRAL
          return { style: 'fill', color, borderColor: color }
        },
      },
    ],
    calc: (dataList) =>
      dataList.map((k) => {
        const v = (k as Record<string, unknown>).tsotTrendValue
        if (typeof v !== 'number' || !Number.isFinite(v)) return {}
        return { tsot: v }
      }),
  })

  /* ---------------- 覆盖物：交易标注 ---------------- */
  registerOverlay<TradeMarkerData>({
    name: 'tradeMarker',
    // 2 个点：入场、离场
    totalStep: 3,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay, yAxis, bounding }) => {
      const ext = overlay.extendData as TradeMarkerData | undefined
      if (!ext || coordinates.length < 2) return []
      const entry = coordinates[0]
      const exit = coordinates[1]
      const color = ext.profitable ? UP : DOWN
      const arrow = ext.side === 'long' ? 1 : -1
      const figures: OverlayFigure[] = []

      // 入场 → 离场的连线
      if (entry?.x !== undefined && exit?.x !== undefined) {
        figures.push({
          type: 'line',
          attrs: { coordinates: [entry, exit] },
          styles: { style: 'solid', color, size: 1.1 },
          ignoreEvent: true,
        })
      }

      if (entry?.x !== undefined && entry?.y !== undefined) {
        const h = 9
        const w = 5.5
        const tipY = entry.y
        const baseY = entry.y + arrow * h
        // 方向三角
        figures.push({
          type: 'polygon',
          attrs: {
            coordinates: [
              { x: entry.x, y: tipY },
              { x: entry.x - w, y: baseY },
              { x: entry.x + w, y: baseY },
            ],
          },
          styles: { style: 'fill', color, borderColor: color, borderSize: 0 },
          ignoreEvent: true,
        })
        // 文字标签
        figures.push({
          type: 'text',
          attrs: {
            x: entry.x,
            y: baseY + arrow * 9,
            text: ext.label,
            align: 'center',
            baseline: 'middle',
          },
          styles: {
            color,
            size: 10,
            weight: '600',
            backgroundColor: 'rgba(10,13,20,0.72)',
            paddingLeft: 3,
            paddingRight: 3,
            paddingTop: 1,
            paddingBottom: 1,
            borderColor: color,
            borderSize: 0.5,
          },
          ignoreEvent: true,
        })
      }

      // 入场价 / 出场价水平线：横贯该笔持仓区间，并配价格文字
      if (
        entry?.x !== undefined &&
        exit?.x !== undefined &&
        entry?.y !== undefined &&
        exit?.y !== undefined
      ) {
        const x1 = entry.x
        const x2 = exit.x
        const spanPx = Math.abs(x2 - x1)
        const exitColor = ext.profitable ? UP : DOWN

        // 区间太窄（同一根 K 线附近）就整体省略，避免糊成一团
        if (spanPx >= 5) {
          // 盈亏区域（极淡填充，帮助一眼识别持仓区间）
          figures.push({
            type: 'polygon',
            attrs: {
              coordinates: [
                { x: x1, y: entry.y },
                { x: x2, y: entry.y },
                { x: x2, y: exit.y },
                { x: x1, y: exit.y },
              ],
            },
            styles: {
              style: 'fill',
              color: ext.profitable ? 'rgba(255,77,79,0.08)' : 'rgba(61,220,151,0.08)',
              borderColor: 'transparent',
              borderSize: 0,
            },
            ignoreEvent: true,
          })

          // 入场价线
          figures.push({
            type: 'line',
            attrs: { coordinates: [{ x: x1, y: entry.y }, { x: x2, y: entry.y }] },
            styles: { style: 'solid', color: ENTRY, size: 1 },
            ignoreEvent: true,
          })

          // 出场价线（按盈亏着色）
          figures.push({
            type: 'line',
            attrs: { coordinates: [{ x: x1, y: exit.y }, { x: x2, y: exit.y }] },
            styles: { style: 'solid', color: exitColor, size: 1 },
            ignoreEvent: true,
          })
        }

        // 价格标签需要一定宽度才放得下；入场靠左端点、出场靠右端点，避免溢出图表边缘
        if (spanPx >= 36) {
          figures.push({
            type: 'text',
            attrs: {
              x: x1 + 4,
              y: entry.y - 8,
              text: `入 ${fmtPrice(ext.entryPrice)}`,
              align: 'left',
              baseline: 'middle',
            },
            styles: tagStyles(ENTRY),
            ignoreEvent: true,
          })
          figures.push({
            type: 'text',
            attrs: {
              x: x2 - 4,
              y: exit.y - 8,
              text: `出 ${fmtPrice(ext.exitPrice)}`,
              align: 'right',
              baseline: 'middle',
            },
            styles: tagStyles(exitColor),
            ignoreEvent: true,
          })
        }
      }

      // 止损 / 止盈参考线（横贯可视区）
      if (ext.showLevels && yAxis && bounding) {
        const levels: { price: number; color: string; text: string }[] = [
          { price: ext.stopLoss, color: '#ff4d4d', text: 'SL' },
          { price: ext.takeProfit1, color: '#ffb01f', text: 'TP1' },
          { price: ext.takeProfit2, color: '#4fa8ff', text: 'TP2' },
        ]
        for (const lv of levels) {
          if (!Number.isFinite(lv.price) || lv.price <= 0) continue
          const y = yAxis.convertToPixel(lv.price)
          if (y < bounding.top || y > bounding.bottom) continue
          figures.push({
            type: 'line',
            attrs: {
              coordinates: [
                { x: bounding.left, y },
                { x: bounding.right, y },
              ],
            },
            styles: { style: 'dashed', color: lv.color, size: 0.8, dashedValue: [3, 3] },
            ignoreEvent: true,
          })
          figures.push({
            type: 'text',
            attrs: { x: bounding.left + 4, y, text: lv.text, align: 'left', baseline: 'bottom' },
            styles: { color: lv.color, size: 9 },
            ignoreEvent: true,
          })
        }
      }

      return figures
    },
  })
}

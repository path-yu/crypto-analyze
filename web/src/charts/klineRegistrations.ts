/**
 * KLineChart 自定义指标与覆盖物注册（模块副作用，只执行一次）。
 *
 *  - 指标 IMBA_FIB：在主图叠加「斐波那契 0.5 回撤趋势线」（Pine 中的 imba_trend_line）
 *  - 指标 TSOT：独立副图绘制趋势强度直方图
 *  - 覆盖物 tradeMarker：一笔完整交易的入场/离场标注（含止损止盈参考线）
 */

import { registerIndicator, registerOverlay, type OverlayFigure } from 'klinecharts'

/** 中国市场习惯：涨红跌绿 */
export const UP = '#ff4d4f'
export const DOWN = '#3ddc97'
export const NEUTRAL = '#8a94a6'

export interface TradeMarkerData {
  side: 'long' | 'short'
  profitable: boolean
  label: string
  stopLoss: number
  takeProfit1: number
  takeProfit2: number
  entryPrice: number
  showLevels: boolean
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

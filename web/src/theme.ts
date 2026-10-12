import { createTheme, type Theme } from '@mui/material/styles'

/** 图表统一配色（深色 / 浅色两套） */
export interface ChartPalette {
  bg: string
  grid: string
  axis: string
  text: string
  tooltipBg: string
  tooltipBorder: string
  equity: string
  equityFill: string
  drawdown: string
  buyHold: string
  profit: string
  loss: string
  accent: string
  muted: string
}

export const darkChartPalette: ChartPalette = {
  bg: 'transparent',
  grid: 'rgba(255,255,255,0.06)',
  axis: 'rgba(255,255,255,0.25)',
  text: '#9aa4b8',
  tooltipBg: '#161b26',
  tooltipBorder: '#2c3444',
  equity: '#ffb01f',
  equityFill: 'rgba(255,176,31,0.22)',
  drawdown: '#3ddc97',
  buyHold: '#6b7a99',
  profit: '#ff4d4f',
  loss: '#3ddc97',
  accent: '#5b8cff',
  muted: '#5c6779',
}

export const lightChartPalette: ChartPalette = {
  bg: 'transparent',
  grid: 'rgba(0,0,0,0.07)',
  axis: 'rgba(0,0,0,0.25)',
  text: '#5b6472',
  tooltipBg: '#ffffff',
  tooltipBorder: '#e0e4ea',
  equity: '#c47f00',
  equityFill: 'rgba(196,127,0,0.18)',
  drawdown: '#12855c',
  buyHold: '#8b95a5',
  profit: '#d9363e',
  loss: '#12855c',
  accent: '#2f6bde',
  muted: '#9aa4b8',
}

/**
 * 中国市场约定：涨 = 红，跌 = 绿。
 * 用于 K 线、盈亏数字与图表。
 */
export const UP_COLOR = '#ff4d4f'
export const DOWN_COLOR = '#3ddc97'
export const UP_COLOR_LIGHT = '#d9363e'
export const DOWN_COLOR_LIGHT = '#12855c'

export function buildTheme(mode: 'dark' | 'light'): Theme {
  const isDark = mode === 'dark'
  return createTheme({
    palette: {
      mode,
      primary: { main: isDark ? '#5b8cff' : '#2f6bde' },
      secondary: { main: isDark ? '#ffb01f' : '#c47f00' },
      success: { main: isDark ? DOWN_COLOR : DOWN_COLOR_LIGHT },
      error: { main: isDark ? UP_COLOR : UP_COLOR_LIGHT },
      background: {
        default: isDark ? '#0b0e14' : '#f4f6fa',
        paper: isDark ? '#131824' : '#ffffff',
      },
      divider: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
      text: {
        primary: isDark ? '#e8ecf4' : '#1a1f2b',
        secondary: isDark ? '#9aa4b8' : '#5b6472',
      },
    },
    shape: { borderRadius: 10 },
    typography: {
      fontFamily:
        "'Inter','PingFang SC','Microsoft YaHei',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
      h6: { fontWeight: 650, letterSpacing: '-0.01em' },
      subtitle2: { fontWeight: 600 },
      button: { textTransform: 'none', fontWeight: 600 },
      caption: { letterSpacing: '0.01em' },
    },
    components: {
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
            border: `1px solid ${isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)'}`,
          },
        },
      },
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiTableCell: {
        styleOverrides: {
          root: { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' },
          head: { fontWeight: 650, whiteSpace: 'nowrap' },
        },
      },
      MuiTooltip: {
        styleOverrides: { tooltip: { fontSize: 12, maxWidth: 360 } },
      },
    },
  })
}

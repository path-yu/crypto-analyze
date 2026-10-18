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
      MuiMenuItem: {
        styleOverrides: {
          root: {
            // 移动端：下拉行更紧凑。策略下拉动辄二三十份已保存脚本，
            // 默认 48px 行高把菜单撑得很长，一屏看不了几项。
            '@media (max-width:899.95px)': { minHeight: 36, paddingTop: 4, paddingBottom: 4 },
          },
        },
      },
      MuiMenu: {
        styleOverrides: {
          paper: {
            // 移动端：把菜单高度上限换成动态视口单位。
            // MUI 默认是 `calc(100% - 96px)`，百分比基于「布局视口」——移动端浏览器
            // 地址栏/工具栏占位时，布局视口比可视区高，菜单底部会压在可视区之外，
            // 而菜单自身已滚到尽头，于是最后几项永远滚不出来、点不到。
            // 用 dvh 按可视区留足余量，保证末项一定能滚进可视区。
            '@media (max-width:899.95px)': { maxHeight: 'calc(100dvh - 160px)' },
          },
          list: {
            // 移动端：列表末尾留出滚动余量。
            // MUI 会把溢出菜单的底边贴到 `window.innerHeight - 16`，而移动端浏览器
            // 的地址栏 / 底部工具栏会吃掉这块区域；留一段尾部留白后，滚到底时最后一项
            // 仍完整停在工具条上方，能稳稳点到（同时也避免误触边缘关掉菜单）。
            '@media (max-width:899.95px)': { paddingBottom: 64 },
          },
        },
      },
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

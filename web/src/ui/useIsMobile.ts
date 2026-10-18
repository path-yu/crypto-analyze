import useMediaQuery from '@mui/material/useMediaQuery'

/**
 * 是否按「移动端」布局渲染。
 *
 * 判据是视口宽度 < 900px（MUI 的 md 断点），与 App 主布局、弹窗全屏
 * 等处的响应式分支保持一致 —— 集中一处定义，避免各处硬编码断点后互相错位。
 */
const MOBILE_QUERY = '(max-width: 899.95px)'

export default function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY)
}

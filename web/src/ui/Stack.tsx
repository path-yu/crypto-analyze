import type { ComponentType, ElementType, ReactNode } from 'react'
import MuiStack from '@mui/material/Stack'
import type { SxProps, Theme } from '@mui/material/styles'
import type { ResponsiveStyleValue } from '@mui/system'

/**
 * MUI v9 的 Stack 只保留 direction / spacing / divider / useFlexGap，
 * 原先可直传的 alignItems / justifyContent / flexWrap 等 system props 已被移除。
 * 这里做一层兼容包装，把它们并入 sx，保持代码可读性。
 */
export interface StackProps {
  children?: ReactNode
  direction?: ResponsiveStyleValue<'row' | 'row-reverse' | 'column' | 'column-reverse'>
  spacing?: ResponsiveStyleValue<number | string>
  divider?: ReactNode
  component?: ElementType
  useFlexGap?: boolean
  alignItems?: unknown
  justifyContent?: unknown
  flexWrap?: unknown
  sx?: SxProps<Theme>
  [key: string]: unknown
}

export default function Stack({
  alignItems,
  justifyContent,
  flexWrap,
  useFlexGap,
  sx,
  ...rest
}: StackProps) {
  const sxObject = sx && typeof sx === 'object' && !Array.isArray(sx) ? sx : {}
  const merged: SxProps<Theme> = {
    ...(alignItems !== undefined ? { alignItems } : {}),
    ...(justifyContent !== undefined ? { justifyContent } : {}),
    ...(flexWrap !== undefined ? { flexWrap } : {}),
    ...(sxObject as object),
  }

  const Compat = MuiStack as unknown as ComponentType<Record<string, unknown>>
  return <Compat {...rest} useFlexGap={useFlexGap} sx={merged} />
}

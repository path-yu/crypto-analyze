/**
 * CodeMirror 6 的极简 React 封装。
 *
 * 只做三件事：挂载时创建 EditorView、卸载时销毁、外部 value 变化时整篇同步。
 * 扩展（语言 / 主题 / 快捷键）在挂载时固定，之后不再重建视图 ——
 * 否则每敲一个字都会重建编辑器，光标与撤销栈都会丢。
 */

import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

interface Props {
  value: string
  onChange: (v: string) => void
  /** 编辑器扩展；仅挂载时生效（见文件头说明） */
  extensions: Extension[]
}

export default function CodeMirrorEditor({ value, onChange, extensions }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)

  // 回调与初始值都放进 ref：既能拿到最新的 onChange，又不必重建视图
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const initial = useRef({ value, extensions })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      state: EditorState.create({
        doc: initial.current.value,
        extensions: [
          ...initial.current.extensions,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString())
          }),
        ],
      }),
      parent: host,
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  // 外部载入（切换到已保存脚本、点示例）：整篇替换，仍可 Ctrl+Z 撤销回原稿
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return <div ref={hostRef} style={{ height: '100%' }} />
}
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
  // 挂载时用的初始值取「当前渲染的 value」，不用首次渲染的快照：
  // 编辑器实例可能比源码更早存在（例如先渲染、后载入脚本），
  // 用首帧快照会把它固化成当时的内容（空串/旧脚本），再被当成用户编辑回传。
  const valueRef = useRef(value)
  valueRef.current = value
  const initial = useRef({ extensions })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({
      state: EditorState.create({
        doc: valueRef.current,
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

  // 外部载入（切换脚本 / 点「重新载入」）：整篇替换，仍可 Ctrl+Z 撤销回原稿。
  // 故意**不写依赖数组**：每次渲染都比对一次文档与 value，任何来源的失步
  // （编辑器实例早于源码就位、状态未变但文档是旧文本…）都会在下一帧自动纠正。
  // 打字时 doc 与 value 由 onChange 保持相等，这里不会产生多余 dispatch。
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  })

  return <div ref={hostRef} style={{ height: '100%' }} />
}
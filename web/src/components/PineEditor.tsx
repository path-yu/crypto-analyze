import { useEffect, useRef, useState } from 'react'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import CircularProgress from '@mui/material/CircularProgress'
import Divider from '@mui/material/Divider'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import Stack from '../ui/Stack'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import CheckIcon from '@mui/icons-material/Check'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import FullscreenIcon from '@mui/icons-material/Fullscreen'
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import RefreshIcon from '@mui/icons-material/Refresh'
import SaveIcon from '@mui/icons-material/Save'

import type { PineCompileMeta, PineDiagnostic, SavedPineScript } from '@shared/types'
import { compilePine } from '../api'
import { pineSetup } from '../pineEditor'
import CodeMirrorEditor from './CodeMirrorEditor'

/** Pine 面板状态与回调：由 App 持有，经 ControlPanel 透传到这里 */
export interface PinePanelState {
  /** 当前源码 */
  source: string
  onSourceChange: (v: string) => void
  /** 保存用的脚本名（同名保存即更新同一份） */
  name: string
  onNameChange: (v: string) => void
  /** 已保存脚本，最近保存的在前 */
  scripts: SavedPineScript[]
  /** 当前载入的已保存脚本 id；未载入任何已保存脚本时为 null */
  selectedId: string | null
  /** 策略下拉里选中一份已保存脚本（null = 切回内置策略或示例） */
  onSelect: (id: string | null) => void
  /** 保存当前源码：写穿到 server/pine/<目录>/ 下的 .pine，返回落盘记录 */
  onSave: () => Promise<SavedPineScript>
  /** 删除当前载入的已保存脚本 */
  onDelete: () => Promise<void>
  /**
   * 回测参数覆盖：键 = input 的 title（未列出的项用脚本默认值）。
   *
   * 注意：只影响「运行回测」提交给服务端的 `inputs`；
   * 图表上那条指标的参数是 Vela 自己的设置弹窗，两者互不相通。
   */
  inputs: Record<string, number | boolean | string>
  onInputsChange: (next: Record<string, number | boolean | string>) => void
  /**
   * 丢弃编辑器里的文本、从磁盘重新载入当前脚本。
   *
   * 编译与回测用的都是**编辑器里的文本**：在应用之外修改（或修复）了 .pine 后，
   * 不重新载入编辑器就会一直用旧文本报旧错 —— 点这个按钮同步一次即可。
   */
  onReload: () => Promise<void>
  /**
   * 重新拉取已保存脚本列表。
   *
   * 列表只在「页面加载 / 保存 / 删除」时刷新，因此在应用之外新增的脚本目录
   * （IDE、`git pull`、文件管理器拷进来的 `server/pine/<名>/<名>.pine`）不会
   * 自动出现在策略下拉里 —— 打开下拉时调一次即可看到。
   */
  onRefresh: () => Promise<void>
  /** 是否在右侧 Drawer 弹窗中放大编辑（面板内的紧凑编辑器让位） */
  drawerOpen: boolean
  onToggleDrawer: () => void
}

interface Props extends PinePanelState {
  onRun: () => void
  loading: boolean
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

export default function PineEditor({
  source,
  onSourceChange,
  name,
  onNameChange,
  inputs,
  onInputsChange,
  scripts,
  selectedId,
  onSave,
  onDelete,
  onReload,
  drawerOpen,
  onToggleDrawer,
  onRun,
  loading,
}: Props) {
  const [diagnostics, setDiagnostics] = useState<PineDiagnostic[]>([])
  const [meta, setMeta] = useState<PineCompileMeta | null>(null)
  const [compiling, setCompiling] = useState(false)
  const [compileError, setCompileError] = useState<string | null>(null)

  /** 保存 / 删除的进行中标记与结果提示 */
  const [busy, setBusy] = useState(false)
  const [saveNote, setSaveNote] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  /**
   * 「重新载入」的计数器：从磁盘取回的内容可能和当前源码完全相同，
   * 光 setSource 不会触发重编译、旧报错也会一直挂着 —— 自增一次强制重跑校验。
   */
  const [reloadTick, setReloadTick] = useState(0)

  // 300ms 防抖：一边打字一边刷新诊断与脚本元信息
  useEffect(() => {
    if (!source.trim()) {
      setDiagnostics([])
      setMeta(null)
      setCompileError(null)
      return
    }
    let cancelled = false
    setCompiling(true)
    const timer = setTimeout(() => {
      compilePine(source)
        .then((res) => {
          if (cancelled) return
          setDiagnostics(res.diagnostics)
          setMeta(res.meta)
          setCompileError(null)
        })
        .catch((err: unknown) => {
          if (cancelled) return
          setCompileError(err instanceof Error ? err.message : '编译失败')
          setDiagnostics([])
          setMeta(null)
        })
        .finally(() => {
          if (!cancelled) setCompiling(false)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [source, reloadTick])

  /**
   * 保存：写穿到服务端 `server/pine/<目录>/` 下的 `.pine`（同名即更新）。
   * 改用 PineTS 后不再产出编译中间产物，因此只落源码。
   */
  const doSave = async () => {
    setBusy(true)
    setSaveNote(null)
    setSaveError(null)
    try {
      const saved = await onSave()
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      setSaveNote(`已保存 · ${saved.pinePath ?? saved.name} · ${time}`)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 从磁盘重新载入：覆盖编辑器里的文本。
   *
   * 编译用的是编辑器里的文本，因此在应用之外修改（或修复）了 .pine 之后，
   * 编辑器不会自动感知 —— 用它把服务端最新源码取回来。
   */
  const doReload = async () => {
    setBusy(true)
    setSaveNote(null)
    setSaveError(null)
    try {
      await onReload()
      // 内容可能与当前源码完全相同：自增一次强制重编译，顺带清掉残留的旧报错
      setReloadTick((n) => n + 1)
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      setSaveNote(`已从磁盘重新载入 · ${time}`)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : '重新载入失败')
    } finally {
      setBusy(false)
    }
  }

  /** 删除当前载入的已保存脚本；编辑器里的源码保留，不会跟着消失 */
  const doDelete = async () => {
    const target = scripts.find((s) => s.id === selectedId)
    if (!target) return
    if (!window.confirm(`删除已保存脚本「${target.name}」？编辑器中的源码会保留。`)) return
    setBusy(true)
    setSaveNote(null)
    setSaveError(null)
    try {
      await onDelete()
      setSaveNote('已删除该脚本')
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : '删除失败')
    } finally {
      setBusy(false)
    }
  }

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length
  /** 已覆盖的回测参数个数（键 = input title） */
  const overrideCount = Object.keys(inputs).length

  return (
    <Box
      sx={
        drawerOpen ? { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } : undefined
      }
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="caption" sx={{ fontWeight: 600 }}>
            Pine 脚本（v6）
          </Typography>
          {compiling && <CircularProgress size={12} />}
        </Stack>
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <Tooltip title={drawerOpen ? '退出放大编辑（Esc）' : '在 Drawer 弹窗中放大编辑'}>
            <IconButton size="small" onClick={onToggleDrawer}>
              {drawerOpen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          <Button
            size="small"
            variant="contained"
            startIcon={loading ? <CircularProgress size={14} color="inherit" /> : <PlayArrowIcon fontSize="small" />}
            disabled={loading || !source.trim()}
            onClick={onRun}
          >
            运行回测
          </Button>
        </Stack>
      </Stack>

      {/* 全屏是为写长脚本服务的，提示条会挤占高度，故仅非全屏时显示 */}
      {!drawerOpen && (
        <Alert severity="info" sx={{ mb: 1.25, py: 0 }}>
          <Typography variant="caption">
            脚本是信号的唯一来源，引擎只负责撮合。编辑后 300ms 自动校验，诊断见下方。
            保存后可从上方「策略」下拉菜单直接选中，无需再次粘贴。
          </Typography>
        </Alert>
      )}

      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
        <TextField
          size="small"
          label="脚本名"
          value={name}
          placeholder="保存后可从「策略」下拉菜单直接选择"
          onChange={(e) => onNameChange(e.target.value)}
          sx={{ flex: 1, minWidth: { xs: '100%', sm: 160 } }}
          slotProps={{
            htmlInput: { maxLength: 60, style: { fontSize: 13 } },
            inputLabel: { shrink: true },
          }}
        />
        <Button
          size="small"
          variant="outlined"
          startIcon={busy ? <CircularProgress size={14} /> : <SaveIcon fontSize="small" />}
          disabled={busy || !source.trim() || !name.trim()}
          onClick={() => void doSave()}
        >
          保存
        </Button>
        <Tooltip
          title={
            selectedId
              ? '丢弃编辑器里的文本，从磁盘重新载入这份脚本（应用外部修改过 .pine 时用）'
              : '当前未载入已保存脚本'
          }
        >
          <span>
            <IconButton size="small" disabled={busy || !selectedId} onClick={() => void doReload()}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={selectedId ? '删除这份已保存脚本' : '当前未载入已保存脚本'}>
          <span>
            <Button
              size="small"
              color="error"
              startIcon={<DeleteOutlinedIcon fontSize="small" />}
              disabled={busy || !selectedId}
              onClick={() => void doDelete()}
            >
              删除
            </Button>
          </span>
        </Tooltip>
      </Stack>

      {(saveNote || saveError) && (
        <Typography
          variant="caption"
          sx={{ display: 'block', mb: 1, color: saveError ? 'error.main' : 'success.main' }}
        >
          {saveError ?? saveNote}
        </Typography>
      )}

      <Box
        sx={{
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 1,
          overflow: 'hidden',
          bgcolor: '#0f141e',
          // 全屏时撑满面板剩余高度；常规时给一个固定高度，避免长脚本把面板顶开
          ...(drawerOpen ? { flex: 1, minHeight: 0 } : { height: 320 }),
          '&:focus-within': { borderColor: 'primary.main' },
        }}
      >
        <CodeMirrorEditor value={source} onChange={onSourceChange} extensions={pineSetup} />
      </Box>

      {!source.trim() && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          粘贴 Pine 脚本，或点「载入示例」。
        </Typography>
      )}

      {compileError && (
        <Alert severity="error" sx={{ mt: 1.25 }}>
          <Typography variant="caption" sx={{ whiteSpace: 'pre-wrap' }}>
            {compileError}
          </Typography>
        </Alert>
      )}

      {!compileError && source.trim() && (
        <Alert severity={errorCount === 0 ? 'success' : 'error'} sx={{ mt: 1.25, py: 0 }}>
          <Typography variant="caption">
            {errorCount === 0
              ? `编译通过 · ${meta?.kind ?? '?'} 脚本 · ${meta?.inputs.length ?? 0} 个 input · ${
                  meta?.plotTitles.length ?? 0
                } 条 plot · ${meta?.alerts.length ?? 0} 条 alert`
              : `编译失败 · ${errorCount} 个错误 · ${diagnostics.length - errorCount} 个警告`}
          </Typography>
        </Alert>
      )}

      {diagnostics.length > 0 && (
        <Box component="ol" sx={{ m: 0, mt: 1, pl: 2.5, fontFamily: MONO, fontSize: 12 }}>
          {diagnostics.map((d, i) => (
            <Box
              component="li"
              key={`${d.line}-${d.column}-${i}`}
              sx={{ color: d.severity === 'error' ? 'error.main' : 'warning.main' }}
            >
              第 {d.line} 行 第 {d.column} 列 · {d.severity === 'error' ? '错误' : '警告'} · {d.message}
            </Box>
          ))}
        </Box>
      )}

      {meta && meta.inputs.length > 0 && (
        <Accordion
          disableGutters
          sx={{
            mt: 1.25,
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            '&:before': { display: 'none' },
          }}
        >
          <AccordionSummary
            expandIcon={<ExpandMoreIcon fontSize="small" />}
            sx={{ minHeight: 34, '& .MuiAccordionSummary-content': { my: 0.5 } }}
          >
            <Typography variant="caption" sx={{ fontWeight: 600 }}>
              回测参数覆盖
              {overrideCount > 0 ? `（已覆盖 ${overrideCount} 项）` : '（未覆盖，全部用脚本默认值）'}
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ pt: 0 }}>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {meta.inputs.map((it) => {
                const key = it.title || it.name
                const cur = inputs[key]
                if (it.type === 'bool') {
                  return (
                    <FormControlLabel
                      key={key}
                      control={
                        <Checkbox
                          size="small"
                          checked={cur === undefined ? Boolean(it.default) : Boolean(cur)}
                          onChange={(e) => onInputsChange({ ...inputs, [key]: e.target.checked })}
                        />
                      }
                      label={<Typography variant="caption">{key}</Typography>}
                    />
                  )
                }
                if (it.type === 'color' || it.type === 'string') return null
                const val = cur ?? (typeof it.default === 'number' ? it.default : '')
                return (
                  <TextField
                    key={key}
                    size="small"
                    type="number"
                    label={key}
                    value={val === '' ? '' : String(val)}
                    onChange={(e) => {
                      const v = e.target.value.trim()
                      const next = { ...inputs }
                      if (v === '') delete next[key]
                      else next[key] = Number(v)
                      onInputsChange(next)
                    }}
                    sx={{ width: 172 }}
                    slotProps={{
                      inputLabel: { shrink: true },
                      htmlInput: { style: { fontSize: 12 } },
                    }}
                  />
                )
              })}
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
              <Button size="small" onClick={() => onInputsChange({})} disabled={overrideCount === 0}>
                全部恢复默认
              </Button>
              <Typography variant="caption" color="text.secondary">
                只影响「运行回测」；图表上那条指标的参数在图表自己的设置里改（不会重跑回测）。
              </Typography>
            </Stack>
          </AccordionDetails>
        </Accordion>
      )}

    </Box>
  )
}
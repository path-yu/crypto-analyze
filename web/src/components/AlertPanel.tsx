/**
 * 价格警报面板（右侧 Drawer）。
 *
 * 三块内容：
 *   1. 推送设置 —— Telegram Bot Token / Chat ID、浏览器通知开关、轮询间隔
 *   2. 警报列表 —— 启用开关、条件摘要、当前值 / 最近检查、编辑 / 测试 / 删除
 *   3. 最近触发记录
 *
 * 判定与推送都在**服务端**完成（页面关掉也照常监控并发电报），
 * 面板只负责配置与展示；页内通知由顶层的 AlertNotifications 轮询触发记录后弹出。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Alert from '@mui/material/Alert'
import Autocomplete from '@mui/material/Autocomplete'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import Drawer from '@mui/material/Drawer'
import FormControl from '@mui/material/FormControl'
import FormControlLabel from '@mui/material/FormControlLabel'
import IconButton from '@mui/material/IconButton'
import InputLabel from '@mui/material/InputLabel'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Select from '@mui/material/Select'
import Stack from '../ui/Stack'
import Switch from '@mui/material/Switch'
import TextField from '@mui/material/TextField'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import AddIcon from '@mui/icons-material/Add'
import CloseIcon from '@mui/icons-material/Close'
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined'
import EditIcon from '@mui/icons-material/Edit'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import RefreshIcon from '@mui/icons-material/Refresh'
import SendIcon from '@mui/icons-material/Send'
import BoltIcon from '@mui/icons-material/Bolt'

import type {
  AlertChannel,
  AlertEvent,
  AlertIndicator,
  AlertKind,
  AlertOverview,
  AlertSettings,
  ExchangeId,
  Instrument,
  PriceAlert,
  SavedPineScript,
  Timeframe,
} from '@shared/types'
import {
  ALERT_INDICATORS,
  ALERT_KIND_META,
  DEFAULT_ALERT_SETTINGS,
  EXCHANGES,
  TIMEFRAMES,
  describeAlertCondition,
} from '@shared/types'
import {
  type AlertInput,
  clearAlertEvents,
  createAlert,
  deleteAlert,
  fetchAlerts,
  fetchAlertEvents,
  fetchInstruments,
  fetchPineScripts,
  runAlertTick,
  sendAlertNow,
  setAlertEnabled,
  testAlert,
  testTelegram,
  updateAlert,
  updateAlertSettings,
} from '../api'
import { dateTime, humanizeError, price as fmtPrice } from '../utils/format'
import useIsMobile from '../ui/useIsMobile'

interface Props {
  open: boolean
  onClose: () => void
  /** 新建警报时的默认交易所 / 合约 / 周期（跟随主界面当前选择） */
  defaultExchange: ExchangeId
  defaultSymbol: string
  defaultTimeframe: Timeframe
}

/** 编辑器表单的扁平草稿（提交时再折算成 AlertInput） */
interface Draft {
  id: string | null
  name: string
  exchange: ExchangeId
  symbol: string
  timeframe: Timeframe
  kind: AlertKind
  value: number
  indicator: AlertIndicator
  period: number
  pineScriptId: string
  message: string
  channels: AlertChannel[]
  enabled: boolean
  once: boolean
  cooldownSec: number
}

function emptyDraft(defaults: Pick<Props, 'defaultExchange' | 'defaultSymbol' | 'defaultTimeframe'>): Draft {
  return {
    id: null,
    name: '',
    exchange: defaults.defaultExchange,
    symbol: defaults.defaultSymbol,
    timeframe: defaults.defaultTimeframe,
    kind: 'priceCrossUp',
    value: 0,
    indicator: 'rsi',
    period: 14,
    pineScriptId: '',
    message: '',
    channels: ['browser', 'telegram'],
    enabled: true,
    once: false,
    cooldownSec: 60,
  }
}

function draftFromAlert(a: PriceAlert): Draft {
  return {
    id: a.id,
    name: a.name ?? '',
    exchange: a.exchange,
    symbol: a.symbol,
    timeframe: a.timeframe,
    kind: a.condition.kind,
    value: a.condition.value ?? 0,
    indicator: a.condition.indicator ?? 'rsi',
    period: a.condition.period ?? 14,
    pineScriptId: a.condition.pineScriptId ?? '',
    message: a.message ?? '',
    channels: a.channels.length ? a.channels : ['browser'],
    enabled: a.enabled,
    once: a.once,
    cooldownSec: a.cooldownSec ?? 0,
  }
}

function draftToInput(d: Draft): AlertInput {
  const meta = ALERT_KIND_META.find((m) => m.kind === d.kind)
  const condition: AlertInput['condition'] = { kind: d.kind }
  if (meta?.needsValue) condition.value = Number(d.value)
  if (meta?.needsIndicator) {
    condition.indicator = d.indicator
    if (ALERT_INDICATORS.find((i) => i.id === d.indicator)?.needsPeriod) {
      condition.period = Math.round(Number(d.period) || 14)
    }
  } else if (d.kind.startsWith('pine') && d.pineScriptId) {
    condition.pineScriptId = d.pineScriptId
  }
  const name = d.name.trim()
  return {
    ...(name ? { name } : {}),
    exchange: d.exchange,
    symbol: d.symbol,
    timeframe: d.timeframe,
    condition,
    message: d.message,
    channels: d.channels,
    enabled: d.enabled,
    once: d.once,
    cooldownSec: Math.max(0, Math.round(Number(d.cooldownSec) || 0)),
  }
}

const CHANNEL_LABEL: Record<AlertChannel, string> = {
  browser: '网页通知',
  telegram: '电报机器人',
}

export default function AlertPanel({
  open,
  onClose,
  defaultExchange,
  defaultSymbol,
  defaultTimeframe,
}: Props) {
  const isMobile = useIsMobile()
  const [overview, setOverview] = useState<AlertOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [settingsDraft, setSettingsDraft] = useState<AlertSettings | null>(null)
  const settingsTouched = useRef(false)
  const [telegramTesting, setTelegramTesting] = useState(false)
  const [telegramResult, setTelegramResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('default')

  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [pineScripts, setPineScripts] = useState<SavedPineScript[]>([])
  /** 脚本列表是否已拉取完（用于区分「还在加载」与「确实找不到这个 id」） */
  const [scriptsLoaded, setScriptsLoaded] = useState(false)
  const [events, setEvents] = useState<AlertEvent[]>([])

  /* ---------------- 数据拉取 ---------------- */

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const o = await fetchAlerts()
      setOverview(o)
      if (!settingsTouched.current) setSettingsDraft(o.settings)
      setError(null)
    } catch (err) {
      setError(humanizeError(err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshEvents = useCallback(async () => {
    try {
      setEvents(await fetchAlertEvents())
    } catch {
      /* 面板展示用，失败静默 */
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    void refreshEvents()
    const timer = window.setInterval(() => {
      void refresh()
      void refreshEvents()
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [open, refresh, refreshEvents])

  useEffect(() => {
    if (!open) return
    setPerm(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
  }, [open])

  /** 合约列表（跟随草稿里的交易所） */
  useEffect(() => {
    if (!draft) return
    let cancelled = false
    fetchInstruments(draft.exchange)
      .then((res) => {
        if (!cancelled) setInstruments(res.data)
      })
      .catch(() => {
        if (!cancelled) setInstruments([])
      })
    return () => {
      cancelled = true
    }
  }, [draft?.exchange])

  /**
   * Pine 脚本列表（Pine 类条件选脚本用）。
   *
   * 面板打开、以及每次打开编辑弹窗时都刷一次 —— 下拉的选项由它决定，只拉一次的话
   * 一旦首次拉取失败，弹窗里的「Pine 脚本」就会一直显示空白（选中值找不到对应选项）。
   */
  useEffect(() => {
    if (!open) return
    fetchPineScripts()
      .then((list) => {
        setPineScripts(list)
        setScriptsLoaded(true)
      })
      .catch((err) => {
        setPineScripts([])
        setScriptsLoaded(true)
        // 不静默吞掉：否则「弹窗里脚本名一片空白」会无从排查
        console.warn('[alerts] 已保存脚本列表拉取失败：', err)
      })
  }, [open, draft !== null])

  /**
   * 「Pine 脚本」下拉的显示文案。
   *
   * 空值走默认脚本时**点出脚本名**（只写「第一份已保存脚本」等于没说）；选中值在列表里
   * 找不到对应项时也不留空白 —— 列表还在路上就显示「加载中…」，确实找不到就说「未知脚本」。
   */
  const scriptLabel = (id: string): string => {
    if (!id) {
      const first = pineScripts[0]?.name
      return first ? `（默认：${first}）` : '（默认：列表第一份已保存脚本）'
    }
    const hit = pineScripts.find((s) => s.id === id)
    if (hit) return hit.name
    return scriptsLoaded ? `未知脚本（${id}）` : '加载中…'
  }

  /** 草稿里的周期变化时同步周期默认值 */
  const selectedInstrument = useMemo(
    () => instruments.find((i) => i.symbol === draft?.symbol) ?? null,
    [instruments, draft?.symbol],
  )

  /* ---------------- 设置 ---------------- */

  const patchSettings = (patch: Partial<AlertSettings>) => {
    settingsTouched.current = true
    setSettingsDraft((prev) => ({ ...(prev ?? DEFAULT_ALERT_SETTINGS), ...patch }))
  }

  const patchTelegram = (patch: Partial<AlertSettings['telegram']>) => {
    settingsTouched.current = true
    setSettingsDraft((prev) => {
      const base = prev ?? DEFAULT_ALERT_SETTINGS
      return { ...base, telegram: { ...base.telegram, ...patch } }
    })
  }

  const saveSettings = async () => {
    if (!settingsDraft) return
    try {
      const saved = await updateAlertSettings(settingsDraft)
      setSettingsDraft(saved)
      settingsTouched.current = false
      setNotice('设置已保存')
      setError(null)
      void refresh()
    } catch (err) {
      setError(humanizeError(err instanceof Error ? err.message : String(err)))
    }
  }

  const handleTestTelegram = async () => {
    if (!settingsDraft) return
    setTelegramTesting(true)
    setTelegramResult(null)
    try {
      setTelegramResult(await testTelegram(settingsDraft.telegram))
    } catch (err) {
      setTelegramResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setTelegramTesting(false)
    }
  }

  const requestPermission = async () => {
    if (typeof Notification === 'undefined') return
    const result = await Notification.requestPermission()
    setPerm(result)
  }

  /* ---------------- 单条警报操作 ---------------- */

  const handleToggle = async (a: PriceAlert, enabled: boolean) => {
    setBusyId(a.id)
    try {
      await setAlertEnabled(a.id, enabled)
      await refresh()
    } catch (err) {
      setError(humanizeError(err instanceof Error ? err.message : String(err)))
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (a: PriceAlert) => {
    setBusyId(a.id)
    try {
      await deleteAlert(a.id)
      setNotice(`已删除「${a.name || a.symbol}」`)
      await refresh()
    } catch (err) {
      setError(humanizeError(err instanceof Error ? err.message : String(err)))
    } finally {
      setBusyId(null)
    }
  }

  const handleTestCondition = async (a: PriceAlert) => {
    setBusyId(a.id)
    try {
      const r = await testAlert(a.id)
      if (r.error) setError(`「${a.name || a.symbol}」判定失败：${humanizeError(r.error)}`)
      else
        setNotice(
          `「${a.name || a.symbol}」当前${r.matched ? '已命中' : '未命中'}条件，当前值 ${r.value}（${
            r.summary.title
          }）`,
        )
    } catch (err) {
      setError(humanizeError(err instanceof Error ? err.message : String(err)))
    } finally {
      setBusyId(null)
    }
  }

  const handleSendNow = async (a: PriceAlert) => {
    setBusyId(a.id)
    try {
      const ev = await sendAlertNow(a.id)
      if (ev.telegram && !ev.telegram.ok) {
        setError(`电报推送失败：${ev.telegram.error ?? '未知原因'}`)
      } else {
        setNotice(`已按「${a.name || a.symbol}」发送一条推送，可在下方触发记录中查看`)
      }
      await refreshEvents()
    } catch (err) {
      setError(humanizeError(err instanceof Error ? err.message : String(err)))
    } finally {
      setBusyId(null)
    }
  }

  const handleTickNow = async () => {
    setBusyId('tick')
    try {
      await runAlertTick()
      await refresh()
      setNotice('已执行一次轮询')
    } catch (err) {
      setError(humanizeError(err instanceof Error ? err.message : String(err)))
    } finally {
      setBusyId(null)
    }
  }

  const handleClearEvents = async () => {
    try {
      await clearAlertEvents()
      setEvents([])
      setNotice('触发记录已清空')
    } catch (err) {
      setError(humanizeError(err instanceof Error ? err.message : String(err)))
    }
  }

  /* ---------------- 草稿保存 ---------------- */

  const saveDraft = async () => {
    if (!draft) return
    if (draft.channels.length === 0) {
      setError('请至少选择一个推送渠道')
      return
    }
    if (!draft.symbol.trim()) {
      setError('请选择合约')
      return
    }
    const meta = ALERT_KIND_META.find((m) => m.kind === draft.kind)
    if (meta?.needsValue && !Number.isFinite(Number(draft.value))) {
      setError('请填写有效的阈值')
      return
    }
    setSaving(true)
    try {
      const input = draftToInput(draft)
      if (draft.id) await updateAlert(draft.id, input)
      else await createAlert(input)
      setDraft(null)
      setError(null)
      setNotice(draft.id ? '警报已更新' : '警报已创建，服务端已开始监控')
      await refresh()
    } catch (err) {
      setError(humanizeError(err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  /* ---------------- 渲染 ---------------- */

  const alerts = overview?.alerts ?? []
  const status = overview?.status
  const stream = status?.stream
  const draftMeta = draft ? ALERT_KIND_META.find((m) => m.kind === draft.kind) : undefined

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            width: { xs: '100%', md: 'min(1040px, 92vw)' },
            p: { xs: 1.5, sm: 2.5 },
            boxSizing: 'border-box',
          },
        },
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
        <NotificationsActiveIcon color="primary" />
        <Box sx={{ flex: 1 }}>
          <Typography variant="h6">价格警报</Typography>
          <Typography variant="caption" color="text.secondary">
            服务端定时轮询行情并判定条件 · 命中后推送到电报机器人 / 网页通知
          </Typography>
        </Box>
        <IconButton size="small" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 1.5 }} onClose={() => setError(null)}>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
            {error}
          </Typography>
        </Alert>
      )}
      {notice && (
        <Alert severity="success" sx={{ mb: 1.5 }} onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      {/* ---------------- 运行状态 ---------------- */}
      <Paper sx={{ p: 1.5, mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Chip
            size="small"
            color={status?.standby ? 'warning' : status?.running ? 'success' : 'default'}
            label={
              status?.standby ? '待机（另一实例正在监控）' : status?.running ? '监控运行中' : '监控已停止'
            }
          />
          {status?.standby && (
            <Tooltip title="同一份警报数据被多个后端实例同时监控时，同一根 K 线会被推两遍（电报收到重复消息）。因此监控权由 monitor.lock 排他持有：本实例只提供接口，不订阅行情、不判定、不推送。停掉另一个实例后，本实例会在 30 秒内自动接管。">
              <Chip size="small" color="warning" variant="outlined" label="为什么是待机？" />
            </Tooltip>
          )}
          <Tooltip title="价格类走交易所 WebSocket（秒级）；指标 / Pine 类在 K 线收盘瞬间判定。WS 不可用时自动回落下面这个轮询间隔。">
            <Chip size="small" color="primary" variant="outlined" label="数据源 WebSocket 优先" />
          </Tooltip>
          <Chip
            size="small"
            variant="outlined"
            label={`REST 兜底间隔 ${((settingsDraft?.pollIntervalMs ?? overview?.settings.pollIntervalMs ?? 0) / 1000).toFixed(0)}s`}
          />
          <Box sx={{ flex: 1 }} />
          <Button
            size="small"
            startIcon={<RefreshIcon />}
            disabled={busyId === 'tick' || loading}
            onClick={() => void handleTickNow()}
          >
            立即轮询
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() =>
              setDraft(
                emptyDraft({ defaultExchange, defaultSymbol, defaultTimeframe }),
              )
            }
          >
            新建警报
          </Button>
        </Stack>

        {/* WS 连接明细：订阅数 / 活跃交易所 / 最近行情 / 报错 */}
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
          <Chip
            size="small"
            variant="outlined"
            color={
              !stream
                ? 'default'
                : stream.activeExchanges.length > 0
                  ? 'success'
                  : stream.tickerSubscriptions + stream.ohlcvSubscriptions > 0
                    ? 'warning'
                    : 'default'
            }
            label={`WS 订阅 价格 ${stream?.tickerSubscriptions ?? 0} · K 线 ${stream?.ohlcvSubscriptions ?? 0}`}
          />
          <Chip
            size="small"
            variant="outlined"
            label={
              stream?.lastMessageAt ? `最近行情 ${dateTime(stream.lastMessageAt)}` : '尚未收到 WS 行情'
            }
          />
          {stream && stream.activeExchanges.length > 0 && (
            <Chip size="small" variant="outlined" label={`活跃交易所 ${stream.activeExchanges.join(' / ')}`} />
          )}
          <Chip
            size="small"
            variant="outlined"
            label={
              status?.lastTickAt
                ? `最近轮询 ${dateTime(status.lastTickAt)}${status.lastTickMs !== undefined ? `（${status.lastTickMs}ms）` : ''}`
                : '尚未轮询'
            }
          />
          {status?.lastTickError && (
            <Chip size="small" color="error" label={`轮询异常：${status.lastTickError}`} />
          )}
          {stream?.lastError && (
            <Tooltip title="WS 断线会按 2s → 30s 退避重连；此期间数据自动回落 REST 取数，不会漏警报">
              <Chip size="small" color="warning" label={`WS：${stream.lastError}`} />
            </Tooltip>
          )}
        </Stack>
      </Paper>

      {/* ---------------- 推送设置 ---------------- */}
      <Accordion
        disableGutters
        elevation={0}
        sx={{ bgcolor: 'transparent', '&:before': { display: 'none' }, mb: 1 }}
      >
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 36 }}>
          <Typography variant="subtitle2">推送设置</Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 0 }}>
          <Stack spacing={2}>
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                Telegram：在 @BotFather 处申请 Bot Token，把机器人拉进目标会话后获取 Chat ID
                （可用 @userinfobot 查询）。
              </Typography>
              <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center">
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={settingsDraft?.telegram.enabled ?? false}
                      onChange={(e) => patchTelegram({ enabled: e.target.checked })}
                    />
                  }
                  label={<Typography variant="body2">启用 Telegram 推送</Typography>}
                />
                <TextField
                  size="small"
                  sx={{ minWidth: { xs: '100%', sm: 300 }, flex: { xs: '1 1 100%', sm: '1 1 auto' } }}
                  label="Bot Token"
                  placeholder="123456:ABC-DEF..."
                  value={settingsDraft?.telegram.botToken ?? ''}
                  onChange={(e) => patchTelegram({ botToken: e.target.value })}
                  slotProps={{ inputLabel: { shrink: true } }}
                />
                <TextField
                  size="small"
                  sx={{ minWidth: { xs: '100%', sm: 200 }, flex: { xs: '1 1 100%', sm: '1 1 auto' } }}
                  label="Chat ID"
                  placeholder="-1001234567890"
                  value={settingsDraft?.telegram.chatId ?? ''}
                  onChange={(e) => patchTelegram({ chatId: e.target.value })}
                  slotProps={{ inputLabel: { shrink: true } }}
                />
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={telegramTesting ? <CircularProgress size={14} /> : <SendIcon />}
                  disabled={telegramTesting}
                  onClick={() => void handleTestTelegram()}
                >
                  发送测试消息
                </Button>
              </Stack>
              {telegramResult && (
                <Alert severity={telegramResult.ok ? 'success' : 'warning'} sx={{ mt: 1 }}>
                  {telegramResult.ok ? '测试消息已发出，请查看 Telegram' : `发送失败：${telegramResult.error}`}
                </Alert>
              )}
            </Box>

            <Divider />

            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
              <FormControlLabel
                control={
                  <Switch
                    size="small"
                    checked={settingsDraft?.browserEnabled ?? true}
                    onChange={(e) => patchSettings({ browserEnabled: e.target.checked })}
                  />
                }
                label={<Typography variant="body2">启用网页通知（Notification API）</Typography>}
              />
              <Chip
                size="small"
                variant="outlined"
                color={perm === 'granted' ? 'success' : perm === 'denied' ? 'error' : 'default'}
                label={
                  perm === 'unsupported'
                    ? '当前浏览器不支持通知'
                    : `通知权限：${
                        perm === 'granted' ? '已授权' : perm === 'denied' ? '已拒绝（需在浏览器设置中恢复）' : '未授权'
                      }`
                }
              />
              {perm !== 'granted' && perm !== 'unsupported' && (
                <Button size="small" variant="outlined" onClick={() => void requestPermission()}>
                  申请通知权限
                </Button>
              )}
              <TextField
                size="small"
                type="number"
                label="轮询间隔"
                sx={{ width: 150 }}
                value={Math.round((settingsDraft?.pollIntervalMs ?? 15000) / 1000)}
                onChange={(e) =>
                  patchSettings({ pollIntervalMs: Math.max(5, Number(e.target.value) || 15) * 1000 })
                }
                slotProps={{
                  htmlInput: { min: 5, step: 1, style: { fontSize: 13 } },
                  inputLabel: { shrink: true },
                  input: { endAdornment: <Typography variant="caption">秒</Typography> },
                }}
              />
              <Button variant="contained" size="small" onClick={() => void saveSettings()}>
                保存设置
              </Button>
            </Stack>
          </Stack>
        </AccordionDetails>
      </Accordion>

      {/* ---------------- 警报列表 ---------------- */}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Typography variant="subtitle2">警报列表（{alerts.length}）</Typography>
        {loading && <CircularProgress size={14} />}
      </Stack>

      {alerts.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            还没有警报。点击右上角「新建警报」，为某个合约添加一条实时监控条件。
          </Typography>
        </Paper>
      ) : (
        <Stack spacing={1.5}>
          {alerts.map((a) => (
            <Paper key={a.id} sx={{ p: 1.75 }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="subtitle2">{a.name || a.symbol}</Typography>
                <Chip size="small" variant="outlined" label={a.symbol} />
                <Chip size="small" variant="outlined" label={`${a.exchange} · ${a.timeframe}`} />
                <Chip size="small" color="primary" variant="outlined" label={describeAlertCondition(a.condition)} />
                {a.channels.map((c) => (
                  <Chip key={c} size="small" variant="outlined" label={CHANNEL_LABEL[c]} />
                ))}
                {a.once && <Chip size="small" variant="outlined" label="单次" />}
                <Box sx={{ flex: 1 }} />
                <FormControlLabel
                  sx={{ mr: 0 }}
                  control={
                    <Switch
                      size="small"
                      checked={a.enabled}
                      disabled={busyId === a.id}
                      onChange={(e) => void handleToggle(a, e.target.checked)}
                    />
                  }
                  label={<Typography variant="caption">{a.enabled ? '监控中' : '已停用'}</Typography>}
                />
              </Stack>

              <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  当前值 {a.state.lastValue !== undefined ? fmtPrice(a.state.lastValue) : '—'}
                  {a.state.basePrice !== undefined ? ` · 基准 ${fmtPrice(a.state.basePrice)}` : ''}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  最近检查 {a.state.checkedAt ? dateTime(a.state.checkedAt) : '—'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  触发 {a.triggerCount} 次
                  {a.lastTriggeredAt ? ` · 最近 ${dateTime(a.lastTriggeredAt)}` : ''}
                </Typography>
              </Stack>

              {(a.state.lastError || a.state.lastPushError) && (
                <Alert severity="warning" sx={{ mt: 1, py: 0 }}>
                  <Typography variant="caption" component="div">
                    {a.state.lastError && <div>判定：{humanizeError(a.state.lastError)}</div>}
                    {a.state.lastPushError && <div>推送：{humanizeError(a.state.lastPushError)}</div>}
                  </Typography>
                </Alert>
              )}

              {a.message.trim() && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ mt: 1, display: 'block', whiteSpace: 'pre-wrap' }}
                >
                  提示信息：{a.message}
                </Typography>
              )}

              <Stack direction="row" spacing={1} sx={{ mt: 1.25 }} flexWrap="wrap" useFlexGap>
                <Button size="small" startIcon={<EditIcon />} onClick={() => setDraft(draftFromAlert(a))}>
                  编辑
                </Button>
                <Tooltip title="用当前行情判定一次，不推送">
                  <Button
                    size="small"
                    startIcon={<BoltIcon />}
                    disabled={busyId === a.id}
                    onClick={() => void handleTestCondition(a)}
                  >
                    测试条件
                  </Button>
                </Tooltip>
                <Tooltip title="立即发送一条推送，验证渠道是否打通">
                  <Button
                    size="small"
                    startIcon={<SendIcon />}
                    disabled={busyId === a.id}
                    onClick={() => void handleSendNow(a)}
                  >
                    测试推送
                  </Button>
                </Tooltip>
                <Button
                  size="small"
                  color="error"
                  startIcon={<DeleteOutlinedIcon />}
                  disabled={busyId === a.id}
                  onClick={() => void handleDelete(a)}
                >
                  删除
                </Button>
              </Stack>
            </Paper>
          ))}
        </Stack>
      )}

      {/* ---------------- 触发记录 ---------------- */}
      <Accordion
        disableGutters
        elevation={0}
        sx={{ bgcolor: 'transparent', '&:before': { display: 'none' }, mt: 2 }}
      >
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 36 }}>
          <Typography variant="subtitle2">最近触发记录（{events.length}）</Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 0 }}>
          {/* 清空按钮放在 Details 里：AccordionSummary 本身渲染为 <button>，内嵌 Button 是非法 HTML */}
          <Stack direction="row" sx={{ mb: 0.5 }}>
            <Box sx={{ flex: 1 }} />
            <Button size="small" disabled={events.length === 0} onClick={() => void handleClearEvents()}>
              清空
            </Button>
          </Stack>
          {events.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              暂无触发记录
            </Typography>
          ) : (
            <List dense disablePadding>
              {[...events]
                .reverse()
                .slice(0, 20)
                .map((e) => (
                  <ListItem key={e.seq} disableGutters alignItems="flex-start" sx={{ py: 0.75 }}>
                    <ListItemText
                      primary={
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Typography variant="body2">{e.title}</Typography>
                          <Chip size="small" variant="outlined" label={e.symbol} />
                          {e.telegram && (
                            <Chip
                              size="small"
                              color={e.telegram.ok ? 'success' : 'error'}
                              variant="outlined"
                              label={e.telegram.ok ? '电报已发' : `电报失败：${e.telegram.error ?? ''}`}
                            />
                          )}
                        </Stack>
                      }
                      secondary={
                        <Typography variant="caption" color="text.secondary">
                          {dateTime(e.at)} · 触发值 {fmtPrice(e.value)}
                          {e.body ? ` · ${e.body}` : ''}
                        </Typography>
                      }
                    />
                  </ListItem>
                ))}
            </List>
          )}
        </AccordionDetails>
      </Accordion>

      {/* ---------------- 新建 / 编辑弹窗 ---------------- */}
      <Dialog open={draft !== null} onClose={() => setDraft(null)} maxWidth="md" fullWidth fullScreen={isMobile}>
        <DialogTitle>{draft?.id ? '编辑价格警报' : '新建价格警报'}</DialogTitle>
        <DialogContent dividers>
          {draft && (
            <Stack spacing={2} sx={{ mt: 0.5 }}>
              <Box
                sx={{
                  display: 'grid',
                  gap: 1.5,
                  gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                }}
              >
                <TextField
                  size="small"
                  label="名称（可选）"
                  placeholder="例如 BTC 突破提醒"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  slotProps={{ inputLabel: { shrink: true } }}
                />
                <FormControl size="small" fullWidth>
                  <InputLabel shrink>交易所</InputLabel>
                  <Select
                    label="交易所"
                    notched
                    value={draft.exchange}
                    onChange={(e) => setDraft({ ...draft, exchange: e.target.value as ExchangeId, symbol: '' })}
                  >
                    {EXCHANGES.map((x) => (
                      <MenuItem key={x.id} value={x.id}>
                        {x.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Autocomplete
                  size="small"
                  options={instruments}
                  value={selectedInstrument}
                  getOptionLabel={(o) => (typeof o === 'string' ? o : `${o.label} · ${o.symbol}`)}
                  isOptionEqualToValue={(a, b) => a.symbol === b.symbol}
                  onChange={(_e, v) => {
                    if (v && typeof v !== 'string') {
                      setDraft((d) => (d ? { ...d, symbol: v.symbol } : d))
                    }
                  }}
                  renderInput={(p) => (
                    <TextField {...p} label="合约（USDT 本位永续）" placeholder="输入 BTC / ETH 搜索" />
                  )}
                />
                <FormControl size="small" fullWidth>
                  <InputLabel shrink>K 线周期</InputLabel>
                  <Select
                    label="K 线周期"
                    notched
                    value={draft.timeframe}
                    onChange={(e) => setDraft({ ...draft, timeframe: e.target.value as Timeframe })}
                  >
                    {TIMEFRAMES.map((tf) => (
                      <MenuItem key={tf} value={tf}>
                        {tf}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Box>

              <Divider />

              <Typography variant="subtitle2">触发条件（策略）</Typography>
              <Box
                sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}
              >
                <FormControl size="small" fullWidth>
                  <InputLabel shrink>条件类型</InputLabel>
                  <Select
                    label="条件类型"
                    notched
                    value={draft.kind}
                    onChange={(e) => {
                      const kind = e.target.value as AlertKind
                      const meta = ALERT_KIND_META.find((m) => m.kind === kind)
                      // 换类型时把阈值重置成该类型的默认值（例如 5% → RSI 70），避免沿用无关数值
                      setDraft({ ...draft, kind, value: meta?.valueDefault ?? draft.value })
                    }}
                  >
                    {ALERT_KIND_META.map((m) => (
                      <MenuItem key={m.kind} value={m.kind}>
                        {m.group} · {m.label}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                {draftMeta?.needsValue && (
                  <TextField
                    size="small"
                    type="number"
                    label={draftMeta.valueLabel}
                    value={draft.value}
                    onChange={(e) => setDraft({ ...draft, value: Number(e.target.value) })}
                    slotProps={{
                      htmlInput: { step: 'any', style: { fontSize: 13 } },
                      inputLabel: { shrink: true },
                      input: draftMeta.valueSuffix
                        ? { endAdornment: <Typography variant="caption">{draftMeta.valueSuffix}</Typography> }
                        : undefined,
                    }}
                  />
                )}

                {draftMeta?.needsIndicator && (
                  <>
                    <FormControl size="small" fullWidth>
                      <InputLabel shrink>指标</InputLabel>
                      <Select
                        label="指标"
                        notched
                        value={draft.indicator}
                        onChange={(e) => setDraft({ ...draft, indicator: e.target.value as AlertIndicator })}
                      >
                        {ALERT_INDICATORS.map((i) => (
                          <MenuItem key={i.id} value={i.id}>
                            {i.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    {ALERT_INDICATORS.find((i) => i.id === draft.indicator)?.needsPeriod && (
                      <TextField
                        size="small"
                        type="number"
                        label="指标周期"
                        value={draft.period}
                        onChange={(e) => setDraft({ ...draft, period: Number(e.target.value) })}
                        slotProps={{ htmlInput: { min: 2, step: 1, style: { fontSize: 13 } }, inputLabel: { shrink: true } }}
                      />
                    )}
                  </>
                )}

                {draft.kind.startsWith('pine') && (
                  <FormControl size="small" fullWidth>
                    <InputLabel shrink>Pine 脚本</InputLabel>
                    <Select
                      label="Pine 脚本"
                      notched
                      // 空值是常态（新建警报、以及保存时没选脚本的警报都会是空）：
                      // 不加 displayEmpty 的话 MUI 对空值直接不渲染任何文案，下拉框就是一片空白
                      displayEmpty
                      value={draft.pineScriptId}
                      onChange={(e) => setDraft({ ...draft, pineScriptId: e.target.value })}
                      renderValue={(v) => scriptLabel(String(v ?? ''))}
                    >
                      <MenuItem value="">{scriptLabel('')}</MenuItem>
                      {pineScripts.map((s) => (
                        <MenuItem key={s.id} value={s.id}>
                          {s.name}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                )}
              </Box>

              <Typography variant="caption" color="text.secondary">
                {draft.kind.startsWith('pine')
                  ? '服务端会在最近一根已收盘 K 线上跑一遍所选脚本，出现对应信号时推送。'
                  : draftMeta?.needsIndicator
                    ? '服务端按周期拉取 K 线，在最近一根已收盘 K 线上计算指标并判定穿越。'
                    : '服务端按轮询间隔取最新价判定；「上穿 / 下穿」只在穿越那一刻触发一次。'}
              </Typography>

              <Divider />

              <TextField
                size="small"
                label="提示信息（可编辑，留空用自动文案）"
                multiline
                minRows={2}
                maxRows={6}
                value={draft.message}
                onChange={(e) => setDraft({ ...draft, message: e.target.value })}
                slotProps={{ inputLabel: { shrink: true } }}
                helperText="支持占位符：{symbol} {name} {price} {value} {condition} {time}；多行时首行为标题、其余为正文"
              />

              <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
                <Box>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>
                    推送渠道
                  </Typography>
                  <Stack direction="row" alignItems="center">
                    {(Object.keys(CHANNEL_LABEL) as AlertChannel[]).map((c) => (
                      <FormControlLabel
                        key={c}
                        control={
                          <Checkbox
                            size="small"
                            checked={draft.channels.includes(c)}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                channels: e.target.checked
                                  ? [...draft.channels, c]
                                  : draft.channels.filter((x) => x !== c),
                              })
                            }
                          />
                        }
                        label={<Typography variant="caption">{CHANNEL_LABEL[c]}</Typography>}
                      />
                    ))}
                  </Stack>
                </Box>
                <TextField
                  size="small"
                  type="number"
                  label="冷却时间"
                  sx={{ width: 150 }}
                  value={draft.cooldownSec}
                  onChange={(e) => setDraft({ ...draft, cooldownSec: Number(e.target.value) })}
                  slotProps={{
                    htmlInput: { min: 0, step: 5, style: { fontSize: 13 } },
                    inputLabel: { shrink: true },
                    input: { endAdornment: <Typography variant="caption">秒</Typography> },
                  }}
                />
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={draft.once}
                      onChange={(e) => setDraft({ ...draft, once: e.target.checked })}
                    />
                  }
                  label={<Typography variant="caption">触发一次后自动停用</Typography>}
                />
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={draft.enabled}
                      onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                    />
                  }
                  label={<Typography variant="caption">创建后立即启用</Typography>}
                />
              </Stack>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDraft(null)}>取消</Button>
          <Button
            variant="contained"
            disabled={saving}
            startIcon={saving ? <CircularProgress size={14} /> : <PlayArrowIcon />}
            onClick={() => void saveDraft()}
          >
            {draft?.id ? '保存修改' : '创建警报'}
          </Button>
        </DialogActions>
      </Dialog>
    </Drawer>
  )
}

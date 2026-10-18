import { useMemo, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import MenuItem from '@mui/material/MenuItem'
import Paper from '@mui/material/Paper'
import Stack from '../ui/Stack'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TablePagination from '@mui/material/TablePagination'
import TableRow from '@mui/material/TableRow'
import TableSortLabel from '@mui/material/TableSortLabel'
import TextField from '@mui/material/TextField'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import DownloadIcon from '@mui/icons-material/Download'
import HistoryIcon from '@mui/icons-material/History'

import type { BacktestResult, Trade } from '@shared/types'
import { EXIT_REASON_LABEL, dateTime, money, num, pct, price } from '../utils/format'
import { UP_COLOR, DOWN_COLOR } from '../theme'
import { tradesToCsv } from '../utils/report'

type SortKey =
  | 'id'
  | 'entryTime'
  | 'netPnl'
  | 'pnlPercent'
  | 'balanceAfter'
  | 'barsHeld'
  | 'priceChangePercent'

const REASON_COLOR: Record<string, string> = {
  TP1: UP_COLOR,
  TP2: UP_COLOR,
  StopLoss: DOWN_COLOR,
  BreakEven: '#8a94a6',
  Reverse: '#ffb01f',
  TrendSwitch: '#5b8cff',
  ScriptClose: '#5b8cff',
  Liquidation: '#ff2244',
  TimeStop: '#ffb01f',
  EndOfData: '#8a94a6',
}

export default function TradesTable({
  result,
  onSelectTrade,
  onReplayTrade,
}: {
  result: BacktestResult
  /** 点击某一行 → 交给外层打开单笔明细弹窗（与 K 线图上的交易标记共用） */
  onSelectTrade?: (trade: Trade) => void
  /** 点击「回溯」按钮 → 打开该笔交易的 K 线回放弹窗 */
  onReplayTrade?: (trade: Trade) => void
}) {
  const [page, setPage] = useState(0)
  const [rowsPerPage, setRowsPerPage] = useState(25)
  const [sortKey, setSortKey] = useState<SortKey>('id')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [filter, setFilter] = useState<'all' | 'long' | 'short' | 'win' | 'loss'>('all')

  const filtered = useMemo(() => {
    let list = result.trades.slice()
    switch (filter) {
      case 'long':
        list = list.filter((t) => t.side === 'long')
        break
      case 'short':
        list = list.filter((t) => t.side === 'short')
        break
      case 'win':
        list = list.filter((t) => t.netPnl > 0)
        break
      case 'loss':
        list = list.filter((t) => t.netPnl <= 0)
        break
      default:
        break
    }
    list.sort((a, b) => {
      const av = a[sortKey] as number
      const bv = b[sortKey] as number
      return sortDir === 'asc' ? av - bv : bv - av
    })
    return list
  }, [result.trades, filter, sortKey, sortDir])

  const rows = useMemo(
    () => filtered.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage),
    [filtered, page, rowsPerPage],
  )

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const downloadCsv = () => {
    const csv = tradesToCsv(result.trades)
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `trades-${result.report.symbol.replace(/[^a-zA-Z0-9]/g, '')}-${
      result.report.timeframe
    }.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const headers: { key: SortKey | null; label: string; align?: 'right' | 'left' | 'center' }[] = [
    { key: 'id', label: '#', align: 'right' },
    { key: null, label: '方向', align: 'center' },
    { key: 'entryTime', label: '入场时间', align: 'left' },
    { key: null, label: '入场价', align: 'right' },
    { key: null, label: '出场时间', align: 'left' },
    { key: null, label: '出场价', align: 'right' },
    { key: null, label: '数量', align: 'right' },
    { key: null, label: '名义价值', align: 'right' },
    { key: 'priceChangePercent', label: '价格变动', align: 'right' },
    { key: 'netPnl', label: '净盈亏', align: 'right' },
    { key: 'pnlPercent', label: '收益率', align: 'right' },
    { key: 'balanceAfter', label: '余额', align: 'right' },
    { key: 'barsHeld', label: '持仓', align: 'right' },
    { key: null, label: '平仓原因', align: 'center' },
    { key: null, label: '回溯', align: 'center' },
  ]

  return (
    <Paper sx={{ overflow: 'hidden' }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{
          px: { xs: 1.5, sm: 2 },
          py: 1.25,
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexWrap: 'wrap',
          gap: 1,
        }}
      >
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle2">历史交易记录</Typography>
          <Typography variant="caption" color="text.secondary">
            共 {filtered.length} 笔（总计 {result.trades.length} 笔）
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <TextField
            select
            size="small"
            label="筛选"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as typeof filter)
              setPage(0)
            }}
            sx={{ width: 130 }}
            slotProps={{ inputLabel: { shrink: true } }}
          >
            <MenuItem value="all">全部</MenuItem>
            <MenuItem value="long">仅多头</MenuItem>
            <MenuItem value="short">仅空头</MenuItem>
            <MenuItem value="win">仅盈利</MenuItem>
            <MenuItem value="loss">仅亏损</MenuItem>
          </TextField>
          <Button size="small" variant="outlined" startIcon={<DownloadIcon />} onClick={downloadCsv}>
            导出 CSV
          </Button>
        </Stack>
      </Stack>

      <TableContainer sx={{ maxHeight: 620 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {headers.map((h) => (
                <TableCell key={h.label} align={h.align ?? 'right'}>
                  {h.key ? (
                    <TableSortLabel
                      active={sortKey === h.key}
                      direction={sortKey === h.key ? sortDir : 'desc'}
                      onClick={() => h.key && onSort(h.key)}
                    >
                      {h.label}
                    </TableSortLabel>
                  ) : (
                    h.label
                  )}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((t) => {
              const win = t.netPnl >= 0
              const color = win ? UP_COLOR : DOWN_COLOR
              return (
                <TableRow
                  key={t.id}
                  hover
                  sx={{ cursor: 'pointer' }}
                  onClick={() => onSelectTrade?.(t)}
                >
                  <TableCell align="right">{t.id}</TableCell>
                  <TableCell align="center">
                    <Chip
                      size="small"
                      label={t.side === 'long' ? '多' : '空'}
                      sx={{
                        height: 18,
                        fontSize: 10,
                        bgcolor: t.side === 'long' ? 'rgba(255,77,79,0.15)' : 'rgba(61,220,151,0.15)',
                        color: t.side === 'long' ? UP_COLOR : DOWN_COLOR,
                      }}
                    />
                  </TableCell>
                  <TableCell>{dateTime(t.entryTime)}</TableCell>
                  <TableCell align="right">{price(t.entryPrice)}</TableCell>
                  <TableCell>{dateTime(t.exitTime)}</TableCell>
                  <TableCell align="right">{price(t.exitPrice)}</TableCell>
                  <TableCell align="right">{num(t.qty, 5)}</TableCell>
                  <TableCell align="right">{money(t.notional, 0)}</TableCell>
                  <TableCell align="right" sx={{ color: t.priceChangePercent >= 0 ? UP_COLOR : DOWN_COLOR }}>
                    {pct(t.priceChangePercent)}
                  </TableCell>
                  <TableCell align="right" sx={{ color, fontWeight: 600 }}>
                    {money(t.netPnl)}
                  </TableCell>
                  <TableCell align="right" sx={{ color, fontWeight: 600 }}>
                    {pct(t.pnlPercent)}
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.secondary' }}
                  >
                    {money(t.balanceAfter)}
                  </TableCell>
                  <TableCell align="right">{t.barsHeld}</TableCell>
                  <TableCell align="center">
                    <Chip
                      size="small"
                      label={EXIT_REASON_LABEL[t.exitReason] ?? t.exitReason}
                      sx={{
                        height: 18,
                        fontSize: 10,
                        bgcolor: 'action.hover',
                        color: REASON_COLOR[t.exitReason] ?? 'text.secondary',
                      }}
                    />
                  </TableCell>
                  <TableCell align="center" padding="none">
                    <Tooltip title="K 线回溯：从入场逐根回放到出场">
                      <IconButton
                        size="small"
                        onClick={(e) => {
                          // 不要触发该行的「打开单笔明细」点击
                          e.stopPropagation()
                          onReplayTrade?.(t)
                        }}
                      >
                        <HistoryIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              )
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={headers.length} align="center" sx={{ py: 4 }}>
                  <Typography variant="body2" color="text.secondary">
                    没有符合条件的交易记录
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <TablePagination
        component="div"
        count={filtered.length}
        page={page}
        onPageChange={(_e, p) => setPage(p)}
        rowsPerPage={rowsPerPage}
        onRowsPerPageChange={(e) => {
          setRowsPerPage(Number(e.target.value))
          setPage(0)
        }}
        rowsPerPageOptions={[10, 25, 50, 100]}
        labelRowsPerPage="每页"
        labelDisplayedRows={({ from, to, count }) => `${from}-${to} / ${count}`}
      />

    </Paper>
  )
}

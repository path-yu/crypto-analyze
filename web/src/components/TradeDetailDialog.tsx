import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import Table from '@mui/material/Table'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableContainer from '@mui/material/TableContainer'
import TableHead from '@mui/material/TableHead'
import TableRow from '@mui/material/TableRow'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import CloseIcon from '@mui/icons-material/Close'

import type { Trade } from '@shared/types'
import { EXIT_REASON_LABEL, dateTime, money, num, pct, price } from '../utils/format'
import { UP_COLOR, DOWN_COLOR } from '../theme'
import Stack from '../ui/Stack'

/**
 * 单笔交易明细弹窗。
 *
 * 「交易明细」表格与 K 线图上的交易标记共用同一个弹窗，保证两处看到的数据一致。
 * 成交明细表按 6 位有效数字展示数量、并用紧凑内边距，避免在窄弹窗里出现横向滚动条。
 */
function compactNum(v: number): string {
  if (!Number.isFinite(v)) return '—'
  return String(Number(v.toPrecision(6)))
}

export default function TradeDetailDialog({
  trade,
  onClose,
}: {
  trade: Trade | null
  onClose: () => void
}) {
  const detail = trade
  return (
    <Dialog open={Boolean(detail)} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pr: 6 }}>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle1">
            交易 #{detail?.id} · {detail?.side === 'long' ? '多头' : '空头'}
          </Typography>
          <Chip
            size="small"
            label={detail ? EXIT_REASON_LABEL[detail.exitReason] ?? detail.exitReason : ''}
            sx={{ height: 20, fontSize: 11, bgcolor: 'action.hover' }}
          />
          <Typography
            variant="subtitle1"
            sx={{ ml: 'auto', color: (detail?.netPnl ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR, fontWeight: 700 }}
          >
            {detail ? `${money(detail.netPnl)} (${pct(detail.pnlPercent)})` : ''}
          </Typography>
        </Stack>
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }} size="small">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {detail && (
          <Stack spacing={1.5}>
            <Box
              sx={{
                display: 'grid',
                gap: 1.25,
                gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(4, 1fr)' },
              }}
            >
              {[
                ['入场时间', dateTime(detail.entryTime)],
                ['出场时间', dateTime(detail.exitTime)],
                ['持仓 K 线', `${detail.barsHeld} 根`],
                ['价格变动', pct(detail.priceChangePercent)],
                ['入场价', price(detail.entryPrice)],
                ['出场价（加权）', price(detail.exitPrice)],
                ['数量', compactNum(detail.qty)],
                ['名义价值', money(detail.notional)],
                ['初始止损价', price(detail.stopLoss)],
                ['离场时止损价', price(detail.finalStopLoss)],
                ['保本价', price(detail.breakEven)],
                ['保证金 / 杠杆', `${money(detail.margin)} · ${detail.leverage}x`],
                ['TP1', price(detail.takeProfit1)],
                ['TP2', price(detail.takeProfit2)],
                ['手续费', money(detail.fee)],
                ['平仓后余额', money(detail.balanceAfter)],
                ['毛利润', money(detail.grossPnl)],
                ['最大有利幅度', `${num(detail.maxFavorableExcursion, 2)}%`],
                ['最大不利幅度', `${num(detail.maxAdverseExcursion, 2)}%`],
              ].map(([k, v]) => (
                <Box key={k}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {k}
                  </Typography>
                  <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                    {v}
                  </Typography>
                </Box>
              ))}
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  平仓说明
                </Typography>
                <Typography variant="body2">{detail.comment}</Typography>
              </Box>
            </Box>

            <Divider />

            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography variant="subtitle2">成交明细</Typography>
              <Typography variant="caption" color="text.secondary">
                共 {detail.fills.length} 笔减仓
              </Typography>
            </Stack>
            <TableContainer sx={{ overflowX: 'hidden' }}>
              <Table
                size="small"
                sx={{
                  tableLayout: 'fixed',
                  '& .MuiTableCell-root': { px: 0.75, py: 0.5, fontSize: 11.5 },
                  '& .MuiTableCell-root:first-of-type': { pl: 0 },
                  '& .MuiTableCell-root:last-of-type': { pr: 0 },
                }}
              >
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ width: '26%' }}>时间</TableCell>
                    <TableCell align="right" sx={{ width: '16%' }}>
                      价格
                    </TableCell>
                    <TableCell align="right" sx={{ width: '14%' }}>
                      数量
                    </TableCell>
                    <TableCell align="right" sx={{ width: '10%' }}>
                      占比
                    </TableCell>
                    <TableCell align="right" sx={{ width: '12%' }}>
                      手续费
                    </TableCell>
                    <TableCell align="right" sx={{ width: '14%' }}>
                      实现盈亏
                    </TableCell>
                    <TableCell align="center" sx={{ width: '8%' }}>
                      原因
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {detail.fills.map((f, i) => (
                    <TableRow key={i}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{dateTime(f.timestamp)}</TableCell>
                      <TableCell align="right">{price(f.price)}</TableCell>
                      <TableCell align="right">
                        <Tooltip title={num(f.qty, 8)}>
                          <span>{compactNum(f.qty)}</span>
                        </Tooltip>
                      </TableCell>
                      <TableCell align="right">{num(f.portion * 100, 1)}%</TableCell>
                      <TableCell align="right">{money(f.fee, 4)}</TableCell>
                      <TableCell
                        align="right"
                        sx={{ color: f.realizedPnl >= 0 ? UP_COLOR : DOWN_COLOR }}
                      >
                        {money(f.realizedPnl)}
                      </TableCell>
                      <TableCell align="center">
                        {EXIT_REASON_LABEL[f.reason] ?? f.reason}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Stack>
        )}
      </DialogContent>
    </Dialog>
  )
}

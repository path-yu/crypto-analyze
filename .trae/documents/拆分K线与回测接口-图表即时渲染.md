# 拆分「取 K 线」与「回测」接口 + 图表即时渲染

## Context（为什么做这件事）

现状：**一次回测请求包办所有事**。点「开始回测」→ `POST /api/pine/backtest` → 服务端 `runBacktestService` 里先 `fetchKlines`（含 1000 根预热）再算指标、跑引擎，最后把 `candles / trades / equityCurve / signals / report` 一起返回。前端只维护一个 `result: BacktestResult | null`，**图表和所有报表页都从它取数**。

由此产生四个问题：

1. **换个品种或周期必须重跑一次完整回测，图才动**——只想看图也得等。`KLinePanel` 甚至硬依赖 `result`（工作区初始化 effect 里 `!result` 直接 return）。
2. **点回测时会重复拉一遍 K 线**（同一窗口再走一次 `fetchKlines`，靠缓存才没重复打交易所）。
3. 没有「切品种/周期就同步回测」的选择。
4. 冷启动慢：日志实测 `POST /api/pine/backtest` **冷 ≈ 4175ms / 热 ≈ 376–405ms**；冷启动的主要成本是 `fetchFromExchange` 的**串行分页**（1 年 1h ≈ 9760 根 ÷ 1500 ≈ 7 页 RTT 叠加）。

目标：把接口拆成「取 K 线」与「回测/编译」两条；切品种/周期/区间时**立即**渲染图表；新增 checkbox「同步进行回测」（默认关）；点回测**不再拉 K 线**；两个接口尽量 <1s。

**已确认的交互决策（用户选定）**
- 切品种/周期/区间时**立即清空**上一次回测结果（统计卡片归零/空态），图表照常渲染。
- K 线实时更新走 **WebSocket**（浏览器 ↔ 服务端 WS；上游复用项目已有的 ccxt.pro 行情流）——**历史仍由 `/api/klines` 一次拉取**，WS 只负责驱动**实时尾巴**（最后一根未收盘 bar 的跳动 + 新 bar 收盘时追加）。
- WS 推来一根新 bar **收盘**时，若「同步进行回测」开着 → **自动用前移一根的窗口重跑回测**（短周期如 5m 每 5 分钟一次，热路径 ≈400ms，可接受）。

## 实时尾巴（WebSocket）设计

复用 `server/src/market/stream.ts`（ccxt.pro：`syncSubscriptions` / `onStreamUpdate` / `streamCandles`，滚动窗口 ≤800 根、含代理与 REST 兜底），**不重造上游**。三个必须处理的点：

1. **订阅来源冲突**：`stream.ts` 的 `syncSubscriptions(desired)` 是**声明式全量覆盖**，而 `alerts/monitor.ts`（L245）每轮轮询都会用自己的那份 `desired` 覆盖一次 —— 图表若直接调它，下一个 monitor tick 就会把图表的订阅取消掉。因此要在 `stream.ts` 里加一层**多来源注册表**：`setSubscriptionSource(name, subs)`，由 stream 自己取并集后再走现有的增量 diff。monitor 与图表各占一个来源。
2. **浏览器侧通道**：新增 `ws` 依赖 + 在现有 HTTP server 上挂 `WebSocketServer`（路径如 `/ws/klines`），订阅/退订与连接断开都要**增删自己在注册表里的那一份**（否则会泄漏到交易所的 WS 连接）。
3. **开发期代理**：`web/vite.config.ts` 目前只代理 `/api`（http）。需要加一条 `ws: true` 的代理（`/ws` → `http://127.0.0.1:8787`），否则 dev 下浏览器连不上。
4. **前端合并**：按时间戳 upsert —— 时间戳已存在则覆盖最后一根，出现新时间戳则追加并裁掉最旧一根，保持窗口长度稳定。**不要让 WS 当图表的主数据源**。


## 关键设计

1. **窗口唯一真源 + 常量预热。** 抽出 `resolveWindow({timeframe, since, until, bars})`，`/api/klines` 与回测都调它。预热根数改为**常量 `KLINES_WARMUP_BARS = 1000`**（今天就是 `min(1000, max(fib, st, ob))` 的上界，多取不亏：多出来的 bar 全部落在 `tradeFromIndex` 之前，`backtestService` 用逐根 `timestamp < since` 定位交易起点）。**实测（BTC 1h，2026-01-01 起，139 笔）：预热 1000 vs 旧值 350 的逐笔结果完全一致**，唯一差异在最后一笔——那根未收盘 bar 的实时价在两次运行之间跳了，与预热无关。
2. **`until` 冻结到 bar 边界。** 前端 `until = alignFloor(Date.now(), tfMs)`，切品种/周期时**复用**同一个值，只在「刷新 / 改区间 / 改自定义结束日期」时前移。这是「回测不拉 K 线」成立的前提：`fetchKlines` 的缓存键是 `alignFloor(since)_alignFloor(until)`，`until` 只要一变窗口就变、缓存必 miss。
3. **不引入 `datasetId`。** 两级缓存（内存 5min / 磁盘 24h）已经够用；再包一层只会多一个「淘汰后 miss」的失败模式。改为：窗口一致 + **in-flight 去重**（同键并发请求合并成一个上游拉取）。
4. **竞态用单飞票号。** `seqRef` 递增取票，响应回来对不上票就丢弃——连点两个品种时最终图上一定是后选中的那个。

## 实施步骤（依赖顺序）

1. **`shared/types.ts`**：新增 `KLINES_WARMUP_BARS = 1000`、`ChartDataset { symbol; timeframe; exchange; since; until; candles: Candle[]; cached; fetchedAt }`。
2. **`server/src/service/backtestService.ts`**：导出 `resolveWindow(...)`（把 L194–230 的 `since/until/targetBars/fetchSince/warmup` 换算搬进去，预热用常量），`runBacktestService` 改为调它；顺手删掉死代码 `previewSeries`（L419–445，grep 无调用者）。
3. **`server/src/routes/api.ts`**：
   - `GET /api/klines`（L117–148）增加可选 `since`（传了就用它，`bars` 仅兜底），内部同样走 `resolveWindow` → 与回测的 `fetchKlines` 入参**完全相同**；响应回显 `since/until/bars/cached`，`data` 只给用户区间（不含预热）。
   - 回测路由（`/backtest`、`/pine/backtest`）**签名不变**，靠窗口一致命中缓存。
4. **`server/src/market/exchange.ts`**：
   - `fetchKlines` 顶部加 **in-flight 去重**（`Map<缓存键, Promise>`，`finally` 清理）。
   - `fetchFromExchange` 改「首页探测 + 其余页有界并发」：页起点 `since + k*limit*tfMs` 完全确定可并行；先确认首页不是 `isTooOldError`/空数据再 fan-out；并发 4–6，按页序拼接（既有 dedup+sort 兜底）；遇 429/418 降级为串行重试一次。
5. **`web/src/api.ts`**：`fetchKlines` 扩展 `since?` 与返回 `{ candles, cached, since, until }`；同步改唯一调用点 `TradeReplayDialog.tsx`（L183）取 `.candles`。
6. **`web/src/App.tsx`**（核心）：
   - state：`chartData: ChartDataset | null`、`chartLoading`、`syncBacktest`（默认 `false`）、`dataUntil`。
   - `loadDataset(refresh)`：取票 → `setResult(null)` + `setDetailTrade(null)` → `fetchKlines` → 票校验 → `setChartData` → 若 `syncBacktest` 再 `runBacktest({ until: dataUntil })`（同一票保护）。
   - effect：`[exchange, symbol, timeframe, range, customSince, customUntil, syncBacktest]` → `loadDataset()`；**删除首次「自动跑一次回测」**（L239–245），首屏只跑 klines（默认不同步也有图）。
   - `runBacktest` 的 `until` 改用 `dataUntil`（不再 `?? Date.now()`）。
   - 渲染重构：把 `Tabs` + `KLinePanel` 移出 `{report && (`（L650）这个门；L727 的空态卡片只在 `tab !== 'chart' && !report && !loading` 时显示；其余 tab 改 `result ? <X/> : <EmptyCard/>`。
7. **`web/src/components/KLinePanel.tsx`**：props → `candles / symbol / timeframe` **必填**，`result?` 可选，另加 `onRefresh`；`velaData`、`barIndex`、`shownBar`、`barInfo` 一律改用 `candles`；工作区初始化守卫由 `!result` 改成 `!symbol || velaData.length === 0`，market 用传入的 `symbol` / `VELA_TIMEFRAME[timeframe]`；表头在无 result 时显示「{symbol} · {timeframe} · 共 N 根 · 未回测」，并加**刷新 IconButton**；`showTrades` 在无 result 时置灰 + Tooltip 说明。
8. **`web/src/components/KpiCards.tsx`**：`report` 放宽为可空，null 时各卡渲染 `—`（归零但不跳版）。
9. **`web/src/components/ControlPanel.tsx`**：行情设置区底部加 `FormControlLabel + Switch`「同步进行回测」（默认关），沿用现有开关写法（应用强平检查 / 仓位由脚本 qty 决定）；Props 增 `syncBacktest` / `onSyncBacktestChange`，Tooltip 说明「勾选后切品种/周期/区间会同步跑回测，耗时更长」。
10. **`server/src/market/stream.ts`**：加多来源订阅注册表 `setSubscriptionSource(name, subs)`（内部取并集 → 仍走现有 `syncSubscriptions` 的增量 diff），并把 `monitor.ts`（L245/L377）改为写自己那一路来源，避免与图表互相覆盖。
11. **服务端 WS 端点**：新增 `ws` 依赖；在现有 HTTP server 上挂 `WebSocketServer`（`/ws/klines`）。客户端消息 `{type:'subscribe', exchange, symbol, timeframe}` / `{type:'unsubscribe'}`；服务端据此维护注册表里 `chart` 来源的那一份，并在 `onStreamUpdate` 命中所订阅的 `(exchange,symbol,ohlcv)` 时把 `streamCandles(...)` 的**最新 1–2 根**推给客户端；连接关闭/出错时清理自己的订阅。
12. **`web/vite.config.ts`**：加 `'/ws': { target: API_TARGET, ws: true }`。
13. **前端实时尾巴**：新增 `web/src/marketStream.ts`（`WebSocket` 客户端 + 重连 + 订阅切换）；`App.tsx` 在 `chartData` 就绪后按 `(exchange,symbol,timeframe)` 订阅，收到推送就按时间戳 upsert 进 `chartData.candles`；若 `syncBacktest` 且**新 bar 收盘**（时间戳前进）→ 把 `dataUntil` 前移一根并自动重跑回测。`KLinePanel` 只消费 `candles`，天然跟着更新。

## 关键代码形状

```ts
// server：窗口唯一真源（/api/klines 与回测共用）
export function resolveWindow(i: { timeframe: Timeframe; since?: number; until?: number; bars?: number }) {
  const until = i.until && i.until > 0 ? i.until : Date.now()
  const tfMs = TIMEFRAME_MS[i.timeframe]
  const targetBars = Math.round(clamp(i.bars ?? DEFAULT_BARS, 300, MAX_BARS, DEFAULT_BARS))
  const since = i.since && i.since > 0 ? i.since : until - targetBars * tfMs
  const requestedBars = Math.floor((until - since) / tfMs)
  return { since, until, requestedBars, fetchSince: since - KLINES_WARMUP_BARS * tfMs,
           targetBars: requestedBars + KLINES_WARMUP_BARS }
}
```

```ts
// web/App.tsx：取票 + 立即清空 + 可选同步回测
const seqRef = useRef(0)
const loadDataset = useCallback(async (refresh = false) => {
  const ticket = ++seqRef.current
  const until = refresh ? alignFloor(Date.now(), TIMEFRAME_MS[timeframe]) : dataUntil
  setResult(null); setDetailTrade(null); setChartLoading(true); setError(null)
  try {
    const ds = await fetchKlines({ exchange, symbol, timeframe, since, until })
    if (ticket !== seqRef.current) return          // 过期响应直接丢
    setChartData({ ...ds, symbol, timeframe, since, until })
    if (syncBacktest) {
      const r = await runBacktest({ until })        // 同窗 → 服务端命中缓存，不拉 K 线
      if (ticket === seqRef.current) setResult(r)
    }
  } finally { if (ticket === seqRef.current) setChartLoading(false) }
}, [exchange, symbol, timeframe, since, dataUntil, syncBacktest])
```

## 风险 / 回归清单

- **最大风险**：`Tabs`/`KLinePanel` 移出 `{report && (` 后，任何遗漏的 `result!` 或 `report.` 解引用都会在「无回测时点 tab」崩溃 → 实现后全量 grep `result!` / `report.` 收敛。
- 常量预热会**改变磁盘缓存键** → 现存 `.cache/klines` 一次性失效（只影响第一次冷启动），冷路径最多多取 ≤800 根。
- `until` 对齐 bar 且不再取 `Date.now()` → 最后一根未收盘 bar 被舍弃、`report.endTime` 变为 bar 边界（更正确，但数值会微变）。
- 默认不同步回测 → 切品种后统计区是空态，必须靠文案指引（勾选或点「开始回测」），否则像坏了。
- 并行分页有交易所限频风险：binance 7 页远低于 2400/min，但 **okx `MAX_LIMIT=300` 会把页数放大到 33**，必须保序 + 429 退避串行降级；`binanceVision` 分支当前是注释掉的，若重启需同步适配。
- Vela 工作区现状是「每次蜡烛变化整体重建」：切品种若有白屏/卡顿，先测量再决定是否改成只换数据。
- **WS 相关**：①`stream.ts` 的滚动窗口只有 ≤800 根，**图表历史仍必须由 `/api/klines` 提供**，WS 只补尾巴——不能指望它画出一年；②连接断开/切品种时若没清订阅，会在交易所侧**泄漏 WS 连接**，必须在 `close`/`unsubscribe` 两条路径上都删自己那一路来源；③图表订阅会额外占用交易所 WS 配额（与价格警报共享同一批 ccxt.pro 实例）；④`ws` 是新增依赖，且 dev 下必须补 vite 的 `ws: true` 代理，否则浏览器连的是 5273 而非 8787；⑤**实施中发现的两个既有缺陷（已一并修掉）**：`stream.ts` 里 OHLCV 滚动窗口写入用的是订阅键（`subKey`）而读取用的是 `ohlcvKey`，导致 `streamCandles()` 永远返回 null（警报的「WS 优先」路径一直静默退回 REST 轮询）；`klineSocket` 里误写成 `ws.OPEN`（静态常量不在实例上），会把所有连接判成不可写而静默丢弃推送。

## 验证计划

1. **静态**：`pnpm typecheck` + `pnpm test`（`server/src/tests/*.test.ts`，当前 51/51）。
2. **等价性回归**（验证常量预热不改结果）：改动前后对同一窗口跑回测，比对 `report.stats` 与逐笔明细。**已完成**：把常量临时改回旧值（BTC 1h 参数下旧预热 = 350）各跑一次，139 笔里 138 笔（时间/方向/开平价/净盈亏）逐位一致，唯一差异来自最后一根未收盘 bar 的实时跳动。
3. **接口计时**（`curl.exe -w "%{time_total}"`）：
   - `GET /api/klines?...&since=<ts>&until=<ts>`：冷 ≈ 秒级、热 **<200ms**；
   - 紧接 `POST /api/pine/backtest` 同 `since/until`：`meta.cached=true`、**≈400ms**；
   - 并发两个相同 klines 请求 → 服务端日志只出现**一次**上游分页（单飞生效）。
4. **浏览器实测**（`npm run dev`，5273）：
   - 首屏（checkbox 关）→ 只发 `/api/klines`，图立即渲染、无空页，表头显示「未回测」；
   - 切品种/周期 → 统计归零、图 <1s 换成新品种；连点两个品种 → 最终是后选中的（竞态）；
   - 勾选「同步进行回测」→ 再切品种 → Network 出现 klines + pine/backtest 两条，且 backtest 命中缓存（`meta.cached=true`）；
   - 点「开始回测」→ **只有** `/api/pine/backtest`，无 klines 请求；
   - 点「刷新」→ `until` 前移一根 bar、图更新（勾选时同时重跑回测）；
   - 无回测状态下逐个点 5 个 tab → 全部空态、无白屏报错。
5. **实时推送**：浏览器 Console 里 `ws://…/ws/klines` 处于 open；把周期切到 **1m** 观察最后一根 bar 的 close 实时跳动（不必等一小时）；切品种 → 旧订阅消失、新订阅建立；关闭页面/切走后服务端日志里该 `(symbol,timeframe)` 的订阅被清理（**无泄漏**）；勾选「同步回测」时，新 bar 收盘会看到一次自动重跑。

## 关键文件

- `web/src/App.tsx`（状态拆分、loadDataset、渲染门重构、WS 订阅与尾巴合并）
- `web/src/marketStream.ts`（新增：浏览器 WS 客户端 + 重连）
- `web/vite.config.ts`（`/ws` 代理，`ws: true`）
- `server/src/market/stream.ts`（多来源订阅注册表）
- `package.json`（新增 `ws` + `@types/ws`）
- `web/src/components/KLinePanel.tsx`（candles 必填 / result 可选）
- `web/src/components/ControlPanel.tsx`（同步回测开关）
- `web/src/components/KpiCards.tsx`（可空 report）
- `web/src/api.ts` + `web/src/components/TradeReplayDialog.tsx`（helper 返回形状）
- `server/src/service/backtestService.ts`（`resolveWindow`、删 `previewSeries`）
- `server/src/routes/api.ts`（`/api/klines` 支持 `since`）
- `server/src/market/exchange.ts`（单飞 + 有界并行分页）
- `shared/types.ts`（`KLINES_WARMUP_BARS`、`ChartDataset`）

# 改造方案：Vela 渲染 + PineTS 编译解析

## 一、Context（为什么做这件事）

现状：
- **Pine 能力**：仓库自带一套**手写的 Pine v4 编译器/运行时**（`server/src/pine/`，约 **6000 行**：codegen 2724、runtime 1385、parser 814、lexer 307、check 304、ast 275、tokens 86、execute 95、compile 52、cache 31、cli 149），逐 bar `step(index, ctx)` 与自研回测引擎对接。
- **图表能力**：前端用 **klinecharts**（`web/src/components/KLinePanel.tsx` 380 行 + `web/src/charts/klineRegistrations.ts` 313 行），自注册 IMBA_FIB / SUPERTREND / TSOT 指标与 `tradeMarker` 覆盖物。
- **既有铺垫**：`pinets ^0.11.0` 已是 devDependency，且已有交叉验证脚本 `scripts/compare-pinets.ts`（`pnpm compare:pinets`），已能"用 PineTS 跑脚本 → 读命名 plot → 转成 `PineSignal` → 喂自研引擎"。

目标（用户明确指示）：改用 `@luxalgo/vela` 渲染图表、`pinets` 编译解析脚本，自行测试通过后**删除冗余代码**。

### 已确认的决策（来自用户）
1. **接受 AGPL-3.0**（`pinets` / `@luxalgo/vela-pinets` 是 AGPL-3.0；`@luxalgo/vela` 本体是 Apache-2.0，但**强制署名水印**，不得隐藏）。
2. **全部 .pine 迁移到 Pine v6**（3 个核心策略是 v4，TV 语料有 v3）。
3. **保留自研回测引擎**（成交/盈亏/仓位口径不变，历史复盘结论可比）。
4. **前端整站换成 `VelaWorkspace`**。

## 二、必须先知道的关键约束（实证发现，直接影响设计）

| # | 发现 | 影响 |
|---|---|---|
| 1 | 引擎 `exitStrategy` 只有 `ATR / Fixed Percent / Trend Switch / Zone OCO`（`server/src/backtest/engine.ts`），**没有移动止损** | MainWave 的 25% 吊灯止损**无法搬到引擎**，纯 plot 信号方案会丢语义 |
| 2 | `normalizeParams` 对 `strategy==='pine'` 强制 `exitStrategy='Zone OCO'`、`partialTp=false`、`tradeDirection='Both'`、`pyramiding=1`（`server/src/service/backtestService.ts` L159-164） | PineTS 券商账本不能直接当结果，必须映射成 `PineSignal` |
| 3 | PineTS 是**异步批量**运行（`await pineTS.run(source)`），**没有** `step(index, ctx)`；我们的契约是逐 bar + 活仓状态 | 需要适配层，且 `step` 模型要改成"一次算完全部信号" |
| 4 | `/api/klines` **没有 `from` 参数**、`bars` 上限 20000（`server/src/routes/api.ts` 附近） | Vela 自建 Provider 只能"以 to 为锚 + limit"近似应答 |
| 5 | 图上 IMBA_FIB / TSOT / SUPERTREND 来自 klinecharts 自定义指标；Vela 无这些 | 需为 fib/supertrend 序列另找渲染出口（服务端仍在算） |
| 6 | `server/src/pine/store.ts`（286 行）是脚本 CRUD，非编译器内部 | **保留**，只有编译器内核要删 |

## 三、信号桥接：两条路（本方案推荐 Tier B）

| | Tier A：纯信号脚本 | Tier B：读 PineTS 券商账本 |
|---|---|---|
| 做法 | 脚本改成 `plot(cond?1:na,'Buy Signal'/'Sell Signal'/'Active Stop Loss Line')`，适配层读命名 plot → `canLong/canShort/obStopLoss/obRisk` | 脚本**保留** `strategy.entry/close`（含追踪止损）→ 读 `ctx.strategy` 账本，把**开仓 fill 映射为 `canLong/canShort`**、**平仓 fill 映射为 `forceClose`**、`obStopLoss` 取该笔止损 |
| 优点 | 简单，引擎全权管仓位/止损 | **保留脚本原语义**（追踪止损留在 Pine 里），仍由自研引擎记账 |
| 缺点 | ⚠️ 受约束 #1 限制：**引擎没有移动止损**，MainWave/PumpHunter/PumpAmbush 的追踪止损会丢失 | 平仓时点最多差 1 根（PineTS 信号根收盘成交 vs 引擎次根开盘）；PineTS 的手续费/滑点一律丢弃 |
| 适用 | 指标型脚本（`test1.pine` / Signal Suite、示例指标） | **3 个核心策略（MainWave / PumpHunter / PumpAmbush）** |

> **本方案推荐**：核心策略走 **Tier B**，指标型脚本走 **Tier A**。
> 若坚持"全部 Tier A"，则**前置任务**是给 `engine.ts` 增加一个 `Trailing` 出场模式（额外工作量，且会改动已被验证的撮合逻辑——本项目硬约束里禁止随意改撮合）。

## 四、目标架构

```
浏览器：VelaWorkspace(+PineWorkerEngine) ── 渲染蜡烛 / Pine 指标 / 交易标记
   ▲ 自建 Provider(GET /api/klines) 或 离线 data(用 /api/backtest 返回的 candles)
服务端：pinetsAdapter.ts ── PineTS 跑 v6 脚本 ── 产出 PineSignal[]
        └→ 既有 runBacktest(自研引擎，口径不变) ─→ 既有 API ─→ 既有面板(权益/交易/报告)
```
删除面：自研编译器内核 + 其测试 + klinecharts + `web/src/charts/klineRegistrations.ts` + v4/v3 语料依赖。

## 五、分阶段实施

### P0 闸门（最便宜的 go/no-go，先做，不通过就停）
只改 **`server/pine/MainWave/MainWave.pine`**（v4→v6），其余不动，复用现成 harness：
```powershell
# 0) 固化基线：现有编译器 × PineTS 必须通过（退出码 0）
pnpm compare:pinets --pine server/pine/test1.pine --bars 400
# 1) MainWave 迁到 v6 后再比（Tier A 的 plot 约定 or Tier B 的账本读取）
pnpm compare:pinets --pine "server/pine/MainWave/MainWave.pine" --bars 800
# 2) 真实行情
pnpm compare:pinets --live --symbol BTC/USDT:USDT --timeframe 1h --bars 3000 --pine "server/pine/MainWave/MainWave.pine"
```
退出码 0 = 逐 bar 信号 + 逐笔交易全等 → PineTS 能执行迁移后脚本且信号可等价提取。产物：迁移范式（Tier A/B 二选一的最终结论）。

### P1 脚本迁移（v3/v4 → v6）
按风险从低到高分批：

- **批 1（核心 3 策略）**：`server/pine/{MainWave,PumpHunter,PumpAmbush}/*.pine`
- **批 2（其余 v4/v6 脚本）**：`做多策略Ai优化1`、`BTC_Long_Only_TV01_200507*`、`test.pine`、`突破支撑趋势`、`加密货币山寨币做空策略`、`Ichimoku.pine`
- **批 3（最高风险，最后做，可先搁置）**：`server/pine/tv/02`（v3）、`09`（v3）、`16`（v3）及其余 v4/v5 语料

v4→v6 必改点：`study()`→`indicator()`；`security()`→`request.security`；裸 `crossover/crossunder/cross/sma/ema/rma/atr`→`ta.*`；`iff()`→三元；`input(x,type=input.float)`→`input.float()`；`strategy()` 的 `default_qty_type/value` 必须显式；`when=`→`if` 块；`[]` 历史引用不可用于函数内局部；`int/float` 不再隐式互转。
v3→v6 额外：`study(title=)`、裸 `cross`、无 type 的 `input()`、`plot(style=)` 常量名变化。

**新增** `scripts/pinets-signals.ts`：PineTS-only → `runBacktest` → 输出 JSON 基线，供后续 diff（长期回归）。

### P2 后端适配
- **新增** `server/src/pine/pinetsAdapter.ts`：`async runPineTsSignals(source, candles, opts) → { signals: PineSignal[], meta, plots, markers, barColor }`，内部 `new PineTS(candles.map(c => ({...c, openTime: c.timestamp})))` + `await pineTS.run(source)`，再按 Tier A/B 映射。
- **改** `server/src/pine/index.ts`：出口改为适配层，不再导出编译器内核。
- **改** `server/src/service/backtestService.ts` L267-302：`compilePineCached` → `await runPineTsSignals`；**去掉 `signalProvider`**（信号一次算好，走 `series={signals}`）；`useScriptPositionSize` 改为对数组做一次后处理。
- **改** `server/src/routes/api.ts`：`POST /pine/compile`（现为同步，L185-199）改 async 并返回 PineTS 诊断；`POST /pine/scripts`（L262-284）去掉 `.ts` 产物写入（前端未使用 `PineCompileResult.ts`）。
- **保留** `server/src/pine/store.ts`。
- **改** `scripts/check-pine-corpus.ts`：改为走 PineTS 而非编译器内核。

### P3 前端 Vela
- **新增** `web/src/charts/velaProvider.ts`：实现 `getBars(ticker, timeframe, {from,to,limit})` 打 `GET /api/klines`（`until`=to、`bars`=limit）；补 `listSymbols`；`registerProvider` 必须在实例化后再调用（注册才触发首次加载）。
- **新增** `web/src/charts/tradeMarkersLayer.ts`：`registerRendererLayer({ id:'trades', placement:'above-data', repaintOnCursor:true })`，用 `coords.timeToX/priceToY` + `scale/bounds` 复刻现有"三角标记 / 持仓区间着色 / 入场出场价线 / SL·TP 虚线 / 命中半径"；数据用 `chart.renderer.setNativeData('trades', payload)` 推入。
- **新增** `web/src/charts/manifestLoader.ts`：读 `GET /api/pine/scripts` → `[{ name, script: source, language:'pine', enabled:false }]`。
- **重写** `web/src/components/KLinePanel.tsx`（**保持组件名与 props 不变**：`result/loading/showTrades/showLevels/onSelectTrade`）：内部 `new VelaWorkspace(el, { layout:false, data:candles, timeframe, engines:{ pine: () => new PineWorkerEngine() }, indicators: manifestLoader })`；`onSelectTrade` 沿用"容器 mouseup + layer 缓存的坐标映射做命中"（Vela 无 drawing:click 公开事件）；`useEffect` + `ref` + `destroy()`；ResizeObserver → resize。
- **改** `web/src/App.tsx`（L545-555 附近）：顶栏/文案与 K 线数据来源适配 VelaWorkspace。
- **改** `web/src/api.ts`：增加 Provider 用的 K 线拉取与 `fetchPineScripts`。
- **改** `web/src/components/PineEditor.tsx`：兼容 `/pine/compile` 变 async（500ms 防抖调用不受影响）。

### P4 删除（**最后做，端到端对齐后才删**）
- 删 `server/src/pine/`：`codegen.ts / runtime.ts / parser.ts / lexer.ts / check.ts / ast.ts / tokens.ts / execute.ts / compile.ts / cache.ts / cli.ts`
- 删 `server/src/tests/pine.test.ts`（旧编译器用例），改为适配层单测
- 删 `scripts/compare-pinets.ts` 中"自研侧"的一半（保留 PineTS-only 断言），或整脚本退役为 `pinets-signals.ts`
- 删 `web/src/charts/klineRegistrations.ts`；`package.json` 移除 `klinecharts` 与 `pine` 脚本
- 视 P1 批 3 的结论决定是否清理 `server/pine/tv/` 中的 v3/v4 文件

## 六、验证

1. `pnpm typecheck`（双 tsconfig：`tsconfig.server.json` + `web/tsconfig.json`）
2. `pnpm test`（`tsx --test server/src/tests/*.test.ts`）
3. **回归**：对 P0/P1 脚本逐个 `pnpm compare:pinets`，要求退出码 0；以及 `scripts/pinets-signals.ts` 基线与新实现的 diff
4. **端到端**：`pnpm dev` 后跑 `pnpm check:ui`（现有 CDP UI 检查需把 `01-chart`/`07-chart-trade-detail` 两步适配 Vela 容器），人工 smoke `http://127.0.0.1:5273/`：
   - 蜡烛渲染、Pine 指标叠加、交易标记与 SL/TP 线、点标记打开交易明细
   - 水印可见、权益曲线/交易明细/报告页无回归
   - MainWave 在 BTCUSDT 1h 上回测结果与改造前**同量级**（Tier B 允许 ≤1 根时点漂移）

## 七、实施记录（P0–P2 实证结论，务必沿用）

### PineTS 能力边界（实测）
| 项 | 结论 |
|---|---|
| 支持版本 | **仅 v5+**；v3/v4 直接报 `Unsupported Pine Script version N` |
| 构造器 | `new PineTS(candles, tickerId?, timeframe?, limit?, sDate?, eDate?)`。**必须传 `tickerId` 与 `timeframe`**，否则 `timeframe.period === ''`，脚本里 `request.security(sym, timeframe.period, …)` 直接报错 |
| `request.security` | **纯数组输入下不可用**（即便字面量 `"D"` 也报 `Invalid value of the 'timeframe' argument ('')`）。PineTS 导出了 `BaseProvider`（含自动聚合）—— 后续若要恢复 HTF 支持，需自建 Provider |
| K 线字段 | 元素需带 `openTime`（`{...candle, openTime: candle.timestamp}`） |
| 多标的 | 单标的模拟器；非当前标的的 `request.security` 返回 na |
| 绘图 | 返回体 `plots`：命名 plot 以 title 为键（无 title 则 `#0`/`#1`），每个 series 是 `{title, options, data:[{value,time}]}`；`plotshape`/`line`/`box` 落在 `__labels__`/`__lines__`/`__boxes__` |
| 元信息 | `new Indicator(source, inputs?)` 提供 `prepare()`（转译，抛错即诊断来源）、`getInputsMeta()`、`getDeclarationType()`、`getPropsMeta()`；`pine.run(indicator)` 可直接吃该实例 |
| 错误定位 | 消息末尾常带 `at 行:列`（如 `... at 80:1`），据此折算 `PineDiagnostic` |

### 账本 → 信号映射（三条硬规则）
1. **信号偏移 `-1`**：本引擎在信号 bar 的**下一根开盘**成交，PineTS 在 fill bar 成交 → `entry_bar_index - 1`、`exit_bar_index - 1`。
2. **`entryQty` 只在脚本显式写了 `qty=` 时回填**（正则 `strategy\.entry\((?:[^()]|\([^()]*\))*qty\s*=`）。
   依赖 `default_qty_type/value`（如 `percent_of_equity`）的脚本**不带 entryQty**，交给引擎按自身口径定仓 —— 旧编译器同样不产出 qty。
   ⚠️ 实测踩坑：若一律用 `|size|`，`BTC_Candle_Correlation_Strategy`（percent_of_equity 100）会因「PineTS 按权益算的名义价值 ≫ 引擎保证金」被引擎拒单，成交数 55 vs 0。
3. **过滤保证金强平残单**：`exit_id` 含 `margin call` 且 `entry_bar_index === exit_bar_index`。
   根治办法是在脚本的 `strategy()` 里写 `margin_long=0, margin_short=0`（实测 98 笔残单 → 55 笔全等）。

### P1 迁移结果（`server/pine/*/**.v6.pine`，逐笔对拍全等）
`pnpm`：`npx tsx scripts/pinets-parity.ts --v4 <v4> --v6 <v6.v6.pine> [--live …]`，`--offset` 默认 -1、`--capital` 给引擎初始资金。

| 脚本 | 数据 | 结果 |
|---|---|---|
| MainWave | BTC 1h × 9000 | ✅ 4 对 4 |
| PumpHunter | 1000PEPE 1h × 15000 | ✅ 2 对 2 |
| PumpAmbush | BTC 1h × 9000 | ✅ 1 对 1 |
| BTC_Long_Only_TV01_200507 | BTC 1h × 1500 | ✅ 5 对 5 |
| BTC_Long_Only_TV01_200507版本2 | BTC 1h × 1500 | ✅ 4 对 4 |
| 做多策略Ai优化1 | BTC 1h × 1500 | ✅ 5 对 5 |
| BTC_Candle_Correlation_Strategy | BTC 1h × 6000（截至 2021-07，脚本窗口 2000–2021） | ✅ 55 对 55（需 `margin_long/short=0`） |

> 该脚本原本用 7 家交易所的 BTC 报价求「平均 K 线」，本项目单标的引擎无法承载 →
> 7 个来源全部回落当前标的（与旧编译器对多标的的回落行为一致），文件头已注明。

### P2 已完成
- 新增 `server/src/pine/pinetsAdapter.ts`：`runPineTsSignals()` / `analyzePine()`；导出 `PineSignal` / `emptyPineSignal` / `PINE_ENTRY_OFFSET`。
- `backtestService.ts`：pine 分支改为 `await runPineTsSignals`，**去掉 `signalProvider`**（PineTS 用自己的券商仓位），`useScriptPositionSize` 改为对信号数组一次性后处理。
- `routes/api.ts`：`/pine/compile` 改为 `analyzePine()`（不再返回 `ts`）；`/pine/scripts` 保存时不再写 `.ts` 产物。
- `shared/types.ts`：`BacktestResult.pine` 去掉 `ts`，加 `warnings`。
- 新增 `scripts/pinets-signals.ts`（PineTS-only 回归基线，替代 `compare:pinets`）。
- `scripts/check-pine-corpus.ts` 改为 PineTS 版并递归扫描：当前 **23/48 可执行**。

### 语料现状（`npx tsx scripts/check-pine-corpus.ts`）
- 可执行 23：7 个 `.v6.pine` + v5/v6 脚本目录（突破支撑趋势、Signal Suite、山寨币做空、CVD逼空、Bitcoin超级趋势、SuperFlip、BTC多空双向、BTC_Short、test/test1、Institutional）+ `tv/03·04·06·14·15`
- 不可执行：17×v4（**已全部有对应 .v6 或将被替换**）、3×v3（`tv/02·09·16`）、2×`request.security`（`Ichimoku.pine`、`SwiftEdge GEX.pine`）、`Breakout.pine`（`request.currency_rate` 缺失）、`CVD_ShortSqueeze_Strategy`（`open_interest` 缺失）、`tv/12`（`resolution` 缺失）

## 八、风险与回滚

- **最大风险**：约束 #1（引擎无移动止损）→ 已用 Tier B 规避；若被迫 Tier A，需先加引擎 `Trailing` 模式，**触及"不得改动既有撮合逻辑"的硬约束**，需重新评审。
- **v3→v6 语料**：`tv/02·09·16` 迁移成本最高，允许**先搁置**（不阻塞主线），最后批量处理或明确舍弃。
- **AGPL**：`pinets` + `@luxalgo/vela-pinets` 一旦对外提供服务需开放整个应用源码；本次已确认接受。Vela 水印**不得隐藏**。
- **回滚**：P0–P3 全部为增量新增，自研编译器在 P4 之前**始终保留**；任何阶段失败可回退到当前实现。

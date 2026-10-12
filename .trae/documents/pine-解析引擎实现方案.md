# Pine Script 解析引擎 · 实时编译为 TS 并回测

## 1. 背景与目标（Context）

项目现状：`server/src/indicators/` 下的三个策略（fib-trend / supertrend / order-block）都是**手工把 Pine 原版逐行翻译成 TS**。每接一个 Pine 脚本就要重写一遍，成本高且易漂移。

本次目标：写一个**完整的 Pine Script v6 解析引擎**，把 `server/pine/*.pine` 在请求时实时编译成 TypeScript 源码，并在内存里执行，产出的信号直接喂给现有回测引擎跑出交易与报告；同时把编译产物（TS 文本 + 逐行诊断）返回给前端展示。

**验收标准（用户确认）**

| 项 | 结论 |
|---|---|
| 执行方式 | 生成 TS 文本 → **Node 内置类型擦除**（`node:module.stripTypeScriptTypes`）→ `vm.runInNewContext` 沙箱执行；TS 文本同时返回前端 |
| v1 语法范围 | 以 `server/pine/test.pine`（`strategy()` 脚本）+ `server/pine/test1.pine`（`indicator()` 脚本）为验收目标，覆盖二者用到的**全部**语法 |
| 交付面 | 后端引擎 + 最小前端编辑器 |
| 一致性 | 与手写 TS 策略（`OrderBlockTracker`）**逐笔一致** |
| `indicator()` 脚本语义 | **信号驱动**：把 `plotshape` 的买/卖信号映射为开仓，把脚本自己的止损线 `plot` 映射为离场 |

### 已确认的关键环境事实

- 本机 **Node v24.15.0**，`require('node:module').stripTypeScriptTypes(code, { mode: 'strip' })` 可用（实测通过，会打印一条 ExperimentalWarning）。
- **esbuild 不是本项目的直接依赖**：它只存在于 `node_modules/.pnpm/` 的 store 里（作为 `tsx`/`vite` 的传递依赖）。从项目根 `import('esbuild')` 实测报 `ERR_MODULE_NOT_FOUND`。因此**不引入 esbuild**，改用 Node 内置类型擦除（零新增依赖、无需联网）。
- 仓库用 pnpm（同时存在 `pnpm-lock.yaml` 与 `package-lock.json`），`node_modules/.pnpm` 布局。

---

## 2. 现状分析（探索结论，含代码位置）

### 2.1 回测引擎是「信号驱动」而非「订单驱动」

引擎不执行任何 Pine，它只读一条**每根 K 线一份的信号快照**，然后自己做撮合：

- [engine.ts](file:///d:/code/Bunm/crypto-analyze/server/src/backtest/engine.ts#L29-L41) `StrategySignalCore { canLong, canShort, atrLongStop, atrShortStop, obStopLoss?, obTakeProfit?, obRisk? }`
- [engine.ts](file:///d:/code/Bunm/crypto-analyze/server/src/backtest/engine.ts#L47-L68) `BacktestInput { candles, series, params, tradeFromIndex?, signalProvider?, tickSize? }`
- [engine.ts](file:///d:/code/Bunm/crypto-analyze/server/src/backtest/engine.ts#L677-L854) 主循环：A0 排单成交 → A 挂单撮合 → **A1 `signalProvider(i, { flat })`（L690）** → 读 `sig`（L691）→ A2 保本（L694）→ B 反手 → **C `i < tradeFromIndex` 预热闸门（L714）** → 开仓分支（L721 ATR / L754 Fixed Percent / **L789 Zone OCO**）→ C2 时间止损（L843）→ D 记权益。
- **关键结论**：`signalProvider` 在 L690 被调用，早于 L714 的预热闸门 —— 因此 Pine 脚本在预热期就能自然累积 `var` 状态，**免费获得与 TradingView 一致的预热行为**。
- [engine.ts](file:///d:/code/Bunm/crypto-analyze/server/src/backtest/engine.ts#L789-L815) **Zone OCO 开仓分支**正是 Pine `strategy.entry` + `strategy.exit(stop/limit)` 的等价物：`wantLong && !inPos` → `pendingEntry = { side, stopLoss: obStopLoss, takeProfit: obTakeProfit, risk: obRisk }`。
- [engine.ts](file:///d:/code/Bunm/crypto-analyze/server/src/backtest/engine.ts#L480-L530) `resolveBeTrigger`（用 `params.orderBlock.useBE/beAtR` + `obRisk` 算保本触发价，对应 Pine `high >= avg + longRisk*beAtR → longStop := max(longStop, avg)`）+ `armBreakEven`（L511，触发后 `max(stopLoss, entryPrice)`）。
- [engine.ts](file:///d:/code/Bunm/crypto-analyze/server/src/backtest/engine.ts#L843-L850) **C2 时间止损**：`i - alive.entryIndex >= params.orderBlock.maxBars` → `pendingExit = 'TimeStop'`，对应 Pine `bar_index - entryBar >= maxBars → strategy.close_all(comment="Time stop")`。
- [engine.ts](file:///d:/code/Bunm/crypto-analyze/server/src/backtest/engine.ts#L200-L232) `fillNextBarOpen = strategy === 'supertrend' || strategy === 'order-block'` —— **新增 `'pine'` 必须加进这里**才能拿到「下一根开盘成交」（TradingView 未设 `process_orders_on_close` 时的默认）。
- [engine.ts](file:///d:/code/Bunm/crypto-analyze/server/src/backtest/engine.ts#L208-L209) `pendingExit: ExitReason | null` + [engine.ts](file:///d:/code/Bunm/crypto-analyze/server/src/backtest/engine.ts#L491-L499) `fillPendingExit` —— 是 `strategy.close_all` 的挂载点。
- [engine.ts](file:///d:/code/Bunm/crypto-analyze/server/src/backtest/engine.ts#L699-L704) 反手块对 `'Zone OCO'` 主动跳过，因此 pine 复用 Zone OCO 时不会误触发反手。

### 2.2 手写 TS 是代码生成的形状目标

[orderBlock.ts](file:///d:/code/Bunm/crypto-analyze/server/src/indicators/orderBlock.ts) 就是 `test.pine` 的人工翻译版，结构如下（编译产物必须镜像它）：

- `constructor` 里预计算整条数组：`atr(high, low, close, cfg.atrLen, 'RMA')`、`sma(volume, cfg.volLen)`、`ema(close, cfg.emaLen)`。
- `step(index, flat)` 做状态机，返回 `OrderBlockSignal`（字段名与 `StrategySignalCore` 对齐）。
- Pine 语义的手工处理：`nz(x) → isNa(x) ? 0 : x`；na 比较恒为 false；`[1] → index - 1`；`array.shift` 用 `zones.shift()`；反向 `for` 配合 `splice` 删除死区域。

### 2.3 可复用的指标库

[ta.ts](file:///d:/code/Bunm/crypto-analyze/server/src/indicators/ta.ts) 已导出 `NA, isNa, sma, ema, rma, wma, highest, lowest, percentileNearestRank, trueRange, atr`，全部返回「与输入等长、窗口不足填 NaN」的数组 —— 正好可以 1:1 承载 Pine 的 `ta.*`。

### 2.4 业务编排与协议

- [backtestService.ts](file:///d:/code/Bunm/crypto-analyze/server/src/service/backtestService.ts#L96-L98) 策略白名单（三选一，需加 `'pine'`）。
- [backtestService.ts](file:///d:/code/Bunm/crypto-analyze/server/src/service/backtestService.ts#L140-L145) order-block 强制固定语义（Zone OCO / 不分批 / Both / pyramiding=1）—— pine 照抄。
- [backtestService.ts](file:///d:/code/Bunm/crypto-analyze/server/src/service/backtestService.ts#L227-L251) `series` / `signalProvider` 装配点；[L272-L285](file:///d:/code/Bunm/crypto-analyze/server/src/service/backtestService.ts#L272-L285) `signalPoints` 映射。
- [types.ts](file:///d:/code/Bunm/crypto-analyze/shared/types.ts#L69-L70) `StrategyKind`、[L149-L210](file:///d:/code/Bunm/crypto-analyze/shared/types.ts#L149-L210) `StrategyParams`、[L471-L505](file:///d:/code/Bunm/crypto-analyze/shared/types.ts#L471-L505) `BacktestResult`。
- [api.ts](file:///d:/code/Bunm/crypto-analyze/server/src/routes/api.ts#L141-L158) `POST /api/backtest`。
- [cli.ts](file:///d:/code/Bunm/crypto-analyze/server/src/cli.ts#L17-L33) `parseArgs` 可复用。
- [ControlPanel.tsx](file:///d:/code/Bunm/crypto-analyze/web/src/components/ControlPanel.tsx#L516-L525) 策略 `Select`；[L226-L231](file:///d:/code/Bunm/crypto-analyze/web/src/components/ControlPanel.tsx#L226-L231) `changeStrategy` 同步资金/费用默认值。
- [App.tsx](file:///d:/code/Bunm/crypto-analyze/web/src/App.tsx#L42-L46) `STRATEGY_LABEL`。
- 前端**没有**任何地方消费 `obStopLoss/obTakeProfit`（已 grep 确认），图表叠加来自 `imbaTrendLine/supertrendUp` 等 —— 因此 v1 **不必**为 pine 新增图表叠加，交易/权益图直接可用。

---

## 3. 总体架构

```
.pine 源码
   │
   ├─ lexer.ts        注释剥离 → 逻辑行合并（括号/运算符续行）→ INDENT/DEDENT 插桩 → token 流
   ├─ parser.ts       递归下降 + Pratt 表达式 → AST（类型声明 / 函数 / if / for / 赋值 / 调用…）
   ├─ check.ts        语义检查（未定义标识符、[k] 可用性、参数个数、na 比较提示）→ 带行列号的诊断
   ├─ codegen.ts      AST → TS 源码（零 import，只依赖注入的 __pine 运行时；同时产出 config/inputs/plots 元信息）
   ├─ execute.ts      stripTypeScriptTypes(TS) → vm.runInNewContext(js, sandbox, {timeout:2000}) → 取回 program
   └─ runtime.ts      __pine 运行时（na/cmp/ta/math/str/session/input/strategy/box/label/color/数组助手）
```

**核心设计取舍（已定）：脚本是信号的唯一来源，引擎是撮合的唯一来源。**

编译产物每根 K 线吐一个信号对象：

```ts
{ canLong, canShort, obStopLoss, obTakeProfit, obRisk, forceClose? }
```

订单撮合、保本触发、时间止损仍由引擎现有的 `Zone OCO` 通路完成 —— 与今天 `order-block` 的运行方式**完全一致**。因此：

- 脚本里 `strategy.entry(...)` → `canLong/canShort`
- 脚本里 `strategy.exit(stop=longStop, limit=longTp)` → `obStopLoss/obTakeProfit`
- 脚本里信号当根的 `close - stop` → `obRisk`
- 脚本里 `strategy.close_all(...)` → `forceClose`

脚本自身的 `longStop := math.max(longStop, avg)`（保本）与 `bar_index - entryBar >= maxBars`（时间止损）语句**照常执行**（保持编译的忠实性，并参与 `plot` 输出），但**落到引擎上的效果由 `params.orderBlock.useBE/beAtR/maxBars` 驱动**，与 `order-block` 今天的行为逐字一致。这是保证「逐笔一致」验收的关键。

`indicator()` 脚本（无任何 `strategy.*`）走另一条出口：`canLong = !na(plotshape 的 belowbar 序列)`、`canShort = !na(plotshape 的 abovebar 序列)`、`obStopLoss = plot(title 命中 /sl|stop/i)`。

---

## 4. 目录与文件清单

### 新增（后端）

| 文件 | 职责 |
|---|---|
| `server/src/pine/tokens.ts` | token 类型枚举、`Token { kind, text, line, col, indent, value? }` |
| `server/src/pine/ast.ts` | AST 节点类型定义 |
| `server/src/pine/lexer.ts` | 注释剥离 + 逻辑行合并 + INDENT/DEDENT + 扫描 |
| `server/src/pine/parser.ts` | 递归下降 + Pratt 优先级表达式解析 |
| `server/src/pine/check.ts` | 语义检查与诊断 |
| `server/src/pine/runtime.ts` | `createRuntime(candles, opts)` 返回 `__pine` 对象（含 `ta/math/str/session/input/strategy/box/label/color` 命名空间与 `na/cmp/nz/tern` 助手） |
| `server/src/pine/codegen.ts` | AST → TS 源码 + `CompileMeta { config, inputs, plotTitles, alerts, kind }` |
| `server/src/pine/compile.ts` | 编排 lexer→parser→check→codegen；返回 `{ ts, js, diagnostics, meta }` |
| `server/src/pine/execute.ts` | TS→JS（Node 内置类型擦除）→ `vm` 沙箱执行 → `CompiledProgram` |
| `server/src/pine/cache.ts` | 以源码字符串为 key 的 LRU（上限 32）缓存 `CompileResult` |
| `server/src/pine/index.ts` | 对外导出 `compilePine / runPineProgram / PineDiagnostic` |
| `server/src/pine/cli.ts` | `npm run pine -- server/pine/test.pine --dump-ts output/pine/test.ts` |
| `server/src/tests/pine.test.ts` | 词法/语法/求值/回测一致性测试 |

### 新增（前端）

| 文件 | 职责 |
|---|---|
| `web/src/components/PineEditor.tsx` | Pine 源码编辑框 + 300ms 防抖编译 + 诊断列表 + 编译产物折叠面板 |
| `web/src/pineExamples.ts` | 内置两份示例源码（从 `/api/pine/examples` 拉取，失败时用内联兜底） |

### 修改

| 文件 | 改动 |
|---|---|
| `shared/types.ts` | `StrategyKind` 加 `'pine'`；新增 `PineDiagnostic`、`PineCompileMeta`；`BacktestResult` 加可选 `pine?: {...}` |
| `server/src/backtest/engine.ts` | 6 处外科手术式改动（见 §6） |
| `server/src/service/backtestService.ts` | `normalizeParams` 支持 pine；`runBacktestService` 支持 `req.pine` 分支 |
| `server/src/routes/api.ts` | 新增 `POST /api/pine/compile`、`POST /api/pine/backtest`、`GET /api/pine/examples` |
| `web/src/api.ts` | 新增 `compilePine` / `runPineBacktest` / `fetchPineExamples` |
| `web/src/components/ControlPanel.tsx` | 策略下拉加 `pine` 选项；`strategy === 'pine'` 分支渲染 `PineEditor` |
| `web/src/App.tsx` | `STRATEGY_LABEL` 加 `pine: 'Pine 脚本'`；把 `pineSource/pineInputs` 透传给面板与 `runBacktest` |
| `package.json` | 新增脚本 `"pine": "tsx server/src/pine/cli.ts"` |

---

## 5. Pine → TS 映射表（v1 冻结）

### 5.1 词法层

| Pine | 处理 |
|---|---|
| `//` 行注释 | 扫描前剥离，保留行号/列号偏移 |
| `//@version=6` | 识别为版本声明，仅存档 |
| 缩进块 | 每行计算缩进；与栈顶比较后插入 `INDENT`/`DEDENT`；缩进量必须为 4 的倍数，否则报错 |
| 逻辑行续行 | 3 条规则合并：**R1** 行尾括号 `(`/`[` 未闭合；**R2** 行尾为 `,` / 二元运算符 / `and` / `or`；**R3** 下一行首 token 为 `and`/`or`/`?`/`:`/`,`/二元运算符 且缩进大于语句起始缩进。合并后的逻辑行记录**首行**行号用于诊断 |
| 字符串 | 支持单/双引号、`\n`、`\"`、unicode（`✔ ▸ ≈ ✗`） |
| 数字 | 支持 `1`、`0.8`、`1e-3`；`#089981` 六位十六进制颜色字面量单独成 token |
| 标识符 | `[A-Za-z_][A-Za-z0-9_]*`；`_bull` 合法 |

### 5.2 语法层（AST）

- `//@version` / `indicator(...)` / `strategy(...)` 声明（具名实参）。
- 类型化声明：`[type] name = expr`、`[type] name := expr`、`name = expr`、`name := expr`；`var [type] name = expr`。
- `type Name` + 缩进字段块（`float top` / `box bx`）。
- 函数声明 `name(p1, p2) =>` + 缩进体（隐式末表达式返回）。
- `if / else if / else`（含单行 `if cond` 后接缩进块）。
- `for i = A to B`（不写 `by`，方向由 `A <= B` 运行时决定）。
- `break` / `continue`。
- 表达式：Pratt 优先级 —— 三元 `?:` < `or` < `and` < `not` < 比较 `== != < <= > >=` < `+ -` < `* / %` < 一元 `-` `+` < 后缀 `[k]` / `.field` / 调用 `/ 方法调用`。
- 调用实参：位置与具名混排（`plotshape(a, b, size=size.tiny)`）。
- 字面量：`na`、`true`、`false`、数字、字符串、颜色。

### 5.3 语义层（执行模型）

**三类顶层声明，三种处理：**

| 类别 | 判定 | 生成 |
|---|---|---|
| **A. `ta.*` 预计算** | 顶层、非 `var`、RHS 整条是 `ta.*` 调用且实参纯（仅 OHLCV/常量） | 程序初始化时算整条数组 `const atrArr: number[] = __pine.ta.atr(C.high, C.low, C.close, 14, 'RMA')`，读用 `atrArr[index]`、`atrArr[index-1]` |
| **B. 常量配置** | `input.*` 调用、`type` 声明、`strategy()/indicator()` 声明、纯字符串常量（如 `G1 = "..."`） | 程序初始化时求值一次。`input.*` 走 `__pine.input.int('atrLen', 14, { minval: 1, group: G1 })`，可由请求里的 `inputs` 覆盖 |
| **C. 其余顶层非 `var`** | 其它 | 放进 `step()` 内**按源码顺序逐 bar 求值**（保证 `mem_buy = valid_buy and …` 这类读 `var` 状态的表达式拿到正确时点语义） |

**`var` 状态**：`let` 声明在 `step()` 外，初始化一次；`:=` → 重新赋值。

**历史引用 `[k]`**：

| 被引用对象 | 生成 |
|---|---|
| 内置变量 `close/high/low/open/volume` | `__pine.at(C.close, index, k)`（越界返回 `NaN`） |
| A 类预计算数组 | `__pine.at(arr, index, k)` |
| `strategy.position_size[k]` | `index === 0 ? 0 : ctx.prevPositionSize`（k=1） |
| 其它顶层**无条件**每 bar 赋值的标量 | 在赋值点紧跟 `__pine.push(__h_x, x)`（环形缓冲，容量 = 最大引用深度+1），读用 `__pine.hist(__h_x, k)` |
| **条件分支内 / 块内局部变量** | **编译期报错**：`[k]` 历史引用仅支持内置变量、预计算数组与顶层无条件赋值变量（清晰的诊断文案 + 行列号） |

这份限制覆盖了两个目标脚本的**全部**用法（实测 `[1]` 只出现在 `close/high/low/open[1]`、`atr[1]`、`volSma[1]`、`is_green[1]`、`is_red[1]`、`high[1]`、`low[1]`、`prev_*`、`open[1]`、`close[1]`、`strategy.position_size[1]`）。

### 5.4 运算符与内置函数

| Pine | 生成 | 说明 |
|---|---|---|
| `and` / `or` / `not` | `&&` / `\|\|` / `!` | 操作数已是布尔 |
| `==` `!=` `<` `<=` `>` `>=` | `__pine.eq/neq/lt/le/gt/ge` | **na 参与比较恒为 false**（Pine 语义；`close < active_sl` 在 `active_sl` 为 na 时必须为 false） |
| `a ? b : c` | `(a ? b : c)` | 条件已由比较助手包成严格布尔；na 条件这一边界在 v1 记为已知限制 |
| `na` | `NaN` | |
| `na(x)` | `__pine.isNa(x)` | |
| `nz(x)` / `nz(x, y)` | `__pine.nz(x, y?)` | |
| `math.abs/min/max` | `Math.abs/min/max` | `Math` 对 NaN 的传播与 Pine 的 na 传播一致 |
| `ta.atr/sma/ema/rma/wma/highest/lowest` | `__pine.ta.*` → 复用 [ta.ts](file:///d:/code/Bunm/crypto-analyze/server/src/indicators/ta.ts) | A 类预计算通路 |
| `str.tostring(v, fmt)` | `__pine.str.tostring(v, fmt)` | `format.mintick` 在运行时解析为按 `mintick` 精度格式化 |
| `syminfo.mintick` | `__pine.ctx.mintick` | 由请求的 `tickSize` 注入 |
| `session.isfirstbar` | `__pine.session.isfirstbar` = `index === 0` | v1 近似（连续加密货币 K 线）；文档标注 |
| `bar_index` | `index` | |
| `open/high/low/close/volume/time` | `C.open[index]` … | |
| `color.rgb/new/gray/white/red/green/black/yellow`、`#089981` | `__pine.color.*`，内部表示是 CSS 颜色串 | `color.new(c, transp)` → `#rrggbbaa` |
| `size.tiny/small/…`、`location.*`、`shape.*`、`plot.style_*`、`label.style_*`、`text.align_*`、`chart.fg_color`、`format.mintick`、`strategy.long/short/percent_of_equity/commission.percent` | 运行时常量字符串 | 仅供实参传递 |
| `array.new<T>()` | `[]` | |
| `arr.size()` / `.get(i)` / `.push(x)` / `.remove(i)` / `.shift()` / `.pop()` / `.clear()` | `arr.length` / `arr[i]` / `arr.push(x)` / `arr.splice(i,1)` / `arr.shift()` / `arr.pop()` / `arr.length = 0` | |
| `Type.new(a, b, …)` | `new Type(a, b, …)`（`type` 声明编译成 `class`，同时挂静态 `new` 别名） | |
| `z.field := v` | `z.field = v` | |
| `box.new/set_*/delete`、`label.new/set_*/delete` | **无副作用存根**：返回不透明对象，`set_*` 记录到 `meta` 供前端可视化用，`delete` 置空 | 保证脚本忠实执行、又不影响回测；`box.delete(na)` 安全 |
| `plot(series, title, …)` | `meta.plots[title][index] = series` | 图元与叠加数据 |
| `plotshape(series, title, location, …)` | 非 na 时记录 marker 到 `meta.markers[index]` | |
| `barcolor(c, title)` | `meta.barColor[index] = c` | |
| `alertcondition(cond, title, message)` | 收集进 `meta.alerts`，无运行时副作用 | |
| `strategy("name", named…)` | 解析成 `meta.config`（initial_capital / commission_value / slippage / pyramiding / default_qty_*） | v1 只**记录**不覆盖 params（一致性验收要求两侧用同一份 params） |
| `strategy.entry(id, dir)` | 置 `__entryDir = dir`；bar 末尾映射为 `canLong/canShort` | |
| `strategy.exit(id, from_entry=, stop=, limit=)` | 置 `__exitStop/__exitLimit`；bar 末尾映射为 `obStopLoss/obTakeProfit` | 止损变量由脚本自己的 `var longStop` 跨 bar 携带 |
| `strategy.close_all(comment=)` | 置 `__forceClose = true` | |
| `strategy.position_size` / `[1]` | `ctx.positionSize` / `ctx.prevPositionSize`（多 1 / 空 -1 / 平 0） | |
| `strategy.position_avg_price` | `ctx.avgPrice` | |

### 5.5 编译产物骨架

```ts
// ===== 由 Pine 编译器生成，请勿手工修改 =====
// 源: test.pine
function __create(__pine) {
  const C = __pine.candles
  const n = C.length

  // [A] ta.* 预计算整条数组
  const atrArr = __pine.ta.atr(C.high, C.low, C.close, __pine.input.int('atrLen', 14, {}), 'RMA')
  const volSmaArr = __pine.ta.sma(C.volume, __pine.input.int('volLen', 20, {}))

  // [B] 类型
  class OB { constructor(top, bottom, impVol, bornBar, isBull, used, bx) { /* ... */ } }

  // [C] var 状态
  let zones = []
  let longStop = NaN, longTp = NaN, longRisk = NaN

  // 用户函数
  function f_overlaps(_bull, _top, _bot) { /* ... */ return hit }

  function step(index, ctx) {
    // [C] 顶层非 var，按源码顺序逐 bar 求值
    const close = C.close[index], open = C.open[index], high = C.high[index], low = C.low[index]
    let _entryDir = null, _exitStop = NaN, _exitLimit = NaN, _forceClose = false
    /* ... 源码语句 1:1 落位 ... */
    return {
      canLong: _entryDir === 'long',
      canShort: _entryDir === 'short',
      obStopLoss: _exitStop, obTakeProfit: _exitLimit, obRisk: __pine.nz(risk),
      forceClose: _forceClose,
    }
  }
  return { step, meta: { /* config, inputs, plotTitles, alerts, kind */ }, plots: {}, markers: [], barColor: [] }
}

globalThis.__pineProgram = { create: __create }
```

`execute.ts` 用 `stripTypeScriptTypes(ts, { mode: 'strip' })` 得到 JS，再 `vm.runInNewContext(js, sandbox, { timeout: 2000 })`；sandbox 内预先放入 `__pine` 与 `console`，**不暴露 `require`/`process`/`global`**。

---

## 6. 接入现有回测引擎（逐条列改动）

### 6.1 `server/src/backtest/engine.ts` —— 6 处，全部为附加式

1. **[L29-L41](file:///d:/code/Bunm/crypto-analyze/server/src/backtest/engine.ts#L29-L41)** `StrategySignalCore` 增加可选字段：
   ```ts
   /** Pine 的 strategy.close_all → 本根收盘后排队、下一根开盘市价平仓 */
   forceClose?: boolean
   ```
2. **[L65](file:///d:/code/Bunm/crypto-analyze/server/src/backtest/engine.ts#L65)** `signalProvider` 的 ctx 扩展为
   `{ flat: boolean; positionSize: number; prevPositionSize: number; avgPrice: number; side: TradeSide | null }`
   （兼容原有 `{ flat }` 调用点；`order-block` 不用新字段，行为不变）。
3. **[L231-232](file:///d:/code/Bunm/crypto-analyze/server/src/backtest/engine.ts#L231-L232)** `fillNextBarOpen` 追加 `|| input.params.strategy === 'pine'`。
4. 新增私有字段 `private prevPositionSize = 0`；在 [L690](file:///d:/code/Bunm/crypto-analyze/server/src/backtest/engine.ts#L690) 调用处传入当前与上一根的仓位方向，并在每轮末尾（D 段之后）更新 `this.prevPositionSize`。
5. 在 [L691](file:///d:/code/Bunm/crypto-analyze/server/src/backtest/engine.ts#L691) `const sig = series.signals[i]` 之后插入：
   ```ts
   // Pine：strategy.close_all(comment="Time stop") → 收盘判定、下一根开盘市价平仓
   if (params.strategy === 'pine' && sig.forceClose && this.position && !this.pendingExit) {
     this.pendingExit = 'TimeStop'
   }
   ```
6. **不改** Zone OCO / armBreakEven / C2 的既有逻辑 —— pine 通过 `normalizeParams` 复用它们的既有语义，从而与 `order-block` 逐字一致。

### 6.2 `server/src/service/backtestService.ts`

1. **[L96-L98](file:///d:/code/Bunm/crypto-analyze/server/src/service/backtestService.ts#L96-L98)** 白名单加入 `'pine'`。
2. 新增 pine 固定语义块（紧邻 order-block 那段）：
   ```ts
   if (p.strategy === 'pine') {
     p.exitStrategy = 'Zone OCO'
     p.partialTp = false
     p.tradeDirection = 'Both'
     p.pyramiding = 1
   }
   ```
3. `BacktestRequest` 增加 `pine?: { source: string; inputs?: Record<string, number | boolean | string> }`。
4. 在 [L227-L251](file:///d:/code/Bunm/crypto-analyze/server/src/service/backtestService.ts#L227-L251) 装配处增加 pine 分支：
   ```ts
   } else if (params.strategy === 'pine') {
     const program = runPineProgram(req.pine!.source, allCandles, { inputs: req.pine!.inputs, tickSize })
     const signals = allCandles.map(() => emptyPineSignal())
     signalProvider = (index, ctx) => { signals[index] = program.step(index, ctx) }
     series = { signals }
     pineArtifact = { source: req.pine!.source, ts: program.ts, diagnostics: [], plotTitles: program.meta.plotTitles, ... }
   }
   ```
   其中 `runPineProgram` 走 `cache.ts`，同一份源码只编译一次。
5. 返回值 [L323-L337](file:///d:/code/Bunm/crypto-analyze/server/src/service/backtestService.ts#L323-L337) 附加 `pine: pineArtifact`（未跑 pine 时为 `undefined`，不破坏现有前端）。

### 6.3 `shared/types.ts`

```ts
export type StrategyKind = 'fib-trend' | 'supertrend' | 'order-block' | 'pine'

export interface PineDiagnostic {
  line: number; column: number
  severity: 'error' | 'warning'
  message: string
}

export interface PineCompileMeta {
  /** 脚本种类：strategy() / indicator() */
  kind: 'strategy' | 'indicator'
  /** strategy() 声明的原始具名实参（仅记录） */
  config: Record<string, string | number | boolean>
  /** input.* 声明，供前端渲染可覆盖项 */
  inputs: { name: string; type: 'int'|'float'|'bool'|'color'|'string'; title: string; group?: string
            minval?: number; maxval?: number; step?: number; default: unknown }[]
  /** plot() 的 title 列表 */
  plotTitles: string[]
  /** alertcondition 收集 */
  alerts: { title: string; message: string }[]
}
```
`BacktestResult` 追加 `pine?: { source: string; ts: string; diagnostics: PineDiagnostic[]; meta: PineCompileMeta }`。

### 6.4 `server/src/routes/api.ts`

```ts
/** 实时编译：POST /api/pine/compile  { source, inputs? } */
apiRouter.post('/pine/compile', (req, res) => {
  // 成功: { ok: true, data: { ts, diagnostics, meta } }
  // 语法/语义错: 仍返回 200 + ok:true + 非空 diagnostics（编辑器要能一边打字一边看错）
})

/** 回测：POST /api/pine/backtest  { source, exchange, symbol, timeframe, since, until, bars, params, inputs, tickSize, useCache } */
apiRouter.post('/pine/backtest', async (req, res) => {
  // 复用 runBacktestService，把 pine 透传进 payload；响应结构与 /api/backtest 相同（data 里多 pine 字段）
})

/** 示例脚本：GET /api/pine/examples → 读取 server/pine/*.pine（fs.readFileSync + import.meta.url 定位） */
```

**错误分级**：编译期「有诊断」→ HTTP 200，`ok:true`，`diagnostics` 非空（供编辑器内联显示）；运行时异常（vm 超时/抛错）→ `ValidationError` → HTTP 400，`error` 带行列号。

---

## 7. 前端最小编辑器

### `web/src/components/PineEditor.tsx`

- `Paper` + 标题「Pine 脚本」+ 右上角「运行回测」「载入示例」按钮。
- 源码输入：`TextField multiline minRows={14}`，`fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace'`，`fontSize: 12.5`，`whiteSpace: 'pre'`。
- **300ms 防抖** → `compilePine(source)` → 写 `diagnostics` 与 `ts`。
- 诊断列表：`<ol>` 每项 `第 N 行 第 M 列 · 消息`，`severity==='error'` 用 `color="error.main"`，`warning` 用 `color="warning.main"`。
- 「编译产物（TS）」`Accordion`，`<pre>` 展示 `ts`，右上角复制按钮。
- **不受控于 debounce 的重跑**：点「运行回测」时把 `source` 一并交给 `App` 的提交逻辑。

### `ControlPanel.tsx` / `App.tsx`

- 策略 `Select` 增加 `<MenuItem value="pine">Pine 脚本（实时编译）</MenuItem>`；`changeStrategy('pine')` 时把 `exitStrategy` 置为 `'Zone OCO'`、`partialTp=false`、`pyramiding=1`（与后端强制值一致，避免界面与行为不符）。
- `strategy === 'pine'` 分支渲染 `<PineEditor />`，隐藏订单块/超趋势的专属字段。
- `App.tsx` 持 `pineSource` / `pineInputs` 状态，提交回测时放进请求体；`STRATEGY_LABEL` 增加 `pine: 'Pine 脚本'`。
- `ReportPanel` / `KLinePanel` 的文案分支增加 pine 说明（复用 order-block 的文案即可）；vm 执行后的图元叠加 v1 不做。

---

## 8. 里程碑与验证

| # | 内容 | 验证 |
|---|---|---|
| **M1** | `tokens/ast/lexer`：注释剥离、续行合并（R1/R2/R3）、INDENT/DEDENT、行列号 | `npx tsx --test server/src/tests/pine.test.ts` 中断言两份 `.pine` 的 token 流关键片段（如 `test.pine` L6-L8 的 `strategy(...)` 合并为 1 个逻辑行；L71-L76 的 `bullImpulse` 合并为 1 行） |
| **M2** | `parser + check`：完整 AST + 诊断；先跑通 `test1.pine`（结构更简单但嵌套更深） | 断言 `test1.pine` 解析零 error、`type OB` 字段数=7、函数数=2、`if/else` 嵌套深度正确；故意注入一处语法错，断言诊断含正确行列号 |
| **M3** | `runtime + codegen`（表达式与 `ta.*` 通路）：先用 `test1.pine` 数值验收 | 在合成的确定性 K 线上执行编译产物，逐 bar 比对 `is_green/prev_green/raw_buy/raw_sell/final_buy/final_sell/active_sl/static_sl/live_tp1..3` 与**同一份 TS 手工实现**（测试内内联的一小段参考实现）完全相等（`Object.is` 级别，含 NaN） |
| **M4** | `codegen` 的状态机部分：`type OB` / `array<OB>` / `for` 双向 / 反向 `for` + `splice` / 函数 / `var` / `:=`；跑通 `test.pine` | `npm run pine -- server/pine/test.pine --dump-ts output/pine/test.ts` 生成 TS；`npm run typecheck` 通过；执行编译产物与 `OrderBlockTracker.step()` 在合成 K 线上**逐 bar 全字段比对**（`canLong/canShort/obStopLoss/obTakeProfit/obRisk`） |
| **M5** | 引擎接入（§6 的 6 处改动）+ `normalizeParams` + `execute.ts`/`cache.ts` | `server/src/tests/pine.test.ts` 新增一致性用例：同一批合成 K 线 + **同一份 params**，分别跑 `strategy:'order-block'` 与 `strategy:'pine'`（源码 = `test.pine`），断言 `trades` 数组逐笔相等（side/entryIndex/exitIndex/entryPrice/exitPrice/qty/netPnl/exitReason/fills），`equityCurve` 逐点相等 |
| **M6** | API + CLI：`/api/pine/compile`、`/api/pine/backtest`、`/api/pine/examples`、`npm run pine` | `npm run pine -- server/pine/test.pine --symbol BTC/USDT:USDT --timeframe 1h --bars 3000` 打印报告；`curl -X POST localhost:5273/api/pine/compile -d '{"source":"..."}'` 返回 TS 与非空 `meta` |
| **M7** | 前端编辑器 + 策略接入 | `node scripts/ui-check.mjs --size=1920x1000` 截图无异常、无页面滚动；手工确认：粘贴 `test1.pine` → 诊断为空 → 「运行回测」出图 |

**每个里程碑结束都要跑**：`npm run typecheck`（注意 `web/src/ui/Stack.tsx` 存在**一个与本次无关的既有错误** `Cannot find module '@mui/system'`，不计入本次回归）与 `npm test`。

---

## 9. 假设与决策（执行者无需再选）

1. **TS→JS 用 Node 内置类型擦除**，不引入 esbuild、不新增任何依赖（已实测 `stripTypeScriptTypes` 在 v24.15.0 可用）。`mode: 'strip'` 要求生成物是「可擦除语法」——生成器只产出 `: type` 注解与 `interface`，不产出 `enum`/`namespace`/参数属性，满足要求。
2. **脚本 = 信号唯一来源；引擎 = 撮合唯一来源。** 脚本自带的保本移动与时间止损语句照常执行并进入 `plot`/图元，但对交易的实际影响由引擎既有 `Zone OCO` 通路承担（与今天 `order-block` 完全一致）。这是「逐笔一致」的前提，也是 v1 的明确设计边界。
3. **`strategy()` 声明只解析与回传，不覆盖 `params`。** 一致性测试两侧使用同一份 `params`。
4. `indicator()` 脚本的回测语义：`plotshape` 按 `location.belowbar/abovebar` 分多/空；离场止损取第一个 `title` 命中 `/\b(sl|stop)\b/i` 的 `plot()`；止盈取第一个命中 `/\b(tp|target)\b/i` 的 `plot()`。`test1.pine` 无 TP plot → 止盈为 `NaN`，离场为「止损命中」或「回测结束强平」。
5. `session.isfirstbar` 在 v1 = `bar_index === 0`（连续加密货币 K 线不存在换场）。
6. `box.*` / `label.*` 为**执行但不影响回测**的存根（真浏览器的绘图语义不在回测范围内）。
7. `vm` 沙箱：`timeout: 2000ms`，不注入 `require`/`process`/`globalThis` 之外的宿主对象；编译产物本身零 `import`。
8. 编译缓存：源码字符串为 key 的 LRU（32 条），同一份源码只在首次请求时编译。

### v1 明确不做

多元组返回 `[a, b] = f()`、`request.security`、`varip`、`matrix`/`map`/`table`、真正的时间段会话语义、`pyramiding > 1` 的 Pine 语义、分批止盈（`strategy.exit(qty_percent=)`）、`strategy.entry` 反手（`strategy.entry` 在持仓时反向开仓）、na 条件的 `?:` 传播、条件分支内变量的 `[k]` 历史引用、Pine 图元在 K 线图上的叠加渲染。

---

## 10. 验收清单（对应用户原始诉求）

- [ ] 「完整的 pine 脚本解析引擎」：`server/src/pine/` 下 lexer/parser/check/codegen/runtime/execute 全链路，两份 `.pine` 零 error 通过。
- [ ] 「实时编译为 ts 脚本」：`POST /api/pine/compile` 返回可读 TS 源码 + 逐行诊断；前端 300ms 防抖实时刷新。
- [ ] 「支持进行回测」：`POST /api/pine/backtest` + `npm run pine` CLI 均可跑出与现有界面同构的报告；`test.pine` 与 `OrderBlockTracker` **逐笔一致**。

---

## 11. M8 增量（M1–M7 落地之后）

### 11.1 v6 语法补全（为跑真实 TradingView 脚本）

用 `server/pine/` 下新增的第三方脚本（`Breakout.pine` / `SwiftEdge GEX.pine` / `Ichimoku.pine`）压测编译器，逐个补齐了 7 处缺口，全部为**新增能力、不改动既有语义**（`npm test` 由 50 → 53 全绿）：

| 缺口 | 现象 | 修法 |
| --- | --- | --- |
| 行尾 `?` / `:` 不触发续行 | 跨行三目链（`cond ? a :` 换行继续）被当成新语句，报「缩进非 4 的倍数」 | 词法层 `TRAILING_OPS` 纳入 `?` `:`（语句不可能以它们结尾，不会误吞新语句） |
| 数组字面量 `[a, b]` | `input.string(..., options = ["USD","EUR"])` 报「无法解析的表达式起始符 `[`」 | AST 增 `ArrayLit`，`parsePrimary` 前缀位 `[` 走数组（后缀位仍是历史引用 `x[k]`） |
| `switch` | 三目难以表达的字符串分派 | AST 增 `SwitchExpr`，codegen 脱糖为嵌套三目（分支匹配 = 相等比较，默认分支兜底） |
| 单行函数体 | `f(x) => expr` 报「期望缩进块」 | `parseFuncDecl` 在 `=>` 后非换行时包成 `expr` 语句（codegen 已把末表达式当返回值） |
| `while` | 报「v1 暂不支持 while 语句」 | AST 增 `WhileStmt` + `whileCode` |
| `for x in coll` | 报「期望 "="，实际是 "in"」 | AST 增 `ForInStmt` + `forInCode`（数组即 JS 数组，直接 `for…of`） |
| 复合赋值 `+=` 等 | `x += v` 报「赋值语句缺少 "=" 或 ":="」 | 词法识别 `+= -= *= /= %=`；`lookaheadAssign` 同步识别；语法层脱糖为 `x := x + v` |

> `for [k, v] in map` 的元组解构遍历会给出明确诊断，不在本次范围内。

### 11.2 脚本保存与选择

- 存储：`server/src/pine/store.ts` → `.cache/pine-scripts.json`（与 K 线缓存同目录，已 gitignore）。**同名即更新、换名即新增**，写入用「临时文件 + rename」防半截 JSON。
- 接口：`GET / POST / DELETE /api/pine/scripts`。
- 交互：编辑器内命名保存 / 删除；已保存脚本列在「策略」下拉菜单分隔线之后，选中即回填源码与名称并实时编译。

### 11.3 编辑器

- **CodeMirror 6** + `web/src/pineEditor.ts` 自写 Pine v6 流式词法器（`StreamLanguage`）。生态里没有可用的 Pine 语言包：`pine-script-syntax-highlighting` 停更于 2018（Pine v4 时代），CodeMirror / Monaco 官方与社区均无 v6 语法，故自研。
- 放大编辑：右侧 **Drawer**（`80vw` / 上限 1200px），打开时面板内编辑器让位并显示提示，避免同时挂载两个 CodeMirror 实例；Esc / 遮罩 / 按钮三种方式关闭。
- `web/vite.config.ts` 增加 `resolve.dedupe: ['react', 'react-dom']`：依赖树变化后若 Vite 预打包残留半旧产物，MUI 会读到 null 的 React internals 并报 `Invalid hook call`。

### 11.4 第三方脚本能力现状（实测结论）

| 脚本 | 行数 | 状态 |
| --- | --- | --- |
| `Breakout.pine` | 433 | **语法全通过**；语义阶段 210 条（149 处无法映射的标识符 / 38 处未支持内置成员 / 23 处未定义标识符） |
| `SwiftEdge GEX.pine` | 785 | 语法第 362 行止步：`array<float> HV = array.new<float>(14, na)`（泛型类型声明 + `array.new`） |
| `Ichimoku.pine` | 966 | 语法第 577 行止步：`array<float> tg = array.from(...)` |
| `Institutional .pine` | 0 | **空文件（0 字节）**，无法测试 |

结论：这三个脚本是「重量级」TradingView 脚本，主要依赖 `array.*`（54–144 处）、UDT `new()`（18–41 处）、绘图对象 `table/label/line/box`（20–60 处）、`request.security` 等尚未实现的 API 面。要完整编译并回测，需要按下列顺序扩面（每项都是独立里程碑）：

1. 泛型类型声明 `array<float> x = ...` 与 `array/map/matrix` 命名空间运行时；
2. UDT 实例化 `Type.new(...)` 与 `method` 绑定；
3. 绘图命名空间（`table/label/line/box/polyline`）作为**执行但不影响回测**的存根（与 §9 第 6 条的 `box.*` 一致）；
4. `request.security` 的 HTF 取值（含 `lookahead` 语义）。

### 11.5 验收清单（M8 收口）

- [x] v6 语法补全 7 项，新增 3 条 M6 回归测试，`npm test` 53/53 通过
- [x] 脚本保存 / 下拉选择：接口层实测新建、同名更新（id 不变）、删除、非法入参 400、落盘持久化；浏览器端刷新后仍可从下拉菜单选中并编译
- [x] CodeMirror 高亮 + Drawer 放大编辑：浏览器实测无控制台报错，Drawer 宽度 80vw、占满高度，Esc / 按钮均可关闭
- [x] `npm run typecheck`、`npx vite build` 均通过
- [ ] 第三方重量级脚本的完整编译与回测：见 §11.4 的扩面顺序，尚未开始
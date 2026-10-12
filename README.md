# crypto-analyze

把 TradingView 上的两个 Pine 策略用 TypeScript 完整复刻成一套本地可跑的回测系统：

- **Fibonacci Trend Reversals**（[IMBA]Algo + TSOT 趋势强度 + ATR SL Finder）
- **SuperTrend STRATEGY**（KivancOzbilgic 原版）

后端负责拉行情、算指标、撮合成交、出绩效报告；前端提供 K 线图、权益曲线、交易明细与回测报告，并支持导出 CSV。

## 功能特性

- **双策略切换**：`fib-trend` 与 `supertrend`，指标层逐一对照 Pine 原始公式实现
- **多交易所行情**：`binanceusdm` / `okx` / `bybit` / `bitget`，合约搜索 + 多源自动降级 + 本地 K 线缓存
- **撮合引擎**：分批止盈（TP1/TP2）、保本离场、ATR / 固定百分比 / 趋势反手三种止损策略、金字塔加仓、逐仓强平模拟、手续费与杠杆
- **与 TradingView 对齐的成交语义**：按策略区分「下一根开盘成交」与「信号 bar 收盘成交」（见下文）
- **绩效报告**：收益率、最大回撤、胜率、盈亏比、Sharpe、连盈连亏、多空分解、月度收益
- **可视化**：K 线图 + 指标叠加（SuperTrend 上下轨、IMBA 趋势线、ATR 止损线）+ 买卖点标记 + 权益曲线
- **导出**：交易明细 CSV、HTML 回测报告
- **CLI 回测** 与一批诊断脚本（`npm run diag:*`）

## 技术栈

| 端 | 技术 |
| --- | --- |
| 后端 | Node.js (>= 20)、TypeScript、Express 5、ccxt |
| 前端 | React 19、MUI、KLineCharts、Recharts、Vite |
| 数据 | ccxt 实时行情 + Binance Vision 归档兜底 + 本地文件缓存 |
| 测试 | node:test + tsx |

## 快速开始

要求 Node.js >= 20。

```bash
npm install
npm run dev          # 同时启动 API(8787) 与 Vite 前端(5273)
```

打开 http://localhost:5273 即可使用。

```bash
npm run dev:prod     # 构建前端产物后启动（生产模式预览）
npm run build        # 类型检查 + 构建 web/dist
npm start            # 生产模式启动（由 Express 托管 web/dist）
npm test             # 运行指标/引擎单元测试
npm run typecheck    # 前后端类型检查
```

命令行回测（无需前端）：

```bash
npm run backtest -- --symbol BTC/USDT:USDT --timeframe 1h --bars 5000 --leverage 5
npm run backtest -- --symbol ETH/USDT:USDT --timeframe 15m --since 2025-01-01 --exit "Fixed Percent"
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 后端 API 端口 |
| `API_TARGET` | `http://127.0.0.1:8787` | Vite 开发代理指向的后端地址 |

## 目录结构

```
server/src/                  后端
  index.ts                   HTTP 入口（API + 生产模式静态托管）
  routes/api.ts              路由层
  service/backtestService.ts 业务编排：参数校验 → 拉行情 → 算指标 → 跑回测 → 出报告
  indicators/
    ta.ts                    Pine 对齐的指标原语（sma/ema/rma/wma/highest/lowest/percentile/atr）
    fibTrendReversal.ts      Fibonacci Trend Reversals 信号
    supertrend.ts            SuperTrend 信号
  backtest/
    engine.ts                撮合引擎（子订单、加仓、止盈止损、反手）
    metrics.ts               绩效统计与报告
  market/
    exchange.ts              ccxt 实例、缓存、多源降级、K 线分页拉取
    binanceVision.ts         Binance 数据归档兜底
  cli.ts                     命令行回测
  tests/indicators.test.ts   单元测试
shared/types.ts              前后端共享类型与默认参数
web/src/                     React 前端（组件、图表、工具函数）
scripts/                     开发启动与诊断脚本
```

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/exchanges` | 支持的交易所与周期列表 |
| GET | `/api/instruments?exchange=&q=&limit=` | 合约列表（内存缓存 10 分钟，多源降级） |
| GET | `/api/price?exchange=&symbol=` | 最新价 |
| GET | `/api/klines?exchange=&symbol=&timeframe=&since=&until=` | K 线 |
| POST | `/api/backtest` | 运行回测（body：`exchange/symbol/timeframe/since/until/params`） |

## 策略参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `strategy` | `fib-trend` | `fib-trend` / `supertrend` |
| `sensitivity` | `18` | fib 通道灵敏度（×10 后作为回看窗口） |
| `atrLength` / `atrSmoothing` / `atrMultiplier` | `14` / `RMA` / `3.5` | ATR 止损参数 |
| `tradeDirection` | `Both` | `Long Only` / `Short Only` / `Both` |
| `exitStrategy` | `ATR` | `ATR` / `Fixed Percent` / `Trend Switch` |
| `slPercent` / `riskRewardRatio` | `1` / `2` | 固定百分比止损、盈亏比 |
| `partialTp` / `allowReversePosition` / `pyramiding` | `true` / `true` / `1` | 分批止盈 / 允许反手 / 加仓次数（1 = 不加仓） |
| `commissionPercent` | `0.055` | 单边手续费（%） |
| `initialCapital` / `leverage` / `positionSizePercent` | `1000` / `3` / `100` | 资金、杠杆、每笔仓位比例 |
| `checkLiquidation` | `true` | 逐仓强平模拟 |
| `supertrend.atrPeriod` / `multiplier` | `10` / `3.0` | SuperTrend 周期与乘数 |
| `supertrend.useSmaAtr` | `false` | `false` = RMA（原版 `changeATR=true` 默认） |
| `supertrend.source` | `hl2` | 价格源：`hl2` / `close` / `open` / `high` / `low` |

## 与 TradingView 对齐的注意事项

复刻过程中已验证过的口径差异（想和 TV 账单逐笔对齐时需注意）：

1. **成交时点**：SuperTrend 原版 `strategy()` 未开启 `process_orders_on_close`，TV 在**信号 K 线的下一根开盘**成交（所以 TV 清单里「平仓价 = 下一笔开仓价」）；fib 原版显式开启了该选项，按**信号 K 线收盘**成交。引擎按策略区分处理。
2. **ATR 算法**：SuperTrend 原版 `atr = changeATR ? atr(Periods) : atr2`，`changeATR=true`（默认）用的是 **RMA**，`false` 才是 SMA。选错会让翻转次数多出约 10%。
3. **回测区间**要一致（TV 的区间选择器以图表时区为准，默认北京时间 UTC+8）。
4. **仓位与费用口径**：TV 策略属性里的初始资金、手续费（默认为 0）、每笔下单量（默认 1 张合约）都会影响收益金额，不影响交易笔数。
5. **行情源**：TV 行情源与交易所官方 K 线存在约 0.01%~0.04% 的微价差，价格贴着指标线时会造成个别翻转错位 ±1 根，属固有误差。

## 数据源说明

行情按「ccxt 实时接口 → Binance Vision 归档 → 本地缓存」的顺序获取，缓存位于 `.cache/klines/`（已在 .gitignore 中忽略）。全程只使用公开行情接口，无需 API Key。

## 免责声明

本项目仅用于策略研究与技术学习，不构成任何投资建议。加密货币合约交易风险极高，请自行评估。

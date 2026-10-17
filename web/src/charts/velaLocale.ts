/**
 * Vela 图表内置 UI 的汉化层。
 *
 * 背景：`@luxalgo/vela` 没有 i18n 开关（`VelaOptions.defaultLanguage` 只管 Pine
 * 脚本语言，与界面文案无关），而且内置的 `volume` 原生指标是在**每次 `new Vela()`
 * 时重新注册**的 —— 所以想通过在 indicator registry 上覆盖 title 来改图例标题，
 * 会被下一次图表实例化冲掉。
 *
 * 因此这里采用最稳的做法：在 DOM 层挂一个 MutationObserver，对**整段文本节点**
 * 做精确匹配替换（同时处理 `title` / `aria-label` / `placeholder` 属性）。
 *
 * 同上，界面文案用 DOM 层；而**时间轴刻度与十字光标日期是 canvas 绘制**的
 * （见下方 `zhDate` / `installCanvasLocale`），DOM 词典够不到，改用 canvas 原型拦截。
 *
 * 三条安全约束：
 *   1. 只做「整串相等」的替换，不做子串替换 —— 免得把用户数据（脚本名、标的名、
 *      价格数字）里的英文误译；
 *   2. 词典只收 Vela 自带的界面文案，不含任何业务文案，所以即使把 observer 挂在
 *      `document.body`（Vela 的菜单/弹窗会 portal 到图表容器之外）也不会误伤本站中文界面；
 *   3. 收词范围对齐本项目实际开启的 Vela 能力 —— 本项目关掉了 `drawings` /
 *      `topbar` / `statusline` / `bottombar`，因此绘图工具目录、状态栏、底部栏、
 *      对象树等不可达的文案没有收进来。
 * canvas 日期拦截同样只匹配 Vela 那几种固定日期格式的**整串**，不做子串替换。
 *
 * 同一个页面允许多个图表（主图 + 回放弹窗）同时安装：observer / canvas 补丁是模块级单例，
 * 按引用计数装卸。
 */

/** 英文原文 → 简体中文（键必须与运行时 DOM 里的整串文本完全一致） */
const DICT: Record<string, string> = {
  /* ---- 指标图例 / 指标标题缺省值 ---- */
  Indicator: '指标',
  Hide: '隐藏',
  Show: '显示',
  Settings: '设置',
  'Move to pane': '移动到面板',
  'Remove indicator': '移除指标',
  'Show indicator legend': '显示指标图例',
  'Hide indicator legend': '隐藏指标图例',
  'Indicator values': '指标数值',
  'New pane above': '上方新建面板',
  'New pane below': '下方新建面板',

  /* ---- 回放水印 ---- */
  Replay: '回放',
  'Replay Mode': '回放模式',

  /* ---- 图表右键菜单（主图） ---- */
  'Reset chart view': '重置图表视图',
  'Remove drawings': '删除绘图',
  'Remove indicators': '移除指标',
  'Settings…': '设置…',
  'More settings…': '更多设置…',

  /* ---- 价格轴右键菜单 ---- */
  'Auto (fits data to screen)': '自动（适配数据到屏幕）',
  'Invert scale': '反转刻度',
  Regular: '常规',
  Percent: '百分比',
  'Indexed to 100': '指数化（基准 100）',
  Logarithmic: '对数',
  Labels: '标签',
  'Price axis labels': '价格轴标签',
  'Last price label': '最新价标签',
  'Countdown to bar close': '距收盘倒计时',
  Levels: '水平线',
  'Last Price Line': '最新价线',

  /* ---- 时间轴右键菜单 ---- */
  'Time zone': '时区',
  Exchange: '交易所',

  /* ---- 图表设置弹窗 ---- */
  'Chart settings': '图表设置',
  Sections: '分区',
  'Reset defaults': '恢复默认值',
  Symbol: '品种',
  'Chart type': '图表类型',
  'Scales and lines': '刻度与线条',
  Canvas: '画布',
  Events: '事件',
  'Visible events': '显示的事件',
  Animation: '动画',
  Type: '类型',
  Candles: '蜡烛图',
  Body: '实体',
  Borders: '边框',
  Wick: '影线',
  Spacing: '间距',
  Bars: '美国线',
  'Color Up': '上涨颜色',
  'Color Down': '下跌颜色',
  Line: '线',
  Color: '颜色',
  Width: '宽度',
  Area: '面积图',
  'Line color': '线条颜色',
  'Top fill': '顶部填充',
  'Bottom fill': '底部填充',
  Baseline: '基准线',
  'Top line': '上边界线',
  'Bottom line': '下边界线',
  'Fill top area': '填充上部区域',
  'Fill bottom area': '填充下部区域',
  'Base level %': '基准水平 %',
  'Animate zoom': '缩放动画',
  'Pan momentum': '平移惯性',
  'Animate price scale': '价格刻度动画',
  'Animate price changes': '价格变动动画',
  'Reveal on load': '加载时渐现',
  'Glide the chart to each zoom step instead of jumping.':
    '缩放时平滑过渡到每一档，而不是直接跳转。',
  'Keep gliding briefly after a drag release, and ease scroll-to-latest and keyboard pans.':
    '拖动松开后短暂惯性滑动，并平滑处理滚动到最新与键盘平移。',
  'Glide the price scale to its new range while zooming or panning.':
    '缩放或平移时，价格刻度平滑过渡到新的范围。',
  'Glide the live bar to each new price instead of snapping.':
    '实时 K 线平滑移动到新价格，而不是瞬间跳变。',
  'Draw the candles in when a chart first loads. Takes effect on the next load.':
    '图表首次加载时以动画绘制 K 线。下次加载时生效。',
  'Price scale': '价格刻度',
  Mode: '模式',
  'Scale border color': '刻度边框颜色',
  Crosshair: '十字光标',
  Style: '样式',
  Solid: '实线',
  Dashed: '虚线',
  Dotted: '点线',
  'Background & text': '背景与文字',
  Background: '背景',
  'Text color': '文字颜色',
  'Text size': '文字大小',
  'Pane separator color': '面板分隔线颜色',
  Grid: '网格',
  Vertical: '垂直',
  Horizontal: '水平',
  Margins: '边距',
  Top: '上',
  Bottom: '下',
  Right: '右',
  Theme: '主题',
  'Color theme': '颜色主题',
  Dark: '深色',
  Light: '浅色',
  'Trading session': '交易时段',
  Session: '时段',
  'Regular hours (RTH)': '常规时段 (RTH)',
  'Extended hours (ETH)': '延长时段 (ETH)',
  'Pre-market': '盘前',
  'Post-market': '盘后',
  'Extended hours': '延长时段',
  Advanced: '高级',
  'Bars to fetch': '获取的 K 线数量',
  'Status line': '状态栏',
  'Symbol name': '品种名称',
  'Market status': '市场状态',
  'OHLC values': 'OHLC 值',
  'Bar change values': 'K 线涨跌值',
  Indicators: '指标',
  Titles: '标题',
  Values: '数值',
  Watermark: '水印',
  'Symbol watermark': '品种水印',
  'Replay watermark': '回放水印',

  /* ---- 指标设置弹窗 ---- */
  Inputs: '输入',
  Properties: '属性',
  Cancel: '取消',
  Ok: '确定',

  /* ---- 脚本「属性」标签页：Pine 声明属性字段 ----
   * 这些标签由 vela-pinets 的 `labelOf(name)` 由属性名生成（下划线换空格 + 首字母大写），
   * 如 `max_bars_back` → "Max bars back"；所以按生成后的整串收词。 */
  Overlay: '叠加到主图',
  Format: '格式',
  Precision: '精度',
  Scale: '刻度',
  'Max bars back': '最大回溯 K 线数',
  'Explicit plot zorder': '显式绘图顺序',
  'Max lines count': '最大线条数',
  'Max labels count': '最大标签数',
  'Max boxes count': '最大方框数',
  'Max polylines count': '最大折线数',
  'Calc bars count': '计算 K 线数',
  'Timeframe gaps': '周期间缺口',
  'Dynamic requests': '动态请求',
  'Behind chart': '置于图表之后',
  Shorttitle: '简称',
  Title: '标题',

  /* ---- 脚本「属性」标签页：策略（strategy）专属属性 ---- */
  Pyramiding: '最大加仓次数',
  'Calc on order fills': '成交后立即重算',
  'Calc on every tick': '每个 tick 重算',
  'Backtest fill limits assumption': '回测撮合限制（K 线数）',
  'Default qty type': '默认下单量类型',
  'Default qty value': '默认下单量数值',
  'Initial capital': '初始资金',
  Currency: '货币',
  Slippage: '滑点（tick）',
  'Commission type': '手续费类型',
  'Commission value': '手续费数值',
  'Process orders on close': '按收盘价成交',
  'Close entries rule': '平仓匹配顺序',
  'Margin long': '多头保证金 %',
  'Margin short': '空头保证金 %',
  'Risk free rate': '无风险利率 %',
  'Use bar magnifier': '使用 K 线放大镜',
  'Fill orders on standard ohlc': '按标准 OHLC 撮合',

  /* ---- 脚本「属性」下拉选项：Pine 枚举 token（原样显示，故按小写整串收词）----
   * format: inherit/mintick/percent/price/volume；scale: left/none/right；
   * default_qty_type: fixed/cash/percent_of_equity；
   * commission_type: percent/cash_per_contract/cash_per_order；close_entries_rule: FIFO/ANY */
  inherit: '继承',
  mintick: '最小变动价位',
  percent: '百分比',
  price: '价格',
  volume: '成交量',
  left: '左',
  right: '右',
  none: '无',
  fixed: '固定数量',
  cash: '现金',
  percent_of_equity: '权益百分比',
  cash_per_contract: '每张合约现金',
  cash_per_order: '每笔订单现金',
  FIFO: '先进先出',
  ANY: '任意顺序',

  /* ---- 数据窗口 ---- */
  'Data window': '数据窗口',
  Time: '时间',
  Date: '日期',
  Open: '开盘价',
  High: '最高价',
  Low: '最低价',
  Price: '价格',
  'No data': '无数据',
  'This renderer provides no data readout.': '此渲染器不提供数据读数。',

  /* ---- 空态 / 加载 / 提示 ---- */
  'Loading…': '加载中…',
  'No data source': '无数据源',
  'No symbols match.': '无匹配品种。',
  'No indicators match.': '无匹配指标。',
  'No indicators in the manifest.': '清单中没有指标。',
  'No tools match.': '无匹配工具。',
  'No alerts yet.': '暂无提醒。',
  'No lower-timeframe data': '无更低周期数据',
  'Area too wide for this timeframe': '该区域对当前周期过宽',
  'No lower timeframe available': '无可用更低周期',

  /* ---- 图表无障碍说明（图表面板的 aria-label） ---- */
  'Interactive price chart. Use Left/Right arrows to move between bars, Shift+Arrow to pan, plus/minus to zoom, Home/End to jump, 0 to reset.':
    '交互式价格图表。使用左右箭头切换 K 线，Shift+方向键平移，加/减号缩放，Home/End 跳转，0 重置。',

  /* ---- 快捷键面板（按 `?` 打开，可达） ---- */
  'Keyboard shortcuts': '键盘快捷键',
  Mouse: '鼠标',
  Chart: '图表',
  Edit: '编辑',
  Help: '帮助',
  'Scroll to most recent bar': '滚动到最新 K 线',
  'Reset view (all history)': '重置视图（全部历史）',
  'Toggle logarithmic scale': '切换对数刻度',
  'Toggle percent scale': '切换百分比刻度',
  'Zoom in': '放大',
  'Zoom out': '缩小',
  'Pan toward history': '向历史平移',
  'Pan toward now': '向最新平移',
  'Open the indicator picker': '打开指标选择器',
  'Show this shortcuts panel': '显示此快捷键面板',
  'Download a screenshot of the layout': '下载布局截图',
  Undo: '撤销',
  Redo: '重做',
  Screenshot: '截图',
  'Download screenshot': '下载截图',
  Alerts: '提醒',
  Timeframe: '周期',
  'Change timeframe': '更改周期',
  'Chart style': '图表样式',
  Layout: '布局',
  Restore: '还原',
  Maximize: '最大化',
  Remove: '移除',
  'Remove all': '全部移除',
  Drawings: '绘图',
  Sync: '同步',

  /* ---- 搜索品种弹窗（按字母键可达） ---- */
  'Symbol Search': '搜索品种',
  'Search symbol…': '搜索品种…',
  'Search…': '搜索…',
  'Search tools…': '搜索工具…',
  'Show contracts': '显示合约',
  All: '全部',
  Stocks: '股票',
  ETFs: 'ETF',
  Crypto: '加密货币',
  Futures: '期货',
  Forex: '外汇',
  Commodities: '商品',
  General: '常规',
  'No symbols indexed (provider still loading?).': '未索引任何品种（数据源仍在加载？）。',
  'Remove from chart': '从图表移除',
  'Object tree': '对象树',
  Timeframes: '周期',
  'Not a timeframe': '不是有效的周期',
  'e.g. 15, 4H, D, 3M': '例如 15、4H、D、3M',
}

const ATTRS = ['title', 'aria-label', 'placeholder'] as const

/** 把一段文本换成中文（整串相等才换；返回 null 表示不动） */
function zh(text: string): string | null {
  return Object.prototype.hasOwnProperty.call(DICT, text) ? DICT[text] : null
}

/* ------------------------------------------------------------------ */
/* 时间轴 / 十字光标的日期汉化                                          */
/* ------------------------------------------------------------------ */

/**
 * Vela 的时间轴（底部刻度）与十字光标日期标签是 **canvas 绘制**
 * （`ctx.fillText(tick.label)`），不走 DOM —— 因此上面的文本节点词典对它们无效。
 * Vela 内部把日期拼成固定格式（见 bundle 里的 `formatTimeStamp` / `timeTicks`）：
 *   · 完整时间戳  `Tue 13 Oct '26 11:00`  / `Tue 13 Oct '26`
 *   · 日刻度      `Oct 12`
 *   · 月刻度      `Oct`（月线级别）
 *   · 年份        `2026`（原样保留）
 * 且 Vela **没有**任何 locale / formatter 公开钩子（价格轴有 `priceAxisTicks` 钩子，
 * 时间轴没有）。所以这里在 canvas 2D 原型层拦截 `fillText` / `measureText`，
 * 只对「完整匹配上述固定格式」的串做替换 —— 不做子串替换，避免误伤其他画布文字。
 * `measureText` 一并拦截，是为了让 Vela 计算刻度居中时（`measureText(label).width`）
 * 用的是中文串的宽度，否则标签会因宽度差异而偏移。
 */
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ZH_MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
const EN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ZH_DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const RE_STAMP =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) '(\d{2})(?: (\d{1,2}:\d{2}))?$/
const RE_MONTH_DAY = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})$/
const RE_MONTH_ONLY = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/

/** Vela 的英文日期串 → 中文（不匹配时返回 null，表示原样保留） */
function zhDate(text: string): string | null {
  let m = RE_STAMP.exec(text)
  if (m) {
    const wd = ZH_DAYS[EN_DAYS.indexOf(m[1])]
    const mo = ZH_MONTHS[EN_MONTHS.indexOf(m[3])]
    return `${mo}${Number(m[2])}日 ${wd} '${m[4]}${m[5] ? ` ${m[5]}` : ''}`
  }
  m = RE_MONTH_DAY.exec(text)
  if (m) return `${ZH_MONTHS[EN_MONTHS.indexOf(m[1])]}${Number(m[2])}日`
  m = RE_MONTH_ONLY.exec(text)
  if (m) return ZH_MONTHS[EN_MONTHS.indexOf(m[1])]
  return null
}

let origFillText: CanvasRenderingContext2D['fillText'] | null = null
let origMeasureText: CanvasRenderingContext2D['measureText'] | null = null

/** 在 canvas 2D 原型层安装日期汉化（生命周期由 installVelaLocale 的引用计数统一管理） */
function installCanvasLocale(): void {
  if (origFillText || typeof CanvasRenderingContext2D === 'undefined') return
  const proto = CanvasRenderingContext2D.prototype
  const fill = proto.fillText
  const measure = proto.measureText
  origFillText = fill
  origMeasureText = measure
  proto.fillText = function (text: string, x: number, y: number, maxWidth?: number): void {
    const t = typeof text === 'string' ? zhDate(text) ?? text : text
    if (maxWidth === undefined) fill.call(this, t, x, y)
    else fill.call(this, t, x, y, maxWidth)
  }
  proto.measureText = function (text: string): TextMetrics {
    return measure.call(this, typeof text === 'string' ? zhDate(text) ?? text : text)
  }
}

/** 还原 canvas 原型 */
function uninstallCanvasLocale(): void {
  if (!origFillText || typeof CanvasRenderingContext2D === 'undefined') return
  CanvasRenderingContext2D.prototype.fillText = origFillText
  if (origMeasureText) CanvasRenderingContext2D.prototype.measureText = origMeasureText
  origFillText = null
  origMeasureText = null
}

/** 翻译一个元素上的属性值（title / aria-label / placeholder） */
function translateAttrs(el: Element): void {
  for (const attr of ATTRS) {
    const v = el.getAttribute(attr)
    if (v === null) continue
    const key = v.trim()
    const t = zhDate(key) ?? zh(key)
    if (t !== null && t !== v) el.setAttribute(attr, t)
  }
}

/** 翻译一棵子树里的文本节点与属性 */
function translateTree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text)
  } else if (root.nodeType === Node.ELEMENT_NODE) {
    translateAttrs(root as Element)
  }
  if (root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    let n: Node | null = walker.nextNode()
    while (n) {
      if (n.nodeType === Node.TEXT_NODE) translateTextNode(n as Text)
      else translateAttrs(n as Element)
      n = walker.nextNode()
    }
  }
}

/**
 * 节点是否位于「可编辑区」内（CodeMirror / 输入框 / contenteditable）。
 *
 * 这些地方的文本绝不能翻译：词典里有 `volume` / `price` / `left` 这类 Pine
 * 标识符（用于脚本属性下拉），而 CodeMirror 会把编辑区的 DOM 变更当成用户
 * 输入同步回文档（readDOMChange）—— 一翻译就把源码里的 `volume` 写成了
 * 「成交量」，编译随即报 `Unexpected character '成'`。刷新/重新载入都救不了，
 * 因为每次重新渲染都会再被改脏。
 */
function insideEditable(node: Node): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  if (!el) return false
  return !!el.closest('.cm-editor, input, textarea, select, [contenteditable="true"]')
}

/** 只改「整串等于词典键（或 Vela 日期格式）」的文本节点；保留首尾空白 */
function translateTextNode(node: Text): void {
  const raw = node.data
  if (!raw) return
  const trimmed = raw.trim()
  if (!trimmed) return
  if (insideEditable(node)) return
  const t = zhDate(trimmed) ?? zh(trimmed)
  if (t === null) return
  const lead = raw.slice(0, raw.indexOf(trimmed))
  const tail = raw.slice(raw.indexOf(trimmed) + trimmed.length)
  node.data = `${lead}${t}${tail}`
}

let observer: MutationObserver | null = null
let refCount = 0

function onMutations(records: MutationRecord[]): void {
  for (const rec of records) {
    if (rec.type === 'attributes') {
      if (rec.target.nodeType === Node.ELEMENT_NODE) translateAttrs(rec.target as Element)
      continue
    }
    if (rec.type === 'characterData') {
      translateTextNode(rec.target as Text)
      continue
    }
    for (const n of rec.addedNodes) translateTree(n)
  }
}

/**
 * 安装/卸载汉化层（引用计数）：
 *   · DOM 观察器 —— 界面文案（Vela 的菜单/弹窗会 portal 到图表容器之外）；
 *   · canvas 原型拦截 —— 时间轴 / 十字光标的日期（画布绘制，DOM 够不到）。
 * 返回 dispose：调用即减一，归零时断开 observer 并还原 canvas 原型。
 */
export function installVelaLocale(): () => void {
  refCount += 1
  installCanvasLocale()
  if (!observer && typeof document !== 'undefined' && document.body) {
    translateTree(document.body)
    observer = new MutationObserver(onMutations)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRS],
    })
  }
  return () => {
    refCount -= 1
    if (refCount <= 0) {
      if (observer) {
        observer.disconnect()
        observer = null
      }
      uninstallCanvasLocale()
      refCount = 0
    }
  }
}

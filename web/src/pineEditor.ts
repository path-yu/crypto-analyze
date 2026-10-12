/**
 * Pine 编辑器：语法高亮 + 暗色主题 + CodeMirror 基础配置。
 *
 * 现成的 Pine 语法包只有 2018 年停更的 `pine-script-syntax-highlighting`（Pine v4 时代），
 * CodeMirror / Monaco 的官方与社区都没有 v6 语法，所以这里用 StreamLanguage
 * 自写一个流式词法器：逐行扫描、不建语法树，足以覆盖 v6 的注释、字符串、数字、
 * 颜色字面量、关键字、类型、内置命名空间（ta. / strategy. / request. …）与运算符。
 *
 * 配色沿用 web/src/theme.ts 的暗色调色板，保证编辑器与面板浑然一体。
 */

import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentUnit,
  syntaxHighlighting,
  type StreamParser,
  type StringStream,
} from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view'
import { tags, type Tag } from '@lezer/highlight'

/* ------------------------------------------------------------------ */
/* 词法表                                                              */
/* ------------------------------------------------------------------ */

/** 脚本声明、控制流、声明与限定符 */
const KEYWORDS = new Set([
  'indicator', 'strategy', 'library',
  'if', 'else', 'for', 'to', 'by', 'while', 'switch', 'case', 'default',
  'break', 'continue', 'return', 'var', 'varip', 'type', 'enum', 'method',
  'import', 'export', 'as', 'in', 'const', 'simple', 'series',
])

/** 逻辑运算符单独染成运算符色（TradingView 亦如此） */
const LOGIC_OPS = new Set(['and', 'or', 'not'])

/** 内置类型（array / matrix / map 既是类型也是命名空间，按后随的 . 判定） */
const TYPES = new Set([
  'int', 'float', 'bool', 'string', 'color', 'line', 'label', 'box', 'table',
  'array', 'matrix', 'map', 'polyline', 'linefill', 'chartpoint', 'void',
])

/** 内置命名空间：`ta.ema`、`strategy.entry`、`request.security` … */
const NAMESPACES = new Set([
  'ta', 'math', 'str', 'array', 'map', 'matrix', 'request', 'strategy', 'input', 'color',
  'plot', 'plotshape', 'plotchar', 'plotarrow', 'plotcandle', 'plotbar',
  'hline', 'fill', 'bgcolor', 'barcolor', 'alert', 'alertcondition',
  'label', 'line', 'box', 'table', 'polyline', 'linefill',
  'time', 'session', 'syminfo', 'barstate', 'timeframe', 'chart', 'runtime', 'ticker',
  'currency', 'display', 'format', 'location', 'shape', 'size', 'style', 'extend',
  'position', 'order', 'barmerge', 'xloc', 'yloc', 'adjustment', 'backadjustment',
  'settlement_as_close', 'earnings', 'dividends', 'splits',
  'dayofweek', 'dayofmonth', 'month', 'weekofyear', 'hour', 'minute', 'second', 'year',
  'log', 'scale', 'font', 'text',
])

/** 内置行情序列与常量 */
const BUILTIN_VARS = new Set([
  'open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4',
  'bar_index', 'last_bar_index', 'time', 'time_close', 'time_tradingday',
  'last_bar_time', 'last_bar_time_close',
])

/** 自定义词法名 → Lezer 标签，HighlightStyle 再据此上色 */
const TOKEN_TABLE: Record<string, Tag | readonly Tag[]> = {
  comment: tags.lineComment,
  string: tags.string,
  number: tags.number,
  color: tags.color,
  keyword: tags.keyword,
  operator: tags.operator,
  bool: tags.bool,
  null: tags.null,
  typeName: tags.typeName,
  namespace: tags.namespace,
  property: tags.propertyName,
  variable: tags.variableName,
  standard: tags.standard(tags.variableName),
  bracket: tags.bracket,
  punctuation: tags.punctuation,
}

/** 一行注释（`//@version=6` 也走这里）、双引号字符串（含转义）、颜色与数字 */
const RE_COLOR = /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?/
const RE_NUMBER = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/
const RE_WORD = /[A-Za-z_][A-Za-z0-9_]*/
const RE_OPERATOR = /(?::=|==|!=|<=|>=|=>|\+=|-=|\*=|\/=|%=|[+\-*/%<>=?:])/

/**
 * Pine v6 流式词法器。
 *
 * 无状态：成员访问靠「读到 . 就顺手把后面的标识符一起吃掉」处理，
 * 因此 `ta.ema` → namespace + property，`ob.bx` → variable + property 都能正确分层。
 */
const pineParser: StreamParser<Record<string, never>> = {
  startState: () => ({}),

  /** 自定义词法名 → Lezer 标签（StreamParser 规范的一部分，不是 define 的第二个参数） */
  tokenTable: TOKEN_TABLE,

  token(stream: StringStream): string | null {
    if (stream.eatSpace()) return null

    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }

    if (stream.match('"')) {
      let escaped = false
      for (;;) {
        const ch = stream.next()
        if (ch === undefined) break
        if (ch === '"' && !escaped) break
        escaped = !escaped && ch === '\\'
      }
      return 'string'
    }

    if (stream.match(RE_COLOR)) return 'color'
    if (stream.match(RE_NUMBER)) return 'number'

    if (stream.match(RE_WORD)) {
      const word = stream.current()
      if (word === 'true' || word === 'false') return 'bool'
      if (word === 'na') return 'null'
      if (LOGIC_OPS.has(word)) return 'operator'
      if (KEYWORDS.has(word)) return 'keyword'
      // 后面跟点就是命名空间（ta. / array. / label.），否则可能是类型或普通变量
      if (stream.peek() === '.') {
        return NAMESPACES.has(word) || TYPES.has(word) ? 'namespace' : 'variable'
      }
      if (TYPES.has(word)) return 'typeName'
      if (BUILTIN_VARS.has(word)) return 'standard'
      return 'variable'
    }

    // 成员访问：把点后面的名字一并染色为属性，避免出现 `ta . ema` 三段异色
    if (stream.eat('.')) {
      if (stream.match(RE_WORD)) return 'property'
      return 'punctuation'
    }

    if (stream.match(RE_OPERATOR)) return 'operator'
    if (stream.match(/[()[\]{}]/)) return 'bracket'
    if (stream.match(',')) return 'punctuation'

    stream.next()
    return null
  },
}

export const pineLanguage = StreamLanguage.define(pineParser)

/* ------------------------------------------------------------------ */
/* 配色                                                                */
/* ------------------------------------------------------------------ */

export const pineHighlightStyle = HighlightStyle.define([
  { tag: tags.lineComment, color: '#5c6779', fontStyle: 'italic' },
  { tag: tags.string, color: '#c3e88d' },
  { tag: tags.number, color: '#f78c6c' },
  { tag: tags.color, color: '#f78c6c' },
  { tag: tags.bool, color: '#f78c6c' },
  { tag: tags.null, color: '#f78c6c' },
  { tag: tags.keyword, color: '#c792ea' },
  { tag: tags.typeName, color: '#ffcb6b' },
  { tag: tags.namespace, color: '#82aaff' },
  { tag: tags.propertyName, color: '#82aaff' },
  { tag: tags.standard(tags.variableName), color: '#ffb01f' },
  { tag: tags.operator, color: '#89ddff' },
  { tag: tags.bracket, color: '#9aa4b8' },
  { tag: tags.punctuation, color: '#9aa4b8' },
])

/** 编辑器外观：与面板同色系，聚焦时不额外描边（边框由外层容器负责） */
export const pineEditorTheme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '12.5px', backgroundColor: '#0f141e', color: '#e8ecf4' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      lineHeight: '1.6',
      overflow: 'auto',
    },
    '.cm-content': { padding: '10px 0', caretColor: '#5b8cff' },
    '.cm-line': { padding: '0 12px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#5b8cff' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(91,140,255,0.28)',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#5c6779', border: 'none', paddingRight: '4px' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)', color: '#9aa4b8' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(255,176,31,0.2)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'rgba(91,140,255,0.22)',
      outline: 'none',
    },
    '.cm-panels': { backgroundColor: '#131824', color: '#e8ecf4' },
    '.cm-textfield': {
      backgroundColor: '#0b0e14',
      color: '#e8ecf4',
      border: '1px solid rgba(255,255,255,0.12)',
    },
    '.cm-button': { backgroundColor: '#1b2230', backgroundImage: 'none', color: '#e8ecf4' },
    '.cm-tooltip': { backgroundColor: '#131824', border: '1px solid rgba(255,255,255,0.1)' },
    '.cm-placeholder': { color: 'rgba(154,164,184,0.55)' },
  },
  { dark: true },
)

/** 编辑器完整扩展集：基础编辑能力 + Pine 语法 + 配色 */
export const pineSetup: Extension[] = [
  lineNumbers(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  drawSelection(),
  history(),
  bracketMatching(),
  closeBrackets(),
  highlightSelectionMatches(),
  indentUnit.of('    '),
  EditorState.tabSize.of(4),
  EditorView.lineWrapping,
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
  placeholder('//@version=6\nindicator("My Indicator", overlay=true)\nplot(close, title="Close")'),
  pineLanguage,
  syntaxHighlighting(pineHighlightStyle),
  pineEditorTheme,
]
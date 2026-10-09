import { DEFAULT_GRIDS, sanitizeGrid, type TapGrid } from './tapZones'

/** 内置三套皮肤；同时允许任意自定义 id —— 配合注入 `.theme-<id>` 的 CSS 变量即可加皮肤，不必改这个类型。 */
export type ReaderTheme = 'light' | 'paper' | 'dark' | (string & {})
/** 内置那三档的 id（自定义皮肤要叠在其中一档之上，所以这个集合要能被类型化地表达）。 */
export type BuiltinSkinId = 'light' | 'paper' | 'dark'
export type ReaderFont = 'song' | 'hei' | 'kai' | 'fangsong' | 'system'
export type ReaderPageMode = 'scroll' | 'paginate'
export type ReaderColumnMode = 'auto' | 'single' | 'double'
export type TtsEngineType = 'webSpeech' | 'edge' | 'custom'

export type ReaderSettings = {
  theme: ReaderTheme
  /**
   * 自定义皮肤的 id 与 CSS。开源项目允许换皮肤，所以给一条真能生效的通道：
   * CSS 落进一个 `<style data-skin>`，id 拼成 `.theme-<id>` 类名（因此必须过白名单字符）。
   * 只存 localStorage —— 这是这台机器自己的外观，不上传服务端，也不进备份包。
   */
  customSkinId: string
  customSkinCss: string
  /** 自定义皮肤叠在哪一套之上（见 `themeClassNames`）：只覆盖用户写到的变量，其余沿用这一套。 */
  customSkinBase: BuiltinSkinId
  fontSize: number
  lineHeight: number
  letterSpacing: number
  paragraphSpacing: number
  /** 首行缩进，单位 em（0 / 1 / 2 三档；2 是中文出版惯例，也是上游 Legado 的默认）。 */
  textIndent: number
  contentPadding: number
  font: ReaderFont
  pageMode: ReaderPageMode
  maxWidth: number
  columnMode: ReaderColumnMode
  sidebarPinned: boolean
  ttsEngine: TtsEngineType
  ttsVoice: string
  ttsSpeed: number
  ttsPitch: number
  ttsAutoNextChapter: boolean
  ttsFilterSymbols: boolean
  ttsCustomUrl?: string
  ttsCustomBody?: string
  ttsCustomMethod?: string
  /**
   * 自定义 HTTP 源的发音人标识，填进 `{{speakVoice}}`。
   * 刻意不与 `ttsVoice` 共用一个字段：ttsVoice 的取值来自 Edge 音色表 / 系统音色表，
   * 切到自定义引擎时把 `zh-CN-XiaoxiaoNeural` 原样发给用户自己的 TTS 服务是错的，
   * 反过来把用户填的标识留着又会污染 Edge / 系统那两个引擎的选择。
   */
  ttsCustomVoice?: string
  /** 附加请求头，JSON 对象文本（例如 `{"Authorization": "Bearer xxx"}`）。第三方 TTS 基本都要一个 key。 */
  ttsCustomHeader?: string
  /**
   * 导入本地 TXT 时用哪条目录规则切章：`auto` 让服务端按正文打分选，
   * `builtin` 强制用服务端原本那条逐行匹配，其余是规则 id（选项来自 `GET /api/books/toc-rules`）。
   * 这是**下一本**的默认值；已经进来的书以自己记着的那条为准（`BookshelfItem.tocRule`）。
   */
  txtTocRule: string
  /**
   * 点击分区（用户 2026-10-04：「可以自定义点击区域范围并设置，自定义管理」）。
   * 两种翻页方式各一张格子表 —— 默认值就是改动前那三区，不改不漂移。
   */
  tapZones: { paginate: TapGrid; scroll: TapGrid }
}

const storageKey = 'legado-reader-settings-v2'
export const defaultReaderSettings: ReaderSettings = {
  theme: 'light',
  customSkinId: '',
  customSkinCss: '',
  customSkinBase: 'light',
  fontSize: 19,
  lineHeight: 1.95,
  letterSpacing: 0,
  paragraphSpacing: 1.15,
  textIndent: 2,
  contentPadding: 80,
  font: 'song',
  pageMode: 'scroll',
  maxWidth: 860,
  columnMode: 'auto',
  sidebarPinned: false,
  ttsEngine: 'edge',
  ttsVoice: 'zh-CN-XiaoxiaoNeural',
  ttsSpeed: 1.0,
  ttsPitch: 1.0,
  ttsAutoNextChapter: true,
  ttsFilterSymbols: true,
  ttsCustomUrl: '',
  ttsCustomBody: '',
  ttsCustomMethod: 'GET',
  ttsCustomVoice: '',
  ttsCustomHeader: '',
  txtTocRule: 'auto',
  tapZones: { paginate: DEFAULT_GRIDS.paginate, scroll: DEFAULT_GRIDS.scroll },
}

export function clampScrollPosition(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

export function scrollPosition(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  return clampScrollPosition(scrollTop / Math.max(1, scrollHeight - clientHeight))
}

/**
 * 数值项的读取一律走这里。以前各字段自己写 `typeof x === 'number' ? Math.min(...)`，
 * 而 `NaN` 也满足 `typeof === 'number'`，`Math.min/max(NaN)` 又返回 `NaN` ——
 * localStorage 里存进一个 NaN（旧版本或被改坏的 JSON）就会让 `--reader-font-size: NaNpx`
 * 这种无效值一路发到 CSS，浏览器整条声明作废，界面表现为"设置突然不生效"。
 */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function parseReaderFont(font: unknown): ReaderFont {
  if (font === 'hei' || font === 'kai' || font === 'fangsong' || font === 'system') return font
  return 'song'
}

export function parsePageMode(mode: unknown): ReaderPageMode {
  return mode === 'paginate' ? 'paginate' : 'scroll'
}

/**
 * 皮肤 id 会被拼成类名 `.theme-<id>`，所以只允许 `[a-z0-9-_]`：
 * 带空格、引号、`>` 之类的输入会把类名拼坏（甚至拼出别的 selector），一律滤掉。
 * 滤完为空就当作"没有自定义皮肤"。
 */
export function parseSkinId(id: unknown): string {
  return typeof id === 'string' ? id.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 32) : ''
}

/** 内置三套皮肤。名字只写一处，两套外壳与「自定义」弹窗共用（各自定义一份迟早会漂移）。 */
export const BUILTIN_SKINS: ReadonlyArray<{ id: BuiltinSkinId; name: string }> = [
  { id: 'light', name: '晓白' },
  { id: 'paper', name: '护眼' },
  { id: 'dark', name: '夜读' },
]

/** 当前可选的皮肤：内置三套 + 填了 CSS 的自定义那一套（没填就不出现在列表里，不摆空控件）。 */
export function availableSkins(settings: ReaderSettings): Array<{ id: string; name: string; builtin: boolean }> {
  const id = parseSkinId(settings.customSkinId)
  const custom = id && (settings.customSkinCss ?? '').trim()
    ? [{ id, name: `自定义（${id}）`, builtin: false }]
    : []
  return [...BUILTIN_SKINS.map(skin => ({ ...skin, builtin: true })), ...custom]
}

/** 自定义皮肤的**叠在哪一套之上**（只认内置三档，别的值退回默认档）。 */
export function parseSkinBase(base: unknown): BuiltinSkinId {
  return BUILTIN_SKINS.some(skin => skin.id === base) ? base as BuiltinSkinId : defaultReaderSettings.customSkinBase
}

/**
 * 皮肤类名列表 —— **自定义皮肤是叠在内置皮肤上的，不是替换它**。
 *
 * 为什么必须叠：用户只写两三条变量（例如只改 `--canvas`）是常见用法，
 * 若此时页面上只有 `.theme-midnight` 这一个类，其余 `--surface / --ink / --line` 全部落空，
 * 界面会直接变成"字和底一个颜色"。叠一层内置皮肤后，没写到的变量沿用那一套的取值，
 * 写到的由注入的 `<style>` 覆盖（它在 `<head>` 末尾，同特异性下后者胜）。
 */
export function themeClassNames(settings: ReaderSettings): string[] {
  const custom = parseSkinId(settings.customSkinId)
  if (custom && settings.theme === custom) return [`theme-${parseSkinBase(settings.customSkinBase)}`, `theme-${custom}`]
  return [`theme-${settings.theme}`]
}

export function parseColumnMode(mode: unknown): ReaderColumnMode {
  if (mode === 'single' || mode === 'double' || mode === 'auto') return mode
  return 'auto'
}

/** 首行缩进只认 0 / 1 / 2 三档：滑杆给中间值（比如 1.3em）在中文里没有对应排版惯例，只会显得没对齐。 */
export const READER_TEXT_INDENTS = [0, 1, 2] as const
export function parseTextIndent(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null
  if (numeric === null) return defaultReaderSettings.textIndent
  return READER_TEXT_INDENTS.reduce((best, option) => (Math.abs(option - numeric) < Math.abs(best - numeric) ? option : best), 0)
}

export function parseMaxWidth(width: unknown): number {
  return Math.round(clampNumber(width, 560, 1400, defaultReaderSettings.maxWidth))
}

export function parseTtsEngine(engine: unknown): TtsEngineType {
  if (engine === 'webSpeech' || engine === 'edge' || engine === 'custom') return engine
  return defaultReaderSettings.ttsEngine
}

/**
 * 本地书目录规则的键：`auto` / `builtin` / 一个规则 id（上游那份表里全是负数）。
 *
 * 有意**不做白名单校验**：合法取值来自服务端 `GET /api/books/toc-rules`，前端硬编码一份迟早漂移。
 * 但形状要挡：这个串会被拼进查询参数与请求体，空串、超长、带符号的都当没填。
 */
export function parseTocRuleKey(value: unknown): string {
  if (typeof value !== 'string') return defaultReaderSettings.txtTocRule
  const trimmed = value.trim()
  return /^(auto|builtin|-?[0-9]{1,6})$/.test(trimmed) ? trimmed : defaultReaderSettings.txtTocRule
}

/**
 * 真正发给 TTS 的发音人。自定义引擎用它自己那一栏（`{{speakVoice}}` 的取值），
 * 其余引擎用音色表选出来的 ttsVoice。Edge 的音色 id 不该出现在用户自建服务的请求里，
 * 反过来也一样 —— 所以两边各存各的，这里只在发出去的一刻汇合。
 */
export function effectiveTtsVoice(settings: ReaderSettings): string {
  if (settings.ttsEngine === 'custom') return (settings.ttsCustomVoice ?? '').trim()
  return settings.ttsVoice?.trim() || defaultReaderSettings.ttsVoice
}

/**
 * "会话身份"：这串里任何一项变了，正在播的音频流就得推倒重来（换引擎、换音色、改语速、
 * 改自定义地址…），否则会出现两条声音叠在一起（用户 2026-09-30「朗读引擎在使用中切换会重音，都启动」）。
 * 语速/语调也在里面：当前这句继续用旧速率播完、下一句才变，读起来是"改了没生效"。
 *
 * `ttsEngine.ts` 的 sessionSettingsKey 与本函数是同一件事的两个名字，所以下面直接引用来一处定义，
 * 避免界面判定与会话判定漂移成两套（漂移过的后果见 AGENTS.md 的跨章竞态那条）。
 */
export function ttsSessionKey(settings: ReaderSettings): string {
  return [
    settings.ttsEngine,
    effectiveTtsVoice(settings),
    settings.ttsSpeed,
    settings.ttsPitch,
    settings.ttsCustomUrl ?? '',
    settings.ttsCustomMethod ?? 'GET',
    settings.ttsCustomBody ?? '',
    settings.ttsCustomHeader ?? '',
  ].join('|')
}

export function loadReaderSettings(): ReaderSettings {
  try {
    const raw = window.localStorage.getItem(storageKey) || window.localStorage.getItem('legado-reader-settings-v1')
    const saved = JSON.parse(raw ?? '{}') as Partial<ReaderSettings> & { font?: string }
    return {
      theme: typeof saved.theme === 'string' && saved.theme.trim() ? saved.theme.trim() : defaultReaderSettings.theme,
      customSkinId: parseSkinId(saved.customSkinId),
      customSkinCss: typeof saved.customSkinCss === 'string' ? saved.customSkinCss : '',
      customSkinBase: parseSkinBase(saved.customSkinBase),
      fontSize: clampNumber(saved.fontSize, 15, 28, defaultReaderSettings.fontSize),
      lineHeight: clampNumber(saved.lineHeight, 1.45, 2.4, defaultReaderSettings.lineHeight),
      letterSpacing: clampNumber(saved.letterSpacing, -.25, 1.5, defaultReaderSettings.letterSpacing),
      paragraphSpacing: clampNumber(saved.paragraphSpacing, .7, 2, defaultReaderSettings.paragraphSpacing),
      textIndent: parseTextIndent(saved.textIndent),
      contentPadding: clampNumber(saved.contentPadding, 20, 120, defaultReaderSettings.contentPadding),
      font: parseReaderFont(saved.font),
      pageMode: parsePageMode(saved.pageMode),
      maxWidth: parseMaxWidth(saved.maxWidth),
      columnMode: parseColumnMode(saved.columnMode),
      sidebarPinned: typeof saved.sidebarPinned === 'boolean' ? saved.sidebarPinned : defaultReaderSettings.sidebarPinned,
      ttsEngine: parseTtsEngine(saved.ttsEngine),
      ttsVoice: typeof saved.ttsVoice === 'string' && saved.ttsVoice.trim() ? saved.ttsVoice : defaultReaderSettings.ttsVoice,
      ttsSpeed: clampNumber(saved.ttsSpeed, 0.5, 3.0, defaultReaderSettings.ttsSpeed),
      ttsPitch: clampNumber(saved.ttsPitch, 0.5, 1.5, defaultReaderSettings.ttsPitch),
      ttsAutoNextChapter: typeof saved.ttsAutoNextChapter === 'boolean' ? saved.ttsAutoNextChapter : defaultReaderSettings.ttsAutoNextChapter,
      ttsFilterSymbols: typeof saved.ttsFilterSymbols === 'boolean' ? saved.ttsFilterSymbols : defaultReaderSettings.ttsFilterSymbols,
      ttsCustomUrl: typeof saved.ttsCustomUrl === 'string' ? saved.ttsCustomUrl : '',
      ttsCustomBody: typeof saved.ttsCustomBody === 'string' ? saved.ttsCustomBody : '',
      ttsCustomMethod: saved.ttsCustomMethod === 'POST' ? 'POST' : 'GET',
      ttsCustomVoice: typeof saved.ttsCustomVoice === 'string' ? saved.ttsCustomVoice : '',
      ttsCustomHeader: typeof saved.ttsCustomHeader === 'string' ? saved.ttsCustomHeader : '',
      txtTocRule: parseTocRuleKey(saved.txtTocRule),
      // 缺项/写错都回落到出厂那张表（不清洗就会点到 undefined 上，表现为"这一格没反应"）
      tapZones: {
        paginate: sanitizeGrid((saved.tapZones as Record<string, unknown> | undefined)?.paginate, DEFAULT_GRIDS.paginate),
        scroll: sanitizeGrid((saved.tapZones as Record<string, unknown> | undefined)?.scroll, DEFAULT_GRIDS.scroll),
      },
    }
  } catch {
    return defaultReaderSettings
  }
}

export const readerFontFamilies: Record<ReaderFont, string> = {
  song: '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", "Noto Serif SC", "Source Han Serif SC", "Songti", STSongti, serif',
  hei: '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "WenQuanYi Micro Hei", "Noto Sans CJK SC", "Source Han Sans SC", "Heiti SC", sans-serif',
  kai: '"Kaiti SC", "STKaiti", "KaiTi", "SimKai", "KaiTi_GB2312", "STKaiti-SC-Regular", "BiauKai", "DFKai-SB", 楷体，楷体_GB2312, serif',
  fangsong: '"FangSong", "STFangsong", "FangSong_GB2312", "STFangsong-SC-Regular", "SimFang", 仿宋，仿宋_GB2312, serif',
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
}

export function getReaderFontFamily(font: ReaderFont): string {
  return readerFontFamilies[font] || readerFontFamilies.song
}

export function saveReaderSettings(settings: ReaderSettings): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(settings))
  } catch {
    // 隐私模式/配额满：保存失败不该在 App 的 effect 里把整棵树炸掉（load 路径有守卫，save 原来没有）
  }
}




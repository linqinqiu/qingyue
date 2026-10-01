/** 内置三套皮肤；同时允许任意自定义 id —— 配合注入 `.theme-<id>` 的 CSS 变量即可加皮肤，不必改这个类型。 */
export type ReaderTheme = 'light' | 'paper' | 'dark' | (string & {})
export type ReaderFont = 'song' | 'hei' | 'kai' | 'fangsong' | 'system'
export type ReaderPageMode = 'scroll' | 'paginate'
export type ReaderColumnMode = 'auto' | 'single' | 'double'
export type TtsEngineType = 'webSpeech' | 'edge' | 'custom'

export type ReaderSettings = {
  theme: ReaderTheme
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
}

const storageKey = 'legado-reader-settings-v2'
export const defaultReaderSettings: ReaderSettings = {
  theme: 'light',
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
    }
  } catch {
    return defaultReaderSettings
  }
}

export const readerFontFamilies: Record<ReaderFont, string> = {
  song: '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", "Noto Serif SC", "Source Han Serif SC", "Songti", STSongti, serif',
  hei: '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "WenQuanYi Micro Hei", "Noto Sans CJK SC", "Source Han Sans SC", "Heiti SC", sans-serif',
  kai: '"Kaiti SC", "STKaiti", "KaiTi", "SimKai", "KaiTi_GB2312", "STKaiti-SC-Regular", "BiauKai", "DFKai-SB", 楷体, 楷体_GB2312, serif',
  fangsong: '"FangSong", "STFangsong", "FangSong_GB2312", "STFangsong-SC-Regular", "SimFang", 仿宋, 仿宋_GB2312, serif',
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
}

export function getReaderFontFamily(font: ReaderFont): string {
  return readerFontFamilies[font] || readerFontFamilies.song
}

export function saveReaderSettings(settings: ReaderSettings): void {
  window.localStorage.setItem(storageKey, JSON.stringify(settings))
}




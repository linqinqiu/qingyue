import { CSSProperties, PointerEvent as ReactPointerEvent, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, BookDetails, Chapter, ReadingProgress, SearchResult, TocRuleOption } from './api'
import { Icon } from './icons'
import { Select } from './Select'
import { calculatePaginationLayout, contentImageUrl, findFirstFullyVisibleParagraphIndex, isAtBottomBoundary, isAtTopBoundary, isInteractiveReaderTarget, isSameSiteAsset, isTapGesture, paginateTapZone, scrollTapZone, swipeDirection, ViewportBounds } from './readerInteractions'
import { clampScrollPosition, defaultReaderSettings, getReaderFontFamily, ReaderSettings, scrollPosition, themeClassNames, ttsSessionKey, TtsEngineType } from './readerSettings'
import { flowAdvance, holdScroll, sectionProgress } from './readerFlow'
import { SourceSwitchModal } from './SourceSwitchModal'
import { cleanAuthor, cleanTitle } from './searchFilters'
import { toast } from './Toast'
import { processChapterForTts, TtsChapterData } from './ttsTextProcessor'
import { ITtsEngine, WebSpeechEngine, HttpAudioTtsEngine, TtsPlayState, TtsSpeakMode, isPlayInterruptedError } from './ttsEngine'
import { TtsSettingsModal, SleepTimerOption } from './TtsSettingsModal'
import { TtsPlayerBar } from './TtsPlayerBar'
import { isTypingTarget, normalizeKey, READER_SHORTCUTS, shortcutFor } from './shortcuts'
import { ReplaceRulesModal } from './ReplaceRulesModal'
import { OfflineCacheModal } from './OfflineCacheModal'
import {
  downloadChaptersToOffline,
  getOfflineChaptersSet,
  putOfflineChapter,
} from './offlineStorage'

export type OpenBook = { details: BookDetails; bookUrl: string; chapters: Chapter[]; progress?: ReadingProgress }

type ReaderScreenProps = {
  openBook: OpenBook
  startIndex: number
  settings: ReaderSettings
  onSettingsChange: (next: ReaderSettings) => void
  onClose: () => void
}

const themes = [
  ['light', '晓白'], ['paper', '护眼'], ['dark', '夜读'],
] as const

function IconButton({ label, icon, onClick, className = '' }: { label: string; icon: Parameters<typeof Icon>[0]['name']; onClick: () => void; className?: string }) {
  return <button className={`reader-icon-button ${className}`} title={label} aria-label={label} onClick={onClick}><Icon name={icon} /></button>
}

function SettingRange({ label, value, min, max, step, onChange, display }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; display: string }) {
  return <label className="setting-range"><span>{label}</span><output>{display}</output><input type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} /></label>
}

function ReaderSettingsControls({
  settings,
  onChange,
  onOpenReplaceRules,
  localBook,
  tocRuleOptions,
  onReparseLocal,
}: {
  settings: ReaderSettings
  onChange: (next: ReaderSettings) => void
  onOpenReplaceRules?: () => void
  /** 当前是导入到本机的书才给；在线书没有"目录规则"这件事。 */
  localBook?: { name: string; tocRule?: string | null } | null
  tocRuleOptions?: TocRuleOption[]
  /** 返回一句给人看的话；null 表示成功（成功的话由 reparseMessage 自己报）。 */
  onReparseLocal?: (ruleKey: string) => Promise<string | null>
}) {
  const update = (value: Partial<ReaderSettings>) => onChange({ ...settings, ...value })
  const [reparseBusy, setReparseBusy] = useState(false)
  const [reparseMessage, setReparseMessage] = useState('')
  const ruleLabelOf = (key?: string | null) =>
    tocRuleOptions?.find(option => option.key === (key || 'auto'))?.label ?? (key || '自动选择（按正文打分）')
  const runReparse = async () => {
    if (!onReparseLocal || reparseBusy) return
    setReparseBusy(true)
    setReparseMessage('')
    const failure = await onReparseLocal(settings.txtTocRule).catch((error: unknown) => error instanceof Error ? error.message : '重切失败')
    setReparseMessage(failure ?? '')
    setReparseBusy(false)
  }
  return <div className="drawer-scroll-content">
    <section className="setting-section"><span className="setting-label">主题</span><div className="theme-grid">{themes.map(([theme, label]) => <button key={theme} className={`theme-choice swatch-${theme} ${settings.theme === theme ? 'selected' : ''}`} onClick={() => update({ theme })}><i>{settings.theme === theme && <Icon name="check" />}</i><small>{label}</small></button>)}</div></section>
    <section className="setting-section"><span className="setting-label">字体</span><label className="font-select"><select value={settings.font} onChange={event => update({ font: event.target.value as ReaderSettings['font'] })}><option value="song">思源宋体</option><option value="hei">黑体 / 苹方</option><option value="kai">华文楷体</option><option value="fangsong">华文仿宋</option><option value="system">系统字体</option></select><Icon name="chevronDown" /></label></section>
    <section className="setting-section compact-settings">
      <span className="setting-label">排版</span>
      <div className="font-stepper"><span>字号</span><button aria-label="减小字号" onClick={() => update({ fontSize: Math.max(15, settings.fontSize - 1) })}>−</button><output>{settings.fontSize}</output><button aria-label="增大字号" onClick={() => update({ fontSize: Math.min(28, settings.fontSize + 1) })}>+</button></div>
      <SettingRange label="字间距" value={settings.letterSpacing} min={-.25} max={1.5} step={.05} display={settings.letterSpacing.toFixed(2)} onChange={letterSpacing => update({ letterSpacing })} />
      <SettingRange label="行间距" value={settings.lineHeight} min={1.45} max={2.4} step={.05} display={settings.lineHeight.toFixed(2)} onChange={lineHeight => update({ lineHeight })} />
      <SettingRange label="段间距" value={settings.paragraphSpacing} min={.7} max={2} step={.05} display={settings.paragraphSpacing.toFixed(2)} onChange={paragraphSpacing => update({ paragraphSpacing })} />
      {/* 首行缩进按"字"给三档，不给滑杆：1.3em 这种中间值在中文排版里没有对应惯例，只会显得没对齐。 */}
      <div className="text-indent-choice" role="group" aria-label="首行缩进">
        <span>首行缩进</span>
        <div className="page-modes indent-modes">
          {([[0, '不缩进'], [1, '1 字'], [2, '2 字']] as const).map(([value, label]) => (
            <button key={value} type="button" className={settings.textIndent === value ? 'selected' : ''} onClick={() => update({ textIndent: value })}>{label}</button>
          ))}
        </div>
      </div>
      <SettingRange label="左右边距" value={settings.contentPadding} min={20} max={120} step={2} display={`${settings.contentPadding}`} onChange={contentPadding => update({ contentPadding })} />
      <SettingRange label="版心宽度" value={settings.maxWidth} min={560} max={1400} step={20} display={`${settings.maxWidth}px`} onChange={maxWidth => update({ maxWidth })} />
    </section>
    <section className="setting-section"><span className="setting-label">翻页方式</span><div className="page-modes"><button className={settings.pageMode === 'scroll' ? 'selected' : ''} onClick={() => update({ pageMode: 'scroll' })}>连续滚动</button><button className={settings.pageMode === 'paginate' ? 'selected' : ''} onClick={() => update({ pageMode: 'paginate' })}>平移分页</button></div><small className="setting-hint">{settings.pageMode === 'paginate' ? '左右轻扫或点击屏幕两侧平滑翻页' : '垂直滚动阅读，点击上下可快速翻滚'}</small></section>
    <section className="setting-section"><span className="setting-label">分栏排版</span><div className="page-modes column-modes"><button className={settings.columnMode === 'auto' ? 'selected' : ''} onClick={() => update({ columnMode: 'auto' })}>自适应</button><button className={settings.columnMode === 'single' ? 'selected' : ''} onClick={() => update({ columnMode: 'single' })}>单栏</button><button className={settings.columnMode === 'double' ? 'selected' : ''} onClick={() => update({ columnMode: 'double' })}>双栏</button></div><small className="setting-hint">{settings.columnMode === 'auto' ? '宽屏 (≥800px) 自动开启双页分栏' : settings.columnMode === 'double' ? '固定双栏双页排版' : '固定单栏排版'}</small></section>
    {/*
      本地书的目录规则（用户 2026-10-02：「txt目录规则…你也没有做啊」—— 原来这一组只在读本地书时
      才出现，于是读完一本在线书的人根本不知道有这件事）。选择器**始终出现**：它写的是"下一本导入的
      本地书用哪条"。只有真正在读本地书时，才多出示一行"这本现在实际用的是哪条"和重切按钮 ——
      那句报的是**实际生效**的那条，不是框里高亮的那条：选了 A 而 A 在这本书上切不出第二个章节时
      服务端会回落，界面不能装作 A 生效了。
    */}
    {(tocRuleOptions?.length ?? 0) > 0 && (
      <section className="setting-section">
        <span className="setting-label">本地书目录</span>
        <Select
          ariaLabel="TXT 目录规则"
          value={settings.txtTocRule}
          options={tocRuleOptions!.map(option => ({ value: option.key, label: option.label, hint: option.example || undefined }))}
          onChange={value => update({ txtTocRule: value })}
        />
        <small className="setting-hint">
          {localBook
            ? `这本《${localBook.name}》现在用的是「${ruleLabelOf(localBook.tocRule)}」。换规则会重切目录并清掉正文缓存，阅读进度按新章数夹住。`
            : '这一条用于**下一本导入的本地书**；已经在读的那本用自己当初切好的规则，在下面那本书的阅读设置里单独换。'}
        </small>
        {!!localBook && onReparseLocal && (
          <button type="button" className="rules-setting-btn" disabled={reparseBusy} onClick={() => void runReparse()}>
            {reparseBusy ? '正在重切目录…' : '按这条规则重新识别目录'}
          </button>
        )}
        {!!reparseMessage && <small className="setting-hint">{reparseMessage}</small>}
      </section>
    )}
    {onOpenReplaceRules && (
      <section className="setting-section">
        <span className="setting-label">内容净化</span>
        <button
          type="button"
          className="rules-setting-btn"
          onClick={onOpenReplaceRules}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            padding: '10px 14px',
            border: '1px solid var(--line)',
            borderRadius: '8px',
            background: 'var(--surface-muted)',
            color: 'var(--ink)',
            cursor: 'pointer',
            fontSize: '14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Icon name="edit" />
            <span>替换净化规则管理</span>
          </div>
          <Icon name="arrowRight" />
        </button>
        <small className="setting-hint">针对当前书籍/书源过滤广告与特定字符</small>
      </section>
    )}
    <button className="reset-settings" onClick={() => onChange({ ...defaultReaderSettings, theme: settings.theme })}>恢复默认设置</button>
  </div>
}

/**
 * 正文按行切成段落。单独抽出来是因为"屏幕上显示的"与"正在朗读的"两件事在切章过渡期间
 * 不是一回事：前者可以继续挂着上一章，后者必须等新章到位，否则朗读会一路读进旧章剩下的段落。
 */
function splitParagraphs(content: string): string[] {
  const rawLines = content.split('\n')
  const result: string[] = []
  for (let i = 0; i < rawLines.length; i++) {
    // 这里的 trim 会连源站自带的 U+3000 全角空格缩进一起剥掉，是故意的：
    // 首行缩进现在由 `--reader-text-indent` 统一控制，留着源站的空格会变成"缩进 + 缩进"，
    // 而且用户把缩进调到 0 时反而还有一截甩尾。
    const trimmed = rawLines[i].trim()
    if (trimmed) {
      result.push(trimmed)
    }
  }
  return result
}

function ReaderContentSkeleton() {
  return (
    <div className="reader-loading-container" aria-label="正在加载正文">
      <div className="reader-loading-badge">
        <span className="reader-loading-spinner-ring" />
        <span>正在从书源拉取正文…</span>
      </div>
      <div className="reader-skeleton-paragraphs">
        <div className="skeleton-line" style={{ width: '100%' }} />
        <div className="skeleton-line" style={{ width: '94%' }} />
        <div className="skeleton-line" style={{ width: '98%' }} />
        <div className="skeleton-line" style={{ width: '91%' }} />
        <div className="skeleton-line" style={{ width: '62%' }} />
        <div className="skeleton-gap" />
        <div className="skeleton-line" style={{ width: '100%' }} />
        <div className="skeleton-line" style={{ width: '96%' }} />
        <div className="skeleton-line" style={{ width: '92%' }} />
        <div className="skeleton-line" style={{ width: '48%' }} />
      </div>
    </div>
  )
}


export interface VirtualChapterListProps {
  chapters: Chapter[]
  activeChapterIndex: number
  cachedUrlsSet?: Set<string>
  onSelect: (index: number) => void
  itemHeight?: number
  overscan?: number
  className?: string
  autoScrollKey?: string | number
}

export function VirtualChapterList({
  chapters,
  activeChapterIndex,
  cachedUrlsSet,
  onSelect,
  itemHeight = 38,
  overscan = 8,
  className = '',
  autoScrollKey,
}: VirtualChapterListProps) {
  const containerRef = useRef<HTMLElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(600)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    setContainerHeight(el.clientHeight || 600)

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (entry.contentRect.height > 0) {
          setContainerHeight(entry.contentRect.height)
        }
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const scrollToActive = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = containerRef.current
    if (!el) return
    const targetIndex = chapters.findIndex(c => c.index === activeChapterIndex)
    if (targetIndex < 0) return

    const itemTop = targetIndex * itemHeight
    const targetScroll = Math.max(0, itemTop - (el.clientHeight - itemHeight) / 2)
    const maxScroll = Math.max(0, chapters.length * itemHeight - el.clientHeight)
    const finalScroll = Math.min(targetScroll, maxScroll)

    if (Math.abs(el.scrollTop - finalScroll) > 1) {
      el.scrollTo({ top: finalScroll, behavior })
    }
  }, [activeChapterIndex, chapters, itemHeight])

  useEffect(() => {
    const timer = window.requestAnimationFrame(() => {
      scrollToActive('auto')
    })
    return () => window.cancelAnimationFrame(timer)
  }, [scrollToActive, autoScrollKey])

  const handleScroll = useCallback((event: React.UIEvent<HTMLElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
  }, [])

  const count = chapters.length
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan)
  const endIndex = Math.min(count, Math.ceil((scrollTop + containerHeight) / itemHeight) + overscan)

  const topSpacer = startIndex * itemHeight
  const bottomSpacer = Math.max(0, (count - endIndex) * itemHeight)

  const visibleChapters = useMemo(() => {
    const items: Array<{ chapter: Chapter; index: number }> = []
    for (let i = startIndex; i < endIndex; i++) {
      if (chapters[i]) {
        items.push({ chapter: chapters[i], index: i })
      }
    }
    return items
  }, [chapters, startIndex, endIndex])

  return (
    <nav
      ref={containerRef}
      className={`reader-chapters ${className}`}
      aria-label="章节目录"
      onScroll={handleScroll}
    >
      {topSpacer > 0 && <div style={{ height: topSpacer }} aria-hidden="true" />}
      {visibleChapters.map(({ chapter }) => {
        if (chapter.isVolume) {
          return (
            <div
              key={`vol-${chapter.index}`}
              style={{ height: itemHeight }}
              className="reader-chapter-volume"
            >
              {chapter.title}
            </div>
          )
        }
        const isCached = cachedUrlsSet ? cachedUrlsSet.has(chapter.url) : false
        return (
          <button
            key={chapter.url}
            style={{ height: itemHeight }}
            className={`reader-chapter-item ${chapter.index === activeChapterIndex ? 'current' : ''} ${isCached ? 'cached' : ''}`}
            onClick={() => onSelect(chapter.index)}
            title={`${chapter.title}${isCached ? '（已离线缓存）' : ''}`}
          >
            <i />
            <span className="reader-chapter-title">{chapter.title}</span>
            {isCached && <span className="chapter-cached-badge" title="已离线缓存" />}
          </button>
        )
      })}
      {bottomSpacer > 0 && <div style={{ height: bottomSpacer }} aria-hidden="true" />}
      {count === 0 && <p className="reader-status" style={{ padding: '24px 0' }}>无匹配章节</p>}
    </nav>
  )
}

export function ReaderScreen({ openBook, startIndex, settings, onSettingsChange, onClose }: ReaderScreenProps) {
  const [currentBook, setCurrentBook] = useState<OpenBook>(openBook)
  /** 可选的目录规则清单（只在读本地书时取一次）；取不到就不摆这一档控件。 */
  const [tocRuleOptions, setTocRuleOptions] = useState<TocRuleOption[]>([])
  /** 这本本地书**实际**用的规则，来自书架记录（设置里那条只是下一本的默认值）。 */
  const [shelfTocRule, setShelfTocRule] = useState<string | null>(null)
  /**
   * 滚动模式的续接窗口（用户 2026-10-02：「章节间的连接还是不对，怎么能跳转呢，不是一体的吗」）。
   * 锚点章之后已经取到正文的章节，渲染在同一个滚动容器里 —— 读完一章是"顶上来"，不是"跳过去"。
   */
  const [flowTail, setFlowTail] = useState<{ chapter: Chapter; content: string }[]>([])
  /** 跨过章边界摘掉顶部那几章时，新锚点该停在屏幕上哪（null = 这一帧不需要校正）。 */
  const pendingKeepRef = useRef<number | null>(null)
  /** 正在"续接推进"（不是用户主动跳章）：这一帧不许 scrollTo，也不许重放进场动画。 */
  const flowAdvanceRef = useRef(false)
  /** 容器 key：只有主动跳章/换源/换书才换；续接推进不换，否则每跨一章白闪一次。 */
  const [flowKey, setFlowKey] = useState(() => openBook.chapters[startIndex]?.url || openBook.bookUrl)
  /** 朗读按段落索引找节点必须限定在锚点那一章里，否则会挑到续接进来的下一章。 */
  const anchorSectionRef = useRef<HTMLElement | null>(null)
  // 滚动回调是长期存在的闭包，读续接窗口要经 ref（与 currentChapterUrlRef 同一手法）
  const flowTailRef = useRef<{ chapter: Chapter; content: string }[]>([])
  flowTailRef.current = flowTail
  const [chapterIndex, setChapterIndex] = useState(startIndex)
  /** 同一个手法：判断"只能往前顶"要读当前的那一个，不能闭包里那个早就过期的数字。 */
  const chapterIndexRef = useRef(chapterIndex)
  chapterIndexRef.current = chapterIndex
  const [content, setContent] = useState('')
  const [loadedChapterUrl, setLoadedChapterUrl] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [chapterQuery, setChapterQuery] = useState('')
  const deferredQuery = useDeferredValue(chapterQuery)
  const [activeDrawer, setActiveDrawer] = useState<'toc' | 'settings' | null>(null)
  const [toolbarsVisible, setToolbarsVisible] = useState(false)
  const [boundaryMessage, setBoundaryMessage] = useState('')
  const [inShelf, setInShelf] = useState(true)
  const [ttsActive, setTtsActive] = useState(false)
  const [ttsPlayState, setTtsPlayState] = useState<TtsPlayState>('idle')
  const [currentChunkIndex, setCurrentChunkIndex] = useState(0)
  const [sleepTimer, setSleepTimer] = useState<SleepTimerOption>('off')
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null)
  const [showTtsSettings, setShowTtsSettings] = useState(false)
  const [showSourceSwitch, setShowSourceSwitch] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else void document.documentElement.requestFullscreen().catch(() => undefined)
  }
  const [showReplaceRules, setShowReplaceRules] = useState(false)
  const [cachedChapterUrls, setCachedChapterUrls] = useState<Set<string>>(new Set())
  const [offlineStatsModal, setOfflineStatsModal] = useState(false)
  const [localSyncing, setLocalSyncing] = useState(false)
  const [localSyncProgress, setLocalSyncProgress] = useState({ current: 0, total: 0 })
  const localSyncAbortRef = useRef<AbortController | null>(null)
  const [customRangeOpen, setCustomRangeOpen] = useState(false)
  const [customRangeStart, setCustomRangeStart] = useState(1)
  const [customRangeEnd, setCustomRangeEnd] = useState(50)
  const [offlineTtsConfirmOpen, setOfflineTtsConfirmOpen] = useState(false)

  const [cacheStatus, setCacheStatus] = useState<{ state: string; cached: number; total: number; error?: string }>({
    state: 'idle',
    cached: 0,
    total: openBook.chapters.length,
  })

  // Pagination states
  const [pageIndex, setPageIndex] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  const [columnWidth, setColumnWidth] = useState(600)
  const [stride, setStride] = useState(640)
  const [isDoubleColumn, setIsDoubleColumn] = useState(false)
  const columnGap = 40

  const currentRef = useRef<{ chapter: Chapter; position: number } | null>(null)
  const timerRef = useRef<number | null>(null)
  const restoredRef = useRef(false)
  const autoPlayNextChapterRef = useRef(false)
  const webSpeechEngineRef = useRef<WebSpeechEngine | null>(null)
  const httpAudioEngineRef = useRef<HttpAudioTtsEngine | null>(null)
  const wakeLockRef = useRef<WakeLockSentinel | null>(null)
  const preloadedContentRef = useRef(new Map<string, string>())
  const preloadingRef = useRef(new Set<string>())
  const lastScrollYRef = useRef(0)
  const pointerStartRef = useRef<{ x: number; y: number; target: EventTarget | null } | null>(null)
  const boundaryTimerRef = useRef<number | null>(null)
  const targetInitialPageRef = useRef<'first' | 'last' | null>(null)
  const initialPagePositionRef = useRef<number | null>(null)
  const wheelTimerRef = useRef<number | null>(null)
  // Ref to the latest playTtsChunk so that async onEnd callbacks always invoke the freshest version,
  // avoiding stale closure issues when cross-chapter auto-play triggers after chapter content reloads.
  const playTtsChunkRef = useRef<(idx: number, mode?: TtsSpeakMode) => void>(() => undefined)

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const chapter = currentBook.chapters[chapterIndex]
  // 异步回调里判断「这一章还是不是当前章」必须用 ref：闭包捕获的 chapter 是发起请求那一刻的。
  const currentChapterUrlRef = useRef('')
  currentChapterUrlRef.current = chapter?.url ?? ''
  const bookName = currentBook.details.name || '书籍正文'

  /** 读本地书时才去取规则清单；取不到就整档不出现，不摆一个点了没反应的控件。 */
  useEffect(() => {
    if (currentBook.details.sourceId !== 'loc_book' || tocRuleOptions.length > 0) return
    void api.tocRules().then(list => setTocRuleOptions(list.options)).catch(() => undefined)
  }, [currentBook.details.sourceId, tocRuleOptions.length])

  /**
   * 换一条目录规则重切这本本地书（用户 2026-10-02：「txt目录规则，这个可以放到阅读设置里」）。
   * 原始文件在导入时就整本留在服务端 `local_books/` 里，所以不必让用户重新上传。
   * 重切后目录、预载缓存、正文缓存要一起换 —— 章节编号整体错位之后留着旧正文等于让读者读到错章。
   */
  const reparseLocalBook = async (ruleKey: string): Promise<string | null> => {
    if (currentBook.details.sourceId !== 'loc_book') return '只有导入到本机的书可以换目录规则'
    try {
      const result = await api.reparseLocalBook(currentBook.details.sourceId, currentBook.bookUrl, ruleKey)
      const chapters = await api.chapters(currentBook.details.sourceId, currentBook.bookUrl)
      const next = { ...currentBook, chapters }
      setCurrentBook(next)
      setChapterIndex(0)
      setShelfTocRule(result.tocRuleUsed)
      preloadedContentRef.current.clear()
      sessionStorage.setItem('legado-open-book-v1', JSON.stringify({ book: next, index: 0 }))
      void syncCacheStatus()
      toast.success(`已按「${result.ruleLabel}」重切出 ${result.totalChapters} 章`)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : '重切目录失败'
    }
  }

  // Sync cache status with bookshelf and local IndexedDB
  const syncCacheStatus = useCallback(async () => {
    try {
      const [shelf, cachedUrlsRes, localOfflineSet] = await Promise.all([
        api.bookshelf().catch(() => []),
        api.getCachedChapters(currentBook.details.sourceId, currentBook.bookUrl).catch(() => null),
        getOfflineChaptersSet(currentBook.details.sourceId, currentBook.bookUrl).catch(() => new Set<string>()),
      ])

      const mergedSet = new Set<string>(localOfflineSet)
      if (cachedUrlsRes?.cachedChapterUrls) {
        for (const u of cachedUrlsRes.cachedChapterUrls) {
          mergedSet.add(u)
        }
      }
      setCachedChapterUrls(mergedSet)

      const item = shelf.find(s => s.sourceId === currentBook.details.sourceId && s.bookUrl === currentBook.bookUrl)
      // 这本本地书"实际用的是哪条目录规则"只有书架记录知道（设置里那条只是下一本的默认值）
      setShelfTocRule(item?.tocRule ?? null)
      if (item) {
        setInShelf(true)
        setCacheStatus(prev => {
          // If state changed to ready or failed, show notification
          if (prev.state === 'caching' && item.cacheState === 'ready') {
            toast.success(`《${bookName}》离线缓存完成（共 ${item.cachedChapters} 章）`)
          } else if (prev.state === 'caching' && item.cacheState === 'failed') {
            toast.warning(`《${bookName}》缓存中断：${item.cacheError || '部分章节未下载'}`)
          }
          return {
            state: item.cacheState,
            cached: Math.max(item.cachedChapters, mergedSet.size),
            total: item.totalChapters || currentBook.chapters.length,
            error: item.cacheError,
          }
        })
      } else {
        setInShelf(false)
      }
    } catch {
      // ignore
    }
  }, [bookName, currentBook.bookUrl, currentBook.chapters.length, currentBook.details.sourceId])

  useEffect(() => {
    void syncCacheStatus()
  }, [syncCacheStatus])

  useEffect(() => {
    if (cacheStatus.state !== 'caching') return
    const timer = window.setInterval(syncCacheStatus, 1200)
    return () => window.clearInterval(timer)
  }, [cacheStatus.state, syncCacheStatus])

  useEffect(() => {
    const title = chapter?.title ? `${bookName} - ${chapter.title} | 青阅` : `${bookName} | 青阅`
    document.title = title
    return () => {
      document.title = '青阅'
    }
  }, [bookName, chapter?.title])

  const filteredChapters = useMemo(() => {
    const query = deferredQuery.trim().toLowerCase()
    if (!query) return currentBook.chapters
    const numQuery = /^\d+$/.test(query) ? parseInt(query, 10) : null
    return currentBook.chapters.filter(item => {
      if (item.title.toLowerCase().includes(query)) return true
      if (numQuery !== null && (item.index === numQuery - 1 || item.index === numQuery)) return true
      return false
    })
  }, [deferredQuery, currentBook.chapters])

  // 目录倒序（借鉴 Legado TocActivity 的 reverse_toc）：仅影响抽屉显示顺序，跳转仍用章节原始 index。
  const [tocReverse, setTocReverse] = useState(false)
  const tocList = useMemo(() => (tocReverse ? filteredChapters.slice().reverse() : filteredChapters), [filteredChapters, tocReverse])
  // 正文配图点击放大（借鉴 Legado「点击预览图片」）：position:fixed 遮罩，点任意处关闭。
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  // 拖动进度条时的临时读数：松手/键盘抬起才真正切章，避免拖一格发一次正文请求。
  const [scrubIndex, setScrubIndex] = useState<number | null>(null)
  const shownChapterIndex = scrubIndex ?? chapterIndex
  const chapterProgress = currentBook.chapters.length > 1 ? (shownChapterIndex / (currentBook.chapters.length - 1)) * 100 : 0

  const isCurrentChapterLoaded = loadedChapterUrl === chapter?.url && !loading
  // content 与 loadedChapterUrl 在 applyContent 里成对写入，所以 loadedChapterUrl 就是
  // "屏幕上这段正文属于哪一章"。切章瞬间它与 chapter 不一致 = 正在过渡：旧正文继续挂着（变暗 +
  // 顶部一条「正在载入」），而不是被骨架屏挖空。
  const isStaleContent = loading && !!content && loadedChapterUrl !== (chapter?.url ?? '')

  const paragraphs = useMemo(() => (content ? splitParagraphs(content) : []), [content])
  // 朗读管线只认"当前这一章已经到位"的正文，过渡期间给空数组，避免读进上一章剩下的段落。
  const ttsParagraphs = useMemo(() => (isCurrentChapterLoaded ? paragraphs : []), [isCurrentChapterLoaded, paragraphs])
  // 过渡期间大标题跟着正文走（挂着上一章的标题），新章名只出现在「正在载入」那条里 ——
  // 标题是新的、正文是旧的，比两者都旧更容易让人以为串了章。
  const shownChapterTitle = isStaleContent ? (currentRef.current?.chapter.title || chapter?.title) : chapter?.title
  const incomingChapterTitle = isStaleContent ? chapter?.title : ''
  // 章末那条「下一章」提示要写出真实章名，跳过卷分组头与没有地址的条目（与预载走同一套判据）。
  const nextChapterTitle = useMemo(() => {
    for (let j = chapterIndex + 1; j < currentBook.chapters.length; j++) {
      const c = currentBook.chapters[j]
      if (!c.isVolume && c.url) return c.title
    }
    return ''
  }, [chapterIndex, currentBook.chapters])

  const persist = useCallback(() => {
    const current = currentRef.current
    if (!current) return
    void api.saveProgress(currentBook.details.sourceId, currentBook.bookUrl, current.chapter.url, current.chapter.index, clampScrollPosition(current.position)).catch(() => undefined)
  }, [currentBook.bookUrl, currentBook.details.sourceId])

  const ttsData: TtsChapterData = useMemo(() => {
    return processChapterForTts(chapter?.title || '', ttsParagraphs, settings.ttsFilterSymbols)
  }, [chapter?.title, ttsParagraphs, settings.ttsFilterSymbols])

  const currentChunk = ttsData.chunks[currentChunkIndex] ?? null
  const activeParagraphIndex = currentChunk ? currentChunk.paragraphIndex : -1
  const activeSentenceText = currentChunk?.text || ''

  const getTtsEngine = useCallback((type: TtsEngineType): ITtsEngine => {
    if (type === 'webSpeech') {
      if (!webSpeechEngineRef.current) {
        webSpeechEngineRef.current = new WebSpeechEngine()
      }
      return webSpeechEngineRef.current
    }
    if (!httpAudioEngineRef.current) {
      httpAudioEngineRef.current = new HttpAudioTtsEngine()
    }
    return httpAudioEngineRef.current
  }, [])

  const stopAllEngines = useCallback(() => {
    webSpeechEngineRef.current?.stop()
    httpAudioEngineRef.current?.stop()
  }, [])

  const stopTts = useCallback(() => {
    stopAllEngines()
    setTtsPlayState('idle')
    setTtsActive(false)
  }, [stopAllEngines])

  const pauseTts = useCallback(() => {
    const engine = getTtsEngine(settings.ttsEngine)
    engine.pause()
    setTtsPlayState('paused')
  }, [getTtsEngine, settings.ttsEngine])

  const resumeTts = useCallback(() => {
    const engine = getTtsEngine(settings.ttsEngine)
    engine.resume()
    setTtsPlayState('playing')
  }, [getTtsEngine, settings.ttsEngine])

  const preloadNextChapter = useCallback((index: number) => {
    let j = index + 1
    while (j < currentBook.chapters.length && (currentBook.chapters[j].isVolume || !currentBook.chapters[j].url)) j++
    const next = currentBook.chapters[j]
    if (!next || !next.url || preloadedContentRef.current.has(next.url) || preloadingRef.current.has(next.url)) return
    preloadingRef.current.add(next.url)
    void api.content(currentBook.details.sourceId, next.url, currentBook.bookUrl)
      .then(result => preloadedContentRef.current.set(next.url, result.content))
      .catch(() => undefined)
      .finally(() => preloadingRef.current.delete(next.url))
  }, [currentBook.bookUrl, currentBook.chapters, currentBook.details.sourceId])

  const preloadPrevChapter = useCallback((index: number) => {
    let j = index - 1
    while (j >= 0 && (currentBook.chapters[j].isVolume || !currentBook.chapters[j].url)) j--
    const prev = currentBook.chapters[j]
    if (!prev || !prev.url || preloadedContentRef.current.has(prev.url) || preloadingRef.current.has(prev.url)) return
    preloadingRef.current.add(prev.url)
    void api.content(currentBook.details.sourceId, prev.url, currentBook.bookUrl)
      .then(result => preloadedContentRef.current.set(prev.url, result.content))
      .catch(() => undefined)
      .finally(() => preloadingRef.current.delete(prev.url))
  }, [currentBook.bookUrl, currentBook.chapters, currentBook.details.sourceId])

  const playTtsChunk = useCallback((idx: number, mode: TtsSpeakMode = 'replace') => {
    if (!ttsData.chunks || ttsData.chunks.length === 0) return
    if (idx < 0) idx = 0
    if (idx >= ttsData.chunks.length) {
      // Reached end of current chapter
      if (sleepTimer === 'chapter') {
        toast.info('已读完本章，睡眠定时已触发')
        stopTts()
        return
      }
      if (settings.ttsAutoNextChapter && chapterIndex < currentBook.chapters.length - 1) {
        persist()
        autoPlayNextChapterRef.current = true
        changeChapter(chapterIndex + 1)
        return
      }
      stopTts()
      return
    }

    setCurrentChunkIndex(idx)
    setTtsPlayState('playing')

    const chunk = ttsData.chunks[idx]
    const engine = getTtsEngine(settings.ttsEngine)

    // 切换引擎或重新开始时必须先停掉所有旧引擎，避免重音
    // mode='continue' 是同一引擎连续播放，不需要停；其他情况都要先停
    if (mode !== 'continue') {
      stopAllEngines()
    }

    engine.speak(
      chunk.text,
      settings,
      () => {
        const nextIdx = idx + 1
        playTtsChunkRef.current(nextIdx, 'continue')
      },
      (err) => {
        if (isPlayInterruptedError(err)) return
        toast.warning(err.message || '朗读中断')
        setTtsPlayState('paused')
      },
      mode,
      { chunkId: `${chapterIndex}:${chunk.globalIndex}`, chapterIndex, paragraphIndex: chunk.paragraphIndex },
    )
    if (settings.ttsEngine !== 'webSpeech') {
      const httpEngine = engine as HttpAudioTtsEngine
      for (let lookahead = 1; lookahead <= 5; lookahead++) {
        const nextIdx = idx + lookahead
        if (nextIdx < ttsData.chunks.length) {
          const nextChunk = ttsData.chunks[nextIdx]
          void httpEngine.prefetch(
            nextChunk.text,
            settings,
            { chunkId: `${chapterIndex}:${nextChunk.globalIndex}`, chapterIndex, paragraphIndex: nextChunk.paragraphIndex },
          )
        }
      }
    }
    if (settings.ttsAutoNextChapter && idx >= ttsData.chunks.length - 5) {
      preloadNextChapter(chapterIndex)
    }
  }, [ttsData, sleepTimer, settings, chapterIndex, currentBook.chapters.length, persist, stopTts, getTtsEngine, preloadNextChapter])

  playTtsChunkRef.current = playTtsChunk

  // 「朗读引擎在使用中切换会重音，都启动」（用户 2026-09-30）。
  // 换引擎/音色/语速时旧引擎不会自己停：WebSpeech 的 utterance.onEnd 与 HttpAudio 的分片 onEnd
  // 都还在推进 currentChunkIndex，新引擎接着出声 → 两条声音叠在一起。这里在"正在播"的当口
  // 把两套引擎一起停掉，再用新设置重读当前分片（'replace' 分支内部会 resetSession 并清掉旧音色的预取队列）。
  // 暂停态刻意不动：resume 只续播现有音频，真正出声的是下一分片的 speak()，
  // 而 HttpAudioTtsEngine.speak 检测到 settings key 变了会自己 resetSession（ttsEngine.ts speak 开头）。
  const ttsVoiceKey = ttsSessionKey(settings)
  const prevTtsVoiceKeyRef = useRef(ttsVoiceKey)
  useEffect(() => {
    const previous = prevTtsVoiceKeyRef.current
    prevTtsVoiceKeyRef.current = ttsVoiceKey
    if (previous === ttsVoiceKey) return
    if (!ttsActive || ttsPlayState !== 'playing') return
    playTtsChunkRef.current(currentChunkIndex, 'replace')
  }, [currentChunkIndex, ttsActive, ttsPlayState, ttsVoiceKey])

  const getInitialTtsChunkIndex = useCallback((): number => {
    if (!ttsData.chunks || ttsData.chunks.length === 0) return 0

    let viewportBounds: ViewportBounds
    if (settings.pageMode === 'paginate') {
      const vEl = viewportRef.current
      if (vEl) {
        const r = vEl.getBoundingClientRect()
        viewportBounds = { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
      } else {
        viewportBounds = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
      }
    } else {
      // In scroll mode, header bar is fixed at 56px height (top boundary)
      const topBarHeight = 56
      viewportBounds = { top: topBarHeight, bottom: window.innerHeight, left: 0, right: window.innerWidth }
    }

    // 1. Check if chapter title <h1> is fully visible on the current screen
    const h1El = document.querySelector(
      settings.pageMode === 'paginate'
        ? '.reader-paginated-column-body h1'
        : '.reading-content h1'
    ) as HTMLElement | null

    if (h1El) {
      const h1Rect = h1El.getBoundingClientRect()
      const isH1FullyVisible =
        h1Rect.top >= viewportBounds.top - 2 &&
        h1Rect.bottom <= viewportBounds.bottom + 2 &&
        h1Rect.left >= viewportBounds.left - 2 &&
        h1Rect.right <= viewportBounds.right + 2
      if (isH1FullyVisible) {
        const titleChunk = ttsData.chunks.find(c => c.paragraphIndex === -1)
        if (titleChunk) return titleChunk.globalIndex
      }
    }

    // 2. Query all paragraph elements with data-paragraph-index
    //    滚动模式要限定在**锚点那一章**里：连续流里续接进来的下一章也带 data-paragraph-index，
    //    从 0 重新编号，全局查会挑到别的章（朗读起始句与高亮跟读都会错段）。
    const paragraphEls = Array.from(
      document.querySelectorAll<HTMLElement>(
        settings.pageMode === 'paginate'
          ? '.reader-paginated-column-body [data-paragraph-index]'
          : '.reading-content .reader-flow-chapter:first-of-type [data-paragraph-index]'
      )
    )

    if (paragraphEls.length === 0) return 0

    const paragraphItems = paragraphEls.map(el => {
      const pIdx = parseInt(el.getAttribute('data-paragraph-index') || '0', 10)
      const r = el.getBoundingClientRect()
      return {
        index: pIdx,
        rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      }
    })

    const targetPIndex = findFirstFullyVisibleParagraphIndex(paragraphItems, viewportBounds)

    const targetChunk = ttsData.chunks.find(c => c.paragraphIndex === targetPIndex)
    return targetChunk ? targetChunk.globalIndex : 0
  }, [ttsData.chunks, settings.pageMode])

  const toggleTts = useCallback(() => {
    if (!ttsActive) {
      if (typeof navigator !== 'undefined' && !navigator.onLine && settings.ttsEngine !== 'webSpeech') {
        setOfflineTtsConfirmOpen(true)
        return
      }
      setTtsActive(true)
      const startIdx = getInitialTtsChunkIndex()
      playTtsChunk(startIdx)
    } else if (ttsPlayState === 'playing') {
      pauseTts()
    } else if (ttsPlayState === 'paused') {
      resumeTts()
    } else {
      playTtsChunk(currentChunkIndex)
    }
  }, [ttsActive, ttsPlayState, playTtsChunk, currentChunkIndex, pauseTts, resumeTts, getInitialTtsChunkIndex, settings.ttsEngine])

  const handleParagraphClick = useCallback((pIdx: number) => {
    // Only jump to paragraph if TTS is already active; don't auto-start reading on arbitrary clicks
    if (!ttsActive) return
    const targetChunk = ttsData.chunks.find(c => c.paragraphIndex === pIdx)
    if (targetChunk) {
      playTtsChunk(targetChunk.globalIndex)
    }
  }, [ttsData.chunks, ttsActive, playTtsChunk])

  const handlePrevChunk = useCallback(() => {
    const prevIdx = Math.max(0, currentChunkIndex - 1)
    playTtsChunk(prevIdx)
  }, [currentChunkIndex, playTtsChunk])

  const handleNextChunk = useCallback(() => {
    const nextIdx = Math.min(ttsData.chunks.length - 1, currentChunkIndex + 1)
    playTtsChunk(nextIdx)
  }, [currentChunkIndex, ttsData.chunks.length, playTtsChunk])

  const handlePrevChapterTts = useCallback(() => {
    if (chapterIndex > 0) {
      persist()
      autoPlayNextChapterRef.current = true
      changeChapter(chapterIndex - 1)
    }
  }, [chapterIndex, persist])

  const handleNextChapterTts = useCallback(() => {
    if (chapterIndex < currentBook.chapters.length - 1) {
      persist()
      autoPlayNextChapterRef.current = true
      changeChapter(chapterIndex + 1)
    }
  }, [chapterIndex, currentBook.chapters.length, persist])

  const renderParagraphContent = (rawLine: string, pIndex: number) => {
    if (!ttsActive || activeParagraphIndex !== pIndex || !currentChunk) {
      return rawLine
    }
    const sentenceText = currentChunk.text
    const sIdx = rawLine.indexOf(sentenceText)
    if (sIdx >= 0) {
      const before = rawLine.slice(0, sIdx)
      const after = rawLine.slice(sIdx + sentenceText.length)
      return <>
        {before}
        <span className="tts-active-sentence">{sentenceText}</span>
        {after}
      </>
    }
    return rawLine
  }

  /** 正文块渲染：`![图片](url)` 占位行还原成走代理的 `<img>`，其余仍是段落。 */
  const renderContentBlock = (line: string, index: number, owner?: Chapter) => {
    const image = contentImageUrl(line)
    if (image) {
      // 本地 EPUB 的插图本来就是站内地址，再过一道图片代理是错的（那一层只收 http(s)）
      // Referer 用**这一段属于哪一章**：续接进来的下一章的图，不能拿锚点章的地址当来源
      const referer = (owner ?? chapter)?.url
      const src = isSameSiteAsset(image) ? image : api.bookImage(image, referer)
      return (
        <figure key={index} className="reader-paragraph-image">
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            role="button"
            tabIndex={0}
            style={{ cursor: 'zoom-in' }}
            onClick={event => { event.stopPropagation(); setLightboxSrc(src) }}
            onError={event => { event.currentTarget.closest('figure')?.setAttribute('hidden', '') }}
          />
        </figure>
      )
    }
    return (
      <p
        key={index}
        data-paragraph-index={index}
        className={`reader-paragraph ${ttsActive && activeParagraphIndex === index ? 'tts-active-paragraph' : ''}`}
        onClick={() => handleParagraphClick(index)}
      >
        {renderParagraphContent(line, index)}
      </p>
    )
  }

  const showBoundaryNotice = useCallback((msg: string) => {
    setBoundaryMessage(msg)
    if (boundaryTimerRef.current !== null) window.clearTimeout(boundaryTimerRef.current)
    boundaryTimerRef.current = window.setTimeout(() => {
      boundaryTimerRef.current = null
      setBoundaryMessage('')
    }, 1400)
  }, [])

  const changeChapter = useCallback((rawIndex: number, targetPage: 'first' | 'last' | 'auto' = 'auto') => {
    if (rawIndex < 0 || rawIndex >= currentBook.chapters.length || rawIndex === chapterIndex) {
      if (rawIndex < 0 || rawIndex >= currentBook.chapters.length) {
        showBoundaryNotice(rawIndex < 0 ? '已是第一章' : '已是最后一章')
      }
      return
    }
    // 卷分组头（isVolume，无正文地址）不能当作章节打开：沿移动方向跳到最近的真实章节。
    let nextIndex = rawIndex
    const dir = rawIndex > chapterIndex ? 1 : -1
    while (nextIndex >= 0 && nextIndex < currentBook.chapters.length && currentBook.chapters[nextIndex].isVolume) {
      nextIndex += dir
    }
    if (nextIndex < 0 || nextIndex >= currentBook.chapters.length || nextIndex === chapterIndex) {
      if (nextIndex < 0 || nextIndex >= currentBook.chapters.length) {
        showBoundaryNotice(nextIndex < 0 ? '已是第一章' : '已是最后一章')
      }
      return
    }
    persist()
    if (!autoPlayNextChapterRef.current) {
      stopTts()
    } else if (settings.ttsEngine === 'webSpeech') {
      stopAllEngines()
    }
    targetInitialPageRef.current = targetPage === 'auto' ? null : targetPage
    // 既不清 content 也不清 loadedChapterUrl：这两个值成对描述"屏幕上挂的是哪一章"。
    // 历史上这里两者都清，是为了杜绝切章瞬间朗读误读上一章旧正文（AGENTS.md 的跨章竞态守卫）——
    // 那个目的现在由 ttsParagraphs 承担（过渡期间给朗读管线空数组），视觉侧不必跟着挖空。
    // 清 content 的代价就是用户 2026-09-30 说的"章节之间过渡没有做好"：整页先白一闪。
    setLoading(true)
    setChapterIndex(nextIndex)
    setActiveDrawer(null)
    // 主动跳章与"顶上来"是两回事：这里要换容器 key（重挂 + 重放一次进场动画），
    // 并把续接推进的状态清干净，否则上一次跨章的补偿会被用错地方。
    flowAdvanceRef.current = false
    pendingKeepRef.current = null
    // 续接窗口跟着跳：留着旧位置后面那几章的话，这一帧会在新的锚点下面挂出毫不相干的章节。
    setFlowTail([])
    setFlowKey(currentBook.chapters[nextIndex]?.url ?? `jump-${nextIndex}`)
  }, [chapterIndex, currentBook.chapters.length, persist, settings.ttsEngine, showBoundaryNotice, stopTts, stopAllEngines])

  // 滚动模式的"滚到底再往下推一下就进下一章"。判据必须是"已经触底 + 继续向下滚"，
  // 只按位置阈值会在正常阅读途中翻章；1.2 秒冷却挡住一次惯性滚动连跳多章。
  // 监听挂在 window 上而不是正文元素上：版心两侧那段空白同样会滚轮，挂在正文里等于
  // "鼠标停在边缘滚就没反应"。
  const autoNextAtRef = useRef(0)
  useEffect(() => {
    if (settings.pageMode !== 'scroll') return
    const onWindowWheel = (event: WheelEvent) => {
      if (event.deltaY <= 0 || loading || !content) return
      if (chapterIndex >= currentBook.chapters.length - 1) return
      // 连续流里"下一章"本来就挂在下面，跨章由滚动回调顶窗口；这里再翻一次就是重复跳章
      if (flowTailRef.current.length > 0) return
      const doc = document.documentElement
      if (doc.scrollHeight - (window.scrollY + window.innerHeight) > 4) return
      const now = Date.now()
      if (now - autoNextAtRef.current < 1200) return
      autoNextAtRef.current = now
      changeChapter(chapterIndex + 1, 'first')
    }
    window.addEventListener('wheel', onWindowWheel, { passive: true })
    return () => window.removeEventListener('wheel', onWindowWheel)
  }, [changeChapter, chapterIndex, content, currentBook.chapters.length, loading, settings.pageMode])

  const toggleShelf = async () => {
    if (inShelf) {
      if (!confirm(`移出“${bookName}”将清除书架、阅读进度和缓存封面，确定继续吗？`)) return
      await api.removeFromBookshelf(currentBook.details.sourceId, currentBook.bookUrl)
      setInShelf(false)
      toast.info(`《${bookName}》已移出书架`)
      return
    }
    const fallbackCover = currentBook.details.coverUrl || currentBook.details.alternateSources?.find(s => s.coverUrl?.trim())?.coverUrl?.trim()
    await api.addToBookshelf({
      sourceId: currentBook.details.sourceId,
      bookUrl: currentBook.bookUrl,
      name: bookName,
      author: currentBook.details.author,
      tocUrl: currentBook.details.tocUrl,
      coverUrl: fallbackCover || undefined,
      alternateSources: currentBook.details.alternateSources,
    })
    setInShelf(true)
    toast.success(`《${bookName}》已加入书架`)
  }

  const handleCacheBook = async () => {
    await handleCacheRange('all')
  }

  const handleCacheRange = async (mode: 'all' | 'custom', start?: number, end?: number) => {
    let s = chapterIndex
    let count: number | undefined
    let e: number | undefined

    if (mode === 'all') {
      s = 0
      count = undefined
    } else {
      s = Math.max(0, (start ?? 1) - 1)
      e = Math.max(s, (end ?? currentBook.chapters.length) - 1)
      count = undefined
    }

    try {
      await api.cacheBookshelfRange({
        sourceId: currentBook.details.sourceId,
        bookUrl: currentBook.bookUrl,
        startIndex: s,
        endIndex: e,
        count,
      })
      toast.success(mode === 'all' ? '已加入全本离线缓存队列' : `已开始缓存第 ${s + 1} ~ ${(e ?? 0) + 1} 章`)
      setCacheStatus(prev => ({ ...prev, state: 'caching', error: undefined }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '发起缓存失败')
    }
  }

  const handleSyncToLocal = async (rangeChapters?: Chapter[]) => {
    const targetChapters = rangeChapters || currentBook.chapters.slice(chapterIndex, chapterIndex + 50)
    localSyncAbortRef.current?.abort()
    const controller = new AbortController()
    localSyncAbortRef.current = controller

    setLocalSyncing(true)
    setLocalSyncProgress({ current: 0, total: targetChapters.length })

    try {
      const res = await downloadChaptersToOffline(
        currentBook.details.sourceId,
        currentBook.bookUrl,
        targetChapters,
        async (chUrl) => {
          return api.content(currentBook.details.sourceId, chUrl, currentBook.bookUrl, controller.signal)
        },
        (comp, tot) => {
          setLocalSyncProgress({ current: comp, total: tot })
        },
        controller.signal
      )
      if (!controller.signal.aborted) {
        toast.success(`离线同步完成：成功 ${res.successful} 章，跳过/已缓存 ${targetChapters.length - res.failed - res.successful} 章`)
        const offlineSet = await getOfflineChaptersSet(currentBook.details.sourceId, currentBook.bookUrl)
        setCachedChapterUrls(offlineSet)
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        toast.error('离线同步中断')
      }
    } finally {
      if (!controller.signal.aborted) {
        setLocalSyncing(false)
      }
    }
  }

  const handleCancelCache = async () => {
    try {
      await api.cancelBookCache(currentBook.details.sourceId, currentBook.bookUrl)
      setCacheStatus(prev => ({ ...prev, state: 'failed', error: '已取消缓存' }))
      toast.info(`已取消《${bookName}》的离线缓存`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '无法取消缓存')
    }
  }

  const handleSwitchSource = async (chosen: { result: SearchResult; chapters: Chapter[]; targetChapterIndex: number }) => {
    const details = await api.details(chosen.result.sourceId, chosen.result.bookUrl)
    const fallbackCover = details.coverUrl?.trim() ||
      chosen.result.coverUrl?.trim() ||
      currentBook.details.coverUrl?.trim() ||
      currentBook.details.alternateSources?.find(s => s.coverUrl?.trim())?.coverUrl?.trim()

    const safeDetails: BookDetails = {
      ...details,
      name: cleanTitle(details.name?.trim() || currentBook.details.name || '未知书名') || currentBook.details.name,
      author: cleanAuthor(details.author?.trim() || currentBook.details.author) || currentBook.details.author,
      coverUrl: fallbackCover || undefined,
      intro: details.intro || currentBook.details.intro,
      alternateSources: currentBook.details.alternateSources,
    }

    await api.switchBookshelfSource({
      oldSourceId: currentBook.details.sourceId,
      oldBookUrl: currentBook.bookUrl,
      book: {
        sourceId: safeDetails.sourceId,
        bookUrl: chosen.result.bookUrl,
        name: safeDetails.name,
        author: safeDetails.author,
        tocUrl: safeDetails.tocUrl,
        coverUrl: safeDetails.coverUrl,
      },
      alternateSources: currentBook.details.alternateSources,
    })

    const newOpenBook: OpenBook = {
      details: safeDetails,
      bookUrl: chosen.result.bookUrl,
      chapters: chosen.chapters,
      progress: {
        sourceId: safeDetails.sourceId,
        bookUrl: chosen.result.bookUrl,
        chapterUrl: chosen.chapters[chosen.targetChapterIndex]?.url || '',
        chapterIndex: chosen.targetChapterIndex,
        scrollPosition: 0,
        updatedAt: Date.now(),
      },
    }

    setCurrentBook(newOpenBook)
    setChapterIndex(chosen.targetChapterIndex)
    preloadedContentRef.current.clear()
    sessionStorage.setItem('legado-open-book-v1', JSON.stringify({ book: newOpenBook, index: chosen.targetChapterIndex }))
  }

  // Load chapter content.
  // 用 useLayoutEffect 而不是 useEffect：预载命中时（下一章往往已经在 preloadedContentRef 里）
  // 正文在浏览器绘制之前就换好了，不会先画一帧骨架屏再画正文；真在飞的场合骨架屏照旧出现。
  useLayoutEffect(() => {
    let cancelled = false
    setLoading(true)
    setMessage('')
    const applyContent = (nextContent: string) => {
      if (cancelled) return
      setContent(nextContent)
      setLoadedChapterUrl(chapter.url)
      // 续接推进时 position 给 null：下面那个定位 effect 见到 null 就直接返回，
      // 于是"跨章"不再伴随任何 scrollTo —— 这正是"不是一体的吗"要的答案。
      const advancing = flowAdvanceRef.current
      flowAdvanceRef.current = false
      const position = advancing ? null
        : (!restoredRef.current && chapter.index === startIndex ? currentBook.progress?.scrollPosition ?? 0 : 0)
      restoredRef.current = true
      currentRef.current = { chapter, position: position ?? 0 }
      initialPagePositionRef.current = position
      setLoading(false)
    }
    const preloaded = preloadedContentRef.current.get(chapter.url)
    if (preloaded) {
      applyContent(preloaded)
    } else {
      void api.content(currentBook.details.sourceId, chapter.url, currentBook.bookUrl)
        .then(result => applyContent(result.content))
        .catch(error => {
          if (!cancelled) setMessage(error instanceof Error ? error.message : '无法读取正文')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }
    return () => {
      cancelled = true
    }
  }, [chapter, currentBook.bookUrl, currentBook.details.sourceId, currentBook.progress?.scrollPosition, startIndex])

  /**
   * 续接窗口：把锚点章之后的 1~2 章挂到下面（只在滚动模式）。
   * 优先吃预载缓存 —— `preloadNextChapter` 在本章读到 70% 时就把下一章取回来了，
   * 所以正常情况下这一趟零请求。
   */
  useEffect(() => {
    if (settings.pageMode !== 'scroll' || !content) return
    // 锚点还没换上这一章的正文时不许重排窗口：那会在"上一章的字还挂着"的那一两帧里
    // 把已经续接进来的那一章从 DOM 中摘走，画面凭空少一章 —— 正是要消灭的"跳"。
    // 宁可让那一章短暂地出现两次（重复的那份在视口下方，看不见），也不许它消失。
    if (chapter && loadedChapterUrl !== chapter.url) return
    let cancelled = false
    void (async () => {
      const wanted: Chapter[] = []
      for (let i = chapterIndex + 1; i < currentBook.chapters.length && wanted.length < 2; i += 1) {
        const candidate = currentBook.chapters[i]
        if (!candidate || candidate.isVolume || !candidate.url) continue
        wanted.push(candidate)
      }
      const filled: { chapter: Chapter; content: string }[] = []
      for (const candidate of wanted) {
        const cached = preloadedContentRef.current.get(candidate.url)
        if (cached) {
          filled.push({ chapter: candidate, content: cached })
          continue
        }
        const result = await api.content(currentBook.details.sourceId, candidate.url, currentBook.bookUrl).catch(() => null)
        if (!result || cancelled) break
        preloadedContentRef.current.set(candidate.url, result.content)
        filled.push({ chapter: candidate, content: result.content })
      }
      if (!cancelled) setFlowTail(filled)
    })()
    return () => { cancelled = true }
  }, [settings.pageMode, chapterIndex, chapter?.url, content, loadedChapterUrl, currentBook.bookUrl, currentBook.chapters, currentBook.details.sourceId])

  // Scroll mode layout effect to restore position or jump to start/end
  useLayoutEffect(() => {
    if (settings.pageMode !== 'scroll' || loading || !content) return
    // 续接推进：摘掉了顶部那几章，滚动位置要按"新锚点现在量出来的偏移"校正回去。
    // 放在这个 layout effect 里是因为它在浏览器绘制之前 —— 校正必须和摘除同一帧完成，
    // 否则用户看到的就是画面往上跳一截（那正是要消灭的症状，只是换了个触发点）。
    if (pendingKeepRef.current !== null) {
      const keep = pendingKeepRef.current
      pendingKeepRef.current = null
      const first = document.querySelector<HTMLElement>('.reading-content .reader-flow-chapter')
      if (first) {
        const next = holdScroll(window.scrollY, first.getBoundingClientRect().top, keep)
        lastScrollYRef.current = next
        window.scrollTo({ top: next, behavior: 'auto' })
      }
      return
    }
    const targetMode = targetInitialPageRef.current
    const initialPos = initialPagePositionRef.current
    targetInitialPageRef.current = null
    initialPagePositionRef.current = null

    const scrollToTarget = () => {
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      let targetScroll = 0
      if (targetMode === 'last') {
        targetScroll = maxScroll
      } else if (targetMode === 'first') {
        targetScroll = 0
      } else if (initialPos !== null) {
        targetScroll = Math.round(maxScroll * initialPos)
      } else {
        return
      }
      lastScrollYRef.current = targetScroll
      window.scrollTo({ top: targetScroll, behavior: 'auto' })
    }

    scrollToTarget()
    const rafId = window.requestAnimationFrame(scrollToTarget)
    return () => window.cancelAnimationFrame(rafId)
  }, [content, loading, settings.pageMode])

  // Pagination measurement
  const measurePagination = useCallback(() => {
    const viewport = viewportRef.current
    const body = bodyRef.current
    if (!viewport || !body) return
    const w = viewport.clientWidth
    if (w <= 0) return
    if (loading || !content) return

    const totalScrollWidth = body.scrollWidth
    const layout = calculatePaginationLayout({
      viewportWidth: w,
      totalScrollWidth,
      columnGap,
      columnMode: settings.columnMode,
    })

    setColumnWidth(layout.columnWidth)
    setStride(layout.stride)
    setIsDoubleColumn(layout.isDoubleColumn)
    setPageCount(layout.pageCount)

    if (targetInitialPageRef.current === 'last') {
      targetInitialPageRef.current = null
      initialPagePositionRef.current = null
      setPageIndex(layout.pageCount - 1)
    } else if (targetInitialPageRef.current === 'first') {
      targetInitialPageRef.current = null
      initialPagePositionRef.current = null
      setPageIndex(0)
    } else if (initialPagePositionRef.current !== null) {
      const pos = initialPagePositionRef.current
      initialPagePositionRef.current = null
      const target = Math.min(layout.pageCount - 1, Math.max(0, Math.round(pos * (layout.pageCount - 1))))
      setPageIndex(target)
    } else {
      setPageIndex(curr => Math.min(curr, layout.pageCount - 1))
    }
  }, [columnGap, content, loading, settings.columnMode])

  useLayoutEffect(() => {
    if (settings.pageMode !== 'paginate') return
    if (loading || !content) return
    measurePagination()
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(() => measurePagination())
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [
    settings.pageMode,
    content,
    loading,
    settings.fontSize,
    settings.lineHeight,
    settings.letterSpacing,
    settings.paragraphSpacing,
    settings.textIndent,
    settings.contentPadding,
    settings.maxWidth,
    settings.columnMode,
    settings.sidebarPinned,
    settings.font,
    measurePagination,
  ])

  const goNextPage = useCallback(() => {
    if (pageIndex < pageCount - 1) {
      setPageIndex(p => p + 1)
    } else {
      // 已到本章最后一页，尝试跳转到下一章
      // 双栏模式下，如果当前页是本章最后一页且处于右栏位置，
      // 需要确保下一章内容能正确衔接
      changeChapter(chapterIndex + 1, 'first')
    }
  }, [chapterIndex, changeChapter, pageCount, pageIndex])

  const goPrevPage = useCallback(() => {
    if (pageIndex > 0) {
      setPageIndex(p => p - 1)
    } else {
      changeChapter(chapterIndex - 1, 'last')
    }
  }, [chapterIndex, changeChapter, pageIndex])

  // Sync scroll / page progress
  useEffect(() => {
    if (settings.pageMode !== 'scroll') return
    let rafId: number | null = null
    const onScroll = () => {
      if (rafId !== null) return
      rafId = window.requestAnimationFrame(() => {
        rafId = null
        const current = currentRef.current
        if (!current) return
        const currentY = window.scrollY
        const scrollDelta = currentY - lastScrollYRef.current
        if (currentY > 72 && scrollDelta > 12) {
          setToolbarsVisible(false)
        } else if (scrollDelta < -8) {
          setToolbarsVisible(true)
        }
        lastScrollYRef.current = currentY
        const scrollHeight = document.documentElement.scrollHeight
        const clientHeight = window.innerHeight
        if (settings.pageMode === 'scroll') {
          // 进度仍然按"这一章读了多少"算（契约不变，分母从整篇换成锚点那一节），
          // 顺便判断该不该把窗口往前顶一格 —— 顶格是摘掉顶部那些章 + 补偿滚动，不是 scrollTo。
          const nodes = [...document.querySelectorAll<HTMLElement>('.reading-content .reader-flow-chapter')]
          if (nodes.length > 0) {
            const boxes = nodes.map(node => ({ top: currentY + node.getBoundingClientRect().top, height: node.offsetHeight }))
            current.position = clampScrollPosition(sectionProgress(boxes[0], currentY, clientHeight))
            // 一帧之内可能跨过多章（拖滚动条、程序化跳转），所以是一次顶过去若干节而不是逐节数。
            const advance = nodes.length > 1 ? flowAdvance(boxes, currentY) : null
            const target = advance ? flowTailRef.current[advance.lead - 1] : undefined
            if (advance && target) {
              const targetIndex = currentBook.chapters.findIndex(item => item.url === target.chapter.url)
              if (targetIndex > chapterIndexRef.current) {
                pendingKeepRef.current = advance.keepTop
                flowAdvanceRef.current = true
                persist()
                setChapterIndex(targetIndex)
              }
            }
          } else {
            current.position = scrollPosition(currentY, scrollHeight, clientHeight)
          }
        } else {
          current.position = scrollPosition(currentY, scrollHeight, clientHeight)
        }
        if (current.position >= 0.7) {
          preloadNextChapter(current.chapter.index)
        } else if (current.position <= 0.3) {
          preloadPrevChapter(current.chapter.index)
        }
        if (timerRef.current === null) {
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null
            persist()
          }, 1200)
        }
      })
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') persist()
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('scroll', onScroll)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      persist()
    }
  }, [persist, preloadNextChapter, preloadPrevChapter, settings.pageMode, currentBook.chapters])

  useEffect(() => {
    if (settings.pageMode !== 'paginate') return
    const position = pageCount > 1 ? pageIndex / (pageCount - 1) : 0
    const current = currentRef.current
    if (current && chapter) {
      current.position = position
      if (position >= 0.7) {
        preloadNextChapter(chapter.index)
      } else if (position <= 0.3) {
        preloadPrevChapter(chapter.index)
      }
      if (timerRef.current === null) {
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null
          persist()
        }, 1200)
      }
    }
  }, [chapter, pageCount, pageIndex, persist, preloadNextChapter, preloadPrevChapter, settings.pageMode])

  // Stop TTS on unmount
  useEffect(() => () => {
    stopAllEngines()
  }, [stopAllEngines])

  // Chapter content load effect for auto continuous next chapter
  useEffect(() => {
    if (!content || loading || loadedChapterUrl !== chapter?.url) return
    if (autoPlayNextChapterRef.current) {
      autoPlayNextChapterRef.current = false
      setTtsActive(true)
      playTtsChunkRef.current(0, 'continue')
    }
  }, [content, loading, loadedChapterUrl, chapter?.url])

  // Sleep Timer countdown effect
  useEffect(() => {
    if (sleepTimer === 'off' || sleepTimer === 'chapter') {
      setRemainingSeconds(null)
      return
    }
    const totalSecs = parseInt(sleepTimer, 10) * 60
    setRemainingSeconds(totalSecs)
    const timer = window.setInterval(() => {
      setRemainingSeconds(prev => {
        if (prev === null || prev <= 1) {
          window.clearInterval(timer)
          toast.info('睡眠定时时间到，已停止朗读')
          stopTts()
          return 0
        }
        return prev - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [sleepTimer, stopTts])

  // MediaSession API integration
  useEffect(() => {
    if (!('mediaSession' in navigator) || !ttsActive) return
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chapter?.title || '正文朗读',
        artist: currentBook.details.author || currentBook.details.name,
        album: bookName,
        artwork: currentBook.details.coverUrl ? [{ src: currentBook.details.coverUrl }] : undefined,
      })
      navigator.mediaSession.playbackState = ttsPlayState === 'playing' ? 'playing' : 'paused'

      navigator.mediaSession.setActionHandler('play', () => resumeTts())
      navigator.mediaSession.setActionHandler('pause', () => pauseTts())
      navigator.mediaSession.setActionHandler('previoustrack', () => handlePrevChunk())
      navigator.mediaSession.setActionHandler('nexttrack', () => handleNextChunk())
    } catch {
      // Ignore mediaSession errors
    }
  }, [ttsActive, ttsPlayState, chapter?.title, bookName, currentBook.details.author, currentBook.details.coverUrl, resumeTts, pauseTts, handlePrevChunk, handleNextChunk])

  // Wake Lock API integration
  useEffect(() => {
    if (!('wakeLock' in navigator)) return
    if (ttsActive && ttsPlayState === 'playing') {
      navigator.wakeLock.request('screen').then(lock => {
        wakeLockRef.current = lock
      }).catch(() => undefined)
    } else {
      wakeLockRef.current?.release().catch(() => undefined)
      wakeLockRef.current = null
    }
    return () => {
      wakeLockRef.current?.release().catch(() => undefined)
      wakeLockRef.current = null
    }
  }, [ttsActive, ttsPlayState])

  // Auto-scroll / highlight follower effect
  useEffect(() => {
    if (!ttsActive || activeParagraphIndex < 0) return

    if (settings.pageMode === 'scroll') {
      // 同上：高亮跟读只在锚点那一章里找，不然会滚到续接进来的下一章的同名段落
      const el = anchorSectionRef.current?.querySelector(`[data-paragraph-index="${activeParagraphIndex}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    } else if (settings.pageMode === 'paginate') {
      const el = bodyRef.current?.querySelector(`[data-paragraph-index="${activeParagraphIndex}"]`) as HTMLElement | null
      if (el && stride > 0) {
        const targetPage = Math.min(pageCount - 1, Math.max(0, Math.floor(el.offsetLeft / stride)))
        setPageIndex(targetPage)
      }
    }
  }, [activeParagraphIndex, ttsActive, settings.pageMode, stride, pageCount])

  useEffect(() => () => { if (boundaryTimerRef.current !== null) window.clearTimeout(boundaryTimerRef.current) }, [])

  // 快捷键：动作与界面上那张「快捷键」表都取自 web/src/shortcuts.ts 同一份定义。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = normalizeKey(event)
      if (!key || isTypingTarget(event.target, key)) return
      const hit = shortcutFor(READER_SHORTCUTS, key)
      if (!hit) return
      const jumpWithinChapter = (end: boolean) => {
        const section = anchorSectionRef.current
        if (!section) return
        const top = window.scrollY + section.getBoundingClientRect().top
        window.scrollTo({
          top: Math.max(0, end ? top + section.offsetHeight - window.innerHeight + 24 : top - 24),
          behavior: 'smooth',
        })
      }
      const stepFontSize = (delta: number) => onSettingsChange({
        ...settings,
        fontSize: Math.min(28, Math.max(15, settings.fontSize + delta)),
      })
      switch (hit.action) {
        case 'close':
          if (!activeDrawer) return
          setActiveDrawer(null)
          break
        case 'page-up':
          event.preventDefault()
          if (settings.pageMode === 'paginate') goPrevPage()
          else if (isAtTopBoundary(window.scrollY)) changeChapter(chapterIndex - 1, 'last')
          else window.scrollBy({ top: -window.innerHeight * 0.85, behavior: 'smooth' })
          break
        case 'page-down':
          event.preventDefault()
          if (settings.pageMode === 'paginate') goNextPage()
          else if (isAtBottomBoundary(window.scrollY, document.documentElement.scrollHeight, window.innerHeight)) changeChapter(chapterIndex + 1, 'first')
          else window.scrollBy({ top: window.innerHeight * 0.85, behavior: 'smooth' })
          break
        case 'chapter-prev':
          event.preventDefault()
          if (settings.pageMode === 'paginate') goPrevPage()
          else changeChapter(chapterIndex - 1, 'last')
          break
        case 'chapter-next':
          event.preventDefault()
          if (settings.pageMode === 'paginate') goNextPage()
          else changeChapter(chapterIndex + 1, 'first')
          break
        case 'chapter-start':
          event.preventDefault()
          jumpWithinChapter(false)
          break
        case 'chapter-end':
          event.preventDefault()
          jumpWithinChapter(true)
          break
        case 'font-increase':
          event.preventDefault()
          stepFontSize(1)
          break
        case 'font-decrease':
          event.preventDefault()
          stepFontSize(-1)
          break
        case 'theme-next': {
          event.preventDefault()
          const next = themes[(themes.findIndex(entry => entry[0] === settings.theme) + 1) % themes.length]
          onSettingsChange({ ...settings, theme: next[0] })
          break
        }
        case 'toc':
          event.preventDefault()
          setActiveDrawer(drawer => drawer === 'toc' ? null : 'toc')
          break
        case 'settings':
          event.preventDefault()
          setActiveDrawer(drawer => drawer === 'settings' ? null : 'settings')
          break
        case 'tts':
          event.preventDefault()
          toggleTts()
          break
        case 'fullscreen':
          event.preventDefault()
          toggleFullscreen()
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeDrawer, changeChapter, chapterIndex, goNextPage, goPrevPage, onSettingsChange, settings, toggleTts])

  // Ctrl/⌘ + 滚轮直接调字号：不用先开设置抽屉再拖滑杆。必须 passive:false，否则拦不住浏览器的页面缩放。
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      const next = Math.min(28, Math.max(15, settings.fontSize + (event.deltaY > 0 ? -1 : 1)))
      if (next !== settings.fontSize) onSettingsChange({ ...settings, fontSize: next })
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [settings, onSettingsChange])

  const readerStyle = {
    '--reader-font-size': `${settings.fontSize}px`,
    '--reader-line-height': settings.lineHeight,
    '--reader-letter-spacing': `${settings.letterSpacing}px`,
    '--reader-paragraph-spacing': `${settings.paragraphSpacing}em`,
    '--reader-text-indent': `${settings.textIndent}em`,
    '--reader-content-padding': `${settings.contentPadding}px`,
    '--reader-max-width': `${settings.maxWidth}px`,
    '--reader-font-family': getReaderFontFamily(settings.font),
  } as CSSProperties

  // Pointer & Gesture interactions
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (loading || activeDrawer || isInteractiveReaderTarget(event.target)) return
    pointerStartRef.current = { x: event.clientX, y: event.clientY, target: event.target }
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const start = pointerStartRef.current
    pointerStartRef.current = null
    if (!start || loading || isInteractiveReaderTarget(event.target) || isInteractiveReaderTarget(start.target) || window.getSelection()?.toString()) return

    if (activeDrawer) {
      setActiveDrawer(null)
      return
    }

    if (settings.pageMode === 'paginate') {
      const swipe = swipeDirection(start.x, start.y, event.clientX, event.clientY)
      if (swipe === 'left') {
        goNextPage()
        return
      }
      if (swipe === 'right') {
        goPrevPage()
        return
      }
      if (isTapGesture(start.x, start.y, event.clientX, event.clientY)) {
        const zone = paginateTapZone(event.clientX, window.innerWidth)
        if (zone === 'previous') goPrevPage()
        else if (zone === 'next') goNextPage()
        else setToolbarsVisible(visible => !visible)
      }
    } else {
      if (isTapGesture(start.x, start.y, event.clientX, event.clientY)) {
        const zone = scrollTapZone(event.clientY, window.innerHeight)
        if (zone === 'previous') {
          if (isAtTopBoundary(window.scrollY)) {
            changeChapter(chapterIndex - 1, 'last')
          } else {
            window.scrollBy({ top: -window.innerHeight * 0.85, behavior: 'smooth' })
          }
        } else if (zone === 'next') {
          if (isAtBottomBoundary(window.scrollY, document.documentElement.scrollHeight, window.innerHeight)) {
            changeChapter(chapterIndex + 1, 'first')
          } else {
            window.scrollBy({ top: window.innerHeight * 0.85, behavior: 'smooth' })
          }
        } else {
          setToolbarsVisible(visible => !visible)
        }
      }
    }
  }

  const onWheelPaginate = (event: React.WheelEvent) => {
    if (settings.pageMode !== 'paginate' || activeDrawer || wheelTimerRef.current !== null) return
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (Math.abs(delta) < 25) return
    wheelTimerRef.current = window.setTimeout(() => { wheelTimerRef.current = null }, 220)
    if (delta > 0) goNextPage()
    else goPrevPage()
  }

  const cachePercent = Math.min(100, Math.round((cacheStatus.cached / Math.max(1, cacheStatus.total || currentBook.chapters.length)) * 100))

  return <main className={`reader-workspace ${themeClassNames(settings).join(' ')} ${toolbarsVisible ? 'toolbars-open' : 'toolbars-hidden'} ${settings.sidebarPinned ? 'sidebar-pinned' : ''}`} style={readerStyle}>
    {/* Floating Header */}
    <header className="reader-header">
      <div className="reader-header-left">
        <IconButton label="返回书架" icon="arrowLeft" onClick={() => { persist(); stopTts(); onClose() }} />
        <IconButton
          label="目录"
          icon="list"
          onClick={() => {
            if (settings.sidebarPinned) {
              onSettingsChange({ ...settings, sidebarPinned: false })
              setActiveDrawer(null)
            } else {
              setActiveDrawer(d => d === 'toc' ? null : 'toc')
            }
          }}
        />
      </div>
      <strong className="reader-header-title" title={bookName}>{bookName}</strong>
      <div className="reader-header-actions">
        <IconButton label="切换书源" icon="sliders" onClick={() => setShowSourceSwitch(true)} />
        <IconButton label="阅读设置" icon="settings" onClick={() => setActiveDrawer(d => d === 'settings' ? null : 'settings')} />
        <IconButton label={isFullscreen ? '退出全屏' : '全屏阅读'} icon="expand" onClick={toggleFullscreen} />
        <IconButton
          label={!ttsActive ? '朗读本章' : ttsPlayState === 'playing' ? '暂停朗读' : '继续朗读'}
          icon={ttsActive && ttsPlayState === 'playing' ? 'pause' : 'volume2'}
          onClick={toggleTts}
        />
      </div>
    </header>

    {/* TOC Drawer (Left) */}
    <aside className={`reader-drawer reader-drawer-left ${activeDrawer === 'toc' ? 'open' : ''} ${settings.sidebarPinned ? 'pinned' : ''}`} aria-label="目录抽屉">
      <header className="drawer-header">
        <div className="drawer-title"><Icon name="list" /><strong>目录</strong><small>共 {currentBook.chapters.length} 章</small></div>
        <div className="drawer-header-actions">
          <IconButton
            className={`desktop-reverse-btn ${tocReverse ? 'reversed' : ''}`}
            label={tocReverse ? '切换为正序目录' : '切换为倒序目录'}
            icon="list"
            onClick={() => setTocReverse(value => !value)}
          />
          <IconButton
            className={`desktop-pin-btn ${settings.sidebarPinned ? 'pinned' : ''}`}
            label={settings.sidebarPinned ? '取消固定目录' : '固定目录到侧边栏'}
            icon={settings.sidebarPinned ? 'pinOff' : 'pin'}
            onClick={() => onSettingsChange({ ...settings, sidebarPinned: !settings.sidebarPinned })}
          />
          <IconButton
            label="关闭目录"
            icon="close"
            onClick={() => {
              if (settings.sidebarPinned) {
                onSettingsChange({ ...settings, sidebarPinned: false })
              }
              setActiveDrawer(null)
            }}
          />
        </div>
      </header>
      <div className="chapter-search">
        <Icon name="search" />
        <input value={chapterQuery} onChange={event => setChapterQuery(event.target.value)} placeholder="搜索章节" />
      </div>
      <VirtualChapterList
        chapters={tocList}
        activeChapterIndex={chapterIndex}
        cachedUrlsSet={cachedChapterUrls}
        onSelect={index => {
          changeChapter(index)
          if (!settings.sidebarPinned) {
            setActiveDrawer(null)
          }
        }}
        itemHeight={40}
        overscan={8}
        autoScrollKey={activeDrawer === 'toc' || settings.sidebarPinned ? 1 : 0}
      />
      <footer className="drawer-footer">
        {/* Cache Control Section */}
        <div className="drawer-cache-section">
          {cacheStatus.state === 'caching' ? (
            <div className="drawer-cache-progress">
              <div className="cache-progress-text">
                <span>正在服务端缓存</span>
                <strong>{cachePercent}% ({cacheStatus.cached}/{cacheStatus.total || currentBook.chapters.length}章)</strong>
              </div>
              <div className="cache-progress-bar-track">
                <div className="cache-progress-bar-fill" style={{ width: `${cachePercent}%` }} />
              </div>
              <button className="cache-cancel-btn" onClick={() => void handleCancelCache()}>取消缓存</button>
            </div>
          ) : localSyncing ? (
            <div className="drawer-cache-progress">
              <div className="cache-progress-text">
                <span>正在下载到这台电脑</span>
                <strong>{localSyncProgress.current} / {localSyncProgress.total} 章</strong>
              </div>
              <div className="cache-progress-bar-track">
                <div
                  className="cache-progress-bar-fill"
                  style={{ width: `${Math.min(100, Math.round((localSyncProgress.current / Math.max(1, localSyncProgress.total)) * 100))}%` }}
                />
              </div>
              <button className="cache-cancel-btn" onClick={() => { localSyncAbortRef.current?.abort(); setLocalSyncing(false) }}>取消本地下载</button>
            </div>
          ) : (
            <div className="drawer-cache-idle">
              <div className="cache-range-btn-grid">
                <button
                  type="button"
                  className="cache-range-btn"
                  title="缓存全本"
                  onClick={() => void handleCacheRange('all')}
                >
                  缓存全本
                </button>
                <button
                  type="button"
                  className="cache-range-btn"
                  title="自定义章节范围"
                  onClick={() => setCustomRangeOpen(prev => !prev)}
                >
                  自定义…
                </button>
              </div>

              {customRangeOpen && (
                <div className="cache-custom-range-box">
                  <div className="range-inputs">
                    <span>第</span>
                    <input
                      type="number"
                      min={1}
                      max={currentBook.chapters.length}
                      value={customRangeStart}
                      onChange={e => setCustomRangeStart(Number(e.target.value))}
                    />
                    <span>至</span>
                    <input
                      type="number"
                      min={customRangeStart}
                      max={currentBook.chapters.length}
                      value={customRangeEnd}
                      onChange={e => setCustomRangeEnd(Number(e.target.value))}
                    />
                    <span>章</span>
                  </div>
                  <button
                    type="button"
                    className="primary-button range-start-btn"
                    onClick={() => {
                      setCustomRangeOpen(false)
                      void handleCacheRange('custom', customRangeStart, customRangeEnd)
                    }}
                  >
                    开始缓存
                  </button>
                </div>
              )}

              <div className="cache-local-sync-row">
                <button
                  type="button"
                  className="cache-sync-btn"
                  onClick={() => void handleSyncToLocal()}
                  title="把已缓存的章节下载到这台电脑的浏览器里，断网也能读"
                >
                  <Icon name="download" />
                  <span>下载到本设备</span>
                </button>
                <button
                  type="button"
                  className="cache-manage-btn"
                  onClick={() => setOfflineStatsModal(true)}
                  title="管理本设备离线缓存"
                >
                  <Icon name="sliders" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="drawer-footer-actions">
          <button className="shelf-button switch-source-btn" onClick={() => { setActiveDrawer(null); setShowSourceSwitch(true) }}>
            <Icon name="sliders" />换源
          </button>
          <button className="shelf-button" onClick={() => void toggleShelf()}>
            <Icon name={inShelf ? 'check' : 'plus'} />{inShelf ? '已在书架' : '加书架'}
          </button>
        </div>
      </footer>
    </aside>

    {/* Settings Drawer (Right) */}
    <aside className={`reader-drawer reader-drawer-right ${activeDrawer === 'settings' ? 'open' : ''}`} aria-label="阅读设置">
      <header className="drawer-header">
        <div className="drawer-title"><Icon name="settings" /><strong>阅读设置</strong></div>
        <IconButton label="关闭设置" icon="close" onClick={() => setActiveDrawer(null)} />
      </header>
      <ReaderSettingsControls
        settings={settings}
        onChange={onSettingsChange}
        onOpenReplaceRules={() => setShowReplaceRules(true)}
        localBook={currentBook.details.sourceId === 'loc_book' ? { name: bookName, tocRule: shelfTocRule } : null}
        tocRuleOptions={tocRuleOptions}
        onReparseLocal={currentBook.details.sourceId === 'loc_book' ? reparseLocalBook : undefined}
      />
    </aside>

    {/* Backdrop for Drawers */}
    {activeDrawer && (activeDrawer !== 'toc' || !settings.sidebarPinned) && (
      <div className="reader-drawer-backdrop" onClick={() => setActiveDrawer(null)} aria-hidden="true" />
    )}

    {/* Central Reading Canvas */}
    <section className="reader-main">
      {settings.pageMode === 'paginate' ? (
        <div className="reader-paginated-wrap" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onWheel={onWheelPaginate}>
          <div ref={viewportRef} className={`reader-paginated-viewport ${isDoubleColumn ? 'is-double-column' : ''}`}>
            <div className="reader-paginated-track" style={{ transform: `translateX(-${pageIndex * stride}px)` }}>
              <article ref={bodyRef} key={loadedChapterUrl || 'pending'} className={`reader-paginated-column-body chapter-enter${isStaleContent ? ' is-stale' : ''}`} style={{ columnWidth: `${columnWidth}px`, columnGap: `${columnGap}px` }}>
                <h1>{shownChapterTitle}</h1>
                {isStaleContent && <p className="reader-chapter-incoming" role="status">正在载入：{incomingChapterTitle}</p>}
                {loading && !content && <ReaderContentSkeleton />}
                {message && <p className="reader-error">{message}</p>}
                {paragraphs.map((line, index) => renderContentBlock(line, index))}
                {/* 双栏模式下，在本章末尾插入隐形占位，确保下一章从新的左栏开始 */}
                {isDoubleColumn && <div className="column-break-placeholder" aria-hidden="true" />}
              </article>
            </div>
          </div>
          <footer className="reader-paginated-footer">
            <span>{shownChapterTitle || ''}</span>
            <span>{pageIndex + 1} / {pageCount}</span>
          </footer>
        </div>
      ) : (
        <article className={`reading-content chapter-enter${isStaleContent ? ' is-stale' : ''}`} key={flowKey} onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
          {/*
            滚动模式是一篇连续文档（用户 2026-10-02：「怎么能跳转呢，不是一体的吗」）：
            锚点章之后把后续章节续接在同一棵容器里，读完一章是"顶上来"，不是"跳过去"。
            每章一个 <section>，标题与正文成组；章与章之间是一条分隔线，不是"翻页"。
          */}
          <section ref={anchorSectionRef} className="reader-flow-chapter" data-chapter-index={chapter?.index ?? 0}>
            <h1>{shownChapterTitle}</h1>
            {isStaleContent && <p className="reader-chapter-incoming" role="status">正在载入：{incomingChapterTitle}</p>}
            {loading && !content && <ReaderContentSkeleton />}
            {message && <p className="reader-error">{message}</p>}
            {paragraphs.map((line, index) => renderContentBlock(line, index))}
          </section>
          {flowTail.map(item => (
            <section key={item.chapter.url} className="reader-flow-chapter reader-flow-tail" data-chapter-index={item.chapter.index}>
              <h1>{item.chapter.title}</h1>
              {splitParagraphs(item.content).map((line, index) => renderContentBlock(line, index, item.chapter))}
            </section>
          ))}
          {!!content && !loading && loadedChapterUrl === chapter?.url && !!nextChapterTitle && flowTail.length === 0 && (
            <div className="reader-next-hint">
              <button type="button" onClick={() => changeChapter(chapterIndex + 1, 'first')}>
                <span>下一章 · {nextChapterTitle}</span>
                <Icon name="chevronDown" />
              </button>
              <small>这是最后一章之前唯一没有续接上的位置：滚到底再向下滑即进入</small>
            </div>
          )}
          {content && <footer className="reader-navigation"><button disabled={chapterIndex === 0 || loading} onClick={() => changeChapter(chapterIndex - 1)}><Icon name="arrowLeft" />上一章</button><div className="chapter-progress"><i style={{ width: `${chapterProgress}%` }} /><input className="chapter-scrub" type="range" min={0} max={Math.max(0, currentBook.chapters.length - 1)} step={1} value={shownChapterIndex} disabled={loading || currentBook.chapters.length < 2} aria-label={`章节进度：第 ${shownChapterIndex + 1} 章，共 ${currentBook.chapters.length} 章`} onChange={event => setScrubIndex(Number(event.target.value))} onPointerUp={() => { if (scrubIndex !== null && scrubIndex !== chapterIndex) changeChapter(scrubIndex); setScrubIndex(null) }} onKeyUp={() => { if (scrubIndex !== null && scrubIndex !== chapterIndex) changeChapter(scrubIndex); setScrubIndex(null) }} /><span>{shownChapterIndex + 1} / {currentBook.chapters.length}</span></div><button disabled={chapterIndex === currentBook.chapters.length - 1 || loading} onClick={() => changeChapter(chapterIndex + 1)}>下一章<Icon name="arrowRight" /></button></footer>}
        </article>
      )}
      {boundaryMessage && <p className="reader-boundary-message" role="status">{boundaryMessage}</p>}
    </section>

    {/* Floating Mobile Bottom Nav */}
    <nav className="mobile-reader-nav">
      <button onClick={() => setActiveDrawer('toc')}><Icon name="list" /><span>目录</span></button>
      <button onClick={() => setShowSourceSwitch(true)}><Icon name="sliders" /><span>换源</span></button>
      <button onClick={toggleTts}><Icon name={ttsActive && ttsPlayState === 'playing' ? 'pause' : 'volume2'} /><span>{ttsActive ? (ttsPlayState === 'playing' ? '暂停' : '继续') : '朗读'}</span></button>
      <button onClick={() => setActiveDrawer('settings')}><span className="aa">Aa</span><span>设置</span></button>
      <button onClick={() => onSettingsChange({ ...settings, theme: settings.theme === 'dark' ? 'light' : 'dark' })}><Icon name="moon" /><span>夜读</span></button>
    </nav>

    {/* In-reader Source Switch Modal */}
    {showSourceSwitch && (
      <SourceSwitchModal
        bookName={bookName}
        author={currentBook.details.author}
        currentSourceId={currentBook.details.sourceId}
        currentBookUrl={currentBook.bookUrl}
        currentChapterTitle={chapter?.title}
        currentChapterIndex={chapterIndex}
        knownAlternateSources={currentBook.details.alternateSources}
        onSwitch={handleSwitchSource}
        onClose={() => setShowSourceSwitch(false)}
      />
    )}

    {/* TTS Floating Player Bar */}
    {ttsActive && (
      <TtsPlayerBar
        playState={ttsPlayState}
        currentParagraphIndex={activeParagraphIndex}
        totalParagraphs={ttsParagraphs.length}
        currentChunkIndex={currentChunkIndex}
        totalChunks={ttsData.chunks.length}
        activeSentenceText={activeSentenceText}
        sleepTimer={sleepTimer}
        remainingSeconds={remainingSeconds}
        onTogglePlay={toggleTts}
        onPrevChunk={handlePrevChunk}
        onNextChunk={handleNextChunk}
        onPrevChapter={handlePrevChapterTts}
        onNextChapter={handleNextChapterTts}
        onOpenSettings={() => setShowTtsSettings(true)}
        onClose={stopTts}
      />
    )}

    {/* TTS Settings Modal */}
    {showTtsSettings && (
      <TtsSettingsModal
        settings={settings}
        onChange={onSettingsChange}
        sleepTimer={sleepTimer}
        onSleepTimerChange={setSleepTimer}
        remainingSeconds={remainingSeconds}
        onClose={() => setShowTtsSettings(false)}
      />
    )}

    {/* Replace Rules Modal */}
    {showReplaceRules && (
      <ReplaceRulesModal
        isOpen={showReplaceRules}
        onClose={() => setShowReplaceRules(false)}
        currentBookName={bookName}
        currentSourceUrl={currentBook.details.sourceId}
        onRulesChanged={() => {
          if (chapter) {
            const requestedUrl = chapter.url
            setLoadedChapterUrl('')
            setContent('')
            setLoading(true)
            api.content(currentBook.details.sourceId, chapter.url, currentBook.bookUrl)
              .then(res => {
                // 用户可能已经翻到别的章节；这里无条件写入会用旧章正文覆盖新章，
                // 结果 loadedChapterUrl 与当前章不符 → 章节标题下永远空白。
                if (currentChapterUrlRef.current !== requestedUrl) return
                setContent(res.content)
                setLoadedChapterUrl(requestedUrl)
              })
              .catch(err => {
                if (currentChapterUrlRef.current !== requestedUrl) return
                setMessage(err.message || '加载章节内容失败')
              })
              .finally(() => {
                if (currentChapterUrlRef.current === requestedUrl) setLoading(false)
              })
          }
        }}
      />
    )}

    {/* Offline Cache Stats Modal */}
    {offlineStatsModal && (
      <OfflineCacheModal
        onClose={() => {
          setOfflineStatsModal(false)
          void syncCacheStatus()
        }}
      />
    )}

    {/* Offline TTS Fallback Confirmation Dialog */}
    {offlineTtsConfirmOpen && (
      <div className="modal-backdrop" onClick={() => setOfflineTtsConfirmOpen(false)}>
        <div
          className="source-login-modal"
          style={{ maxWidth: '420px' }}
          onClick={e => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="离线语音提示"
        >
          <header className="source-login-header">
            <div className="source-login-title">
              <span className="source-login-icon"><Icon name="volume2" /></span>
              <div className="source-login-heading">
                <h2>离线朗读提示</h2>
                <small>当前设备处于离线状态</small>
              </div>
            </div>
            <button type="button" className="subtle-button close-btn" onClick={() => setOfflineTtsConfirmOpen(false)} aria-label="关闭">
              <Icon name="close" />
            </button>
          </header>
          <div className="source-login-body">
            <p style={{ margin: '8px 0', fontSize: '14px', lineHeight: '1.6', color: 'var(--ink)' }}>
              当前未连接到互联网，云端 Edge-TTS 朗读不可用。是否切换使用设备本地自带的<strong>系统语音 (Web Speech)</strong> 进行脱机朗读？
            </p>
          </div>
          <footer className="source-login-footer">
            <button type="button" className="subtle-button" onClick={() => setOfflineTtsConfirmOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setOfflineTtsConfirmOpen(false)
                onSettingsChange({ ...settings, ttsEngine: 'webSpeech' })
                setTtsActive(true)
                const startIdx = getInitialTtsChunkIndex()
                playTtsChunk(startIdx)
              }}
            >
              使用系统离线语音
            </button>
          </footer>
        </div>
      </div>
    )}
    {lightboxSrc && (
      <div className="reader-image-lightbox" onClick={() => setLightboxSrc(null)} role="dialog" aria-label="图片预览">
        <button type="button" className="reader-image-lightbox-close" aria-label="关闭预览" onClick={() => setLightboxSrc(null)}><Icon name="close" /></button>
        <img src={lightboxSrc} alt="" onClick={event => event.stopPropagation()} />
      </div>
    )}
  </main>
}

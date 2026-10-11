import { FormEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api, BookDetails, BookGroup, BookshelfItem, Chapter, SearchResult, SearchStreamEvent, SourceRecord, SourceSubscription, SourceSummary } from './api'
import { Icon } from './icons'
import { useEscapeClose } from './useEscapeClose'
import { ContextMenuLayer, showContextMenu } from './ContextMenu'
import { readSearchLayout, readShelfLayout, readShelfSort, ShelfLayout, ShelfSort, writeSearchLayout, writeShelfLayout, writeShelfSort } from './shelfLayout'
import { compareCustomSort } from './shelfOrder'
import { useDragSort } from './dragSort'
import { Logo } from './Logo'
import { BookCover, CoverFallback, SearchCover } from './Cover'
import { OpenBook, ReaderScreen } from './ReaderScreen'
import { ErrorBoundary } from './ErrorBoundary'
import { loadReaderSettings, parseSkinId, ReaderSettings, saveReaderSettings, themeClassNames } from './readerSettings'
import { AppHeader } from './AppHeader'
import { ChangelogPage } from './ChangelogPage'
import { AboutPage } from './AboutPage'
import { FirstRunAgreement } from './FirstRunAgreement'
import { CustomizeModal } from './CustomizeModal'
import { ServerPortModal } from './ServerPortModal'
import { cleanAuthor, cleanTitle, defaultSearchFilters, filterSearchGroups, formatIntro, isExactMatch, pickBlurb, SearchFilters, SearchGroup, SortMode } from './searchFilters'
import { bookTypeMeta, commonBookType } from './bookType'
import { groupSearchResults, loadSourceBook, SourceChoice, SourceChoiceStatus, useSearchStore } from './searchStore'
import { SourceSwitchModal } from './SourceSwitchModal'
import { SourceLoginModal } from './SourceLoginModal'
import { SourceDebugModal } from './SourceDebugModal'
import { SourceShareModal } from './SourceShareModal'
import { ReplaceRulesModal } from './ReplaceRulesModal'
import { PageDialog } from './PageDialog'
import { ExplorePage } from './ExplorePage'
import { RssPanel } from './RssPanel'
import { Notice } from './Notice'
import { EmptyGuide } from './EmptyGuide'
import { Select } from './Select'
import { describeSyncError } from './syncErrors'
import { sourcePickerOptions } from './sourceOrder'
import { BackupPage } from './BackupPage'
import { OfflineCacheModal } from './OfflineCacheModal'
import { LogsModal } from './LogsModal'
import { ShortcutHelp } from './ShortcutHelp'
import { GLOBAL_SHORTCUTS, isTypingTarget, normalizeKey, PRIMARY_PAGES, shortcutFor } from './shortcuts'
import { SourceHealthModal } from './SourceHealthModal'
import { TocRulesModal } from './TocRulesModal'
import { SettingsPage, type SettingsSection } from './SettingsPage'
import { useHealthRun } from './sourceHealthRun'
import { SourceEditor } from './SourceEditorPanel'
import { SourceGroupModal } from './SourceGroupModal'
import { PwaManager } from './PwaManager'
import { flushOfflineProgress } from './offlineStorage'
import { toast, ToastContainer } from './Toast'
import './styles.css'

import { clearStoredInspections, getInitialOrStoredInspections, inspectAllSourcesConcurrently, SourceHealthInspection } from './sourceInspector'
import { parseSourceJsonText, extractSourcesFromRaw, sanitizeImageUrl } from './sourceImport'

/** 书源侧栏一次渲染的条数上限：整库导入常有数千个源，全量挂载会让首屏和滚动一起变卡。 */
const SOURCE_PAGE_SIZE = 120

/* 目录预览不再分水位：一次全给（用户 2026-10-09：「目录预览直接展示全部目录，不需要展开了」）。 */

/**
 * Legado 的 `bookSourceGroup` 是标签串而非单个分组名：`小说 书源`、`js失效，音乐` 表示同时属于两个分组。
 * 整串当一个分组的话，4876 个源只数得出 20 个"分组"，选任何分组都只剩几条，且 91% 的源永远归不进去。
 */
const splitSourceGroups = (raw?: string) =>
  (raw ?? '').split(/[,，、\s]+/).map(tag => tag.trim()).filter(Boolean)

export { extractSourcesFromRaw, parseSourceJsonText, sanitizeImageUrl }
export type { SourceChoice, SourceChoiceStatus }

type Page = 'sources' | 'subscriptions' | 'library' | 'shelf' | 'explore' | 'reader' | 'settings'
/** 不占导航栏、也不占整页的目的地（0.6.27 起全部悬浮化）：规则 / 备份 / 更新日志 / 关于 */
type PageDialogKind = 'rules' | 'backup' | 'changelog' | 'about'
const PAGE_DIALOG_TITLES: Record<PageDialogKind, string> = { rules: '替换净化规则', backup: '备份包', changelog: '更新日志', about: '关于' }
const readerStorageKey = 'legado-open-book-v1'
const pageFromHash = (): Page => location.hash === '#sources' ? 'sources' : location.hash === '#subscriptions' ? 'subscriptions' : location.hash === '#shelf' ? 'shelf' : location.hash === '#explore' ? 'explore' : location.hash === '#reader' ? 'reader' : location.hash === '#settings' ? 'settings' : 'library'
/** 旧深链进来仍开对的那一个悬浮层，不白屏也不跳页 */
const dialogFromHash = (): PageDialogKind | null => location.hash === '#rules' ? 'rules' : location.hash === '#backup' ? 'backup' : location.hash === '#changelog' ? 'changelog' : location.hash === '#about' ? 'about' : null

/**
 * 自定义皮肤的注入点（「自定义」里填的 CSS 真的挂上，不是摆个空控件）。
 *
 * 用 `document.createElement('style')` + `textContent` 而不是 `dangerouslySetInnerHTML`：
 * 用户写的 CSS 里出现 `</style>` 也不会拼出新标签（textContent 不走 HTML 解析）。
 * 规则按用户写的样子挂上去（要求他自己写 `.theme-<id> { … }` 这种完整选择器），
 * 因为把用户输入包进 `.theme-x{…}` 会依赖 CSS 嵌套语法，老浏览器上一条都不生效。
 * id 过一遍白名单（`parseSkinId`），只允许 `[a-z0-9-_]`。
 */
function SkinStyle({ settings }: { settings: ReaderSettings }) {
  const id = parseSkinId(settings.customSkinId)
  const css = (settings.customSkinCss ?? '').trim()
  useEffect(() => {
    const marker = 'legado-custom-skin'
    const existing = document.getElementById(marker)
    if (!id || !css) {
      existing?.remove()
      return
    }
    let el = existing as HTMLStyleElement | null
    if (!el) {
      el = document.createElement('style')
      el.id = marker
      document.head.appendChild(el)
    }
    el.textContent = css
    return () => { document.getElementById(marker)?.remove() }
  }, [id, css])
  return null
}

/**
 * 「在书源页中定位」的握手变量。
 *
 * SourcesPage 是按页签条件挂载的（page === 'sources' 才存在），所以从别的页面跳过去时，
 * 它一定是一次新挂载 —— 用模块变量把目标带过去，比把 query 状态提升到 App 再传回来简单，
 * 也不会为此给三层组件各加一个 prop。消费后立即清空，避免下次进书源页还带着旧目标。
 */
let pendingSourceFocus: string | null = null

const flipSource = async (source: SourceSummary, onSourcesChanged?: () => void) => {
  try {
    await api.batchSources(source.enabled ? 'disable' : 'enable', [source.id])
    toast.success(source.enabled ? `已停用「${source.name}」` : `已启用「${source.name}」`)
    onSourcesChanged?.()
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '启停失败')
  }
}

/** 换源行的右键：能就地做的就地做，做不了的跳去书源页并带着定位目标。 */
function openSourceMenu(event: ReactMouseEvent, choice: SourceChoice, source: SourceSummary | undefined, onSourcesChanged?: () => void) {
  showContextMenu(event, [
    ...(source
      ? [
          { label: source.enabled ? '停用此书源' : '启用此书源', icon: source.enabled ? ('close' as const) : ('check' as const), onSelect: () => void flipSource(source, onSourcesChanged) },
          { label: '在书源页中定位', icon: 'edit' as const, onSelect: () => { pendingSourceFocus = source.name; location.hash = '#sources' } },
        ]
      : []),
    { label: '复制书源地址', icon: 'copy' as const, onSelect: () => void navigator.clipboard?.writeText(choice.result.sourceId) },
  ])
}

/**
 * 详情弹窗里的「可用书源」列表：一行 = 一个源在这本书上的实际表现。
 *
 * 以前行内只写 `choice.result.sourceId`（一串 `https://xxx.com/`），十几个源摊开时
 * 用户根本分不清哪个是哪个 —— 那正是「书籍详情信息不完善、不明了」的直接来源。
 * 现在按 `sources` 反查书源名与分组，把体检拿到的细节摊开，并且右键一行就能直接管理该书源。
 */
function SourceChoiceList({
  choices,
  inspections,
  sources,
  active,
  onChoose,
  onRecheck,
  onSourcesChanged,
  checking,
}: {
  choices: SourceChoice[]
  inspections: Map<string, SourceHealthInspection>
  sources: SourceSummary[]
  active?: string
  onChoose: (choice: SourceChoice) => void
  onRecheck: () => void
  /** 停用/启用之后要请上层重取一次书源，否则行上的「已停用」标记会停在旧值。 */
  onSourcesChanged?: () => void
  checking: boolean
}) {
  const sourceIndex = useMemo(() => {
    const map = new Map<string, SourceSummary>()
    for (const source of sources) map.set(source.id, source)
    return map
  }, [sources])

  const sortedChoices = useMemo(() => {
    const scoreOf = (choice: SourceChoice) => {
      const key = `${choice.result.sourceId}\u0000${choice.result.bookUrl}`
      const insp = inspections.get(key)
      return insp ? insp.score : (choice.status === 'loaded' ? 5000 : 0)
    }
    const chaptersOf = (choice: SourceChoice) => {
      const key = `${choice.result.sourceId}\u0000${choice.result.bookUrl}`
      const insp = inspections.get(key)
      return insp?.totalChapters ?? choice.book?.chapters.length ?? 0
    }
    return [...choices].sort((a, b) => scoreOf(b) - scoreOf(a) || chaptersOf(b) - chaptersOf(a))
  }, [choices, inspections])

  const completedCount = useMemo(() => {
    let count = 0
    for (const choice of choices) {
      const insp = inspections.get(`${choice.result.sourceId}\u0000${choice.result.bookUrl}`)
      if (insp && insp.status !== 'checking' && insp.status !== 'idle') count++
    }
    return count
  }, [choices, inspections])

  return (
    <section className="source-choice-list" aria-label="可用书源切换列表">
      <header>
        <div className="source-choice-header-left">
          <span>可用书源 ({choices.length})</span>
          <small>
            {checking
              ? `正在校验各源的后期章节 (${completedCount}/${choices.length})`
              : `${completedCount}/${choices.length} 个源已出校验结论`}
          </small>
        </div>
        <button
          type="button"
          className="subtle-button source-recheck-btn"
          onClick={onRecheck}
          disabled={checking}
          title="重新复检每个源的后期章节与付费拦截"
        >
          <Icon name="refresh" className={checking ? 'spin' : ''} />
          <span>{checking ? '校验中' : '重新校验'}</span>
        </button>
      </header>
      <div className="source-choice-items">
        {sortedChoices.map(choice => {
          const key = `${choice.result.sourceId}\u0000${choice.result.bookUrl}`
          const isSelected = active === choice.result.bookUrl
          const isLoading = choice.status === 'loading'
          const inspection = inspections.get(key)
          const summary = sourceIndex.get(choice.result.sourceId)
          const host = choice.result.sourceId.replace(/^[a-z]+:\/\//i, '').split('/')[0].replace(/^www\./i, '')

          let badge = null
          let statusText = '点击切换为此书源'
          if (inspection) {
            // 徽章只写结论，不再混 ✓ / ⚠ / ✕ 这类字形：颜色与文字已经表达了，符号在窄列表里只是噪声。
            if (inspection.status === 'checking') {
              badge = <span className="source-health-badge health-checking">校验中</span>
              statusText = '正在复检后期章节'
            } else if (inspection.status === 'valid') {
              badge = <span className="source-health-badge health-valid">可读</span>
              statusText = inspection.summaryText
            } else if (inspection.status === 'vip_restricted') {
              badge = <span className="source-health-badge health-vip">VIP 拦截</span>
              statusText = inspection.summaryText
            } else if (inspection.status === 'incomplete') {
              badge = <span className="source-health-badge health-incomplete">疑似残卷</span>
              statusText = inspection.summaryText
            } else if (inspection.status === 'error') {
              badge = <span className="source-health-badge health-error">读不出</span>
              statusText = inspection.summaryText
            }
          } else if (isLoading) {
            statusText = '正在读取目录…'
          } else if (choice.status === 'loaded' && choice.book) {
            statusText = `已载入 · 共 ${choice.book.chapters.length} 章`
          }

          // 体检拿到的细节：抽检了几章、最新章叫什么。以前只把 summaryText 塞进一行 small，
          // 用户看不出"可读"是全本可读还是只抽检了 3 章。
          const detail = inspection && inspection.status !== 'checking' && inspection.status !== 'idle'
            ? [
                inspection.checkedChaptersCount ? `已复检 ${inspection.checkedChaptersCount} 章` : '',
                inspection.validChaptersCount && inspection.validChaptersCount !== inspection.checkedChaptersCount
                  ? `${inspection.validChaptersCount} 章有正文` : '',
                inspection.latestChapterTitle ? `最新：${inspection.latestChapterTitle}` : '',
              ].filter(Boolean).join(' · ')
            : ''
          const tags = [
            summary?.group?.trim() || '',
            summary && summary.isJsSource ? 'JS 书源' : '',
            summary && summary.hasLogin ? '已配登录' : '',
            summary && !summary.enabled ? '已停用' : '',
          ].filter(Boolean)

          return (
            <button
              type="button"
              key={key}
              className={`source-choice-item ${isSelected ? 'selected' : ''} ${isLoading ? 'loading' : ''}`}
              disabled={isLoading}
              onClick={() => onChoose(choice)}
              onContextMenu={event => openSourceMenu(event, choice, summary, onSourcesChanged)}
              title="右键可直接管理这个书源"
            >
              <div className="source-choice-top">
                <strong>{summary?.name || host}</strong>
                {badge}
              </div>
              <small>{statusText}</small>
              {detail && <small className="source-choice-detail">{detail}</small>}
              {tags.length > 0 && <small className="source-choice-tags">{tags.join(' · ')} · {host}</small>}
            </button>
          )
        })}
      </div>
    </section>
  )
}

function BookDetailModal({
  book,
  choices,
  sources,
  onSourcesChanged,
  resumeIndex,
  onOpen,
  onChooseSource,
  onClose,
}: {
  book: OpenBook
  choices: SourceChoice[]
  /** 本机书源清单：换源行要靠它把 sourceId 反查成名字与分组。 */
  sources: SourceSummary[]
  onSourcesChanged?: () => void
  resumeIndex: number
  onOpen: (index: number) => void
  onChooseSource: (choice: SourceChoice) => void
  onClose: () => void
}) {
  const [introExpanded, setIntroExpanded] = useState(false)
  const [inspections, setInspections] = useState<Map<string, SourceHealthInspection>>(() =>
    getInitialOrStoredInspections(choices.map(c => c.result))
  )
  const [checking, setChecking] = useState(false)
  const [inShelf, setInShelf] = useState<boolean | null>(null)
  const [shelfBusy, setShelfBusy] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const cancelInspectRef = useRef(false)

  const latestChapter = book.chapters.at(-1)
  const availableSources = choices.length
  /**
   * 详情页封面优先于搜索结果封面，但源站详情页常给出一个打不开的地址（防盗链、http、已失效），
   * 直接渲染就是一个破图框。这里排好候选队列，onError 逐级降级到别的源拿到的封面。
   */
  const coverCandidates = useMemo(() => {
    const seen = new Set<string>()
    return [book.details.coverUrl, ...choices.map(choice => choice.result.coverUrl)]
      .map(url => sanitizeImageUrl(url ?? undefined))
      .filter((url): url is string => {
        if (!url || seen.has(url)) return false
        seen.add(url)
        return true
      })
  }, [book.details.coverUrl, choices])
  const [coverTried, setCoverTried] = useState(0)
  const cover = coverCandidates[coverTried]
  /** 外域封面走服务端代理（0.6.22），浏览器只加载同源地址 */
  const coverSrc = cover ? api.coverProxy(cover, book.details.sourceId) : null
  /** 点详情封面放大查看（用户 2026-10-09：只在书籍详情页放大，其余地方不动）。 */
  const [coverZoom, setCoverZoom] = useState(false)
  /** 换源/换书时弹窗不卸载：上一本书的封面报错计数不复位，下一本的有效封面永远显示不出来。 */
  useEffect(() => {
    setCoverTried(0)
    setIntroExpanded(false)
  }, [book.bookUrl])

  /** 体检只认"这一批源是谁"（key），不认 choices 数组的身份 —— 搜索 store 每次状态更新都会
      重建数组，按身份依赖会让体检被中止后**从零重新联网复检**。 */
  const choicesKey = useMemo(
    () => choices.map(c => `${c.result.sourceId}\u0000${c.result.bookUrl}`).join('\u0001'),
    [choices],
  )
  const choicesRef = useRef(choices)
  choicesRef.current = choices
  const runInspection = useCallback((forceRefresh = false) => {
    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    cancelInspectRef.current = false
    const rawSources = choicesRef.current.map(c => c.result)
    if (forceRefresh) {
      clearStoredInspections(rawSources)
      setInspections(getInitialOrStoredInspections(rawSources))
    }
    setChecking(true)
    void inspectAllSourcesConcurrently(
      rawSources,
      3,
      updated => {
        if (!cancelInspectRef.current && !controller.signal.aborted) {
          setInspections(updated)
        }
      },
      () => cancelInspectRef.current || controller.signal.aborted,
      undefined,
      controller.signal
    ).finally(() => {
      if (!cancelInspectRef.current && !controller.signal.aborted) {
        setChecking(false)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choicesKey])

  useEffect(() => {
    runInspection()
    return () => {
      cancelInspectRef.current = true
      abortControllerRef.current?.abort()
    }
  }, [runInspection])

  const handleClose = useCallback(() => {
    cancelInspectRef.current = true
    abortControllerRef.current?.abort()
    onClose()
  }, [onClose])

  const handleOpenReader = useCallback((idx: number) => {
    cancelInspectRef.current = true
    abortControllerRef.current?.abort()
    onOpen(idx)
  }, [onOpen])

  /**
   * 目录预览一次全给（0.6.21）：整份目录都挂成按钮，不再分水位。
   * 离屏行靠 CSS content-visibility 不参与布局与绘制，大目录也不会卡。
   */
  const visibleChapters = useMemo(() => book.chapters.map(item => (
    <button
      className={item.index === resumeIndex ? 'resume-chapter' : ''}
      key={item.url}
      onClick={() => handleOpenReader(item.index)}
    >
      <span>{item.title}</span>
      {item.index === resumeIndex && book.progress && <small>上次阅读</small>}
    </button>
  )), [book.chapters, book.progress, handleOpenReader, resumeIndex])

  useEffect(() => {
    let active = true
    void api.bookshelf().then(items => {
      if (!active) return
      const found = items.some(
        item => (item.sourceId === book.details.sourceId && item.bookUrl === book.bookUrl) ||
                (cleanTitle(item.name).toLowerCase() === cleanTitle(book.details.name).toLowerCase() &&
                 (cleanAuthor(item.author) || '').toLowerCase() === (cleanAuthor(book.details.author) || '').toLowerCase())
      )
      setInShelf(found)
    }).catch(() => {
      if (active) setInShelf(false)
    })
    return () => {
      active = false
    }
  }, [book.details.sourceId, book.bookUrl, book.details.name, book.details.author])

  const toggleShelf = async () => {
    if (shelfBusy) return
    setShelfBusy(true)
    try {
      if (inShelf) {
        await api.removeFromBookshelf(book.details.sourceId, book.bookUrl)
        setInShelf(false)
        toast.info(`《${book.details.name}》已移出书架`)
      } else {
        const fallbackCover = book.details.coverUrl || choices.find(c => c.result.coverUrl?.trim())?.result.coverUrl?.trim()
        await api.addToBookshelf({
          sourceId: book.details.sourceId,
          bookUrl: book.bookUrl,
          name: book.details.name,
          author: book.details.author,
          tocUrl: book.details.tocUrl,
          coverUrl: fallbackCover || undefined,
          alternateSources: choices.map(c => c.result).filter(s => s.sourceId !== book.details.sourceId || s.bookUrl !== book.bookUrl),
        })
        setInShelf(true)
        toast.success(`《${book.details.name}》已加入书架`)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作书架失败')
    } finally {
      setShelfBusy(false)
    }
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 封面大图叠在详情弹窗之上：一次 Esc 只关最上面那层
        if (coverZoom) { setCoverZoom(false); return }
        handleClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleClose, coverZoom])

  const handleSelectChoice = (choice: SourceChoice) => {
    const key = `${choice.result.sourceId}\u0000${choice.result.bookUrl}`
    const insp = inspections.get(key)
    const fallbackCover = book.details.coverUrl || choices.find(c => c.result.coverUrl?.trim())?.result.coverUrl?.trim()
    const fallbackIntro = book.details.intro || choices.find(c => c.result.intro?.trim())?.result.intro?.trim()

    if (insp?.book) {
      const mergedBook: OpenBook = {
        ...insp.book,
        details: {
          ...insp.book.details,
          name: (cleanTitle(insp.book.details.name) && cleanTitle(insp.book.details.name) !== '未命名书籍' && cleanTitle(insp.book.details.name) !== '未知书名')
            ? cleanTitle(insp.book.details.name)
            : book.details.name,
          author: cleanAuthor(insp.book.details.author) || book.details.author,
          coverUrl: insp.book.details.coverUrl || fallbackCover || undefined,
          intro: insp.book.details.intro || fallbackIntro || undefined,
          alternateSources: choices.map(c => c.result).filter(s => s.sourceId !== choice.result.sourceId || s.bookUrl !== choice.result.bookUrl),
        }
      }
      onChooseSource({ ...choice, book: mergedBook, status: 'loaded' })
    } else {
      onChooseSource(choice)
    }
  }

  return (
    <div className="overlay-backdrop" onClick={handleClose}>
      <div
        className="dialog-shell size-m book-detail-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`书籍详情: ${book.details.name}`}
      >
        <header className="dialog-head book-detail-modal-header">
          <div className="book-detail-heading">
            {coverSrc ? (
              <button type="button" className="book-detail-cover-btn" aria-label="放大查看封面" title="放大查看封面" onClick={() => setCoverZoom(true)}>
                <img className="book-detail-cover" src={coverSrc} alt="" referrerPolicy="no-referrer" onError={() => setCoverTried(count => count + 1)} />
              </button>
            ) : (
              // 以前这里只有书名第一个字，等于一块带字的色板；换成与书架同一套文字书封
              <div className="book-detail-cover book-detail-cover-text"><CoverFallback name={book.details.name} author={book.details.author} /></div>
            )}
            <div className="book-detail-info">
              <h2>{book.details.name}</h2>
              <p>
                {book.details.author || '未知作者'}
                {bookTypeMeta(book.details.sourceType) && (
                  <span className={`book-type-badge type-${book.details.sourceType}`}>{bookTypeMeta(book.details.sourceType)!.label}</span>
                )}
              </p>
              {/*
                一行 run-on 的 span 读不出主次（用户：「书籍详情信息不完善，明了」）：
                改成"标签 + 值"两列，并把书架上才有、这里一直没说过的阅读进度补进来。
              */}
              <dl className="book-detail-stats">
                <div><dt>章节</dt><dd>{book.chapters.length} 章</dd></div>
                <div><dt>可用源</dt><dd>{availableSources || 1} 个</dd></div>
                {!!book.details.kind && <div><dt>分类</dt><dd>{book.details.kind}</dd></div>}
                {!!book.details.wordCount && <div><dt>篇幅</dt><dd>{book.details.wordCount}</dd></div>}
                {(book.details.lastChapter || latestChapter?.title) && <div><dt>最新</dt><dd>{book.details.lastChapter || latestChapter?.title}</dd></div>}
                {book.progress && book.chapters.length > 0 && (
                  <div>
                    <dt>读到</dt>
                    <dd>
                      第 {Math.min(book.progress.chapterIndex + 1, book.chapters.length)} 章 ·{' '}
                      {Math.min(100, Math.round((((book.progress.chapterIndex + 1) / book.chapters.length) + book.progress.scrollPosition / Math.max(1, book.chapters.length)) * 100))}%
                      {' '}· {new Date(book.progress.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          </div>
          <div className="book-detail-header-actions">
            <button
              type="button"
              className={`subtle-button shelf-toggle-btn ${inShelf ? 'in-shelf' : ''}`}
              onClick={toggleShelf}
              disabled={shelfBusy || inShelf === null}
              title={inShelf ? '从书架中移出' : '加入书架'}
            >
              <Icon name="book" />
              <span>{inShelf ? '已在书架' : '加入书架'}</span>
            </button>
            <button className="primary-button read-btn" onClick={() => handleOpenReader(resumeIndex)}>
              {book.progress ? '继续阅读' : '开始阅读'}
              <Icon name="arrowRight" />
            </button>
            <button type="button" className="overlay-close" onClick={handleClose} aria-label="关闭">
              <Icon name="close" />
            </button>
          </div>
        </header>

        <div className="book-detail-modal-body">
          {choices.length > 1 && (
            <div className="book-detail-section">
              <SourceChoiceList
                choices={choices}
                inspections={inspections}
                sources={sources}
                active={book.bookUrl}
                onChoose={handleSelectChoice}
                onRecheck={() => runInspection(true)}
                onSourcesChanged={onSourcesChanged}
                checking={checking}
              />
            </div>
          )}

          {book.details.intro && (
            <div className="book-detail-section">
              <div className={`book-intro ${introExpanded ? 'expanded' : ''}`}>
                <p>{formatIntro(book.details.intro)}</p>
                {book.details.intro.length > 120 && (
                  <button className="intro-toggle" onClick={() => setIntroExpanded(value => !value)}>
                    {introExpanded ? '收起简介' : '展开简介'}
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="book-detail-section">
            <div className="book-detail-section-title">
              <span>目录预览</span>
              <small>共 {book.chapters.length} 章</small>
            </div>
            {/* 一次全给（用户 2026-10-09：「目录预览直接展示全部目录，不需要展开了」）。
                离屏行靠 CSS content-visibility 不参与布局与绘制，所以不必再分水位 ——
                "继续展开 / 收起"那种做法让大目录看着像只显示了一小截。 */}
            <div className="preview-chapters">
              {visibleChapters}
            </div>
          </div>
        </div>
      </div>
      {coverZoom && coverSrc && (
        /* 与阅读器正文配图同一套看图层（.overlay-backdrop.is-viewer） */
        <div
          className="overlay-backdrop is-viewer"
          onClick={event => { event.stopPropagation(); setCoverZoom(false) }}
          role="dialog"
          aria-label="封面预览"
        >
          <button type="button" className="reader-image-lightbox-close" aria-label="关闭预览" onClick={() => setCoverZoom(false)}><Icon name="close" /></button>
          <img src={coverSrc} alt="" onClick={event => event.stopPropagation()} />
        </div>
      )}
    </div>
  )
}





function SubscriptionPanel({ onSourcesChange, onChanged, onNavigate }: {
  onSourcesChange: () => void
  onChanged: () => void
  onNavigate: (page: Page) => void
}) {
  const [items, setItems] = useState<SourceSubscription[]>([])
  const [url, setUrl] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<number | 'all' | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try { setItems(await api.subscriptions()) }
    catch (error) { setNotice(error instanceof Error ? error.message : '无法载入订阅') }
  }, [])
  useEffect(() => { void load() }, [load])

  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (!url.trim()) return
    setBusy('all')
    try {
      await api.saveSubscription(url.trim())
      setUrl('')
      setNotice('订阅已保存，等下一次自动同步或点「立即同步」')
      await load()
      onChanged()
    } catch (error) { setNotice(error instanceof Error ? error.message : '保存订阅失败') }
    finally { setBusy(null) }
  }
  const update = async (id: number) => {
    setBusy(id)
    setNotice('')
    try {
      const result = await api.updateSubscription(id)
      setNotice(`同步完成：新增 ${result.imported || 0}，更新 ${result.updated || 0}，跳过 ${result.skipped || 0}`)
      onSourcesChange()
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '同步失败') }
    finally { setBusy(null) }
  }
  const updateAll = async () => {
    setBusy('all')
    setNotice('')
    try {
      const result = await api.updateSubscriptions()
      setNotice(result.failed
        ? `全部同步完成：成功 ${result.updated}，失败 ${result.failed}（原因看每条订阅下面那行）`
        : `全部同步完成：成功 ${result.updated}`)
      onSourcesChange()
      await load()
    } catch (error) { setNotice(error instanceof Error ? error.message : '同步失败') }
    finally { setBusy(null) }
  }
  const toggle = async (item: SourceSubscription) => {
    setBusy(item.id)
    try { await api.saveSubscription(item.url, !item.enabled); await load() }
    catch (error) { setNotice(error instanceof Error ? error.message : '更新失败') }
    finally { setBusy(null) }
  }
  const remove = async (item: SourceSubscription) => {
    if (!confirm(`删除订阅“${item.url}”？已导入的书源会保留。`)) return
    setBusy(item.id)
    try { await api.removeSubscription(item.id); await load(); onChanged() }
    catch (error) { setNotice(error instanceof Error ? error.message : '删除失败') }
    finally { setBusy(null) }
  }

  const focusInput = () => {
    inputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    inputRef.current?.focus()
  }

  return (
    <section className="subscription-panel">
      <header>
        <div>
          <h2>书源订阅地址</h2>
          <p>放的是<b>返回书源 JSON 的直链</b>（Legado「书源管理 · 订阅」里那种链接），不是网页地址。每 6 小时自动同步一次，同一地址的书源会整体覆盖更新。</p>
        </div>
        <button className="subtle-button" onClick={() => void updateAll()} disabled={busy !== null || items.length === 0}>
          {busy === 'all' ? '同步中…' : '全部同步'}
        </button>
      </header>
      <form onSubmit={add}>
        <input ref={inputRef} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/sources.json" inputMode="url" aria-label="书源订阅地址" />
        <button className="primary-button" disabled={busy !== null}>添加订阅</button>
      </form>
      <Notice text={notice} />
      <div className="subscription-list">
        {items.length === 0 && !notice && (
          <EmptyGuide
            icon="globe"
            title="还没有订阅地址"
            body={<>填一个能直接打开书源 JSON 的地址即可开始同步；只想临时加几个源，也可以到「书源」页粘贴导入。要找「订阅」页那些 RSS 源，请切到旁边的 <b>RSS 订阅</b> 页签。</>}
            actions={[
              { label: '填一个订阅地址', onClick: focusInput, primary: true, icon: 'plus' },
              { label: '去书源页粘贴导入', onClick: () => onNavigate('sources'), icon: 'importFile' },
            ]}
          />
        )}
        {items.map(item => {
          const failure = item.lastError ? describeSyncError(item.lastError) : null
          return (
            <article key={item.id} className={item.enabled ? '' : 'sub-off'}>
              <div className="sub-main">
                <strong title={item.url}>{item.url}</strong>
                {failure ? (
                  <>
                    <small className="sub-error">
                      <b>{`同步失败：${failure.headline}`}</b>
                      {failure.hint && <span>{` ${failure.hint}`}</span>}
                      {item.lastAttemptAt && <em>{` 最近尝试 ${new Date(item.lastAttemptAt).toLocaleString()}`}</em>}
                    </small>
                    <details className="sub-raw"><summary>原始报错</summary><code>{item.lastError}</code></details>
                  </>
                ) : (
                  <small>{item.lastSuccessAt
                    ? `最近同步 ${new Date(item.lastSuccessAt).toLocaleString()} · 处理 ${item.lastImported} 个书源`
                    : '尚未同步；点「立即同步」马上拉一次'}</small>
                )}
                {!item.enabled && <small className="sub-muted">已停用：自动同步会跳过这一条</small>}
              </div>
              <div className="subscription-actions">
                <button className="subtle-button" onClick={() => void toggle(item)} disabled={busy !== null}>{item.enabled ? '已启用' : '已停用'}</button>
                <button
                  className="subtle-button"
                  title={item.enabled ? undefined : '停用中的订阅也可以手动试一次'}
                  onClick={() => void update(item.id)}
                  disabled={busy !== null}
                >
                  {busy === item.id ? '同步中…' : '立即同步'}
                </button>
                <button className="shelf-remove" aria-label="删除订阅" onClick={() => void remove(item)} disabled={busy !== null}><Icon name="close" /></button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

/**
 * 「订阅」页。上游在这里其实是两个完全不同的东西，界面上必须先分开：
 * - 书源订阅：远程 JSON 地址，同步进来的是**书源**（上游 `RuleSub` / `sourceSub.json`）
 * - RSS 订阅：要**读**的订阅源（上游 `RssSource` / `rssSources.json`，手机「订阅」页那一栏）
 *
 * 页签上带条数：这张页最容易出现的状态是"看着像空的"，
 * 数字能立刻区分"这一类我一条都没有"和"数据在另一张页签里"。
 */
function SubscriptionPage({ onSourcesChange, onNavigate, onOpenBackup }: { onSourcesChange: () => void; onNavigate: (page: Page) => void; onOpenBackup: () => void }) {
  const [tab, setTab] = useState<'sources' | 'rss'>('sources')
  const [counts, setCounts] = useState<{ sources: number | null; rss: number | null }>({ sources: null, rss: null })
  const [refreshKey, setRefreshKey] = useState(0)
  const refresh = useCallback(() => setRefreshKey(value => value + 1), [])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      api.subscriptions().then(list => list.length).catch(() => null),
      api.rssSources().then(list => list.length).catch(() => null),
    ]).then(([sources, rss]) => {
      if (!cancelled) setCounts({ sources, rss })
    })
    return () => { cancelled = true }
  }, [refreshKey])

  return (
    <main className="subscription-page">
      <header className="page-title">
        <div>
          <h1>订阅</h1>
          <p>「书源订阅」同步远程书源列表；「RSS 订阅」是「订阅」页那些源，导入备份包后会出现在那里。</p>
        </div>
      </header>
      <nav className="subscription-tabs" aria-label="订阅类型">
        <button type="button" className={tab === 'sources' ? 'active' : ''} onClick={() => setTab('sources')}>
          书源订阅{counts.sources !== null && <small>{counts.sources}</small>}
        </button>
        <button type="button" className={tab === 'rss' ? 'active' : ''} onClick={() => setTab('rss')}>
          RSS 订阅{counts.rss !== null && <small>{counts.rss}</small>}
        </button>
      </nav>
      {tab === 'sources'
        ? <SubscriptionPanel onSourcesChange={onSourcesChange} onChanged={refresh} onNavigate={onNavigate} />
        : <RssPanel onChanged={refresh} onOpenBackup={onOpenBackup} />}
    </main>
  )
}

function SourcesPage({ selected, onSelect, onSourcesChange }: { selected: SourceSummary | null; onSelect: (source: SourceSummary | null) => void; onSourcesChange: (sources: SourceSummary[]) => void }) {
  const [sources, setSources] = useState<SourceSummary[]>([])
  const [query, setQuery] = useState('')
  const loadGeneration = useRef(0)
  const [groupFilter, setGroupFilter] = useState('')
  const [notice, setNotice] = useState('')
  const [importing, setImporting] = useState(false)
  const [isBatchMode, setIsBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showHealthModal, setShowHealthModal] = useState(false)
  // 体检跑在组件之外（见 sourceHealthRun.ts）：这一栏只是订阅者，窗口关了也继续显示进度
  const healthRun = useHealthRun()
  const [showGroupModal, setShowGroupModal] = useState(false)
  const [busyBatch, setBusyBatch] = useState(false)
  const [debugModalSource, setDebugModalSource] = useState<SourceSummary | null>(null)
  const [loginModalSource, setLoginModalSource] = useState<SourceSummary | null>(null)
  const search = useSearchStore()
  /**
   * 「在书库搜」（用户 2026-10-09 的建议）：把书库的搜索范围设成「指定书源 + 这一条」再跳过去。
   * 不自动开搜 —— 关键词由用户自己填（跳过去只是想"就用这个源试一下"）。
   */
  const searchInLibrary = (source: SourceSummary) => {
    search.setSelectedSourceId(source.id)
    search.setScopeMode('single')
    location.hash = '#library'
  }
  const [shareIds, setShareIds] = useState<string[] | null>(null)
  const [creating, setCreating] = useState(false)
  /**
   * 书源清单到没到手。体检弹窗要读这个：清单还在路上时 `sources` 是空数组，
   * 于是界面会一本正经地写「探测『启用中』的 0 个书源」—— 把"还没取到"说成"一个都没有"。
   */
  const [sourcesState, setSourcesState] = useState<'loading' | 'ready' | 'failed'>('loading')

  // 从别处（书籍详情的换源行）右键跳过来时，把目标填进搜索框并选中它
  useEffect(() => {
    if (!pendingSourceFocus) return
    const name = pendingSourceFocus
    pendingSourceFocus = null
    setQuery(name)
  }, [])

  const load = useCallback(async () => {
    // 防抖只挡键盘连击，不挡"慢的旧响应晚到"：'a' 的请求比 'ab' 的晚回来会把列表覆盖回旧结果
    const generation = ++loadGeneration.current
    try {
      const values = await api.sources(query)
      if (generation !== loadGeneration.current) return
      setSources(values)
      setSourcesState('ready')
      onSourcesChange(values)
    } catch (error) {
      if (generation !== loadGeneration.current) return
      setSourcesState('failed')
      setNotice(error instanceof Error ? error.message : '无法载入书源')
    }
  }, [onSourcesChange, query])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 180)
    return () => window.clearTimeout(timer)
  }, [load])

  // 右键菜单走的是「单源」动作：复用批量接口，但只传一个 id，因此不需要批量确认框。
  const flipOne = async (source: SourceSummary) => {
    try {
      await api.batchSources(source.enabled ? 'disable' : 'enable', [source.id])
      await load()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '操作失败')
    }
  }
  const removeOne = async (source: SourceSummary) => {
    if (!confirm(`删除「${source.name}」？这本书源的规则、登录态会被移除，已缓存的书籍不受影响。`)) return
    try {
      await api.batchSources('delete', [source.id])
      await load()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除失败')
    }
  }

  const groupStats = useMemo(() => {
    const counts = new Map<string, number>()
    let ungrouped = 0
    for (const source of sources) {
      const tags = splitSourceGroups(source.group)
      if (!tags.length) { ungrouped++; continue }
      for (const tag of new Set(tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return { groups: [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN')), ungrouped }
  }, [sources])

  const allGroups = useMemo(() => groupStats.groups.map(([name]) => name), [groupStats])

  const filteredSources = useMemo(() => {
    return sources.filter(source => {
      if (groupFilter) {
        const tags = splitSourceGroups(source.group)
        if (groupFilter === '__none__') { if (tags.length) return false }
        else if (!tags.includes(groupFilter)) return false
      }
      if (query) {
        const q = query.toLowerCase()
        return source.name.toLowerCase().includes(q) || source.url.toLowerCase().includes(q) || (source.group ?? '').toLowerCase().includes(q)
      }
      return true
    })
  }, [sources, groupFilter, query])

  // 4876 个书源全量铺进 DOM 时，侧栏首屏和滚动都会卡：先渲染一屏，按需再续。
  const [visibleSourceCount, setVisibleSourceCount] = useState(SOURCE_PAGE_SIZE)
  useEffect(() => { setVisibleSourceCount(SOURCE_PAGE_SIZE) }, [query, groupFilter])
  const visibleSources = useMemo(
    () => filteredSources.slice(0, visibleSourceCount),
    [filteredSources, visibleSourceCount],
  )

  /*
    自定义书源排序（用户 2026-10-02：「自定义书源排序，优化书源编辑功能」）。
    服务端返回的就是「排过序的在前，没编号的按名称跟在后面」，所以这里只负责拖完写回去 ——
    客户端再排一遍就会有第二个事实来源，两边一漂，界面顺序和刷新后的顺序就不一样。
  */
  const sourceListRef = useRef<HTMLElement | null>(null)
  const applySourceOrder = useCallback((ordered: SourceSummary[]) => {
    const rank = new Map(ordered.map((item, index) => [item.id, index + 1]))
    // 就地回填：可见那几条按新顺序换回来，没在这一列里的保持原位。
    // 这里**不写比较器** —— 顺序是服务端排的（`sort_order is null, sort_order, name`），
    // 客户端再排一遍就有两套规则，中文书名上 SQLite 的 nocase 与 localeCompare 本来就会分歧。
    setSources(current => {
      const queue = [...ordered]
      return current.map(item => {
        if (!rank.has(item.id)) return item
        const next = queue.shift()
        return next ? { ...next, sortOrder: rank.get(next.id) ?? null } : item
      })
    })
    void api.reorderSources(ordered.map(item => item.id)).catch(() => {
      setNotice('书源顺序没能保存，刷新后会回到原来的顺序')
      void load()
    })
  }, [load])
  const { drag: sourceDrag, onPointerDown: onSourcePointerDown, onClickCapture: onSourceClickCapture } = useDragSort({
    enabled: () => !isBatchMode,
    gridRef: sourceListRef,
    itemSelector: '.source-list-item',
    items: visibleSources,
    onReorder: applySourceOrder,
  })
  const orderedCount = useMemo(() => sources.filter(item => item.sortOrder != null).length, [sources])
  const clearSourceOrder = () => {
    setSources(current => current.map(item => ({ ...item, sortOrder: null })))
    void api.clearSourceOrder().catch(() => { setNotice('自定义顺序没能清掉，刷新后会回到原样'); void load() })
  }
  const sourceStats = useMemo(() => ({
    total: sources.length,
    enabled: sources.filter(s => s.enabled).length,
    js: sources.filter(s => s.isJsSource).length,
    login: sources.filter(s => s.hasLogin).length,
    groups: allGroups.length,
  }), [sources, allGroups])

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSelectAll = () => {
    setSelectedIds(new Set(filteredSources.map(s => s.id)))
  }

  const handleClearAll = () => {
    setSelectedIds(new Set())
  }

  const handleInvertSelection = () => {
    setSelectedIds(prev => {
      const next = new Set<string>()
      for (const s of filteredSources) {
        if (!prev.has(s.id)) next.add(s.id)
      }
      return next
    })
  }

  /**
   * 批量启停会一次改写整库状态，而「停用」不报错 —— 表现只是搜索慢慢没结果。
   * 「全选」又是跨分页选中全部筛选结果（几千个），所以必须让数量先露面再动手。
   */
  const confirmBatch = (verb: string) =>
    confirm(`将对 ${selectedIds.size} 个书源执行「${verb}」，确定继续吗？`)

  const handleBatchEnable = async () => {
    if (selectedIds.size === 0) return
    if (!confirmBatch('批量启用')) return
    setBusyBatch(true)
    try {
      const resp = await api.batchSources('enable', Array.from(selectedIds))
      toast.success(resp.message || `已批量启用 ${resp.affected} 个书源`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '启用失败')
    } finally {
      setBusyBatch(false)
    }
  }

  const handleBatchDisable = async () => {
    if (selectedIds.size === 0) return
    if (!confirmBatch('批量停用')) return
    setBusyBatch(true)
    try {
      const resp = await api.batchSources('disable', Array.from(selectedIds))
      toast.success(resp.message || `已批量停用 ${resp.affected} 个书源`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '停用失败')
    } finally {
      setBusyBatch(false)
    }
  }

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return
    const selectedSources = sources.filter(s => selectedIds.has(s.id))
    const namesSummary = selectedSources.slice(0, 3).map(s => s.name).join('、') + (selectedSources.length > 3 ? ` 等共 ${selectedSources.length} 项` : '')
    if (!confirm(`确定要彻底删除选中的 ${selectedIds.size} 个书源吗？\n（${namesSummary}）\n删除后不可恢复！`)) return
    setBusyBatch(true)
    try {
      const resp = await api.batchSources('delete', Array.from(selectedIds))
      toast.success(resp.message || `已删除 ${resp.affected} 个书源`)
      setSelectedIds(new Set())
      if (selected && selectedIds.has(selected.id)) {
        onSelect(null)
      }
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusyBatch(false)
    }
  }

  const handleBatchExport = async () => {
    if (selectedIds.size === 0) return
    setBusyBatch(true)
    try {
      const exportStrings = await api.exportSources(Array.from(selectedIds))
      const parsedList = exportStrings.map(str => {
        try { return JSON.parse(str) } catch { return null }
      }).filter(Boolean)
      const blob = new Blob([JSON.stringify(parsedList, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `legado_sources_export_${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast.success(`已成功导出 ${parsedList.length} 个书源`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导出失败')
    } finally {
      setBusyBatch(false)
    }
  }

  const handleBatchGroupConfirm = async (newGroup: string | null) => {
    if (selectedIds.size === 0) return
    setBusyBatch(true)
    try {
      const resp = await api.batchSources('set_group', Array.from(selectedIds), newGroup ?? undefined)
      toast.success(resp.message || `已更新 ${resp.affected} 个书源的分组`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '修改分组失败')
    } finally {
      setBusyBatch(false)
    }
  }

  const importSources = async (file: File | undefined) => {
    if (!file) return
    setImporting(true)
    try {
      const rawText = await file.text()
      const rawList = parseSourceJsonText(rawText)
      if (rawList.length === 0) {
        toast.error('未在文件中识别到有效的书源配置')
        setNotice('导入失败：未在文件中识别到有效的书源配置')
        return
      }
      const serialized = rawList
        .filter(item => item && typeof item === 'object')
        .map(item => JSON.stringify(item))
      if (serialized.length === 0) {
        toast.error('书源格式无效')
        setNotice('导入失败：书源格式无效')
        return
      }
      const result = await api.import(serialized)
      const importedCount = result.imported || 0
      const updatedCount = result.updated || 0
      const skippedCount = result.skipped || 0
      const parts = [`新增 ${importedCount} 个`, `更新 ${updatedCount} 个`]
      if (skippedCount > 0) parts.push(`跳过 ${skippedCount} 个`)
      let msg = `导入完成：${parts.join('，')}`
      if (result.errors && result.errors.length > 0) {
        const errorSummary = result.errors.slice(0, 3).join('；') + (result.errors.length > 3 ? ` 等共 ${result.errors.length} 项错误` : '')
        msg += ` (${errorSummary})`
      }
      setNotice(msg)
      if (importedCount > 0 || updatedCount > 0) {
        toast.success(`已导入/更新 ${importedCount + updatedCount} 个书源`)
      } else if (skippedCount > 0) {
        toast.error(result.errors?.[0] || '书源未能导入，请检查格式')
      }
      await load()
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : '导入失败'
      toast.error(errMsg)
      setNotice(`导入失败：${errMsg}`)
    } finally {
      setImporting(false)
    }
  }

  const remove = async () => {
    if (!selected || !confirm(`删除“${selected.name}”？`)) return
    try {
      await api.remove(selected.id)
      onSelect(null)
      await load()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除失败')
    }
  }

  return (
    <main className={`sources-page ${isBatchMode ? 'batch-mode-active' : ''}`}>
      <aside className="source-sidebar">
        <div className="source-sidebar-heading">
          <div className="source-sidebar-title-row">
            <span>书源</span>
            <small>{sources.length}</small>
          </div>
          <div className="source-sidebar-top-actions">
            <button
              type="button"
              className={`subtle-button health-probe-btn ${healthRun.running ? 'is-running' : ''}`}
              title={healthRun.running
                ? `体检正在后台跑：已检测 ${healthRun.checked} / ${healthRun.total}，途中已给 ${healthRun.autoTagged} 个不能正常使用的打上标签。点开看进度，收起不会停。`
                : '批量联网体检：每个源拿关键词试搜一次，只看能不能出条目。想先确认 JSON 写没写坏用编辑器里的「校验」（不联网），要看搜索→详情→目录→正文每一步用「调试」。'}
              onClick={() => setShowHealthModal(true)}
            >
              <Icon name="activity" />
              <span>{healthRun.running ? `体检中 ${healthRun.checked} / ${healthRun.total}` : '体检'}</span>
            </button>
            <button
              type="button"
              className={`subtle-button ${isBatchMode ? 'active-batch-btn' : ''}`}
              onClick={() => {
                setIsBatchMode(prev => !prev)
                setSelectedIds(new Set())
              }}
            >
              {isBatchMode ? '退出批量' : '批量管理'}
            </button>
          </div>
        </div>

        {allGroups.length > 0 && (
          <div className="source-group-filter-bar">
            <Select
              className="source-group-select"
              ariaLabel="按分组筛选书源"
              value={groupFilter}
              onChange={setGroupFilter}
              options={[
                { value: '', label: `全部分组 (${sources.length})` },
                ...groupStats.groups.map(([name, count]) => ({ value: name, label: `${name} (${count})` })),
                { value: '__none__', label: `未分组 (${groupStats.ungrouped})` },
              ]}
            />
          </div>
        )}

        <div className="source-filter">
          <Icon name="search" />
          <input placeholder="筛选书源" value={query} onChange={event => setQuery(event.target.value)} />
        </div>

        {orderedCount > 0 && (
          <div className="source-order-bar">
            <small>{orderedCount} 个书源有自定义位置；其余按名称排在后面</small>
            <button type="button" className="subtle-button" onClick={clearSourceOrder}
              title="清掉全部自定义位置，回到只按名称排（切分组、筛选都不会清）">
              清除自定义顺序
            </button>
          </div>
        )}

        <button
          type="button"
          className="primary-button source-create-btn"
          onClick={() => { setCreating(true); onSelect(null) }}
        >
          <Icon name="plus" />
          新建书源
        </button>

        <label className={`import-button ${importing ? 'disabled' : ''}`}>
          <Icon name="upload" />
          {importing ? '导入中…' : '导入 JSON'}
          <input
            type="file"
            accept="application/json,.json,text/plain,.txt,*"
            disabled={importing}
            onChange={event => {
              const file = event.target.files?.[0]
              event.target.value = ''
              void importSources(file)
            }}
          />
        </label>

        {notice && <p className="sidebar-notice">{notice}</p>}

        <nav ref={sourceListRef} className={`source-list ${isBatchMode ? '' : 'source-list-sortable'}`} aria-label="书源列表">
          {visibleSources.map((source, index) => {
            const isChecked = selectedIds.has(source.id)
            const isCurrent = selected?.id === source.id

            if (isBatchMode) {
              return (
                <div
                  key={source.id}
                  className={`source-list-item batch-item ${isChecked ? 'checked' : ''}`}
                  onClick={() => toggleSelect(source.id)}
                >
                  <label className="batch-checkbox-wrap" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleSelect(source.id)}
                    />
                  </label>
                  <div className="source-list-item-content">
                    <div className="source-list-item-title">
                      <span>{source.name}</span>
                      {!source.enabled && <span className="source-disabled-badge">已停用</span>}
                      {source.hasLogin && <span className="source-login-badge" title="支持登录鉴权">登录</span>}
                    </div>
                    <small>{splitSourceGroups(source.group).join(' · ') || (source.isJsSource ? 'JS 书源' : '未分组')}</small>
                  </div>
                </div>
              )
            }

            return (
              <button
                className={`source-list-item${isCurrent ? ' selected' : ''}${sourceDrag?.from === index ? ' source-item-dragging' : ''}${sourceDrag && sourceDrag.at === index && sourceDrag.from !== index ? ' source-item-drop-before' : ''}`}
                key={source.id}
                type="button"
                onPointerDown={onSourcePointerDown(index)}
                onClickCapture={onSourceClickCapture}
                onClick={() => { setCreating(false); onSelect(source) }}
                onContextMenu={event => showContextMenu(event, [
                  { label: '编辑此书源', icon: 'edit', onSelect: () => { setCreating(false); onSelect(source) } },
                  { label: '分阶段调试', icon: 'activity', onSelect: () => setDebugModalSource(source) },
                  ...(source.hasLogin ? [{ label: '登录 / Cookie', icon: 'logOut' as const, onSelect: () => setLoginModalSource(source) }] : []),
                  {
                    label: source.enabled ? '停用此书源' : '启用此书源',
                    icon: source.enabled ? 'close' : 'check',
                    onSelect: () => void flipOne(source),
                  },
                  { label: '分享书源', icon: 'copy', onSelect: () => setShareIds([source.id]) },
                  { label: '删除此书源', icon: 'trash', danger: true, onSelect: () => void removeOne(source) },
                ])}
              >
                <div className="source-list-item-title">
                  <span>{source.name}</span>
                  {!source.enabled && <span className="source-disabled-badge">已停用</span>}
                  {source.hasLogin && <span className="source-login-badge" title="支持登录鉴权">登录</span>}
                </div>
                <small>{splitSourceGroups(source.group).join(' · ') || (source.isJsSource ? 'JS 书源' : '未分组')}</small>
                <span
                  className={`source-enable-switch${source.enabled ? ' is-on' : ''}`}
                  role="switch"
                  aria-checked={source.enabled}
                  tabIndex={0}
                  title={source.enabled ? '点击停用此书源' : '点击启用此书源'}
                  aria-label={source.enabled ? `停用 ${source.name}` : `启用 ${source.name}`}
                  onClick={event => { event.stopPropagation(); void flipOne(source) }}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); void flipOne(source) } }}
                >
                  <span className="source-enable-switch-knob" />
                </span>
              </button>
            )
          })}
          {visibleSources.length < filteredSources.length && (
            <button type="button" className="source-list-more" onClick={() => setVisibleSourceCount(count => count + SOURCE_PAGE_SIZE)}>
              已显示 {visibleSources.length} / {filteredSources.length}，点击加载更多
            </button>
          )}
        </nav>
      </aside>

      <section className="sources-content">
        <header className="page-title">
          <div>
            <h1>书源管理</h1>
            <p>导入、校验与维护你的阅读来源。</p>
          </div>
          <div className="page-title-actions">
            {selected && (
              <button type="button" className="danger-button" onClick={() => void remove()}>
                删除书源
              </button>
            )}
          </div>
        </header>
        <SourceEditor
          selected={selected}
          creating={creating}
          summary={sourceStats}
          onSaved={() => void load()}
          onCreateCancel={() => setCreating(false)}
          onCreated={source => {
            setCreating(false)
            onSelect(source)
          }}
          onOpenLogin={source => setLoginModalSource(source)}
          onOpenDebug={source => setDebugModalSource(source)}
          onSearchInLibrary={searchInLibrary}
        />
      </section>

      {/* Floating Batch Action Bar */}
      {isBatchMode && (
        <aside className="source-batch-bar" aria-label="书源批量操作工具栏">
          <div className="batch-bar-left">
            <span className="batch-bar-count">
              已选 <strong>{selectedIds.size}</strong> / {filteredSources.length}
            </span>
            <div className="batch-select-helpers">
              <button type="button" className="subtle-button compact" onClick={handleSelectAll}>
                全选
              </button>
              <button type="button" className="subtle-button compact" onClick={handleClearAll}>
                全不选
              </button>
              <button type="button" className="subtle-button compact" onClick={handleInvertSelection}>
                反选
              </button>
            </div>
          </div>
          <div className="batch-bar-right">
            <button
              type="button"
              className="subtle-button"
              disabled={selectedIds.size === 0 || busyBatch}
              onClick={() => void handleBatchEnable()}
            >
              批量启用
            </button>
            <button
              type="button"
              className="subtle-button"
              disabled={selectedIds.size === 0 || busyBatch}
              onClick={() => void handleBatchDisable()}
            >
              批量停用
            </button>
            <button
              type="button"
              className="subtle-button"
              disabled={selectedIds.size === 0 || busyBatch}
              onClick={() => setShowGroupModal(true)}
            >
              修改分组
            </button>
            <button
              type="button"
              className="subtle-button"
              disabled={selectedIds.size === 0 || busyBatch}
              onClick={() => void handleBatchExport()}
            >
              导出选中
            </button>
            <button
              type="button"
              className="subtle-button"
              disabled={selectedIds.size === 0 || busyBatch}
              onClick={() => setShareIds(Array.from(selectedIds))}
            >
              分享选中
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={selectedIds.size === 0 || busyBatch}
              onClick={() => void handleBatchDelete()}
            >
              批量删除
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setIsBatchMode(false)
                setSelectedIds(new Set())
              }}
            >
              完成
            </button>
          </div>
        </aside>
      )}

      {showHealthModal && (
        <SourceHealthModal
          sources={sources}
          sourcesState={sourcesState}
          onClose={() => setShowHealthModal(false)}
          onSourcesChange={() => void load()}
          onToast={(msg, type) => {
            if (type === 'error') toast.error(msg)
            else if (type === 'success') toast.success(msg)
            else toast.info(msg)
          }}
        />
      )}

      {showGroupModal && (
        <SourceGroupModal
          selectedCount={selectedIds.size}
          existingGroups={allGroups}
          onConfirm={handleBatchGroupConfirm}
          onClose={() => setShowGroupModal(false)}
        />
      )}

      {debugModalSource && (
        <SourceDebugModal
          sourceId={debugModalSource.id}
          sourceName={debugModalSource.name}
          onClose={() => setDebugModalSource(null)}
        />
      )}

      {loginModalSource && (
        <SourceLoginModal
          sourceId={loginModalSource.id}
          sourceName={loginModalSource.name}
          onClose={() => setLoginModalSource(null)}
          onToast={(msg, type) => {
            if (type === 'error') toast.error(msg)
            else if (type === 'success') toast.success(msg)
            else toast.info(msg)
          }}
        />
      )}
      {shareIds && (
        <SourceShareModal
          sourceIds={shareIds}
          sources={sources}
          onClose={() => setShareIds(null)}
          onToast={(msg, type) => { if (type === 'error') toast.error(msg); else if (type === 'success') toast.success(msg); else toast.info(msg) }}
        />
      )}
    </main>
  )
}

/** 关键词 → 编译好的正则：每张结果卡每次渲染都 new RegExp 纯属浪费，按关键词缓存（小型 FIFO）。 */
const highlightRegexCache = new Map<string, RegExp>()
function keywordRegex(keyword: string): RegExp {
  let re = highlightRegexCache.get(keyword)
  if (!re) {
    re = new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    if (highlightRegexCache.size > 20) highlightRegexCache.clear()
    highlightRegexCache.set(keyword, re)
  }
  return re
}

function HighlightText({ text, keyword }: { text: string; keyword: string }) {
  const cleanK = cleanTitle(keyword).trim()
  if (!cleanK || !text) return <>{text}</>

  const parts = text.split(keywordRegex(cleanK))

  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === cleanK.toLowerCase() ? (
          <mark key={i} className="search-highlight">{part}</mark>
        ) : (
          part
        )
      )}
    </>
  )
}

const SEARCH_HISTORY_KEY = 'legado-search-history'
const readSearchHistory = (): string[] => {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
const writeSearchHistory = (list: string[]): void => {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list.slice(0, 10)))
  } catch {
    /* 隐私模式或配额满时静默忽略 */
  }
}

function LibraryPage({ sources, onSourcesChanged, onOpen }: { sources: SourceSummary[]; onSourcesChanged: () => void; onOpen: (book: OpenBook, index: number) => void }) {
  const search = useSearchStore()
  // 范围模式放进 store：书源编辑器的「在书库里搜这个源」要能设好它再跳过来（用户 2026-10-09）
  const scopeMode = search.scopeMode
  const setScopeMode = search.setScopeMode
  const [scopeGroup, setScopeGroup] = useState('')
  const [includeDisabledSources, setIncludeDisabledSources] = useState(false)
  const enabledSourceCount = useMemo(() => sources.filter(source => source.enabled).length, [sources])
  const [history, setHistory] = useState<string[]>(readSearchHistory)
  const recordHistory = (keyword: string) => {
    const kw = keyword.trim()
    if (!kw) return
    setHistory(prev => {
      const next = [kw, ...prev.filter(h => h !== kw)].slice(0, 10)
      writeSearchHistory(next)
      return next
    })
  }
  const handleSearch = (event: FormEvent) => {
    event.preventDefault()
    if (scopeMode !== 'all' && !scopeIds.length) {
      search.setKeyword(search.keyword)
      toast.warning(scopeMode === 'group' ? '这个分组里没有处于启用状态的书源，换一组或先去「书源」页启用' : '先选一个书源，或改用「全部书源」')
      return
    }
    search.setSelectedSourceIds(scopeMode === 'all' ? null : scopeIds)
    recordHistory(search.keyword)
    search.startSearch()
  }
  const groupOptions = useMemo(() => {
    const tally = new Map<string, { total: number; ready: number }>()
    for (const source of sources) {
      for (const tag of splitSourceGroups(source.group)) {
        const row = tally.get(tag) ?? { total: 0, ready: 0 }
        row.total += 1
        if (source.enabled) row.ready += 1
        tally.set(tag, row)
      }
    }
    return [...tally.entries()]
      .map(([name, row]) => ({ name, ...row }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh-CN'))
  }, [sources])
  const scopeIds = useMemo(() => {
    if (scopeMode === 'single') return search.selectedSourceId ? [search.selectedSourceId] : []
    if (scopeMode === 'group') return scopeGroup ? sources.filter(source => source.enabled && splitSourceGroups(source.group).includes(scopeGroup)).map(source => source.id) : []
    return []
  }, [scopeMode, scopeGroup, sources, search.selectedSourceId])
  // 提示要跟着本机状态走：一个停用源都没有时还写"停用的搜不到，需要时勾「含已停用」"，
  // 用户只会去找那个勾 —— 而它括号里明明写着 0。
  const disabledSourceCount = sources.length - enabledSourceCount
  const scopeHint = scopeMode === 'all'
    ? (disabledSourceCount === 0
        ? `库里 ${sources.length} 个书源全部处于启用状态，「全部书源」会挨个搜过去`
        : `库里 ${sources.length} 个书源，其中 ${enabledSourceCount} 个处于启用状态；「全部书源」只搜启用的这些`)
    : scopeMode === 'group'
      ? (scopeIds.length ? `将搜索该分组下 ${scopeIds.length} 个启用书源` : '该分组当前没有可搜的启用书源')
      : (search.selectedSourceId
        ? `只搜「${sources.find(source => source.id === search.selectedSourceId)?.name ?? '该书源'}」这一个源，结果最干净但也最容易空`
        : (disabledSourceCount === 0
            ? `下拉里是本机全部 ${sources.length} 个源，都在启用状态`
            : `下拉里只有启用中的 ${enabledSourceCount} 个源（停用的搜不到，需要时勾「含已停用」）`))
  const resumeIndex = search.openBook?.progress ? Math.min(Math.max(search.openBook.progress.chapterIndex, 0), Math.max(0, search.openBook.chapters.length - 1)) : 0
  const groups = useMemo(() => groupSearchResults(search.results), [search.results])
  const visibleGroups = useMemo(() => filterSearchGroups(groups, search.filters, search.keyword), [groups, search.filters, search.keyword])
  const hasFilters = !!search.filters.query.trim()
  // 三档展示形态与书架同一套词汇，但各存各的偏好（在书架看封面 ≠ 搜索时也想先看封面）。
  const [resultLayout, setResultLayout] = useState<ShelfLayout>(() => readSearchLayout())
  const chooseResultLayout = (next: ShelfLayout) => {
    setResultLayout(next)
    writeSearchLayout(next)
  }
  const completed = search.progress?.completedSources ?? 0
  const total = search.progress?.totalSources ?? 0
  const failures = search.progress?.failedSources ?? 0
  const empty = search.progress?.emptySources ?? 0

  return (
    <main className="library-page">
      <section className="library-hero">
        <span className="section-kicker">在线书库</span>
        <h1>找一本书，安静地读下去。</h1>
        <p>从已配置的书源搜索并继续上次阅读。</p>
        <form onSubmit={handleSearch}>
          <Icon name="search" />
          <input
            value={search.keyword}
            onChange={event => search.setKeyword(event.target.value)}
            placeholder="输入书名或作者"
          />
          {search.loading ? (
            <button
              key="stop-search-btn"
              type="button"
              className="primary-button"
              onClick={e => {
                e.preventDefault()
                e.stopPropagation()
                search.stopSearch()
              }}
            >
              停止搜索
            </button>
          ) : (
            <button
              key="start-search-btn"
              type="submit"
              className="primary-button"
            >
              搜索
            </button>
          )}
        </form>
        {history.length > 0 && (
          <div className="library-history" role="group" aria-label="最近搜索">
            <span className="library-history-label">最近搜索</span>
            <div className="library-history-chips">
              {history.map(item => (
                <button
                  key={item}
                  type="button"
                  className="library-history-chip"
                  onClick={() => { search.setKeyword(item); search.setSelectedSourceIds(scopeMode === 'all' ? null : scopeIds); recordHistory(item); search.startSearch() }}
                >
                  {item}
                </button>
              ))}
              <button type="button" className="library-history-clear" onClick={() => { setHistory([]); writeSearchHistory([]) }} title="清空搜索历史">清空</button>
            </div>
          </div>
        )}
        <div className="library-scope">
          <span className="library-scope-label">搜索范围</span>
          <div className="library-scope-modes" role="group" aria-label="搜索范围">
            {([['all', '全部书源'], ['group', '按分组'], ['single', '指定书源']] as const).map(([key, label]) => (
              <button key={key} type="button" className={scopeMode === key ? 'active' : ''} onClick={() => setScopeMode(key)}>{label}</button>
            ))}
          </div>
          {scopeMode === 'group' && (
            <Select
              ariaLabel="按分组搜索"
              placeholder="选择分组"
              value={scopeGroup}
              onChange={setScopeGroup}
              options={groupOptions.map(item => ({ value: item.name, label: item.name, hint: `可搜 ${item.ready} / 共 ${item.total}` }))}
            />
          )}
          {scopeMode === 'single' && (
            <>
              <Select
                ariaLabel="指定书源搜索"
                placeholder={sources.length ? '选择书源' : '书源还在载入'}
                value={search.selectedSourceId}
                onChange={search.setSelectedSourceId}
                options={sourcePickerOptions(sources, includeDisabledSources)}
              />
              {/* 默认只列启用中的：停用的源选了必然搜不到，那正是"这个功能不能正常使用"的来源。
                  一个停用源都没有时这条勾不出现 —— 留着它只是让人去勾一个括号里写 0 的开关。 */}
              {disabledSourceCount > 0 && (
                <label className="library-scope-toggle">
                  <input type="checkbox" checked={includeDisabledSources} onChange={event => setIncludeDisabledSources(event.target.checked)} />
                  含已停用（{disabledSourceCount}）
                </label>
              )}
            </>
          )}
          <small className="library-scope-hint">{scopeHint}</small>
        </div>
        {/*
          搜完了但一本都没命中时也必须给一句结论。原来这一行只在 loading/stopped 时渲染，
          搜完空结果就整行消失、这一屏退回「快速入口」，用户看不出刚才发生过搜索
          （用户 2026-10-01：「指定源搜索还没做好」里就有这一半）。
        */}
        {(search.loading || search.stopped || (search.progress !== null && groups.length === 0)) && (
          <p className="library-search-status" role="status">
            {search.stopped
              ? `已停止，已获得 ${groups.length} 本书。`
              : search.loading
                ? `已获得 ${groups.length} 本书，已检查 ${completed} / ${total} 个书源${failures || empty ? `，失败 ${failures} 个、无结果 ${empty} 个` : ''}…`
                : `搜完了：检查 ${completed} / ${total} 个书源，命中 ${search.progress?.matchedSources ?? 0} 本`
                  + `${failures || empty ? `（失败 ${failures} · 无结果 ${empty}）` : ''}。`
                  + (scopeMode === 'single'
                    ? '这个源没返回这本书，换个书源或改个关键词再搜。'
                    : '没有一本书命中，换个关键词、换一组书源，或改用「全部书源」再搜。')}
          </p>
        )}
      </section>
      {groups.length === 0 && !search.loading && (
        <section className="library-idle" aria-label="快速入口">
          <a href="#shelf">
            <strong><Icon name="bookmark" /> 书架</strong>
            <small>接着上次没读完的地方读，也可以拖入本地 TXT / EPUB。</small>
          </a>
          <a href="#explore">
            <strong><Icon name="activity" /> 发现</strong>
            <small>读读书源自带的榜单与分类分栏，挑一本新的。</small>
          </a>
          <a href="#sources">
            <strong><Icon name="list" /> 书源</strong>
            <small>当前接入 {sources.length} 个书源，可导入、体检和逐阶段调试。</small>
          </a>
        </section>
      )}
      {search.message && <p className="form-error library-message">{search.message}</p>}
      {groups.length > 0 && (
        <section className="library-results">
          <header>
            <h2>搜索结果</h2>
            <div className="library-results-tools">
              {/* 筛选与排序原来单独占一条工具条（用户 2026-10-09：挪进结果表头，省一整行） */}
              <label className="library-filter-inline">
                <Icon name="search" />
                <input
                  value={search.filters.query}
                  onChange={event => search.setFilters(current => ({ ...current, query: event.target.value }))}
                  placeholder="筛选书名或作者"
                  aria-label="筛选书名或作者"
                />
              </label>
              <small>{visibleGroups.length} 本书{hasFilters && ` / ${groups.length}`}</small>
              <span className="library-sort-picker">
                排序
                <Select
                  ariaLabel="搜索结果排序"
                  value={search.filters.sortMode}
                  onChange={value => search.setFilters(current => ({ ...current, sortMode: value as SortMode }))}
                  options={[
                    { value: 'smart', label: '智能推荐' },
                    { value: 'sources', label: '书源最多' },
                    { value: 'exact', label: '精准优先' },
                    { value: 'name', label: '书名 A-Z' },
                  ]}
                />
              </span>
              {/* 与书架同一套三档：网格看封面、列表看简介、紧凑列表一屏塞最多。 */}
              <div className="shelf-layout-picker" role="group" aria-label="搜索结果布局">
                <button
                  type="button"
                  className={resultLayout.mode === 'grid' ? 'active' : ''}
                  aria-label="封面网格"
                  title="封面网格：一行多张封面，挑书先看脸"
                  onClick={() => chooseResultLayout({ mode: 'grid' })}
                >
                  <Icon name="columns" />
                </button>
                <button
                  type="button"
                  className={resultLayout.mode === 'list' ? 'active' : ''}
                  aria-label="列表"
                  title="列表：一行一本，右边显示简介"
                  onClick={() => chooseResultLayout({ mode: 'list' })}
                >
                  <Icon name="list" />
                </button>
                <button
                  type="button"
                  className={resultLayout.mode === 'compact' ? 'active' : ''}
                  aria-label="紧凑列表"
                  title="紧凑列表：只看书名、作者与来源数，一屏放最多"
                  onClick={() => chooseResultLayout({ mode: 'compact' })}
                >
                  <Icon name="menu" />
                </button>
              </div>
            </div>
          </header>
            {/*
              三档共用同一份 DOM（与书架同一套做法）：切换只改容器类名，
              由 CSS 决定封面、简介、hover 层谁显示 —— 换档不重新拉数据，也不改变点击行为。
            */}
            <div className={`search-grid search-mode-${resultLayout.mode}`}>
              {visibleGroups.map(group => {
                const isExact = isExactMatch(group, search.keyword)
                // 同书多源的类型：全部一致才挂徽标（音频/漫画/文件/视频）
                const groupType = commonBookType(group.sources.map(source => source.sourceType))
                const groupTypeMeta = bookTypeMeta(groupType)
                // 封面取第一个真给了地址的源；referer 也用它 —— 防盗链图站按来源放行
                const coverSource = group.sources.find(source => source.coverUrl?.trim())
                const cover = sanitizeImageUrl(coverSource?.coverUrl)
                const blurb = pickBlurb(group)
                return (
                  <button
                    key={group.key}
                    type="button"
                    className={`search-card ${isExact ? 'exact-match' : ''}`}
                    onClick={() => void search.openGroup(group)}
                    aria-label={`打开《${group.name}》${group.author ? `，作者 ${group.author}` : ''}，${group.sources.length} 个书源`}
                  >
                    <span className="search-card-cover">
                      <SearchCover cover={cover} name={group.name} author={group.author} referer={coverSource?.sourceId} />
                      {/* 列表态封面只有 48px，完整文字书封塞不下 —— 换两字版（DOM 共用，CSS 按档切换） */}
                      <span className="search-card-cover-mini"><CoverFallback name={group.name} author={group.author} compact /></span>
                      <span className="search-card-hover">
                        <strong>{group.name}</strong>
                        <p>{group.author || '未知作者'}</p>
                        <dl>
                          <div><dt>来源</dt><dd>{group.sources.length} 个书源</dd></div>
                          {isExact && <div><dt>匹配</dt><dd>书名与关键词一致</dd></div>}
                          <div><dt>简介</dt><dd>{group.sources.some(source => source.intro?.trim()) ? '有' : '无'}</dd></div>
                        </dl>
                        <span>点击查看这本书</span>
                      </span>
                    </span>
                    <strong className="search-card-name" title={group.name}><HighlightText text={group.name} keyword={search.keyword} /></strong>
                    {groupTypeMeta && <span className={`book-type-badge type-${groupType}`}>{groupTypeMeta.label}</span>}
                    <small className="search-card-author">{group.author || '未知作者'}</small>
                    <small className="search-card-sources">{group.sources.length} 个书源{isExact ? ' · 精准匹配' : ''}</small>
                    {/* 只有列表档显示：挑书时最该看的是这本书讲什么，而不是又一个书名。没简介也没最新章就整栏不渲染。 */}
                    {blurb && <small className="search-card-intro">{blurb}</small>}
                  </button>
                )
              })}
            </div>
            {visibleGroups.length === 0 && <p className="library-filter-empty">没有符合当前筛选条件的书籍。</p>}
          </section>
      )}
      {search.openBook && (
        <BookDetailModal
          book={search.openBook}
          choices={search.choices}
          sources={sources}
          onSourcesChanged={onSourcesChanged}
          resumeIndex={resumeIndex}
          onOpen={index => onOpen(search.openBook!, index)}
          onChooseSource={choice => void search.chooseSource(choice)}
          onClose={() => search.setOpenBook(null)}
        />
      )}
    </main>
  )
}

function BookInfoEditModal({
  item,
  onSaved,
  onClose,
}: {
  item: BookshelfItem
  onSaved: (updated: BookshelfItem) => void
  onClose: () => void
}) {
  const [name, setName] = useState(item.name)
  const [author, setAuthor] = useState(item.author || '')
  const [coverUrl, setCoverUrl] = useState<string | null>(null) // null = keep existing, '' = clear, string = new URL
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useEscapeClose(onClose)

  const candidateCovers = useMemo(() => {
    const map = new Map<string, { sourceId: string; coverUrl: string }>()
    for (const alt of item.alternateSources || []) {
      const url = sanitizeImageUrl(alt.coverUrl)
      if (url && !map.has(url)) {
        map.set(url, { sourceId: alt.sourceId, coverUrl: url })
      }
    }
    return Array.from(map.values())
  }, [item.alternateSources])

  const previewSrc = useMemo(() => {
    if (coverUrl === '') return null
    if (coverUrl) return sanitizeImageUrl(coverUrl)
    if (item.coverKey) return api.cover(item.coverKey)
    return null
  }, [coverUrl, item.coverKey])

  const handleSave = async (e: FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('书名不能为空')
      return
    }

    setSaving(true)
    setError('')
    try {
      const updated = await api.updateBookshelfInfo({
        sourceId: item.sourceId,
        bookUrl: item.bookUrl,
        name: trimmedName,
        author: author.trim() || undefined,
        coverUrl: coverUrl === null ? undefined : coverUrl,
      })
      toast.success(`《${updated.name}》信息已更新`)
      onSaved(updated)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新书籍信息失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay-backdrop is-topped" onClick={onClose}>
      <div
        className="dialog-shell size-s"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`编辑书籍信息: ${item.name}`}
      >
        <header className="dialog-head">
          <div>
            <h2>编辑书籍信息</h2>
          </div>
          <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>

        <form onSubmit={handleSave} className="book-info-edit-form">
          <div className="book-info-edit-body">
            {/* Cover Preview & Options */}
            <div className="edit-cover-section">
              <div className="edit-cover-preview-box">
                {previewSrc ? (
                  <img src={previewSrc} alt="封面预览" referrerPolicy="no-referrer" />
                ) : (
                  <div className="edit-cover-fallback">
                    <span>{name.trim().slice(0, 1) || '书'}</span>
                  </div>
                )}
                {coverUrl !== '' && (item.coverKey || coverUrl) && (
                  <button
                    type="button"
                    className="subtle-button clear-cover-btn"
                    onClick={() => setCoverUrl('')}
                    title="清除并使用文字占位封面"
                  >
                    清除封面
                  </button>
                )}
                {coverUrl === '' && (
                  <button
                    type="button"
                    className="subtle-button reset-cover-btn"
                    onClick={() => setCoverUrl(null)}
                    title="恢复原封面"
                  >
                    恢复原封面
                  </button>
                )}
              </div>

              <div className="edit-cover-inputs">
                <label className="edit-form-label">
                  <span>封面图片 URL</span>
                  <div className="input-with-icon">
                    <Icon name="image" />
                    <input
                      type="url"
                      placeholder="https://example.com/cover.jpg"
                      value={coverUrl === null ? '' : coverUrl}
                      onChange={e => setCoverUrl(e.target.value)}
                    />
                  </div>
                  <small>可粘贴图片网络地址，保存时将自动拉取并缓存到服务器</small>
                </label>

                {candidateCovers.length > 0 && (
                  <div className="candidate-covers-picker">
                    <span className="candidate-covers-title">从备选书源选择封面 ({candidateCovers.length})：</span>
                    <div className="candidate-covers-grid">
                      {candidateCovers.map(c => {
                        const isSelected = coverUrl === c.coverUrl
                        return (
                          <button
                            key={c.coverUrl}
                            type="button"
                            className={`candidate-cover-card ${isSelected ? 'selected' : ''}`}
                            onClick={() => setCoverUrl(c.coverUrl)}
                            title={`使用来自【${c.sourceId}】的封面`}
                          >
                            <img src={c.coverUrl} alt={c.sourceId} referrerPolicy="no-referrer" />
                            <small>{c.sourceId}</small>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Title & Author Fields */}
            <div className="edit-fields-section">
              <label className="edit-form-label">
                <span>书名 <span className="required-mark">*</span></span>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="请输入书名"
                />
              </label>

              <label className="edit-form-label">
                <span>作者</span>
                <input
                  type="text"
                  value={author}
                  onChange={e => setAuthor(e.target.value)}
                  placeholder="作者（可选）"
                />
              </label>
            </div>

            {error && <p className="form-error">{error}</p>}
          </div>

          <footer className="book-info-edit-footer">
            <button type="button" className="subtle-button" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving ? '保存中…' : '保存修改'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}

function BookManageModal({
  item,
  onClose,
  onSwitchSource,
  onCache,
  onCancelCache,
  onToggleCompleted,
  onUpdateInfo,
  onRemove,
  groups,
  onAssignGroup,
}: {
  item: BookshelfItem
  onClose: () => void
  onSwitchSource: () => void
  onCache: () => void
  onCancelCache: () => void
  onToggleCompleted: () => void
  onUpdateInfo: (updated: BookshelfItem) => void
  onRemove: () => void
  groups: BookGroup[]
  onAssignGroup: (groupId: number) => void
}) {
  const [editingInfo, setEditingInfo] = useState(false)
  useEscapeClose(onClose, editingInfo ? '.book-info-edit-modal' : undefined)
  const isCaching = item.cacheState === 'caching'
  const isReady = item.cacheState === 'ready'
  const isFailed = item.cacheState === 'failed'
  const percent = Math.min(100, Math.round((item.cachedChapters / Math.max(1, item.totalChapters || 1)) * 100))

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="dialog-shell size-s book-manage-sheet" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`书籍管理: ${item.name}`}>
        <header className="manage-sheet-header">
          <div className="manage-sheet-cover">
            <BookCover coverKey={item.coverKey} name={item.name} author={item.author} compact />
          </div>
          <div className="manage-sheet-info">
            <h3>{item.name}</h3>
            <p>
              {item.author || '未知作者'}
              {bookTypeMeta(item.sourceType) && <span className={`book-type-badge type-${item.sourceType}`}>{bookTypeMeta(item.sourceType)!.label}</span>}
            </p>
            <small>{item.completed ? '已读完' : item.chapterIndex === undefined ? '刚加入书架' : `阅读至第 ${item.chapterIndex + 1} 章`}</small>
          </div>
          <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </header>

        <div className="manage-sheet-actions">
          <button className="manage-action-row" onClick={() => setEditingInfo(true)}>
            <div className="action-icon"><Icon name="edit" /></div>
            <div className="action-text">
              <strong>编辑书籍信息</strong>
              <small>修改书名、作者或更换封面</small>
            </div>
            <Icon name="arrowRight" />
          </button>

          <div className="manage-group-box">
            <div className="manage-group-box-head">
              <div className="action-icon"><Icon name="folder" /></div>
              <div className="action-text">
                <strong>分组</strong>
                <small>{groups.find(group => group.id === (item.groupId ?? 0))?.name ?? '未分组'}</small>
              </div>
            </div>
            {/*
              这里原来是把**全部**分组摊成一排胶囊：十几个分组时还行，"分组一大堆"（用户 2026-09-30
              问的就是这个）就变成一堵墙，而且右键菜单那条「更多分组…」正是落到这里，等于把问题搬了个家。
              换成站内 Select：能按名字过滤、每条带本数，规模再大也只有一个控件的高度。
            */}
            <Select
              className="manage-group-select"
              ariaLabel="这本书的分组"
              searchable
              value={String(item.groupId ?? 0)}
              onChange={value => onAssignGroup(Number(value))}
              options={[
                { value: '0', label: '未分组' },
                ...groups.map(group => ({ value: String(group.id), label: group.name, hint: `${group.bookCount} 本` })),
              ]}
            />
          </div>

          {item.sourceId !== 'loc_book' && (
            <button className="manage-action-row" onClick={() => { onClose(); onSwitchSource() }}>
              <div className="action-icon"><Icon name="sliders" /></div>
              <div className="action-text">
                <strong>切换书源</strong>
                <small>{item.alternateSources?.length ? `已有 ${item.alternateSources.length} 个备选书源，可全网检索` : '在其他书源中搜索匹配并无缝替换'}</small>
              </div>
              <Icon name="arrowRight" />
            </button>
          )}

          {isCaching ? (
            <div className="manage-cache-box">
              <div className="manage-cache-info-row">
                <div className="action-icon"><Icon name="download" /></div>
                <div className="action-text">
                  <strong>正在离线缓存全本</strong>
                  <small>{percent}% ({item.cachedChapters} / {item.totalChapters || '?'}) 章</small>
                </div>
                <button className="subtle-button cancel-cache-link" onClick={onCancelCache}>取消缓存</button>
              </div>
              <div className="manage-cache-bar-track">
                <div className="manage-cache-bar-fill" style={{ width: `${percent}%` }} />
              </div>
            </div>
          ) : (
            <button className="manage-action-row" onClick={() => onCache()}>
              <div className="action-icon"><Icon name="download" /></div>
              <div className="action-text">
                <strong>{isReady ? '重新缓存 / 校验全本' : isFailed ? '重试离线缓存' : '离线缓存全本'}</strong>
                <small>{isReady ? `已离线缓存 ${item.cachedChapters} 章` : isFailed ? (item.cacheError || '部分章节未缓存，点击重试') : '预先下载全书正文以供离线阅读'}</small>
              </div>
              <Icon name="arrowRight" />
            </button>
          )}

          <button className="manage-action-row" onClick={() => { onClose(); onToggleCompleted() }}>
            <div className="action-icon"><Icon name="check" /></div>
            <div className="action-text">
              <strong>{item.completed ? '恢复为正在阅读' : '标记为已读完'}</strong>
              <small>{item.completed ? '移回「正在阅读」分组' : '移至「已读完」分组'}</small>
            </div>
            <Icon name="arrowRight" />
          </button>

          <button className="manage-action-row danger" onClick={() => { onClose(); onRemove() }}>
            <div className="action-icon"><Icon name="close" /></div>
            <div className="action-text">
              <strong>移出书架</strong>
              <small>清除阅读进度与离线缓存</small>
            </div>
            <Icon name="arrowRight" />
          </button>
        </div>
      </div>

      {editingInfo && (
        <BookInfoEditModal
          item={item}
          onSaved={updated => {
            onUpdateInfo(updated)
          }}
          onClose={() => setEditingInfo(false)}
        />
      )}
    </div>
  )
}

function ShelfPage({
  onOpen,
  sources,
  txtTocRule,
  onTxtTocRuleChange,
  tocRulesSignal,
}: {
  onOpen: (item: BookshelfItem) => void
  sources: SourceSummary[]
  txtTocRule: string
  onTxtTocRuleChange: (value: string) => void
  /** 从「设置 → TXT 分章规则」过来的"去开一下"信号（0 = 还没人点过）。 */
  tocRulesSignal: number
}) {
  const [items, setItems] = useState<BookshelfItem[]>([])
  const [message, setMessage] = useState('')
  const [switchingItem, setSwitchingItem] = useState<BookshelfItem | null>(null)
  const [managingItem, setManagingItem] = useState<BookshelfItem | null>(null)
  const [view, setView] = useState<'reading' | 'completed' | 'all'>('reading')
  const [groups, setGroups] = useState<BookGroup[]>([])
  /** 分组接口失败 ≠ 一个组都没有；界面必须把这两件事分开说。 */
  const [groupsFailed, setGroupsFailed] = useState(false)
  /** null = 不按分组筛（全部分组）；0 = 未分组；其余是 book_group.group_id */
  const [groupFilter, setGroupFilter] = useState<number | null>(null)
  const [layout, setLayout] = useState<ShelfLayout>(() => readShelfLayout())
  const [sort, setSort] = useState<ShelfSort>(() => readShelfSort())
  const chooseSort = (next: ShelfSort) => { setSort(next); writeShelfSort(next) }
  const [batchMode, setBatchMode] = useState(false)
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(new Set())
  
  // 批量操作辅助函数
  const toggleBookSelection = (sourceId: string, bookUrl: string) => {
    setSelectedBooks(prev => {
      const next = new Set(prev)
      const key = `${sourceId}::${bookUrl}`
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  
  const isBookSelected = (sourceId: string, bookUrl: string) => {
    return selectedBooks.has(`${sourceId}::${bookUrl}`)
  }
  
  const handleBatchDelete = async () => {
    if (selectedBooks.size === 0) {
      toast.warning('请先选择要删除的书籍')
      return
    }
    if (!confirm(`确定要删除选中的 ${selectedBooks.size} 本书吗？此操作不可恢复。`)) return
    
    const books = Array.from(selectedBooks).map(key => {
      const [sourceId, bookUrl] = key.split('::')
      return { sourceId, bookUrl }
    })
    
    try {
      const result = await api.batchDeleteBooks(books)
      toast.success(`已删除 ${result.deleted} 本书`)
      setSelectedBooks(new Set())
      setBatchMode(false)
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量删除失败')
    }
  }
  
  const handleBatchMoveToGroup = async (groupId: number | null) => {
    if (selectedBooks.size === 0) {
      toast.warning('请先选择要移动的书籍')
      return
    }
    
    const books = Array.from(selectedBooks).map(key => {
      const [sourceId, bookUrl] = key.split('::')
      return { sourceId, bookUrl }
    })
    
    try {
      const result = await api.batchMoveToGroup(books, groupId)
      toast.success(`已将 ${result.moved} 本书移动到${groupId === null ? '未分组' : '指定分组'}`)
      setSelectedBooks(new Set())
      setBatchMode(false)
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量移动失败')
    }
  }
  
  const handleBatchMarkAsRead = async (isRead: boolean) => {
    if (selectedBooks.size === 0) {
      toast.warning('请先选择要标记的书籍')
      return
    }
    
    const books = Array.from(selectedBooks).map(key => {
      const [sourceId, bookUrl] = key.split('::')
      return { sourceId, bookUrl }
    })
    
    try {
      const result = await api.batchMarkAsRead(books, isRead)
      toast.success(`已将 ${result.marked} 本书标记为${isRead ? '已读完' : '未读完'}`)
      setSelectedBooks(new Set())
      setBatchMode(false)
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '批量标记失败')
    }
  }
  
  const selectAllBooks = () => {
    const keys = items.map(item => `${item.sourceId}::${item.bookUrl}`)
    setSelectedBooks(new Set(keys))
  }
  
  const clearSelection = () => {
    setSelectedBooks(new Set())
  }
  
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  /** 「本地书分章规则」弹窗：从书架的导入动作旁边打开，不在「自定义」里。 */
  const [showTocRules, setShowTocRules] = useState(false)
  // 「设置」页那一行点过来时信号会 +1；第一次挂载（0）不弹，否则刷新一下页面就跳出弹窗
  useEffect(() => {
    if (tocRulesSignal > 0) setShowTocRules(true)
  }, [tocRulesSignal])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const previousStateRef = useRef<Map<string, string>>(new Map())

  const load = useCallback(async () => {
    try {
      // 分组请求失败不能当成"一个分组都没有"：那样书架会把"没载入成功"渲染成"你还没建分组"，
      // 右键菜单里的归组快捷项也会凭空消失（全库搜索压满工作线程时最容易撞上）。
      const [list, groupResult] = await Promise.all([
        api.bookshelf(),
        api.shelfGroups()
          .then(items => ({ items, failed: false }))
          .catch(() => ({ items: [] as BookGroup[], failed: true })),
      ])
      setGroups(groupResult.items)
      setGroupsFailed(groupResult.failed)
      list.forEach(curr => {
        const key = `${curr.sourceId}\u0000${curr.bookUrl}`
        const prevState = previousStateRef.current.get(key)
        if (prevState === 'caching' && curr.cacheState === 'ready') {
          toast.success(`《${curr.name}》全本离线缓存完成（共 ${curr.cachedChapters} 章）`)
        } else if (prevState === 'caching' && curr.cacheState === 'failed') {
          toast.warning(`《${curr.name}》缓存中断：${curr.cacheError || '未全部完成'}`)
        }
        previousStateRef.current.set(key, curr.cacheState)
      })
      setItems(list)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法载入书架')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleImportFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter(f => {
      const n = f.name.toLowerCase()
      return n.endsWith('.txt') || n.endsWith('.epub') || n.endsWith('.text')
    })
    if (list.length === 0) {
      toast.warning('请选择 .txt 或 .epub 格式的电子书文件')
      return
    }
    setUploading(true)
    toast.info(`正在解析并导入 ${list.length} 本本地书籍…`)
    try {
      // 导入时用「分章规则」那一档选中的规则；它是 App 那一份阅读设置里的同一个字段，
      // 不是书架自己另存的偏好（两处各存一份就会出现"选了却没生效"）。
      const resp = await api.importLocalBooks(list, txtTocRule)
      if (resp.imported > 0) {
        // 只报数量的 toast 等于没说：哪几本进来了、进到哪一组，要当场看得见
        const names = resp.results.filter(r => r.success).map(r => `《${r.name}》`).slice(0, 3).join('、')
        const more = resp.imported > 3 ? ` 等 ${resp.imported} 本` : ''
        toast.success(`已导入 ${resp.imported} 本并归到「本地」分组：${names}${more}`)
        await load()
      }
      if (resp.failed > 0) {
        const errorMsg = resp.results.filter(r => !r.success).map(r => `${r.filename}: ${r.error}`).join('; ')
        toast.error(`部分书籍导入失败（${resp.failed} 本）: ${errorMsg}`)
      }
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导入本地书籍失败')
    } finally {
      setUploading(false)
    }
  }

  const caching = items.some(item => item.cacheState === 'caching')
  useEffect(() => {
    if (!caching) return
    const timer = window.setInterval(load, 1200)
    return () => window.clearInterval(timer)
  }, [caching, load])

  const remove = async (item: BookshelfItem) => {
    if (!confirm(`移出“${item.name}”将清除书架、阅读进度和缓存封面，确定继续吗？`)) return
    try {
      await api.removeFromBookshelf(item.sourceId, item.bookUrl)
      setItems(values => values.filter(value => value.sourceId !== item.sourceId || value.bookUrl !== item.bookUrl))
      toast.info(`《${item.name}》已移出书架`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '移出失败')
    }
  }

  const cache = async (item: BookshelfItem) => {
    try {
      await api.cacheBookshelfBook(item.sourceId, item.bookUrl)
      setItems(values => values.map(value => value.sourceId === item.sourceId && value.bookUrl === item.bookUrl ? { ...value, cacheState: 'caching', cacheError: undefined } : value))
      previousStateRef.current.set(`${item.sourceId}\u0000${item.bookUrl}`, 'caching')
      toast.info(`已加入离线缓存队列，正在下载《${item.name}》…`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法开始缓存')
    }
  }

  const cancelCache = async (item: BookshelfItem) => {
    try {
      await api.cancelBookCache(item.sourceId, item.bookUrl)
      setItems(values => values.map(value => value.sourceId === item.sourceId && value.bookUrl === item.bookUrl ? { ...value, cacheState: 'failed', cacheError: '已取消缓存' } : value))
      previousStateRef.current.set(`${item.sourceId}\u0000${item.bookUrl}`, 'failed')
      toast.info(`已取消《${item.name}》的离线缓存`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '取消缓存失败')
    }
  }

  const handleSwitchShelfSource = async (chosen: { result: SearchResult; chapters: Chapter[]; targetChapterIndex: number }) => {
    if (!switchingItem) return
    const details = await api.details(chosen.result.sourceId, chosen.result.bookUrl)
    const fallbackCover = details.coverUrl?.trim() ||
      chosen.result.coverUrl?.trim() ||
      switchingItem.alternateSources?.find(s => s.coverUrl?.trim())?.coverUrl?.trim()

    await api.switchBookshelfSource({
      oldSourceId: switchingItem.sourceId,
      oldBookUrl: switchingItem.bookUrl,
      book: {
        sourceId: details.sourceId,
        bookUrl: chosen.result.bookUrl,
        name: cleanTitle(details.name?.trim() || switchingItem.name) || switchingItem.name,
        author: cleanAuthor(details.author?.trim() || switchingItem.author) || switchingItem.author,
        tocUrl: details.tocUrl,
        coverUrl: fallbackCover || undefined,
      },
      alternateSources: switchingItem.alternateSources,
    })
    setSwitchingItem(null)
    await load()
  }

  const setCompleted = async (item: BookshelfItem, completed: boolean) => {
    try {
      const updated = await api.setBookshelfCompleted(item.sourceId, item.bookUrl, completed)
      setItems(values => values.map(value => value.sourceId === item.sourceId && value.bookUrl === item.bookUrl ? updated : value))
      toast.success(completed ? `已将《${item.name}》标记为已读完` : `已将《${item.name}》恢复为正在阅读`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '更新阅读状态失败')
    }
  }

  /**
   * 缓存状态在 hover 层里用一句话说清楚，不再压三色徽章在封面上。
   * 值要短：这一层压在 111~180px 宽的封面上，「已缓存 1364 / 1364 章」这种整句
   * 在窄屏上会把 dl 顶出封面边界（source-scale-check 实测过 834 / 390 两档溢出）。
   */
  const cacheText = (item: BookshelfItem) => {
    if (item.cacheState === 'caching') return `缓存中 ${Math.min(100, Math.round((item.cachedChapters / Math.max(1, item.totalChapters || 1)) * 100))}%`
    if (item.cacheState === 'ready') return `${item.cachedChapters}${item.totalChapters ? ` / ${item.totalChapters}` : ''} 章`
    if (item.cacheState === 'failed') return item.cacheError ? `中断：${item.cacheError}` : '中断，可重试'
    return '未缓存'
  }
  const groupOf = (item: BookshelfItem) => groups.find(group => group.id === (item.groupId ?? 0) && group.id !== 0)
  /** 来源只显示主机名，并且去掉 `www.`：整串 `https://www.x.com/` 在 111px 的窄封面上要换三行。 */
  const sourceHostOf = (sourceId?: string) => {
    if (!sourceId) return '未知来源'
    const host = sourceId.replace(/^[a-z]+:\/\//i, '').split('/')[0].replace(/^www\./i, '')
    return host || sourceId
  }
  const groupNameOf = (item: BookshelfItem) => groupOf(item)?.name ?? ''
  /** 悬停「来源」要显示书源的中文名而非裸 host：用全局 sources 建 id→name 映射，取不到再退回 host。 */
  const sourceNameById = useMemo(() => new Map(sources.map(s => [s.id, s.name])), [sources])

  const visibleItems = useMemo(() => {
    const byStatus = view === 'all' ? items : items.filter(item => view === 'completed' ? item.completed : !item.completed)
    const filtered = groupFilter === null ? byStatus : byStatus.filter(item => (item.groupId ?? 0) === groupFilter)
    const progressOf = (item: BookshelfItem) => ((item.chapterIndex ?? 0) + 1) / Math.max(1, item.totalChapters || 1)
    const sorted = [...filtered]
    switch (sort) {
      case 'name': sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')); break
      case 'author': sorted.sort((a, b) => (a.author || '').localeCompare(b.author || '', 'zh-CN')); break
      case 'progress': sorted.sort((a, b) => progressOf(b) - progressOf(a)); break
      case 'custom': sorted.sort(compareCustomSort); break
      default: sorted.sort((a, b) => b.lastReadAt - a.lastReadAt)
    }
    return sorted
  }, [items, view, sort, groupFilter])
  const counts = { reading: items.filter(item => !item.completed).length, completed: items.filter(item => item.completed).length, all: items.length }

  /*
    长按拖动排序（用户 2026-10-02：「批量管理功能在，长按书籍可移动能排顺序（自定义）」）。
    只在「自定义」这一档生效：其它四档是按时间/名字排的，拖完下一次刷新就打回去了，
    那种"能拖但拖不住"比不能拖更糟。发送的是**当前这一列**（分组与状态筛过之后的）新顺序。
  */
  const gridRef = useRef<HTMLElement | null>(null)
  const applyOrder = useCallback((ordered: BookshelfItem[]) => {
    const rank = new Map(ordered.map((item, index) => [`${item.sourceId}\u0000${item.bookUrl}`, index + 1]))
    setItems(current => current.map(item => {
      const next = rank.get(`${item.sourceId}\u0000${item.bookUrl}`)
      return next === undefined ? item : { ...item, sortOrder: next }
    }))
    void api.reorderShelf(ordered.map(item => ({ sourceId: item.sourceId, bookUrl: item.bookUrl })))
      .catch(() => { setMessage('排序没能保存，刷新后会回到原来的顺序'); void load() })
  }, [load])
  const clearOrder = async () => {
    setItems(current => current.map(item => ({ ...item, sortOrder: null })))
    try { await api.clearShelfOrder() } catch { setMessage('自定义顺序没能清掉，刷新后会回到原样'); void load() }
  }
  const { drag, onPointerDown, onClickCapture } = useDragSort({
    itemSelector: '.shelf-card',
    enabled: () => sort === 'custom' && !batchMode,
    gridRef,
    items: visibleItems,
    onReorder: applyOrder,
  })
  const chooseLayout = (next: ShelfLayout) => { setLayout(next); writeShelfLayout(next) }
  const [addingGroup, setAddingGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [busyGroup, setBusyGroup] = useState(false)

  const submitGroup = async () => {
    const name = groupName.trim()
    if (!name) return
    setBusyGroup(true)
    try {
      const created = await api.createShelfGroup(name)
      setGroupName('')
      setAddingGroup(false)
      setGroupFilter(created.id)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '建组失败')
    } finally {
      setBusyGroup(false)
    }
  }

  const removeGroup = async (id: number) => {
    const group = groups.find(item => item.id === id)
    if (!group) return
    if (!confirm(`删除分组「${group.name}」？${group.bookCount ? `组里 ${group.bookCount} 本书会回到「未分组」，书本身不删。` : ''}`)) return
    setBusyGroup(true)
    try {
      await api.removeShelfGroup(id)
      setGroupFilter(null)
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除分组失败')
    } finally {
      setBusyGroup(false)
    }
  }

  /**
   * 归组。既给「书籍管理」弹窗用，也给书架右键的快捷项用 ——
   * 快捷项要有一句反馈，否则改了分组界面上看不出来（书还在原来的筛选结果里）。
   */
  const assignGroup = async (item: BookshelfItem, groupId: number, label?: string) => {
    try {
      const updated = await api.setBookGroup(item.sourceId, item.bookUrl, groupId)
      setItems(values => values.map(value => value.sourceId === item.sourceId && value.bookUrl === item.bookUrl ? updated : value))
      setManagingItem(current => (current && current.sourceId === item.sourceId && current.bookUrl === item.bookUrl ? updated : current))
      setGroups((await api.shelfGroups().catch(() => groups)))
      if (label) toast.success(`《${item.name}》已移到「${label}」`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '移动分组失败')
    }
  }
  // 上游书架头就是「继续阅读 + 统计」：最想看的是上次读到哪儿，而不是再挑一次封面。
  const resume = useMemo(() => items.filter(item => !item.completed).sort((a, b) => b.lastReadAt - a.lastReadAt)[0] ?? null, [items])
  const resumePercent = resume ? Math.min(100, Math.round((((resume.chapterIndex ?? 0) + 1) / Math.max(1, resume.totalChapters || 1)) * 100)) : 0

  return (
    <main
      className={`shelf-page ${dragOver ? 'drag-active' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOver(false)
        }
      }}
      onDrop={e => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          void handleImportFiles(e.dataTransfer.files)
        }
      }}
    >
      <header className="shelf-bar">
        <h1>书架<small>{counts.all} 本</small></h1>
        <div className="shelf-header-actions">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.epub,.text,application/epub+zip,text/plain"
            style={{ display: 'none' }}
            onChange={e => {
              if (e.target.files && e.target.files.length > 0) {
                void handleImportFiles(e.target.files)
                e.target.value = ''
              }
            }}
          />
          <button
            type="button"
            className="shelf-import-btn"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            title="导入本地 TXT 或 EPUB 小说"
          >
            <Icon name="upload" />
            <span>{uploading ? '导入中…' : '导入本地'}</span>
          </button>
          {/* 分章规则跟着导入走（用户 2026-10-03：「『自定义』弹窗成了杂物间」）：
              只有准备导一本书时才会想起它，所以入口就放在那颗导入按钮旁边。 */}
          <button
            type="button"
            className="shelf-import-btn"
            onClick={() => setShowTocRules(true)}
            title="本地 TXT 按哪条规则切章节"
          >
            <Icon name="list" />
            <span>分章规则</span>
          </button>
          <div className="shelf-layout-picker" role="group" aria-label="书架布局">
            <button
              type="button"
              className={layout.mode === 'grid' ? 'active' : ''}
              aria-label="封面网格"
              title="封面网格：列数随窗口宽度自动排布"
              onClick={() => chooseLayout({ mode: 'grid' })}
            >
              <Icon name="columns" />
            </button>
            <button
              type="button"
              className={layout.mode === 'list' ? 'active' : ''}
              aria-label="列表"
              title="列表：封面在左，含作者/进度/最后阅读"
              onClick={() => chooseLayout({ mode: 'list' })}
            >
              <Icon name="list" />
            </button>
            <button
              type="button"
              className={layout.mode === 'compact' ? 'active' : ''}
              aria-label="紧凑列表"
              title="紧凑列表：只看书名与进度"
              onClick={() => chooseLayout({ mode: 'compact' })}
            >
              <Icon name="menu" />
            </button>
          </div>
          <button
            type="button"
            className={`shelf-batch-btn ${batchMode ? 'active' : ''}`}
            title={batchMode ? '退出批量管理' : '进入批量管理模式'}
            onClick={() => {
              setBatchMode(prev => !prev)
              setSelectedBooks(new Set()) // 切换模式时清空选择
            }}
          >
            <Icon name={batchMode ? 'checkSquare' : 'square'} />
            <span>{batchMode ? '完成' : '批量管理'}</span>
          </button>
          {batchMode && (
            <div className="shelf-batch-toolbar">
              <button
                type="button"
                className="shelf-batch-action"
                onClick={selectAllBooks}
                title="全选当前页所有书籍"
              >
                全选
              </button>
              <button
                type="button"
                className="shelf-batch-action"
                disabled={selectedBooks.size === 0}
                onClick={clearSelection}
                title="清空选择"
              >
                清空
              </button>
              <span className="shelf-batch-separator">|</span>
              <button
                type="button"
                className="shelf-batch-action shelf-batch-danger"
                disabled={selectedBooks.size === 0}
                onClick={() => void handleBatchDelete()}
                title="删除选中的书籍"
              >
                <Icon name="trash" />
                删除 ({selectedBooks.size})
              </button>
              <button
                type="button"
                className="shelf-batch-action"
                disabled={selectedBooks.size === 0}
                onClick={() => void handleBatchMarkAsRead(true)}
                title="标记为已读完"
              >
                标已读
              </button>
              <button
                type="button"
                className="shelf-batch-action"
                disabled={selectedBooks.size === 0}
                onClick={() => void handleBatchMarkAsRead(false)}
                title="标记为未读完"
              >
                标未读
              </button>
              <Select
                ariaLabel="把选中的书移到分组"
                className="shelf-batch-group-select"
                placeholder="移到分组…"
                searchable
                disabled={selectedBooks.size === 0}
                value=""
                onChange={value => void handleBatchMoveToGroup(value === 'none' ? null : Number(value))}
                options={[
                  { value: 'none', label: '未分组' },
                  ...groups.map(group => ({ value: String(group.id), label: group.name, hint: `${group.bookCount} 本` })),
                ]}
              />
            </div>
          )}
          <div className="shelf-sort">
            <Select
              ariaLabel="书架排序"
              value={sort}
              onChange={value => chooseSort(value as ShelfSort)}
              options={[
                { value: 'recent', label: '按最后阅读' },
                { value: 'name', label: '按书名' },
                { value: 'author', label: '按作者' },
                { value: 'progress', label: '按阅读进度' },
                { value: 'custom', label: '自定义（长按拖动）' },
              ]}
            />
            {sort === 'custom' && items.some(item => item.sortOrder != null) && (
              <button
                type="button"
                className="subtle-button"
                title="把全架的自定义位置清空，回到「从没拖过」的状态（切到别的排序档不会清，那一档只是不看它）"
                onClick={() => void clearOrder()}
              >
                清除自定义顺序
              </button>
            )}
          </div>
        </div>
      </header>

      <nav className="shelf-tabs" aria-label="书架分组">
        {([['reading', '正在阅读'], ['completed', '已读完'], ['all', '全部']] as const).map(([key, label]) => (
          <button key={key} className={view === key ? 'active' : ''} onClick={() => setView(key)}>
            {label}<small>{counts[key]}</small>
          </button>
        ))}
      </nav>

      {groups.length > 0 && (
        <div className="shelf-group-bar">
          <button type="button" className={groupFilter === null ? 'active' : ''} onClick={() => setGroupFilter(null)}>全部分组</button>
          {groups.map(group => (
            <button key={group.id} type="button" className={groupFilter === group.id ? 'active' : ''} onClick={() => setGroupFilter(group.id)}>
              {group.name}<small>{group.bookCount}</small>
            </button>
          ))}
          <button type="button" className={groupFilter === 0 ? 'active' : ''} onClick={() => setGroupFilter(0)}>
            未分组<small>{items.filter(item => !item.groupId).length}</small>
          </button>
          {groupFilter === null || groupFilter === 0 ? (
            <button type="button" className="ghost-button shelf-group-new" onClick={() => setAddingGroup(true)}>新建分组</button>
          ) : (
            <button type="button" className="ghost-button shelf-group-remove" onClick={() => void removeGroup(groupFilter)}>删除分组</button>
          )}
        </div>
      )}
      {groups.length === 0 && (
        <div className="shelf-group-bar">
          {/* 分组没读出来时不许冒充"你还没建分组"——那会让用户去建第二个同名组，也不知道右键少了什么 */}
          {groupsFailed && (
            <span className="shelf-group-failed">
              分组没载入
              <button type="button" className="link-button" onClick={() => void load()}>重试</button>
            </span>
          )}
          <button type="button" className="ghost-button shelf-group-new" onClick={() => setAddingGroup(true)}>新建分组</button>
        </div>
      )}
      {addingGroup && (
        <form className="shelf-group-form" onSubmit={event => { event.preventDefault(); void submitGroup() }}>
          <input
            value={groupName}
            onChange={event => setGroupName(event.target.value)}
            placeholder="分组名（最长 24 字）"
            aria-label="新分组名称"
            maxLength={24}
            autoFocus
          />
          <button type="submit" className="primary-button" disabled={busyGroup}>建组</button>
          <button type="button" className="subtle-button" onClick={() => setAddingGroup(false)}>取消</button>
        </form>
      )}

      {resume && (
        <section className="shelf-resume" aria-label="继续阅读">
          <span className="shelf-resume-cover" onClick={() => onOpen(resume)} role="button" tabIndex={0} aria-label={`继续阅读 ${resume.name}`}>
            <BookCover coverKey={resume.coverKey} name={resume.name} author={resume.author} compact />
          </span>
          <div className="shelf-resume-info">
            <strong title={resume.name}>{resume.name}</strong>
            <small>
              {resume.completed ? '已读完' : `上次读到第 ${(resume.chapterIndex ?? 0) + 1} 章${resume.totalChapters ? ` / 共 ${resume.totalChapters} 章` : ''}`}
              {' · '}
              {new Date(resume.lastReadAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </small>
            <span className="shelf-resume-track" aria-hidden="true"><i style={{ width: `${resumePercent}%` }} /></span>
          </div>
          <button type="button" className="primary-button" onClick={() => onOpen(resume)}>继续阅读</button>
        </section>
      )}

      {message && <p className="form-error">{message}</p>}

      {items.length === 0 && !message ? (
        <section className="shelf-empty">
          <Icon name="book" />
          <h2>书架还是空的</h2>
          <p>在书库检索添加在线小说，或直接导入本地 TXT / EPUB 文件。</p>
          <button
            type="button"
            className="shelf-import-btn"
            style={{ marginTop: '12px' }}
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="upload" />
            <span>{uploading ? '正在解析导入…' : '导入本地 TXT / EPUB'}</span>
          </button>
        </section>
      ) : visibleItems.length === 0 ? (
        <section className="shelf-empty">
          <Icon name="book" />
          <h2>这个分组还是空的</h2>
        </section>
      ) : (
        <section
          ref={gridRef}
          className={`shelf-grid shelf-mode-${layout.mode} ${sort === 'custom' ? 'shelf-sortable' : ''}${batchMode ? ' is-batching' : ''}`}
        >
          {visibleItems.map((item, index) => {
            const isCaching = item.cacheState === 'caching'
            const isLocal = item.sourceId === 'loc_book'
            const percent = Math.min(100, Math.round((item.cachedChapters / Math.max(1, item.totalChapters || 1)) * 100))

            // 落点线：拖到哪两格之间，就在那一格的左/右缘亮一条竖线（最后一格之后画右缘）
            const dropBefore = drag !== null && drag.at === index && drag.from !== index
            const dropAfter = drag !== null && drag.at === index + 1 && index === visibleItems.length - 1

            return (
              <article
                key={`${item.sourceId}-${item.bookUrl}`}
                className={`shelf-card ${batchMode && isBookSelected(item.sourceId, item.bookUrl) ? 'selected' : ''}${drag?.from === index ? ' shelf-card-dragging' : ''}${dropBefore ? ' shelf-card-drop-before' : ''}${dropAfter ? ' shelf-card-drop-after' : ''}`}
                onPointerDown={onPointerDown(index)}
                onClickCapture={onClickCapture}
                onContextMenu={event => {
                  // 分组超过 8 个时，右键菜单里只放前 7 个 + "更多分组…"，避免菜单过长
                  const availableGroups = groups.filter(group => group.id !== 0 && group.id !== (item.groupId ?? 0))
                  const showAllGroups = availableGroups.length <= 8
                  const visibleGroups = showAllGroups ? availableGroups : availableGroups.slice(0, 7)
                  const hasMore = !showAllGroups

                  showContextMenu(event, [
                    { label: item.completed ? '重新阅读' : '继续阅读', icon: 'book', onSelect: () => onOpen(item) },
                    { label: '书籍管理', icon: 'settings', onSelect: () => setManagingItem(item) },
                    { label: '换源', icon: 'refresh', disabled: isLocal, onSelect: () => setSwitchingItem(item) },
                    { label: isCaching ? '取消缓存' : '缓存全本', icon: isCaching ? 'close' : 'download', onSelect: () => void (isCaching ? cancelCache(item) : cache(item)) },
                    { label: item.completed ? '标记未读完' : '标记已读完', icon: 'check', onSelect: () => void setCompleted(item, !item.completed) },
                    { label: '复制书名', icon: 'copy', onSelect: () => void navigator.clipboard?.writeText(`${item.name}${item.author ? ` — ${item.author}` : ''}`) },
                    ...visibleGroups.map(group => ({ label: `移到「${group.name}」`, icon: 'bookmark' as const, onSelect: () => void assignGroup(item, group.id, group.name) })),
                    ...(hasMore ? [{ label: `更多分组（还有 ${availableGroups.length - 7} 个）…`, icon: 'folder' as const, onSelect: () => setManagingItem(item) }] : []),
                    ...(item.groupId ?? 0) !== 0 ? [{ label: '移到「未分组」', icon: 'folder' as const, onSelect: () => void assignGroup(item, 0, '未分组') }] : [],
                    { label: '移出书架', icon: 'trash', danger: true, onSelect: () => void remove(item) },
                  ])
                }}
              >
                {/* 批量模式下的复选框 */}
                {batchMode && (
                  <div 
                    className="shelf-card-checkbox"
                    onClick={event => {
                      event.stopPropagation()
                      toggleBookSelection(item.sourceId, item.bookUrl)
                    }}
                    role="checkbox"
                    aria-checked={isBookSelected(item.sourceId, item.bookUrl)}
                    tabIndex={0}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        toggleBookSelection(item.sourceId, item.bookUrl)
                      }
                    }}
                  >
                    <Icon name={isBookSelected(item.sourceId, item.bookUrl) ? 'checkSquare' : 'square'} />
                  </div>
                )}
                
                {/*
                  封面：点它 = 继续阅读。徽章（「N章已缓存」「本地」）以前直接压在封面上，
                  一张卡三种底色，整架看下去很吵 —— 现在收进 hover 信息层：封面在背后模糊，
                  信息浮在上面（用户 2026-09-29 的口径）。触屏没有 hover，所以下方信息区
                  仍然常驻书名/进度，并且点它 = 打开「书籍管理」，动作一个都不少。
                */}
                <div
                  className="shelf-card-cover"
                  onClick={() => { if (batchMode) toggleBookSelection(item.sourceId, item.bookUrl); else onOpen(item) }}
                  role="button"
                  tabIndex={0}
                  aria-label={batchMode ? `${isBookSelected(item.sourceId, item.bookUrl) ? '取消选择' : '选择'} ${item.name}` : `继续阅读 ${item.name}`}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      if (batchMode) toggleBookSelection(item.sourceId, item.bookUrl); else onOpen(item)
                    }
                  }}
                >
                  <BookCover coverKey={item.coverKey} name={item.name} author={item.author} />
                  {isCaching && (
                    <div className="shelf-card-progress-track">
                      <div className="shelf-card-progress-fill" style={{ width: `${percent}%` }} />
                    </div>
                  )}
                  {/* 封面下沿不再画阅读进度（用户 2026-10-03）：读到哪儿在下面的章数/百分比、
                      hover 信息层与顶部「继续阅读」那条里都有。样式那边也删了，别只删一半。 */}
                  <div className="shelf-card-hover" aria-hidden="true">
                    <strong>{item.name}</strong>
                    <p>{item.author || '未知作者'}</p>
                    {/*
                      值要短：这一层压在 111~180px 宽的封面上，「已缓存 1364 / 1364 章」这种
                      整句在窄屏上会把 dl 顶出封面边界（source-scale-check 实测过 834/390 两档溢出）。
                      标签已经说了是什么，值就只留数字与结论。
                    */}
                    <dl>
                      <div><dt>进度</dt><dd>{item.completed ? '已读完' : item.chapterIndex === undefined ? '刚加入' : `${item.chapterIndex + 1}${item.totalChapters ? ` / ${item.totalChapters}` : ''} 章${item.totalChapters ? ` · ${Math.min(100, Math.round(((item.chapterIndex + 1) / item.totalChapters) * 100))}%` : ''}`}</dd></div>
                      <div><dt>缓存</dt><dd>{cacheText(item)}</dd></div>
                      <div><dt>上次</dt><dd>{new Date(item.lastReadAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd></div>
                      {(item.tocUpdatedAt ?? 0) > 0 && <div><dt>更新</dt><dd>{new Date(item.tocUpdatedAt!).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd></div>}
                      {/* 来源：本地书直说；在线书给书源显示名（sources 传入后建 id→name 映射），取不到再退回 host */}
                      <div><dt>来源</dt><dd>{isLocal ? '本地导入' : (sourceNameById.get(item.sourceId) || sourceHostOf(item.sourceId))}</dd></div>
                      {!isLocal && !!item.alternateSources?.length && <div><dt>换源</dt><dd>{item.alternateSources.length} 个源</dd></div>}
                      {!!groupNameOf(item) && <div><dt>分组</dt><dd>{groupNameOf(item)}</dd></div>}
                      {!!item.author && <div><dt>作者</dt><dd>{item.author}</dd></div>}
                    </dl>
                  </div>
                </div>

                <div
                  className="shelf-card-info"
                  role="button"
                  tabIndex={0}
                  aria-label={`管理《${item.name}》：缓存、换源、分组、移出书架`}
                  title="点击打开书籍管理"
                  onClick={() => setManagingItem(item)}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setManagingItem(item) } }}
                >
                  <h3 className="shelf-card-name" title={item.name}>{item.name}</h3>
                  <p className="shelf-card-author">{item.author || '未知作者'}</p>
                  <div className="shelf-card-meta">
                    {bookTypeMeta(item.sourceType) && (
                      <span className={`book-type-badge type-${item.sourceType}`}>{bookTypeMeta(item.sourceType)!.label}</span>
                    )}
                    <span className={`shelf-meta-chapter ${item.completed ? 'completed' : ''}`}>
                      {item.completed ? '已读完' : item.chapterIndex === undefined ? '刚加入书架' : `第 ${item.chapterIndex + 1} 章`}
                    </span>
                    {item.totalChapters > 0 && <span className="shelf-meta-percent">{Math.min(100, Math.round(((item.chapterIndex ?? 0) / item.totalChapters) * 100))}%</span>}
                    <time className="shelf-meta-when" dateTime={new Date(item.lastReadAt).toISOString()}>
                      {new Date(item.lastReadAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}
                    </time>
                  </div>
                </div>
              </article>
            )
          })}
        </section>
      )}

      {/* Book Management Modal */}
      {managingItem && (
        <BookManageModal
          item={managingItem}
          onClose={() => setManagingItem(null)}
          onSwitchSource={() => {
            const target = managingItem
            setManagingItem(null)
            setSwitchingItem(target)
          }}
          onCache={() => {
            void cache(managingItem)
            setManagingItem(prev => prev ? { ...prev, cacheState: 'caching' } : null)
          }}
          onCancelCache={() => {
            void cancelCache(managingItem)
            setManagingItem(prev => prev ? { ...prev, cacheState: 'failed', cacheError: '已取消缓存' } : null)
          }}
          onToggleCompleted={() => setCompleted(managingItem, !managingItem.completed)}
          groups={groups}
          onAssignGroup={groupId => void assignGroup(managingItem, groupId)}
          onUpdateInfo={updated => {
            setItems(values => values.map(v => v.sourceId === updated.sourceId && v.bookUrl === updated.bookUrl ? updated : v))
            setManagingItem(updated)
          }}
          onRemove={() => remove(managingItem)}
        />
      )}

      {/* Standalone Source Switch Modal for Shelf Book */}
      {switchingItem && (
        <SourceSwitchModal
          bookName={switchingItem.name}
          author={switchingItem.author}
          currentSourceId={switchingItem.sourceId}
          currentBookUrl={switchingItem.bookUrl}
          currentChapterIndex={switchingItem.chapterIndex}
          knownAlternateSources={switchingItem.alternateSources}
          onSwitch={handleSwitchShelfSource}
          onClose={() => setSwitchingItem(null)}
        />
      )}
      {showTocRules && (
        <TocRulesModal
          value={txtTocRule}
          onChange={onTxtTocRuleChange}
          onClose={() => setShowTocRules(false)}
          onImport={() => {
            // 导书这条动作就着这一屏做完：关掉弹窗、直接开文件选择，不再让人回去找那颗按钮
            setShowTocRules(false)
            fileInputRef.current?.click()
          }}
        />
      )}
    </main>
  )
}

function App() {
  const [ready, setReady] = useState(false)
  /**
   * 启动等待提示。这台服务不设身份、冷启动要几十秒（加载几千个书源、预热缓存），
   * 探活一次没问到只说明"它还没起来"——这时该做的是自动重试，而不是把人挡在一张
   * 「连不上本机服务 / 不是你的密码」的整屏页前面（用户 2026-10-08 要求删掉那张页）。
   */
  const [bootHint, setBootHint] = useState('')
  const [settings, setSettings] = useState<ReaderSettings>(loadReaderSettings)
  /**
   * 当前要挂在根上的皮肤类名（自定义皮肤是**叠**在内置皮肤上的，所以可能有两个类；
   * 理由见 `readerSettings.themeClassNames`）。收成一份，effect 与各处外壳同引，
   * 免得某一处忘了跟着改而少挂基类。
   */
  const skinClasses = themeClassNames(settings).join(' ')
  /**
   * 皮肤类**同时挂到 `<html>`**，不只挂在 `.app-shell` 上。
   * 起因是用户 2026-10-01：「指定源搜索还没做好，你看看在夜读模式下」——
   * `Select` 的下拉浮层是 `createPortal(…, document.body)`（必须如此：书架/订阅各有各的
   * 滚动容器与边框，绝对定位会被祖先裁掉），而 `--surface`/`--ink`/`--line` 这些变量原本只定义在
   * `.theme-*` 上、`.theme-*` 只在应用外壳那一层 → **portal 出来的浮层一个变量都拿不到**：
   * 实测菜单底色 `rgba(0,0,0,0)`、文字 `rgb(0,0,0)`。浅色模式只是描边发虚所以藏了很久。
   */
  useEffect(() => {
    const root = document.documentElement
    const stale = [...root.classList].filter(name => name.startsWith('theme-'))
    if (stale.length) root.classList.remove(...stale)
    root.classList.add(...themeClassNames(settings))
  }, [skinClasses])
  /**
   * 系统标题栏/状态栏那条边跟着皮肤走。取的是 `<html>` 上**算出来**的 `--canvas`，
   * 不是前端写死的三档色表 —— 自定义皮肤（叠在某一档之上的那一套）只有这样才取得到。
   * 声明顺序要紧：它必须排在上面挂类的那个 effect 之后，否则读到的是上一个皮肤的值。
   */
  useEffect(() => {
    const canvas = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim()
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', canvas || '#f8f9f7')
  }, [skinClasses])
  const [page, setPage] = useState<Page>(pageFromHash)
  const [readerReturnPage, setReaderReturnPage] = useState<Page>('shelf')
  const [sources, setSources] = useState<SourceSummary[]>([])
  /** 服务端 /healthz 报回来的版本号，显示在顶栏功能菜单里；构建清单是唯一来源。 */
  const [serverVersion, setServerVersion] = useState('')
  const [selected, setSelected] = useState<SourceSummary | null>(null)
  const [reader, setReader] = useState<{ book: OpenBook; index: number } | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(readerStorageKey) ?? 'null')
    } catch {
      return null
    }
  })
  const [showReplaceRules, setShowReplaceRules] = useState(false)
  const [pageDialog, setPageDialog] = useState<PageDialogKind | null>(dialogFromHash())
  const [showOfflineCache, setShowOfflineCache] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  /** 「自定义」弹窗：只有皮肤那一档（界面布局随 v2 一起撤掉了）。 */
  const [showCustomize, setShowCustomize] = useState(false)
  /** 「设置 → 服务端口」：改的是安装根的 port.txt，重启青阅后生效。 */
  const [showServerPort, setShowServerPort] = useState(false)
  /**
   * 「设置 → TXT 分章规则」点下去的意图。规则弹窗连同它那颗「按这条导入本地书」都住在
   * 书架里（导书的动作在那边），所以这里只发一个"去开一下"的信号，不复制一份弹窗。
   */
  const [tocRulesSignal, setTocRulesSignal] = useState(0)
  /** 发现页点中的书：先进详情弹窗（与搜索页同一套），点「开始阅读」才进阅读器。 */
  const [explorePick, setExplorePick] = useState<{ result: SearchResult; book: OpenBook } | null>(null)
  const search = useSearchStore()

  useEffect(() => {
    saveReaderSettings(settings)
  }, [settings])

  useEffect(() => {
    const handleOnline = () => {
      void flushOfflineProgress(async (item) => {
        await api.saveProgress(item.sourceId, item.bookUrl, item.chapterUrl, item.chapterIndex, item.scrollPosition)
      })
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [])

  useEffect(() => {
    // 启动探活：问到就进界面；问不到就**自动重试**（服务冷启动要十几秒）。
    // 不再整屏挡住 —— 这台服务不设身份，"连不上"只意味着它还没起来或正在重启，
    // 该做的是等一等再试，而不是让人去猜一个根本不存在的密码。
    //
    // 两个刻意的取舍（用户 2026-10-09：「加载页转半分钟」）：
    // ① 每次探活**带超时**。原来 fetch 不带 signal：端口已 listen 但服务还没开始答请求时，
    //    这个 fetch 会一直挂着 —— `catch` 不触发、重试不启动、连"正在等待…"那句都换不出来，
    //    加载页就这么干等到服务答话。
    // ② 探活一过就放行，**不再等整份书源清单**（5,574 个源、~1MB）。书源在后台接着取，
    //    取回来再填进去；首屏不必为它多等几秒。
    let cancelled = false
    let timer: number | undefined
    let attempts = 0
    // 前 ~60s 每 1.5s 快速重试（期间停在加载页）；之后先进界面，再每 5s 慢轮询，服务起来会自愈。
    const FAST_UNTIL = 40
    const PROBE_TIMEOUT_MS = 2500
    const tick = async () => {
      if (cancelled) return
      attempts += 1
      if (attempts === 4) setBootHint('正在等待本机服务启动…（它可能正在重启，稍等片刻）')
      // 等了十几秒还没来，多半是服务压根没在跑 —— 给一句能照着做的。
      // 桌面那个青阅是 PWA 快捷方式，不会启动本机服务；真正能起服务的是同目录的 start.cmd。
      if (attempts === 12) setBootHint('本机服务还没起来。请双击桌面上的「青阅」启动它 —— 起来后会自动打开这一页。')
      const controller = new AbortController()
      const probeTimeout = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
      try {
        const response = await fetch('/healthz', { signal: controller.signal })
        if (!response.ok) throw new Error(`healthz ${response.status}`)
        // 版本号只认服务端报的这一个来源：Gradle 写进清单、/healthz 报出来、界面显示它。
        // 三处同一个数，不会出现"改了 build.gradle 忘了改界面"的假版本号。
        const health = await response.json().catch(() => null)
        if (cancelled) return
        if (health?.version) setServerVersion(String(health.version))
        setBootHint('')
        setReady(true)
        void api.sources().then(list => { if (!cancelled) setSources(list) }).catch(() => undefined)
      } catch {
        if (cancelled) return
        if (attempts === FAST_UNTIL) setReady(true) // 等够了先放行，别把人永远挡在加载页
        timer = window.setTimeout(tick, attempts < FAST_UNTIL ? 1500 : 5000)
      } finally {
        window.clearTimeout(probeTimeout)
      }
    }
    void tick()
    return () => { cancelled = true; if (timer) window.clearTimeout(timer) }
  }, [])

  useEffect(() => {
    // 深链与浏览器前进/后退都从这里走：命中悬浮层 hash（#backup 等）就开层、不换页（保住语境）；
    // 命中普通页面 hash 就换页并关掉可能还开着的悬浮层。
    const sync = () => {
      const dialog = dialogFromHash()
      setPageDialog(dialog)
      if (!dialog) setPage(pageFromHash())
    }
    addEventListener('hashchange', sync)
    return () => removeEventListener('hashchange', sync)
  }, [])

  const navigate = (next: Page) => {
    if (next === 'reader' && !reader) return
    location.hash = `#${next}`
    setPage(next)
  }

  // 桌面手感（借鉴悦读）+ 全局快捷键（表在 web/src/shortcuts.ts，「快捷键」那张表渲染同一份）。
  // 阅读器里不抢 Ctrl+F —— 在长正文里找字，浏览器原生查找更好用。
  useEffect(() => {
    const NAV: Page[] = PRIMARY_PAGES.map(item => item.page as Page)
    const focusSearch = () => {
      // 这一页上的"搜索框"措辞不统一（输入书名或作者 / 筛选书名或作者 / 筛选书源），
      // 只按"搜索"两个字找会一条都找不到 —— Ctrl+F 原来就是这么哑着的。
      const input = document.querySelector<HTMLInputElement>(
        'main input[type="search"], .source-filter input, '
        + 'main input[placeholder*="搜索"], main input[placeholder*="筛选"], main input[placeholder*="输入"]')
      if (!input) return false
      input.focus()
      input.select()
      return true
    }
    const handler = (event: KeyboardEvent) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const current = NAV.indexOf(page)
        if (current < 0) return
        event.preventDefault()
        navigate(NAV[(current + (event.key === 'ArrowRight' ? 1 : NAV.length - 1)) % NAV.length])
        return
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f' && page !== 'reader') {
        if (focusSearch()) event.preventDefault()
        return
      }
      const key = normalizeKey(event)
      if (!key || isTypingTarget(event.target, key)) return
      const hit = shortcutFor(GLOBAL_SHORTCUTS, key)
      if (!hit) return
      // 阅读器里那些单字母键归阅读器自己（D/S/T/F/M…）；只有这张表在哪都要能开
      if (page === 'reader' && hit.action !== 'help' && hit.action !== 'close-help') return
      if (hit.action === 'search') {
        if (focusSearch()) event.preventDefault()
      } else if (hit.action === 'help') {
        event.preventDefault()
        setShowShortcuts(value => !value)
      } else if (hit.action === 'close-help') {
        setShowShortcuts(value => (value ? false : value))
      } else if (hit.action === 'logs') {
        event.preventDefault()
        setShowLogs(true)
      } else if (hit.page) {
        event.preventDefault()
        navigate(hit.page as Page)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [page, showShortcuts])

  const openReader = (book: OpenBook, index: number, origin: Page = 'library') => {
    const fallbackCover = book.details.coverUrl || book.details.alternateSources?.find(s => s.coverUrl?.trim())?.coverUrl?.trim()
    void api.addToBookshelf({
      sourceId: book.details.sourceId,
      bookUrl: book.bookUrl,
      name: book.details.name,
      author: book.details.author,
      tocUrl: book.details.tocUrl,
      coverUrl: fallbackCover || undefined,
      alternateSources: book.details.alternateSources,
    }).catch(error => {
      // 静默吞掉的后果是"书读着、进度却写到一本不在书架上的书"——至少要让人知道加架没成
      toast.error(`《${book.details.name}》没能加入书架：${error instanceof Error ? error.message : '未知原因'}`)
    })
    const value = { book, index }
    setReader(value)
    setReaderReturnPage(origin)
    sessionStorage.setItem(readerStorageKey, JSON.stringify(value))
    location.hash = '#reader'
    setPage('reader')
  }

  /**
   * 发现页点击：只取详情与目录，然后弹详情窗 —— 和搜索页走同一个 BookDetailModal。
   * 以前一步直达阅读器，等于在用户还没决定读不读的时候就把书塞进书架。
   */
  const openExploreDetail = async (result: SearchResult) => {
    const book = await loadSourceBook(result)
    setExplorePick({ result, book })
  }

  const openShelfItem = async (item: BookshelfItem) => {
    const fallbackCover = item.coverKey ? api.cover(item.coverKey) : (item.alternateSources?.find(s => s.coverUrl?.trim())?.coverUrl?.trim() || undefined)
    const safeDetails: BookDetails = {
      sourceId: item.sourceId,
      name: cleanTitle(item.name) || item.name,
      author: cleanAuthor(item.author) || item.author,
      coverUrl: fallbackCover,
      intro: undefined,
      tocUrl: item.tocUrl,
      alternateSources: item.alternateSources,
      // 书架条目带书源类型（服务端 json_extract 来的）—— 阅读器据此选播放器/图片流
      sourceType: item.sourceType,
    }

    try {
      const [chapters, progress] = await Promise.all([
        api.chapters(safeDetails.sourceId, safeDetails.tocUrl),
        api.progress(safeDetails.sourceId, item.bookUrl).catch(() => undefined),
      ])
      const resumeIdx = progress?.chapterIndex ?? item.chapterIndex ?? 0
      openReader({
        details: safeDetails,
        bookUrl: item.bookUrl,
        chapters,
        progress: progress || (item.chapterIndex !== undefined ? {
          sourceId: item.sourceId,
          bookUrl: item.bookUrl,
          chapterUrl: chapters[resumeIdx]?.url || '',
          chapterIndex: resumeIdx,
          scrollPosition: item.scrollPosition ?? 0,
          updatedAt: item.lastReadAt,
        } : undefined),
      }, resumeIdx, 'shelf')
    } catch (error) {
      // 这里原来会伪造一章（url = tocUrl）直接进阅读器：读者看到的是一个假章节，
      // 抓回来的其实是目录页内容，还会把 `chapterUrl=tocUrl` 当成真实进度写回服务端与 IndexedDB，
      // 下次联网打开就从这一章的假位置继续。目录取不到时宁可明确报错，不要进入坏状态。
      toast.error(error instanceof Error ? `无法打开《${item.name}》：${error.message}` : `无法打开《${item.name}》：目录加载失败`)
    }
  }

  if (!ready) {
    // 慢启动期间也要挂 PwaManager 与 Toast：更新提示、后台同步的反馈不能因为"还在等"就消失。
    return (
      <main className={`app-loading ${skinClasses}`}>
        <ToastContainer />
        <PwaManager />
        {/* 转一下至少说明"在动"，不是一张死页 —— 服务冷启动要十几秒，光一行字容易被当成卡死。 */}
        <div className="app-loading-box" role="status" aria-live="polite">
          <span className="app-loading-spinner" aria-hidden="true" />
          <span>{bootHint || '正在打开阅读空间…'}</span>
        </div>
      </main>
    )
  }

  if (page === 'reader' && reader) {
    return (
      <div className={`app-shell ${skinClasses}`}>
        <ToastContainer />
        {/* 阅读器这一支是自己那层 app-shell，浮层要自己挂一遍：
            不挂 ContextMenuLayer，卸载主壳时 publish 已被清成空函数，阅读器里右键就"什么都没发生"。 */}
        <ContextMenuLayer />
        {/* 阅读器崩了不该把外壳一起带走：正文那一支单独包一层，出口回到进入前的页面 */}
        <ErrorBoundary region="阅读器" onExit={() => navigate(readerReturnPage)}>
          <ReaderScreen
            openBook={reader.book}
            startIndex={reader.index}
            settings={settings}
            onSettingsChange={setSettings}
            onClose={() => navigate(readerReturnPage)}
          />
        </ErrorBoundary>
      </div>
    )
  }

  const refreshSources = () => {
    void api.sources().then(setSources).catch(() => undefined)
  }

  /**
   * 「设置」这一页的内容（用户 2026-10-03：「在我的里面新加一个设置，把一些 txt 目录规则、备份、
   * 替换净化之类的放进去」）。每行只做一件事：说清它管什么，然后打开**原来那一份**实现。
   * 这里不建第二套编辑器 —— 两处都能改，迟早两处不一样。
   */
  const settingsSections: SettingsSection[] = [
    {
      title: '规则',
      rows: [
        {
          title: '替换净化规则',
          hint: '正文里按正则删除广告与杂乱内容。',
          action: '打开规则',
          onClick: () => setShowReplaceRules(true),
        },
      ],
    },
    {
      title: '界面',
      rows: [{
        title: '皮肤与配色',
        hint: '晓白 / 护眼 / 夜读三档，外加自定义 CSS。',
        action: '打开自定义',
        onClick: () => setShowCustomize(true),
      }],
    },
    {
      title: '阅读',
      rows: [
        {
          title: '快捷键',
          hint: '阅读器与全局的按键表。',
          action: '看按键表',
          onClick: () => setShowShortcuts(true),
        },
        {
          title: '离线缓存',
          hint: '已下载到这台电脑浏览器里的章节。',
          action: '管理离线缓存',
          onClick: () => setShowOfflineCache(true),
        },
      ],
    },
    {
      title: '本地书',
      rows: [{
        title: 'TXT 分章规则',
        hint: '下一本导入的 TXT 按哪条切目录，以及哪几条参与「自动」打分。',
        action: '打开规则表',
        onClick: () => setTocRulesSignal(value => value + 1),
      }],
    },
    {
      title: '数据与诊断',
      rows: [
        {
          title: '备份包',
          hint: '导入手机备份包，或把本机的书源 / 书架 / 规则导出成一份。',
          action: '打开备份',
          onClick: () => setPageDialog('backup'),
        },
        {
          title: '运行日志',
          hint: '这台服务写了什么：级别、失败原因、错误计数。',
          action: '看日志',
          onClick: () => setShowLogs(true),
        },
      ],
    },
    {
      title: '服务',
      rows: [
        {
          title: '服务端口',
          hint: '青阅跑在哪个端口；改完重启青阅后生效。',
          action: '改端口',
          onClick: () => setShowServerPort(true),
        },
      ],
    },
  ]

  return (
    <div className={`app-shell ${skinClasses}`}>
      <SkinStyle settings={settings} />
      <ToastContainer />
      <ContextMenuLayer />
      <PwaManager />
      <FirstRunAgreement />
      <AppHeader
        page={page}
        settings={settings}
        searching={search.loading}
        onSettingsChange={setSettings}
        onNavigate={navigate}
        onOpenChangelog={() => setPageDialog('changelog')}
        onOpenAbout={() => setPageDialog('about')}
        onOpenCustomize={() => setShowCustomize(true)}
        version={serverVersion}
      />
      {page === 'sources' ? (
        <SourcesPage selected={selected} onSelect={setSelected} onSourcesChange={setSources} />
      ) : page === 'subscriptions' ? (
        <SubscriptionPage onSourcesChange={refreshSources} onNavigate={navigate} onOpenBackup={() => setPageDialog('backup')} />
      ) : page === 'settings' ? (
        <SettingsPage sections={settingsSections} />
      ) : page === 'shelf' ? (
        <ShelfPage
          sources={sources}
          onOpen={item => void openShelfItem(item)}
          txtTocRule={settings.txtTocRule}
          onTxtTocRuleChange={value => setSettings({ ...settings, txtTocRule: value })}
          tocRulesSignal={tocRulesSignal}
        />
      ) : page === 'explore' ? (
        <ExplorePage onOpen={openExploreDetail} />
      ) : (
        <LibraryPage sources={sources} onSourcesChanged={refreshSources} onOpen={(book, index) => openReader(book, index, 'library')} />
      )}
      {explorePick && page === 'explore' && (
        <BookDetailModal
          book={explorePick.book}
          choices={[{ result: explorePick.result, status: 'loaded', book: explorePick.book }]}
          sources={sources}
          onSourcesChanged={refreshSources}
          resumeIndex={0}
          onOpen={index => {
            const book = explorePick.book
            setExplorePick(null)
            openReader(book, index, 'explore')
          }}
          onChooseSource={() => undefined}
          onClose={() => setExplorePick(null)}
        />
      )}
      <ReplaceRulesModal
        isOpen={showReplaceRules || pageDialog === 'rules'}
        onClose={() => { setShowReplaceRules(false); if (pageDialog === 'rules') setPageDialog(null) }}
      />
      {pageDialog && pageDialog !== 'rules' && (
        <PageDialog title={PAGE_DIALOG_TITLES[pageDialog]} onClose={() => setPageDialog(null)}>
          {pageDialog === 'backup' && <BackupPage />}
          {pageDialog === 'changelog' && <ChangelogPage serverVersion={serverVersion} />}
          {pageDialog === 'about' && (
            <AboutPage
              onOpenChangelog={() => setPageDialog('changelog')}
              onOpenShortcuts={() => setShowShortcuts(true)}
            />
          )}
        </PageDialog>
      )}
      {showOfflineCache && (
        <OfflineCacheModal onClose={() => setShowOfflineCache(false)} />
      )}
      {showLogs && (
        <LogsModal onClose={() => setShowLogs(false)} />
      )}
      {showShortcuts && (
        <ShortcutHelp onClose={() => setShowShortcuts(false)} />
      )}
      {showCustomize && (
        <CustomizeModal settings={settings} onChange={setSettings} onClose={() => setShowCustomize(false)} />
      )}
      {showServerPort && (
        <ServerPortModal onClose={() => setShowServerPort(false)} />
      )}
    </div>
  )
}

// 根上这一层是最后兜底：连页面外壳自己抛错时，也不能剩一片白屏让人以为程序没了
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary region="页面">
    <App />
  </ErrorBoundary>,
)

import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api, BookDetails, BookshelfItem, SearchResult, SourceSummary } from './lib/api'
import { ContextMenuLayer } from './components/ContextMenu'
import { ReaderScreen } from './reader/ReaderScreen'
import type { OpenBook } from './reader/openBook'
import { ErrorBoundary } from './components/ErrorBoundary'
import { activeCustomSkin, loadReaderSettings, ReaderSettings, saveReaderSettings, themeClassNames } from './reader/readerSettings'
import { AppHeader } from './components/AppHeader'
import { FirstRunAgreement } from './components/FirstRunAgreement'
import { CustomizeModal } from './components/CustomizeModal'
import { ServerPortModal } from './components/ServerPortModal'
import { LabModal } from './plugins/labHost'
import { frontendPlugins } from './lab/pluginRegistry'
import type { UiContext } from './lib/uiContext'
import { cleanAuthor, cleanTitle } from './lib/searchFilters'
import { loadSourceBook, SourceChoice, SourceChoiceStatus, useSearchStore } from './lib/searchStore'
import { ReplaceRulesModal } from './components/ReplaceRulesModal'
import { PageDialog } from './components/PageDialog'
import { ExplorePage } from './pages/ExplorePage'
import { RssPage } from './pages/RssPage'
import { Select } from './components/Select'
import { OfflineCacheModal } from './components/OfflineCacheModal'
import { LogsModal } from './components/LogsModal'
import { ShortcutHelp } from './reader/ShortcutHelp'
import { GLOBAL_SHORTCUTS, isTypingTarget, normalizeKey, PRIMARY_PAGES, shortcutFor } from './reader/shortcuts'
import { SettingsPage } from './pages/SettingsPage'
import { buildSettingsSections } from './settings/settingsSections'
import { PwaManager } from './components/PwaManager'
import { flushOfflineProgress } from './lib/offlineStorage'
import { toast, ToastContainer } from './components/Toast'
import './styles.css'
import { Page, PageDialogKind } from './lib/nav'
import { BookDetailModal } from './components/BookDetailModal'
import { SourcesPage } from './pages/SourcesPage'
import { LibraryPage } from './pages/LibraryPage'
import { ShelfPage } from './pages/ShelfPage'

import { parseSourceJsonText, extractSourcesFromRaw, sanitizeImageUrl } from './sources/sourceImport'

export { extractSourcesFromRaw, parseSourceJsonText, sanitizeImageUrl }
export type { SourceChoice, SourceChoiceStatus }
const PAGE_DIALOG_TITLES: Record<PageDialogKind, string> = { rules: '替换净化规则' }
const readerStorageKey = 'legado-open-book-v1'
const pageFromHash = (): Page => location.hash === '#sources' ? 'sources' : location.hash === '#subscriptions' ? 'subscriptions' : location.hash === '#shelf' ? 'shelf' : location.hash === '#explore' ? 'explore' : location.hash === '#reader' ? 'reader' : location.hash === '#settings' ? 'settings' : 'library'
/** 旧深链进来仍开对的那一个悬浮层，不白屏也不跳页 */
const dialogFromHash = (): PageDialogKind | null => location.hash === '#rules' ? 'rules' : null

/**
 * 已下沉成插件的页面，它们的旧深链该开实验室的哪个条目。
 *
 * 0.8.3 起这些页面不在主程序里了（住 `plugins/` 里），但老书签/老链接还在 ——
 * 映射到实验室对应条目，比 404 或空弹窗都体面。
 */
const LAB_DEEP_LINKS: Record<string, string> = {
  '#changelog': 'changelog',
  '#backup': 'backup',
  '#about': 'about',
  '#reading-log': 'reading-log',
}

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
  const active = activeCustomSkin(settings)
  const id = active?.id ?? ''
  const css = (active?.css ?? '').trim()
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
  const [pageDialog, setPageDialog] = useState<PageDialogKind | null>(dialogFromHash())
  const [showOfflineCache, setShowOfflineCache] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  /** 「自定义」弹窗：只有皮肤那一档（界面布局随 v2 一起撤掉了）。 */
  const [showCustomize, setShowCustomize] = useState(false)
  /** 「设置 → 服务端口」：改的是安装根的 port.txt，重启青阅后生效。 */
  const [showServerPort, setShowServerPort] = useState(false)
  /**
   * 「实验室」（Lab）：悬浮式框架容器，承载还没进主界面的能力。
   * AI 接入是它目前登记的第一条实验条目 —— 实验室本身不认识 AI。
   */
  const [showLab, setShowLab] = useState(false)
  /** 实验室要直接打开哪个条目（点版本号进更新日志等）；空 = 第一条。 */
  const [labEntryId, setLabEntryId] = useState<string | undefined>(undefined)
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
        if (health?.version) {
          setServerVersion(String(health.version))
          // 插件里用 HOST_VERSION 声明的版本号，展示时替换成这个真实值
          // （前端不许写字面量版本号，见 HeaderMenu.test.ts）。
          frontendPlugins.setHostVersion(String(health.version))
        }
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
      // 旧深链兼容：这些页面在 0.8.3 都下沉成插件了（住实验室里）。
      // 老链接不该白屏、也不该留个没有渲染分支的空悬浮层 —— 引到实验室并直达对应条目。
      const labDeepLink = LAB_DEEP_LINKS[location.hash]
      if (labDeepLink) {
        setPageDialog(null)
        setLabEntryId(labDeepLink)
        setShowLab(true)
        return
      }
      const dialog = dialogFromHash()
      setPageDialog(dialog)
      if (!dialog) setPage(pageFromHash())
    }
    addEventListener('hashchange', sync)
    // 首次挂载也跑一次：直接打开 `/#backup` 这类深链时没有 hashchange 事件，
    // 不跑就等于"深链只对已经在页面里的人有效"—— 那正是新标签页打开老链接的常见场景。
    sync()
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
   * 当前界面上下文 —— 给实验室里的 AI 面板用（它随对话发给模型）。
   *
   * 只收集**真实存在**的状态：当前页、打开的浮层、选中的书源、正在读的书与章节。
   * 不做推断、不塞正文（正文让模型用工具去取，那才是插件级功能的用法）。
   */
  const currentUiContext: UiContext = {
    page,
    dialog: pageDialog,
    source: selected ? { id: selected.id, name: selected.name } : null,
    book: reader
      ? {
          sourceId: reader.book.details.sourceId,
          bookUrl: reader.book.bookUrl,
          name: reader.book.details.name,
          author: reader.book.details.author,
          chapterIndex: reader.index,
          chapterTitle: reader.book.chapters[reader.index]?.title,
        }
      : null,
    keyword: null,
  }

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
        onOpenChangelog={() => { setLabEntryId('changelog'); setShowLab(true) }}
        onOpenAbout={() => { setLabEntryId('about'); setShowLab(true) }}
        onOpenReadingLog={() => { setLabEntryId('reading-log'); setShowLab(true) }}
        onOpenCustomize={() => setShowCustomize(true)}
        version={serverVersion}
      />
      {page === 'sources' ? (
        <SourcesPage selected={selected} onSelect={setSelected} onSourcesChange={setSources} />
      ) : page === 'subscriptions' ? (
        <RssPage onOpenBackup={() => { setLabEntryId('backup'); setShowLab(true) }} />
      ) : page === 'settings' ? (
        <SettingsPage sections={buildSettingsSections({
          openShortcuts: () => setShowShortcuts(true),
          openOfflineCache: () => setShowOfflineCache(true),
          openCustomize: () => setShowCustomize(true),
          openReplaceRules: () => setPageDialog('rules'),
          openTocRules: () => setTocRulesSignal(value => value + 1),
          openBackup: () => { setLabEntryId('backup'); setShowLab(true) },
          openLogs: () => setShowLogs(true),
          openServerPort: () => setShowServerPort(true),
          openAiConnections: () => setShowLab(true),
        })} />
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
        isOpen={pageDialog === 'rules'}
        onClose={() => setPageDialog(null)}
      />

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
      {showLab && (
        <LabModal
          onClose={() => { setShowLab(false); setLabEntryId(undefined) }}
          uiContext={currentUiContext}
          serverVersion={serverVersion}
          initialEntryId={labEntryId}
          actions={{
            // 插件要"去别处"时用：实验室只转发，不解释这些 key 是什么。
            openChangelog: () => setLabEntryId('changelog'),
            openShortcuts: () => setShowShortcuts(true),
          }}
        />
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

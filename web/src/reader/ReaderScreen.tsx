// `VirtualChapterList` 在 `web/test/VirtualChapterList.test.ts` 里被 `renderToStaticMarkup` 静态渲染，
// 那条链路走 classic JSX（`React.createElement`），只有 Vite 构建才走 automatic runtime。
// 少这一行时页面与构建都正常，只有用例抛 `React is not defined`（AGENTS §5 的同形坑第三次：
// PageBar/Notice 一回、ShortcutHelp+useEscapeClose 一回、TapZoneEditor 一回，这是第四回）。
import React, { CSSProperties, Fragment, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, BookDetails, Chapter, ReadingProgress, SearchResult, TocRuleOption } from '../lib/api'
import { ContextMenuItem, showContextMenu } from '../components/ContextMenu'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'
import { Select } from '../components/Select'
import { calculatePaginationLayout, contentImageUrl, findFirstFullyVisibleParagraphIndex, isAtBottomBoundary, isAtTopBoundary, isInteractiveReaderTarget, isSameSiteAsset, isTapGesture, paginateWheelStep, swipeDirection, TOC_ROW_HEIGHT, ViewportBounds } from './readerInteractions'
import { mapCells, TapAction, zoneAt } from './tapZones'
import { isMediaType } from '../shelf/bookType'
import { TapZoneEditor } from './TapZoneEditor'
import { clampScrollPosition, defaultReaderSettings, effectiveReaderFontFamily, ReaderSettings, scrollPosition, themeClassNames, ttsSessionKey, TtsEngineType } from './readerSettings'
import { moveReaderMenu, READER_MENU_ITEMS, ReaderMenuAction, toggleReaderMenu } from './readerMenu'
import { flowAdvance, holdScroll, pageAlignmentPads, pageAlignmentStarts, pageProgress, pageWindowShift, resolveMeasuredPage, sectionAtPage, sectionProgress } from './readerFlow'
import { computeCenterScrollOffset, computeVirtualWindow } from './virtualSlice'
import { SourceSwitchModal } from '../sources/SourceSwitchModal'
import { cleanAuthor, cleanTitle } from '../lib/searchFilters'
import { toast } from '../components/Toast'
import { processChapterForTts, TtsChapterData } from './ttsTextProcessor'
import { ITtsEngine, WebSpeechEngine, HttpAudioTtsEngine, TtsPlayState, TtsSpeakMode, isPlayInterruptedError } from './ttsEngine'
import { TtsSettingsModal, SleepTimerOption } from './TtsSettingsModal'
import { TtsPlayerBar } from './TtsPlayerBar'
import { resetTtsBarPosition } from './ttsBarPosition'
import { isTypingTarget, normalizeKey, READER_SHORTCUTS, shortcutFor } from './shortcuts'
import { ReplaceRulesModal } from '../components/ReplaceRulesModal'
import { OfflineCacheModal } from '../components/OfflineCacheModal'
import {
  downloadChaptersToOffline,
  getOfflineChaptersSet,
  putOfflineChapter,
} from '../lib/offlineStorage'

/**
 * 图片预热：把一段正文里的 `![图](url)` 地址提前发给服务端图片代理，
 * 趁用户在看首屏时把后续图片取回落盘缓存（代理命中 7 天有效），
 * 滚动/翻页下去就不必每张都等服务端联网一次。漫画章节正文就是一张张图，
 * 这一项直接决定翻页顺不顺。
 * 只预热外域图（站内资产本就在本地）；失败静默 —— 渲染层 `<img>` 会自己退化成占位图。
 */
function warmContentImages(text: string, page: string | undefined) {
  if (!text) return
  for (const raw of text.split('\n')) {
    const image = contentImageUrl(raw)
    if (!image || isSameSiteAsset(image)) continue
    const img = new Image()
    img.decoding = 'async'
    img.src = api.bookImage(image, page)
  }
}

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
  ['qingzhu', '青竹'], ['mulan', '暮蓝'], ['meigui', '玫瑰'], ['shimo', '石墨'],
] as const

function IconButton({ label, icon, onClick, className = '', onDoubleClick, hint, disabled = false }: { label: string; icon: Parameters<typeof Icon>[0]['name']; onClick: () => void; className?: string; onDoubleClick?: () => void; hint?: string; disabled?: boolean }) {
  return <button className={`reader-icon-button ${className}`} title={hint ? `${label} · ${hint}` : label} aria-label={label} onClick={onClick} onDoubleClick={onDoubleClick} disabled={disabled}><Icon name={icon} /></button>
}

function SettingRange({ label, value, min, max, step, onChange, display }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; display: string }) {
  return <label className="setting-range"><span>{label}</span><output>{display}</output><input type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} /></label>
}

function ReaderSettingsControls({
  settings,
  onChange,
  onOpenReplaceRules,
  onEditTapZones,
  localBook,
  tocRuleOptions,
  onReparseLocal,
}: {
  settings: ReaderSettings
  onChange: (next: ReaderSettings) => void
  onOpenReplaceRules?: () => void
  /** 打开"在正文上编辑点击区域"那层。见 TapZoneEditor。 */
  onEditTapZones?: () => void
  /** 当前是导入到本机的书才给；在线书没有"目录规则"这件事。 */
  localBook?: { name: string; tocRule?: string | null } | null
  tocRuleOptions?: TocRuleOption[]
  /** 返回一句给人看的话；null 表示成功（成功的话由 reparseMessage 自己报）。 */
  onReparseLocal?: (ruleKey: string) => Promise<string | null>
}) {
  const update = (value: Partial<ReaderSettings>) => onChange({ ...settings, ...value })
  const [reparseBusy, setReparseBusy] = useState(false)
  const [reparseMessage, setReparseMessage] = useState('')
  /**
   * 「这本换成哪条重切」的暂选，**只影响这一本**：不写进 `settings.txtTocRule`，
   * 否则"给在读的这本换个规则"会顺手把下一本导入的默认规则也改掉（用户 2026-10-03：
   * 一个元素干两件事、功能分配不当）。null 表示还没改过，跟着这本当前生效的那条。
   */
  const [repick, setRepick] = useState<string | null>(null)
  const repickRule = repick ?? (localBook?.tocRule || 'auto')
  // 抽屉常驻挂载：换一本书读时那颗选择器要回到"跟着这本"，不能留着上一本的暂选。
  useEffect(() => { setRepick(null) }, [localBook?.name])
  const ruleLabelOf = (key?: string | null) =>
    tocRuleOptions?.find(option => option.key === (key || 'auto'))?.label ?? (key || '自动选择（按正文打分）')
  const runReparse = async () => {
    if (!onReparseLocal || reparseBusy) return
    setReparseBusy(true)
    setReparseMessage('')
    const failure = await onReparseLocal(repickRule).catch((error: unknown) => error instanceof Error ? error.message : '重切失败')
    setReparseMessage(failure ?? '')
    setReparseBusy(false)
  }
  return <div className="drawer-scroll-content">
    <section className="setting-section"><span className="setting-label">主题</span><div className="theme-grid">{themes.map(([theme, label]) => <button key={theme} className={`theme-choice swatch-${theme} ${settings.theme === theme ? 'selected' : ''}`} onClick={() => update({ theme })}><i>{settings.theme === theme && <Icon name="check" />}</i><small>{label}</small></button>)}</div></section>
    <section className="setting-section"><span className="setting-label">字体</span><label className="font-select"><select value={settings.font} onChange={event => update({ font: event.target.value as ReaderSettings['font'] })}><option value="song">思源宋体</option><option value="hei">黑体 / 苹方</option><option value="kai">华文楷体</option><option value="fangsong">华文仿宋</option><option value="yuan">圆体</option><option value="mono">等宽字体</option><option value="system">系统字体</option><option value="custom">自定义字体名…</option></select><Icon name="chevronDown" /></label>
      {settings.font === 'custom' && <input type="text" className="reader-text-input" value={settings.customFont} placeholder="本机已装字体，如：霞鹜文楷 / LXGW WenKai" onChange={event => update({ customFont: event.target.value })} />}
      {settings.font === 'custom' && <small className="setting-hint">填本机已装字体的名字（多个用逗号隔开，先找到的先用）；字体文件需要自己装进系统。</small>}
    </section>
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
      <section className="setting-section"><span className="setting-label">阅读背景</span>
        <div className="bg-row">
          <input type="color" className="reader-bg-color" value={settings.readerBgColor || '#ffffff'} onChange={event => update({ readerBgColor: event.target.value })} aria-label="背景颜色" />
          <button type="button" className="ghost-button" onClick={() => update({ readerBgColor: '', readerBgImage: '' })}>清除背景</button>
        </div>
        <input type="text" className="reader-text-input" value={settings.readerBgImage} placeholder="背景图 URL（http(s):// 或站内路径，可留空）" onChange={event => update({ readerBgImage: event.target.value })} />
        <SettingRange label="背景压暗" value={settings.readerBgDim} min={0} max={0.6} step={0.05} display={`${Math.round(settings.readerBgDim * 100)}%`} onChange={dim => update({ readerBgDim: dim })} />
        <small className="setting-hint">颜色与背景图铺在阅读区上，压暗让文字保持可读；全部清空则跟随主题。背景图只存在这台浏览器里。</small>
      </section>
    </section>
    <section className="setting-section"><span className="setting-label">翻页方式</span><div className="page-modes"><button className={settings.pageMode === 'scroll' ? 'selected' : ''} onClick={() => update({ pageMode: 'scroll' })}>连续滚动</button><button className={settings.pageMode === 'paginate' ? 'selected' : ''} onClick={() => update({ pageMode: 'paginate' })}>平移分页</button></div><small className="setting-hint">{settings.pageMode === 'paginate' ? '左右轻扫或点击屏幕两侧平滑翻页' : '垂直滚动阅读，点击上下可快速翻滚'}</small></section>
    {settings.pageMode === 'paginate' && (
      <section className="setting-section"><span className="setting-label">翻页动画</span><div className="page-modes">
        <button className={settings.pageAnim === 'slide' ? 'selected' : ''} onClick={() => update({ pageAnim: 'slide' })}>平移过渡</button>
        <button className={settings.pageAnim === 'fade' ? 'selected' : ''} onClick={() => update({ pageAnim: 'fade' })}>淡化</button>
        <button className={settings.pageAnim === 'none' ? 'selected' : ''} onClick={() => update({ pageAnim: 'none' })}>无动画</button>
      </div><small className="setting-hint">翻页时怎么过渡。连续滚动模式没有页，用不上这一项。</small></section>
    )}
    {/*
      点击区域改到正文上编辑（用户 2026-10-09：「这个改成底下一小行，可以折叠进去，目的是显示更多书籍内容」）：
      抽屉里只留一颗入口，真正的编辑器是盖在正文上的一层 —— 调分区时看得见书，控制条收在底部一行。
    */}
    <section className="setting-section">
      <span className="setting-label">点击区域</span>
      <button type="button" className="rules-setting-btn is-wide" onClick={onEditTapZones}>
        <span className="rules-setting-btn-label"><Icon name="sliders" />在正文上编辑点击区域</span>
        <Icon name="arrowRight" />
      </button>
      <small className="setting-hint">
        当前「{settings.pageMode === 'paginate' ? '平移分页' : '连续滚动'}」分
        {' '}{mapCells(settings.pageMode === 'paginate' ? settings.tapZones.paginate : settings.tapZones.scroll)} 区；
        进去在正文上拖横竖虚线改分区，改完立刻生效，不用重开这本书。
      </small>
    </section>
    <section className="setting-section"><span className="setting-label">分栏排版</span><div className="page-modes column-modes"><button className={settings.columnMode === 'auto' ? 'selected' : ''} onClick={() => update({ columnMode: 'auto' })}>自适应</button><button className={settings.columnMode === 'single' ? 'selected' : ''} onClick={() => update({ columnMode: 'single' })}>单栏</button><button className={settings.columnMode === 'double' ? 'selected' : ''} onClick={() => update({ columnMode: 'double' })}>双栏</button></div><small className="setting-hint">{settings.columnMode === 'auto' ? '宽屏 (≥800px) 自动开启双页分栏' : settings.columnMode === 'double' ? '固定双栏双页排版' : '固定单栏排版'}</small></section>
    {/*
      工具栏可配置（用户 2026-10-11「阅读菜单可配置」）。清单来自 readerMenu.ts ——
      与右上角工具栏的渲染是同一份，这里只改「显示哪些 / 什么顺序」，不重写按钮。
    */}
    <section className="setting-section">
      <span className="setting-label">工具栏</span>
      <div className="reader-menu-config">
        {READER_MENU_ITEMS.map(item => {
          const shown = settings.menuItems.includes(item.id)
          const index = settings.menuItems.indexOf(item.id)
          return (
            <div key={item.id} className={`reader-menu-row${shown ? '' : ' is-hidden'}`}>
              <button
                type="button"
                className="reader-menu-toggle"
                aria-pressed={shown}
                onClick={() => update({ menuItems: toggleReaderMenu(settings.menuItems, item.id) })}
              >
                <Icon name={shown ? 'check' : 'close'} />{item.label}
              </button>
              {shown && (
                <span className="reader-menu-move">
                  <button type="button" aria-label={`上移${item.label}`} disabled={index <= 0} onClick={() => update({ menuItems: moveReaderMenu(settings.menuItems, item.id, -1) })}>↑</button>
                  <button type="button" aria-label={`下移${item.label}`} disabled={index >= settings.menuItems.length - 1} onClick={() => update({ menuItems: moveReaderMenu(settings.menuItems, item.id, 1) })}>↓</button>
                </span>
              )}
            </div>
          )
        })}
      </div>
      <small className="setting-hint">右上角显示哪些按钮、按什么顺序。至少留一个。</small>
    </section>
    {/*
      这一档只管**手上这一本**（用户 2026-10-03：「抽屉里只留『这本用的哪条 + 重切』」）。
      "下一本导入用哪条"不在这儿改 —— 那是在书架「导入本地」旁边的「分章规则」弹窗里，
      两处各管一件事，就不会出现"想改这本却把默认值带跑了"。
      上面那句报的是**实际生效**的那条，不是框里选中的那条：选了 A 而 A 在这本书上切不出
      第二个章节时服务端会回落，界面不能装作 A 生效了。
    */}
    {!!localBook && (tocRuleOptions?.length ?? 0) > 0 && (
      <section className="setting-section">
        <span className="setting-label">本地书目录</span>
        <small className="setting-hint">
          这本《{localBook.name}》现在用的是「{ruleLabelOf(localBook.tocRule)}」。
          换规则会重切目录并清掉正文缓存，读到的位置会回到第 1 章（章号整个变了，没法照原样挪过去）。
        </small>
        {!!onReparseLocal && (
          <div className="toc-repick">
            <Select
              ariaLabel="换一条规则重切这本"
              value={repickRule}
              options={tocRuleOptions!
                .filter(option => !option.broken)
                .map(option => ({
                  value: option.key,
                  label: option.enable || option.builtIn || option.key === 'auto' ? option.label : `${option.label}（不参与自动）`,
                  hint: option.example || undefined,
                }))}
              onChange={setRepick}
            />
            <button type="button" className="rules-setting-btn" disabled={reparseBusy} onClick={() => void runReparse()}>
              {reparseBusy ? '正在重切目录…' : '按这条规则重新识别目录'}
            </button>
          </div>
        )}
        {!!reparseMessage && <small className="setting-hint">{reparseMessage}</small>}
      </section>
    )}
    {onOpenReplaceRules && (
      <section className="setting-section">
        <span className="setting-label">内容净化</span>
        {/* 之前这颗挂着 12 条内联样式，而隔壁「按这条规则重新识别目录」用同一个类名却是裸按钮
            —— 类名不管用、样式写在 JSX 里，改一处漏一处。现在两边都走 .rules-setting-btn。 */}
        <button type="button" className="rules-setting-btn is-wide" onClick={onOpenReplaceRules}>
          <span className="rules-setting-btn-label"><Icon name="edit" />替换净化规则管理</span>
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
  itemHeight = TOC_ROW_HEIGHT,
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

    const finalScroll = computeCenterScrollOffset(targetIndex, itemHeight, el.clientHeight, chapters.length)

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
  const slice = computeVirtualWindow({
    totalCount: count,
    itemHeight,
    scrollTop,
    viewportHeight: containerHeight,
    overscan,
  })
  const { startIndex, endIndex } = slice
  const topSpacer = slice.offsetY
  const bottomSpacer = slice.bottomSpacer

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
        // url 不能单独当 key：服务端 chapters() 不按地址去重（RuleRunner.kt:1389），
        // 上下篇共用一页、"本章完"重复条目都会给出同 url 两行 —— 撞 key 只 warning，门禁看不见
        return (
          <button
            key={`${chapter.index}-${chapter.url}`}
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
  /**
   * 续接窗口的**前面一半**（用户 2026-10-04：「你只是在两章之间起作用了，往回怎么办」）。
   *
   * 原来窗口只有尾巴：往回翻到第 0 页就 `changeChapter(-1,'last')` —— 换锚点、清空窗口、
   * 再按"当时量到的页数"跳到最后一页。而那一刻尾章还没挂上来、垫栏还没补上，页数还在变，
   * 于是落点算的是**旧窗口**的页码。实测（双栏、书「像素游戏成真了…」）：
   * 前进是 `8/15 → 1/16`（一步一页），后退一步却落到 `4/15` —— 第 11 章在这一窗里占 1–8 页，
   * 该回的是 8，落在中间就是"往回翻不知道自己在哪"。
   *
   * 现在改成与前进对称：往回翻到窗口开头时，把上一章**接到窗口前面**，页码整体加上它的页数，
   * 眼前这一页一个字都不动，"上一页"就真的只是上一页。不需要任何"猜最后一页"的算术。
   */
  const [flowHead, setFlowHead] = useState<{ chapter: Chapter; content: string }[]>([])
  const flowHeadRef = useRef<{ chapter: Chapter; content: string }[]>([])
  flowHeadRef.current = flowHead
  /** 刚把某一章接到窗口前面：先记着是哪一章，量完 DOM 才知道它占几页、页码要后移多少。 */
  const pendingPrependRef = useRef<string | null>(null)
  /** 分页模式下每一章占的页区间（量自排版后的 DOM），以及顶窗口之后该落到第几页。 */
  const pageSpansRef = useRef<{ start: number; end: number }[]>([])
  /** 量得的每章起始**栏**号（DOM 真值）。后退接章的页码补偿按它落页 —— 算术推的 spans 在
   *  垫栏/强制分栏有一处出入时就差半页（paginate-flow-check ④：接之前第 2 段落 vs 之后第 5 段落）。 */
  const measuredStartsRef = useRef<number[]>([])
  const columnsPerPageRef = useRef(1)
  /** 屏幕上真的对齐了吗（按 DOM 量出来的，不是按算术推的）—— 挪窗口的闸门看这个。 */
  const pageAlignedRef = useRef(true)
  const pendingPageRef = useRef<number | null>(null)
  const [chapterIndex, setChapterIndex] = useState(startIndex)
  /** 同一个手法：判断"只能往前顶"要读当前的那一个，不能闭包里那个早就过期的数字。 */
  const chapterIndexRef = useRef(chapterIndex)
  chapterIndexRef.current = chapterIndex
  const [content, setContent] = useState('')
  // 非文本章节（音频/EPUB 直链）：服务端把媒体地址放在 `mediaUrl`。离线缓存里没有这个字段，
  // 但音频源的 `content` 本身就是那串地址，所以渲染时用 `mediaUrl`，没有就用像 URL 的 `content`。
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [loadedChapterUrl, setLoadedChapterUrl] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [chapterQuery, setChapterQuery] = useState('')
  const deferredQuery = useDeferredValue(chapterQuery)
  const [activeDrawer, setActiveDrawer] = useState<'toc' | 'settings' | null>(null)
  /** 「在正文上编辑点击区域」那层开着没有（见 TapZoneEditor）。 */
  const [tapZoneEditing, setTapZoneEditing] = useState(false)
  /** 正在拖「目录 | 正文」那条边界（只为高亮它）。 */
  const [resizingSidebar, setResizingSidebar] = useState(false)
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
  /**
   * 目录抽屉底部那一块（离线缓存 + 这本书）默认收起（用户 2026-10-09：「这张图片位置内容折叠整理
   * 归纳到底部，不要影响目录显示」）—— 原来它常驻四五行，把章节列表挤得只剩几条。
   * 缓存进行中时强制展开，不然进度条看不见。
   */
  const [drawerFooterOpen, setDrawerFooterOpen] = useState(false)
  const [customRangeStart, setCustomRangeStart] = useState(1)
  const [customRangeEnd, setCustomRangeEnd] = useState(50)
  const [offlineTtsConfirmOpen, setOfflineTtsConfirmOpen] = useState(false)
  // 这两层都只认点击、不认 Esc —— 统一补上 Esc 关闭（PROPOSAL-018 W6 的"遮罩与关闭键必须走统一那一套"）
  useEscapeClose(() => setOfflineTtsConfirmOpen(false))
  useEscapeClose(() => setLightboxSrc(null))

  const [cacheStatus, setCacheStatus] = useState<{ state: string; cached: number; total: number; error?: string }>({
    state: 'idle',
    cached: 0,
    total: openBook.chapters.length,
  })

  // Pagination states
  const [pageIndex, setPageIndex] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  /** 每一章**前面**垫几栏空白（双栏时把章节边界对齐到页开头）；量出来的，见 measurePagination。 */
  const [pageFillers, setPageFillers] = useState<number[]>([])
  const [columnWidth, setColumnWidth] = useState(600)
  const [stride, setStride] = useState(640)
  const [isDoubleColumn, setIsDoubleColumn] = useState(false)
  const columnGap = 40

  /**
   * 翻页动画（参照 legado-with-MD3 的 PageAnim，Web 里做真的三种）：
   * `slide` 给 track 挂过渡类 —— 只在**逐页翻**（页码差 1）时挂；接章补偿/窗口挪动是几页的跳，
   * 滑过去反而像"又跳了一次"，所以大跳一律即时切。`fade` 在页码变化时把 track 淡出再淡回。
   * `none` 即时切换（改动前的行为）。连续滚动没有页，整段不生效。
   */
  const pageAnim = settings.pageMode === 'paginate' ? settings.pageAnim : 'none'
  const prevPageIndexRef = useRef(pageIndex)
  const [fading, setFading] = useState(false)
  const slideAnimOn = pageAnim === 'slide' && Math.abs(pageIndex - prevPageIndexRef.current) === 1
  useEffect(() => { prevPageIndexRef.current = pageIndex }, [pageIndex])
  useEffect(() => {
    if (pageAnim !== 'fade') return
    setFading(true)
    const timer = window.setTimeout(() => setFading(false), 150)
    return () => window.clearTimeout(timer)
  }, [pageIndex, pageAnim])

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
  // 滚轮增量累计量（像素）与"没在滚了就清零"的定时器：见 readerInteractions.paginateWheelStep
  const wheelAccumRef = useRef(0)
  const wheelIdleRef = useRef<number | null>(null)
  // Ref to the latest playTtsChunk so that async onEnd callbacks always invoke the freshest version,
  // avoiding stale closure issues when cross-chapter auto-play triggers after chapter content reloads.
  const playTtsChunkRef = useRef<(idx: number, mode?: TtsSpeakMode) => void>(() => undefined)

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  /** 正文区（.reader-main）：点击分区按它的矩形算，固定目录时不把目录栏算进去。 */
  const readerMainRef = useRef<HTMLElement | null>(null)
  const resizingSidebarRef = useRef(false)

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
  // 非文本章节（音频/视频/文件）：这一章的"正文"其实是一个媒体地址，不能当段落排出来。
  // 优先用服务端给的 `mediaUrl`；离线缓存没有它，但音频源的 `content` 本身就是那串地址，故兜底。
  const sourceType = currentBook.details.sourceType ?? 0
  const mediaSrc = useMemo(() => {
    if (!isMediaType(sourceType)) return null
    // 优先用服务端给的 mediaUrl；离线缓存没有它，但音频源的 content 本身就是那串地址，故兜底。
    const raw = mediaUrl ? mediaUrl : (() => {
      const trimmed = content.trim()
      return /^https?:\/\/\S+$/.test(trimmed) ? trimmed : null
    })()
    if (!raw) return null
    // 外域地址走服务端媒体代理（注入 Referer + 转发 Range），本站内的原样返回。
    if (isSameSiteAsset(raw)) return raw
    return api.bookMedia(raw, chapter.url)
  }, [sourceType, mediaUrl, content, chapter.url])
  // 过渡期间大标题跟着正文走（挂着上一章的标题），新章名只出现在「正在载入」那条里 ——
  // 标题是新的、正文是旧的，比两者都旧更容易让人以为串了章。
  const shownChapterTitle = isStaleContent ? (currentRef.current?.chapter.title || chapter?.title) : chapter?.title
  /**
   * 窗口里现在挂着哪些章 —— 顺序必须和 DOM 里 `.reader-page-chapter` 的顺序一致，
   * 因为量出来的 `pageSpansRef` 是按 DOM 排的。前面接的章、锚点、后面续的章三段拼成一条。
   */
  const windowChapters = useMemo(() => [
    ...flowHead.map(item => item.chapter), chapter, ...flowTail.map(item => item.chapter),
  ].filter((item): item is Chapter => !!item), [chapter, flowHead, flowTail])
  const windowChaptersRef = useRef<Chapter[]>(windowChapters)
  windowChaptersRef.current = windowChapters
  /**
   * 页脚那一格要说的是**你眼前这一页属于哪一章**，不是"这一窗口锚在哪一章"。
   * 窗口里挂着两三章，用锚点名就会连着几页都写着上一章的名字 —— 用户截图里
   * 「第4章 生活」配着满屏的「第5章 片刻喘息」就是这一条（2026-10-03）。
   */
  const paginatedFooterTitle = (() => {
    const spans = pageSpansRef.current
    if (spans.length <= 1) return shownChapterTitle ?? ''
    return windowChapters[sectionAtPage(spans, pageIndex)]?.title ?? shownChapterTitle ?? ''
  })()
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

  // 切到音频/视频/文件章节（`mediaSrc` 非空）时把朗读停掉：那一章的"正文"是媒体地址，朗读没有意义。
  useEffect(() => {
    if (mediaSrc) stopTts()
  }, [mediaSrc, stopTts])

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
      .then(result => {
        const map = preloadedContentRef.current
        map.set(next.url, result.content)
        // 只增不清的 Map 会跟着阅读无界增长（长书读一章缓存一章），留最近的十几章足够
        if (map.size > 12) {
          const oldest = map.keys().next().value
          if (oldest !== undefined) map.delete(oldest)
        }
      })
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
      .then(result => {
        const map = preloadedContentRef.current
        map.set(prev.url, result.content)
        if (map.size > 12) {
          const oldest = map.keys().next().value
          if (oldest !== undefined) map.delete(oldest)
        }
      })
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
          ? '.reader-paginated-column-body .reader-page-chapter:first-of-type [data-paragraph-index]'
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
    // 音频/视频/文件章节的"正文"是媒体地址，朗读没有意义（念一串 URL 只会干扰）—— 直接不响应。
    if (mediaSrc) return
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
  }, [mediaSrc, ttsActive, ttsPlayState, playTtsChunk, currentChunkIndex, pauseTts, resumeTts, getInitialTtsChunkIndex, settings.ttsEngine])

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

  /** 非文本章节的渲染：音频播放器 / 视频播放器 / 文件下载（`mediaSrc` 为空时返回 null）。 */
  const renderMediaBlock = () => {
    if (!mediaSrc) return null
    if (sourceType === 1) {
      return (
        <div className="reader-media" data-media-type="audio">
          <audio
            src={mediaSrc}
            controls
            autoPlay
            onEnded={() => { if (chapterIndex < currentBook.chapters.length - 1) changeChapter(chapterIndex + 1) }}
          />
        </div>
      )
    }
    if (sourceType === 4) {
      return (
        <div className="reader-media" data-media-type="video">
          <video src={mediaSrc} controls />
        </div>
      )
    }
    return (
      <div className="reader-media" data-media-type="file">
        <a className="reader-media-download" href={mediaSrc} target="_blank" rel="noreferrer" download>下载文件</a>
      </div>
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

  /**
   * @param keepContainer 翻页模式里"跨章的那一翻"用：不换容器 key，于是整棵子树不重挂、
   *   进场动画不重放。主动跳章（目录、`Home/End`、章末提示条）仍然要重挂 —— 那是另一回事。
   */
  const changeChapter = useCallback((rawIndex: number, targetPage: 'first' | 'last' | 'auto' = 'auto', keepContainer = false) => {
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
    // 翻页模式的页码是**相对当前窗口**的，而这里马上要清掉续接窗口并重挂容器（下面两行），
    // 旧页码对新锚点没有任何含义。原来 'auto' 什么都不设，测量收尾那一轮只做夹取，
    // 于是从目录跳章、底部「上一章/下一章」、进度滑条、朗读的上一/下一章按钮都会**停在旧页码上**：
    // 在第 12 页点目录跳到一章只有三页的书，落点是第 3 页而不是第 1 页。
    targetInitialPageRef.current = targetPage === 'auto'
      ? (settings.pageMode === 'paginate' ? 'first' : null)
      : targetPage
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
    // 前面接的那些同理 —— 主动跳章就是"换地方重新看"，不保留窗口两侧。
    setFlowTail([])
    setFlowHead([])
    pendingPrependRef.current = null
    if (!keepContainer) setFlowKey(currentBook.chapters[nextIndex]?.url ?? `jump-${nextIndex}`)
  }, [chapterIndex, currentBook.chapters.length, persist, settings.pageMode, settings.ttsEngine, showBoundaryNotice, stopTts, stopAllEngines])

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
    try {
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
    } catch (error) {
      // 调用点是 void toggleShelf()：不接住就成 unhandled rejection，用户还以为加架成功了
      toast.error(error instanceof Error ? error.message : '书架操作失败')
    }
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
    const applyContent = (nextContent: string, nextMediaUrl: string | null = null) => {
      if (cancelled) return
      setContent(nextContent)
      setMediaUrl(nextMediaUrl)
      setLoadedChapterUrl(chapter.url)
      // 漫画/图文章节：趁用户看首屏，把正文里的图片提前喂给服务端代理取回落盘缓存，
      // 后面滚动/翻页不必每张都等服务端联网（referer 用本章地址，图站防盗链才放得过去）。
      warmContentImages(nextContent, chapter.url)
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
        .then(result => applyContent(result.content, result.mediaUrl ?? null))
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
   * 续接窗口：把锚点章之后的 1~2 章挂到下面（滚动与分页两种模式都要）。
   * 优先吃预载缓存 —— `preloadNextChapter` 在本章读到 70% 时就把下一章取回来了，
   * 所以正常情况下这一趟零请求。
   */
  useEffect(() => {
    if (!content) return
    // 非文本章节（音频/视频/文件）不续接下一章：它们是"一章一个媒体"，续接只会把地址当正文排出来。
    if (isMediaType(sourceType)) { setFlowTail([]); return }
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
        // 预载的下一章若含图（漫画常见），趁现在把它的图也预热，翻过去时直接命中缓存。
        warmContentImages(result.content, candidate.url)
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

  /**
   * 分页模式的跨章也是"顶窗口"（用户 2026-10-02：「竖版做好了，横板还是跳转」）。
   * 翻进已经挂在下面的那一章时不换章、不重挂子树、不把页码归零：
   * 摘掉最前面那一章，页码减去它的页数 —— 与滚动模式同一套动作，只是单位从像素换成页。
   */
  useLayoutEffect(() => {
    if (settings.pageMode !== 'paginate' || pendingPageRef.current !== null) return
    // 只在几何真的对齐时才挪窗口。垫栏是"量完再渲染"的，首屏那一轮可能还没落进 DOM：
    // 这时下一章的起始栏是奇数（正好挂在上一页的右半格），挪一下会把页码归零到
    // 同一栏上 —— 用户看到的就是"同一栏读两遍"。不挪反而没事：继续往前翻是连续的。
    // 下一轮重量会把垫栏补上，之后再挪就是无缝的。
    if (!pageAlignedRef.current) return
    const shift = pageWindowShift(pageSpansRef.current, pageIndex)
    if (!shift) return
    // 窗口现在是「前面接的章 + 锚点 + 后面续的章」，所以要按整条窗口找第 lead 节是哪一章，
    // 不能再假设 sections[0] 就是锚点（往前翻过之后它是某个 head）。
    const target = windowChaptersRef.current[shift.lead]
    if (!target) return
    const targetIndex = currentBook.chapters.findIndex(item => item.url === target.url)
    if (targetIndex <= chapterIndexRef.current) return
    pendingPageRef.current = shift.pageIndex
    setChapterIndex(targetIndex)
  }, [pageIndex, settings.pageMode, currentBook.chapters])

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

    // 每一章在窗口里占哪几页。
    // 关键：**先算每一章占几栏（精确整数），再累加出起始栏号**，最后才除以"一屏几栏"。
    // 原来直接 (矩形左边缘 - body 左边缘) / stride 取整，等于把章节起始列的奇偶丢掉 ——
    // 下一章落在奇数列时，它的第一栏是上一页的右半格（用户已经看过），窗口一挪页码归零，
    // 那一栏又挪回左半格。用户 2026-10-03 的两句"不要这样的跳转"就是这么来的。
    const sections = [...body.querySelectorAll<HTMLElement>('.reader-page-chapter')]
    if (sections.length > 0) {
      const columnsPerPage = layout.isDoubleColumn ? 2 : 1
      // 每一章占几栏 —— **不能量 section 的 getBoundingClientRect().width**：
      // 分栏里一个跨七栏的 <section>，它的矩形只报到约两栏宽（实测算出 [1,2,2] 而真实是 [1,7,7]），
      // 于是"补齐到整页"永远算出 0，界面照旧重复一栏。用 Range 量才拿得到每一栏的那块碎片。
      // 也正因为如此，垫的那一栏必须落在 section **外面**：算在里面的话章数会被自己数多一栏，
      // 下一轮又算成不用垫 —— 来回振荡。
      //
      // 数"多少栏"还不能直接对碎片左缘去重：段落有**首行缩进**时，每一栏里都多出一个
      // "缩进后的第一行"左缘 —— 一个真栏被数成两个（探针书实测：一章 8 栏数成 13、
      // 前言 1 栏数成 2）。偶数的假栏数 → 该垫的垫成 0 → 下一章落在奇数栏，接章补偿
      // 与翻页窗口全都差半页。修法：左缘先按 stride 分桶量化，缩进的左缘落进所在栏的桶，
      // 桶数才是真栏数（paginate-flow-check ④ 的几何转储逮到的就是这个）。
      const bodyLeft = body.getBoundingClientRect().left
      const measuredStride = layout.columnWidth + columnGap
      const columnCounts = sections.map(node => {
        const range = document.createRange()
        range.selectNodeContents(node)
        const lefts = new Set([...range.getClientRects()]
          .filter(rect => rect.width > 1)
          .map(rect => Math.round((rect.left - bodyLeft) / measuredStride)))
        return Math.max(1, lefts.size)
      })
      const nextFillers = pageAlignmentPads(columnCounts, columnsPerPage)
      const starts = pageAlignmentStarts(columnCounts, columnsPerPage)
      // 对齐闸门按**量出来的**起始栏判，不按算术：算术说垫了、DOM 里还没渲染出来，
      // 这一刻挪窗口照样会重复一栏。
      const measuredStarts = sections.map(node => {
        const range = document.createRange()
        range.selectNodeContents(node)
        const rects = [...range.getClientRects()].filter(rect => rect.width > 1)
        const left = rects.length > 0 ? Math.min(...rects.map(rect => rect.left)) : bodyLeft
        return Math.round((left - bodyLeft) / measuredStride)
      })
      pageAlignedRef.current = measuredStarts.every(col => col % columnsPerPage === 0)
      measuredStartsRef.current = measuredStarts
      columnsPerPageRef.current = columnsPerPage
      setPageFillers(current => (current.length === nextFillers.length
        && current.every((value, index) => value === nextFillers[index]) ? current : nextFillers))
      pageSpansRef.current = starts.map((start, index) => ({
        start: Math.round(start / columnsPerPage),
        end: index + 1 < starts.length
          ? Math.round(starts[index + 1] / columnsPerPage)
          : layout.pageCount,
      }))
      // 刚往前接了一章：页码由下面那个专门的 layout effect 补（它同步量、同步补，不靠这里的时机）
      // 刚把窗口往前挪过：页码要落到"摘掉前面那几章之后"的那一页上，否则画面跳回窗口开头
      if (pendingPageRef.current !== null) {
        const next = Math.min(layout.pageCount - 1, Math.max(0, pendingPageRef.current))
        pendingPageRef.current = null
        setPageIndex(next)
        return
      }
    } else {
      pageSpansRef.current = []
      measuredStartsRef.current = []
    }

    const pageTarget = targetInitialPageRef.current
    const restoredPosition = initialPagePositionRef.current
    targetInitialPageRef.current = null
    initialPagePositionRef.current = null
    if (pageTarget === null && restoredPosition === null) {
      // 同一个锚点内重量一次（改字号、拖窗口、续接挂章）：原地不动，只做夹取
      setPageIndex(curr => resolveMeasuredPage(null, null, curr, layout.pageCount))
      return
    }
    setPageIndex(resolveMeasuredPage(pageTarget, restoredPosition, 0, layout.pageCount))
  }, [columnGap, content, loading, settings.columnMode])

  useLayoutEffect(() => {
    if (settings.pageMode !== 'paginate') return
    if (loading || !content) return
    measurePagination()
    const viewport = viewportRef.current
    if (!viewport) return
    // 只观察 viewport 是不够的：续接窗口挂上/摘掉章节时窗口宽度会变，而视口尺寸没变，
    // ResizeObserver 一次都不会回调 —— 于是 pageCount 停在"只有锚点那一章"的页数上，
    // 多出来的那些列被 overflow:hidden 裁掉，用户永远翻不进去（横版"还是跳转"就是这么来的）。
    const observer = new ResizeObserver(() => measurePagination())
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [
    settings.pageMode,
    content,
    loading,
    // 往前接一章之后必须重量一次。分栏容器的高度不变、宽度才变，而 ResizeObserver 观察的是
    // 元素盒子 —— 内容变宽而盒子没变时它一次都不回调（AGENTS §5「分页/测量」那条同一个病），
    // 只挂 flowTail 的话新接进来的那一章永远算不进页数，页码就不会后移。
    flowHead,
    flowTail,
    // 垫栏本身要再量一次：首屏只挂上锚点那一章时"章末那一栏"还没有地方渲染，
    // 等下一张预览挂上来才补得上 —— 不重量的话第一次跨章那一下仍会重复一栏。
    pageFillers,
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

  /**
   * 往前接进来的那一章挂上之后，立刻把页码补到"眼前这一栏一个字不动"。
   *
   * 补偿按**量得的起始栏**落页：接章前窗口的第 0 节（无论它当时是锚点还是之前的头章）
   * 在接完之后排到第 1 节，它的实测起始栏除以每页栏数就是页码该在的那一页 ——
   * 目标只有一个：这一栏字必须还在原地。
   *
   * 原来按"接进来的那章占几页"（`pageSpans` 的算术推算）补，实测（双栏、探针书）
   * 页码补了、眼前那栏字却滑到几段之外（paginate-flow-check ④「接之前第 2 段落 vs
   * 之后第 5 段落」）—— 算术与 DOM 在垫栏/强制分栏上有一处出入，这里就错半页；
   * 量出来的不会错。单独一个 layout effect、并且自己调 `measurePagination()`：
   * 原来这段写在 measurePagination 里面，依赖"别的那个 effect 会因 flowHead 变了而重跑"，
   * 实测（双栏、书「像素游戏成真了…」）接进来的那一章确实挂上了（62 段、文档宽度从
   * ~14.4k 涨到 17510px），页码却一动不动 —— 时机不该由两个 effect 互相指望。
   * 这里同步量、同步补，量不到就下一帧再试，不静默吞掉。
   */
  useLayoutEffect(() => {
    const url = pendingPrependRef.current
    if (!url || settings.pageMode !== 'paginate' || loading || !content) return
    // 这一章还没成为窗口最上面那一节（React 还没提交，或提交到一半）：等它成为再说
    if (windowChaptersRef.current[0]?.url !== url) return
    measurePagination()
    const sections = windowChaptersRef.current.length
    const starts = measuredStartsRef.current
    if (starts.length !== sections || sections < 2) return
    // 章末垫的那一栏是"量完再渲染"的：没对齐之前这一章的起始页还会挪半栏，
    // 这时候补页码就会差半页（实测：接上之后眼前那一栏字变成了往后一栏）。
    // 不对齐就留着标记，等 pageFillers 落地后那一轮重量再来 —— 与前进侧"只在真对齐时挪窗口"同一条闸门。
    if (!pageAlignedRef.current) return
    // 接章前窗口的第 0 节，接完后排第 1：它的实测起始栏就是眼前这一页的新页码。
    const keptColumn = starts[1]
    pendingPrependRef.current = null
    setPageIndex(Math.round(keptColumn / columnsPerPageRef.current))
  }, [content, loading, measurePagination, settings.pageMode, windowChapters])

  const goNextPage = useCallback(() => {
    if (pageIndex < pageCount - 1) {
      setPageIndex(p => p + 1)
    } else {
      // 已到本章最后一页，尝试跳转到下一章
      // 双栏模式下，如果当前页是本章最后一页且处于右栏位置，
      // 需要确保下一章内容能正确衔接
      // 翻页模式下这是"下一页"而不是"跳一章"：不换容器 key，就不该重挂 + 重放进场动画
      changeChapter(chapterIndex + 1, 'first', settings.pageMode === 'paginate')
    }
  }, [chapterIndex, changeChapter, pageCount, pageIndex, settings.pageMode])

  /**
   * 往回翻到窗口开头时，把**上一章接到窗口最前面**。
   *
   * 不做"换锚点 + 跳到最后一页"那一套：那要等尾章挂上来、垫栏补完才知道总页数，
   * 而它是在旧窗口的页数上算的，实测就会落到上一章的中间（这正是用户问的"往回怎么办"）。
   * 接进来之后眼前这一页一个字都不动，只是页码整体涨了那一章的页数 —— 与前进完全对称。
   * 返回 false 表示前面真的没有章了（调用方去说"已是第一章"）。
   */
  const prependPreviousChapter = useCallback(async () => {
    // 非文本章节（音频/视频/文件）不往回接章：同续接，媒体地址不能当正文。
    if (isMediaType(currentBook.details.sourceType ?? 0)) return false
    const oldest = flowHeadRef.current[0]?.chapter ?? chapter
    const oldestIndex = oldest ? currentBook.chapters.findIndex(item => item.url === oldest.url) : -1
    let target = oldestIndex - 1
    while (target >= 0 && (currentBook.chapters[target]?.isVolume || !currentBook.chapters[target]?.url)) target -= 1
    if (oldestIndex < 1 || target < 0) return false
    const candidate = currentBook.chapters[target]
    const cached = preloadedContentRef.current.get(candidate.url)
    let text = cached ?? null
    if (text === null) {
      const result = await api.content(currentBook.details.sourceId, candidate.url, currentBook.bookUrl).catch(() => null)
      if (!result) return false
      text = result.content
      preloadedContentRef.current.set(candidate.url, result.content)
    }
    pendingPrependRef.current = candidate.url
    setFlowHead(prev => (prev.some(item => item.chapter.url === candidate.url) ? prev : [{ chapter: candidate, content: text ?? '' }, ...prev]))
    return true
  }, [chapter, currentBook.bookUrl, currentBook.chapters, currentBook.details.sourceId])

  const goPrevPage = useCallback(() => {
    if (pageIndex > 0) {
      setPageIndex(p => p - 1)
      return
    }
    // 窗口开头：往前接一章，而不是跳去"上一章的最后一页"。接的过程中不重复触发。
    if (pendingPrependRef.current !== null) {
      // 那一章其实已经挂上来了、只是页码还没补上（标记卡在量之前）：主动再量一次，
      // 不然一次错过就把"往回翻"永久锁死在这里。
      if (flowHeadRef.current[0]?.chapter.url === pendingPrependRef.current) measurePagination()
      return
    }
    void prependPreviousChapter().then(ok => {
      // 成了就不清这个标记：它要活到量出页数那一刻（由 measurePagination 消费）。
      // 没成就清掉，否则一次失败会永久卡住往回翻。
      if (!ok) {
        pendingPrependRef.current = null
        showBoundaryNotice('已是第一章')
      }
    })
  }, [pageIndex, prependPreviousChapter, showBoundaryNotice])

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
    // 分母是"这一章有几页"，不是"这个窗口有几页" —— 与滚动模式同一份进度契约
    const position = pageSpansRef.current.length
      ? pageProgress(pageSpansRef.current, pageIndex)
      : (pageCount > 1 ? pageIndex / (pageCount - 1) : 0)
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
      // 高亮跟读只在锚点那一章里找（续接进来的下一章有同名段落），页码换算用与
      // `pageSpansRef` 同一套矩形差：offsetLeft 与 rect.left 混着量，跳页就会偏一整页。
      const body = bodyRef.current
      const anchor = body?.querySelector<HTMLElement>('.reader-page-chapter')
      const el = anchor?.querySelector<HTMLElement>(`[data-paragraph-index="${activeParagraphIndex}"]`)
      if (body && el && stride > 0) {
        const offset = el.getBoundingClientRect().left - body.getBoundingClientRect().left
        const targetPage = Math.min(pageCount - 1, Math.max(0, Math.round(offset / stride)))
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
    '--reader-sidebar-width': `${settings.sidebarWidth}px`,
    '--reader-font-family': effectiveReaderFontFamily(settings),
    '--reader-bg-color': settings.readerBgColor || 'transparent',
    // 背景图带一层压暗（readerBgDim）：再亮的图也不至于把墨色文字顶没。
    '--reader-bg-image': settings.readerBgImage
      ? `linear-gradient(rgb(0 0 0 / ${settings.readerBgDim}), rgb(0 0 0 / ${settings.readerBgDim})), url("${settings.readerBgImage}")`
      : 'none',
  } as CSSProperties

  // Pointer & Gesture interactions
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    // 只认主键。右键是"叫出上下文菜单"的手势，不是翻页：原来这里没判 button，
    // 右键点正文会一路走到 `paginateTapZone` / `scrollTapZone`，于是"右键 → 取消菜单"之后
    // 页面已经翻了一页 / 正文往上滚了一屏（用户 2026-10-04：「鼠标右键点击正文页面取消后正文莫名向上移动」）。
    if (event.button !== 0) return
    if (loading || activeDrawer || isInteractiveReaderTarget(event.target)) return
    pointerStartRef.current = { x: event.clientX, y: event.clientY, target: event.target }
  }

  /**
   * 点在一格里该干什么（用户 2026-10-04：「可以自定义点击区域范围并设置」）。
   * 格子表在 `settings.tapZones`，出厂那张与改动前逐字一致；这里只负责"动作 → 行为"。
   */
  const runTapAction = useCallback((action: TapAction) => {
    const paginate = settings.pageMode === 'paginate'
    if (action === 'previous') {
      if (paginate) {
        goPrevPage()
        return
      }
      if (isAtTopBoundary(window.scrollY)) changeChapter(chapterIndex - 1, 'last')
      else window.scrollBy({ top: -window.innerHeight * 0.85, behavior: 'smooth' })
      return
    }
    if (action === 'next') {
      if (paginate) {
        goNextPage()
        return
      }
      if (isAtBottomBoundary(window.scrollY, document.documentElement.scrollHeight, window.innerHeight)) changeChapter(chapterIndex + 1, 'first')
      else window.scrollBy({ top: window.innerHeight * 0.85, behavior: 'smooth' })
      return
    }
    if (action === 'toc' || action === 'settings') {
      setActiveDrawer(drawer => (drawer === action ? null : action))
      return
    }
    if (action === 'none') return
    setToolbarsVisible(visible => !visible)
  }, [chapterIndex, changeChapter, goNextPage, goPrevPage, settings.pageMode])

  /**
   * 正文区的视口矩形。
   *
   * 点击分区的范围必须按它算，不能按整窗 —— 目录固定在左侧时正文被 `margin-left` 挤到右边
   * （用户 2026-10-09：「如果我左侧打开了目录那么你这规定范围会不会有问题」），
   * 按整窗算的话"左边一列"有一半压在目录栏底下，点在正文左缘会算成别的区。
   */
  const readingRect = () => {
    const el = readerMainRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      }
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
  }

  /**
   * 拖「目录 | 正文」那条边界改目录栏宽度（用户 2026-10-09：「我希望目录与正文边界能左右移动部分，
   * 但是不影响功能和界面展示」）。宽度存进设置；正文区与点击分区的范围都跟着 CSS 变量走。
   */
  const onSidebarResizeDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    resizingSidebarRef.current = true
    setResizingSidebar(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onSidebarResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizingSidebarRef.current) return
    const width = Math.round(Math.min(560, Math.max(220, event.clientX)))
    if (width !== settings.sidebarWidth) onSettingsChange({ ...settings, sidebarWidth: width })
  }
  const onSidebarResizeUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    resizingSidebarRef.current = false
    setResizingSidebar(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  /**
   * 编辑层要盖在**正文区**上，不能压住固定的目录栏（用户 2026-10-09：「不要影响目录显示」）。
   * 正文区左缘由布局决定（固定目录 / 拖出来的宽度），所以实测而不是猜。
   */
  const [readingLeft, setReadingLeft] = useState(0)
  useEffect(() => {
    if (!tapZoneEditing) return
    const measure = () => setReadingLeft(Math.round(readerMainRef.current?.getBoundingClientRect().left ?? 0))
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [tapZoneEditing, settings.sidebarPinned, settings.sidebarWidth])

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const start = pointerStartRef.current
    pointerStartRef.current = null
    if (event.button !== 0) return
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
        const rect = readingRect()
        runTapAction(zoneAt(settings.tapZones.paginate, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height))
      }
    } else {
      if (isTapGesture(start.x, start.y, event.clientX, event.clientY)) {
        const rect = readingRect()
        runTapAction(zoneAt(settings.tapZones.scroll, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height))
      }
    }
  }

  /**
   * 正文上的右键（用户 2026-10-04：「书签加载章节目录，选定段落，右击功能你还没有添加」）。
   *
   * 上游在手机上是"长按选句 → 一条菜单"（复制/朗读/替换/站内搜索…），桌面这边对应物就是右键。
   * 第一条永远是**手上正选着的那几段** —— 人右键的时候多半刚选好，让他再去别处找那颗按钮，
   * 等于没有这个功能。
   */
  const onBodyContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (settings.pageMode === 'paginate' && activeDrawer) return
    const selectedText = (window.getSelection()?.toString() ?? '').trim()
    const items: ContextMenuItem[] = []
    if (selectedText) {
      items.push({
        label: '复制',
        icon: 'copy',
        onSelect: () => {
          void navigator.clipboard?.writeText(selectedText).then(
            () => toast.success('已复制'),
            () => toast.warning('浏览器没让复制，手动选一次再试'),
          )
        },
      })
    }
    items.push({ label: '章节目录', icon: 'list', onSelect: () => setActiveDrawer('toc') })
    showContextMenu(event, items)
  }

  const onWheelPaginate = (event: React.WheelEvent) => {
    if (settings.pageMode !== 'paginate' || activeDrawer) return
    const { action, rest } = paginateWheelStep(event.deltaX, event.deltaY, event.deltaMode, wheelAccumRef.current)
    if (action === null) {
      // 还没攒够一格：继续攒，但停手 500ms 就把零头丢掉，免得下次一上手被旧累计量带翻一页。
      // 这个窗口不能太紧：慢速轻扫（每下间隔接近一个 round-trip）也要能攒起来，
      // 实测 180ms 在"一下一下慢慢滚"的节奏下每下都被清零，等于又回到修前的"翻不动"。
      wheelAccumRef.current = rest
      if (wheelIdleRef.current !== null) window.clearTimeout(wheelIdleRef.current)
      wheelIdleRef.current = window.setTimeout(() => { wheelAccumRef.current = 0; wheelIdleRef.current = null }, 500)
      return
    }
    // 攒够了一格却撞上冷却：**不消费**，把这一格留在累计量里，冷却结束后的第一件事件立刻兑现。
    // 修前是"冷却期一到就整段 return"，连累计都不进 —— 快速轻扫时有整整一格行程被吞掉，
    // 表现还是"翻不动"，只是换了个成因。
    if (wheelTimerRef.current !== null) return
    if (wheelIdleRef.current !== null) { window.clearTimeout(wheelIdleRef.current); wheelIdleRef.current = null }
    wheelAccumRef.current = rest
    wheelTimerRef.current = window.setTimeout(() => { wheelTimerRef.current = null }, 140)
    if (action === 'next') goNextPage()
    else goPrevPage()
  }

  const cachePercent = Math.min(100, Math.round((cacheStatus.cached / Math.max(1, cacheStatus.total || currentBook.chapters.length)) * 100))

  /**
   * 工具栏按钮由 `settings.menuItems` 决定（显示与顺序都在设置抽屉的「工具栏」里配）。
   * 清单的唯一来源是 `readerMenu.ts`，别在这儿另起一套。
   */
  const readerMenuButton = (id: ReaderMenuAction) => {
    switch (id) {
      case 'switchSource':
        return <IconButton key={id} label="切换书源" icon="sliders" onClick={() => setShowSourceSwitch(true)} />
      case 'settings':
        return <IconButton key={id} label="阅读设置" icon="settings" onClick={() => setActiveDrawer(d => d === 'settings' ? null : 'settings')} />
      case 'fullscreen':
        return <IconButton key={id} label={isFullscreen ? '退出全屏' : '全屏阅读'} icon="expand" onClick={toggleFullscreen} />
      case 'tts':
        return <IconButton
          key={id}
          label={mediaSrc ? '本类型不支持朗读' : !ttsActive ? '朗读本章' : ttsPlayState === 'playing' ? '暂停朗读' : '继续朗读'}
          icon={ttsActive && ttsPlayState === 'playing' ? 'pause' : 'volume2'}
          onClick={toggleTts}
          onDoubleClick={resetTtsBarPosition}
          hint="双击可把朗读悬浮条放回默认位置"
          disabled={!!mediaSrc}
        />
      default:
        return null
    }
  }

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
        {settings.menuItems.map(id => readerMenuButton(id))}
      </div>
    </header>

    {/* TOC Drawer (Left) */}
    <aside className={`reader-drawer reader-drawer-left ${activeDrawer === 'toc' ? 'open' : ''} ${settings.sidebarPinned ? 'pinned' : ''}`} aria-label="目录抽屉">
      <header className="drawer-header">
        {/*
          标题栏原来只写「共 N 章」，不告诉你在读哪一章（用户 2026-10-09：「目录你怎么不标注章节名」）。
          现在把当前章名放进来；章名可能很长，CSS 截断 + title 里给全名。
        */}
        <div className="drawer-title">
          <Icon name="list" /><strong>目录</strong>
          <small className="drawer-title-current" title={chapter?.title || undefined}>
            {chapter?.title ? `正在读：${chapter.title}` : `共 ${currentBook.chapters.length} 章`}
          </small>
        </div>
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
            // 固定态下抽屉由 `pinned` 类撑着，光 setActiveDrawer(null) 关不掉 —— 这颗必须顺带解除固定。
            // 审计把它报成"一个控件兼两个职务"，核了 :1917 的 className 才确认是必需的；
            // 该修的是标签：它得说自己按下去会发生什么。
            label={settings.sidebarPinned ? '取消固定并关闭目录' : '关闭目录'}
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
        itemHeight={TOC_ROW_HEIGHT}
        overscan={8}
        autoScrollKey={activeDrawer === 'toc' || settings.sidebarPinned ? 1 : 0}
      />
      <footer className={`drawer-footer ${drawerFooterOpen ? 'is-open' : ''}`}>
        {/* 收起态只有这一行；展开才露出缓存与「这本书」那两组（见 drawerFooterOpen 的注释） */}
        <button
          type="button"
          className="drawer-footer-toggle"
          aria-expanded={drawerFooterOpen || cacheStatus.state === 'caching' || localSyncing}
          onClick={() => setDrawerFooterOpen(value => !value)}
        >
          <Icon name={drawerFooterOpen ? 'chevronDown' : 'chevronRight'} />
          <span>离线缓存 · 这本书</span>
          {inShelf && <span className="drawer-footer-badge">已在书架</span>}
        </button>
        {(drawerFooterOpen || cacheStatus.state === 'caching' || localSyncing) && (
        <div className="drawer-footer-body">
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
              <span className="drawer-action-group-label">离线缓存</span>
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
          <span className="drawer-action-group-label">这本书</span>
          <button className="shelf-button" onClick={() => { setActiveDrawer(null); setShowSourceSwitch(true) }}>
            <Icon name="sliders" />换源
          </button>
          <button className="shelf-button" onClick={() => void toggleShelf()}>
            <Icon name={inShelf ? 'check' : 'plus'} />{inShelf ? '已在书架' : '加书架'}
          </button>
        </div>
        </div>
        )}
      </footer>
    </aside>

    {/* 目录 | 正文 那条边界：固定目录时可左右拖（用户 2026-10-09） */}
    {settings.sidebarPinned && (
      <div
        className={`reader-sidebar-resizer ${resizingSidebar ? 'is-dragging' : ''}`}
        style={{ left: `${settings.sidebarWidth}px` }}
        role="separator"
        aria-label="拖动调整目录栏宽度"
        onPointerDown={onSidebarResizeDown}
        onPointerMove={onSidebarResizeMove}
        onPointerUp={onSidebarResizeUp}
      />
    )}

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
        onEditTapZones={() => { setActiveDrawer(null); setTapZoneEditing(true) }}
        localBook={currentBook.details.sourceId === 'loc_book' ? { name: bookName, tocRule: shelfTocRule } : null}
        tocRuleOptions={tocRuleOptions}
        onReparseLocal={currentBook.details.sourceId === 'loc_book' ? reparseLocalBook : undefined}
      />
    </aside>

    {/* Backdrop for Drawers */}
    {activeDrawer && (activeDrawer !== 'toc' || !settings.sidebarPinned) && (
      <div className="reader-drawer-backdrop" onClick={() => setActiveDrawer(null)} aria-hidden="true" />
    )}

    {/*
      「在正文上编辑点击区域」那层：盖在正文之上（正文仍渲染，看得见字），
      画横竖虚线分区、控制条收在底部一行。只编**当前翻页方式**那张表 —— 分页看竖线、滚动看横线。
    */}
    {tapZoneEditing && (
      <TapZoneEditor
        map={settings.pageMode === 'paginate' ? settings.tapZones.paginate : settings.tapZones.scroll}
        mode={settings.pageMode}
        left={readingLeft}
        onMap={map => onSettingsChange({
          ...settings,
          tapZones: settings.pageMode === 'paginate'
            ? { ...settings.tapZones, paginate: map }
            : { ...settings.tapZones, scroll: map },
        })}
        onMode={mode => onSettingsChange({ ...settings, pageMode: mode })}
        onPreset={(paginate, scroll) => onSettingsChange({ ...settings, tapZones: { paginate, scroll } })}
        onClose={() => setTapZoneEditing(false)}
      />
    )}

    {/* Central Reading Canvas */}
    <section ref={readerMainRef} className="reader-main">
      {settings.pageMode === 'paginate' ? (
        <div className="reader-paginated-wrap" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onWheel={onWheelPaginate} onContextMenu={onBodyContextMenu}>
          <div ref={viewportRef} className={`reader-paginated-viewport ${isDoubleColumn ? 'is-double-column' : ''}${pageAnim === 'fade' && fading ? ' is-fading' : ''}`}>
            <div className={`reader-paginated-track${slideAnimOn ? ' is-anim-slide' : ''}`} style={{ transform: `translateX(-${pageIndex * stride}px)` }}>
              {/*
                分页模式也是一篇连续文档：一章一个 <section> 排在同一条分栏流里，
                翻页翻过章边界只是"下一页"，不是重挂一棵子树再回到章首。
                容器的 key 只在主动跳章/换书时换（续接推进不换），否则每跨一章白闪一次。
              */}
              <article ref={bodyRef} key={flowKey} className={`reader-paginated-column-body chapter-enter${isStaleContent ? ' is-stale' : ''}`} style={{ columnWidth: `${columnWidth}px`, columnGap: `${columnGap}px` }}>
                {/*
                  章末垫的那一栏空白，渲染在两个 <section> **之间**（不是章节里面）：
                  这一章占了奇数栏时，不垫的话下一章的第一栏正好是上一页的右半格（用户已经看过），
                  翻页窗口一挪、页码归零，同一栏又挪回左半格 —— 用户 2026-10-03 的"不要这样的跳转"。
                */}
                {/*
                  窗口前面接进来的那些章，排在锚点章**之前**（往回翻就是往这里加一章）。
                  垫栏的下标是"这一章在窗口里的绝对位置"：head 占 0..K-1、锚点 K、尾巴 K+1..，
                  所以接进 head 之后，尾巴那些的垫栏下标要整体往后挪 —— 不挪就是把空白垫错章。
                */}
                {flowHead.map((item, headIndex) => (
                  <Fragment key={item.chapter.url}>
                    {headIndex > 0 && (pageFillers[headIndex - 1] ?? 0) > 0 && <div className="reader-column-filler" aria-hidden="true" />}
                    <section className="reader-page-chapter" data-chapter-index={item.chapter.index}>
                      <h1>{item.chapter.title}</h1>
                      {splitParagraphs(item.content).map((line, index) => renderContentBlock(line, index, item.chapter))}
                    </section>
                  </Fragment>
                ))}
                {flowHead.length > 0 && (pageFillers[flowHead.length - 1] ?? 0) > 0 && <div className="reader-column-filler" aria-hidden="true" />}
                <section className="reader-page-chapter" data-chapter-index={chapter?.index ?? 0}>
                  <h1>{shownChapterTitle}</h1>
                  {isStaleContent && <p className="reader-chapter-incoming" role="status">正在载入：{incomingChapterTitle}</p>}
                  {loading && !content && <ReaderContentSkeleton />}
                  {message && <p className="reader-error">{message}</p>}
                  {mediaSrc ? renderMediaBlock() : paragraphs.map((line, index) => renderContentBlock(line, index))}
                </section>
                {flowTail.map((item, tailIndex) => (
                  <Fragment key={item.chapter.url}>
                    {(pageFillers[flowHead.length + tailIndex] ?? 0) > 0 && <div className="reader-column-filler" aria-hidden="true" />}
                    <section className="reader-page-chapter" data-chapter-index={item.chapter.index}>
                      <h1>{item.chapter.title}</h1>
                      {splitParagraphs(item.content).map((line, index) => renderContentBlock(line, index, item.chapter))}
                    </section>
                  </Fragment>
                ))}
              </article>
            </div>
          </div>
          <footer className="reader-paginated-footer">
            <span>{paginatedFooterTitle || ''}</span>
            <span>{pageIndex + 1} / {pageCount}</span>
          </footer>
        </div>
      ) : (
        <article className={`reading-content chapter-enter${isStaleContent ? ' is-stale' : ''}`} key={flowKey} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onContextMenu={onBodyContextMenu}>
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
            {mediaSrc ? renderMediaBlock() : paragraphs.map((line, index) => renderContentBlock(line, index))}
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
      <button onClick={toggleTts} disabled={!!mediaSrc}><Icon name={ttsActive && ttsPlayState === 'playing' ? 'pause' : 'volume2'} /><span>{ttsActive ? (ttsPlayState === 'playing' ? '暂停' : '继续') : '朗读'}</span></button>
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
      <div className="overlay-backdrop" onClick={() => setOfflineTtsConfirmOpen(false)}>
        <div
          className="dialog-shell size-s"
          onClick={e => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label="离线语音提示"
        >
          <header className="dialog-head">
            <div className="source-login-title">
              <span><Icon name="volume2" /></span>
              <div>
                <h2>离线朗读提示</h2>
                <small>当前设备处于离线状态</small>
              </div>
            </div>
            <button type="button" className="overlay-close" onClick={() => setOfflineTtsConfirmOpen(false)} aria-label="关闭">
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
      <div className="overlay-backdrop is-viewer" onClick={() => setLightboxSrc(null)} role="dialog" aria-label="图片预览">
        <button type="button" className="reader-image-lightbox-close" aria-label="关闭预览" onClick={() => setLightboxSrc(null)}><Icon name="close" /></button>
        <img src={lightboxSrc} alt="" onClick={event => event.stopPropagation()} />
      </div>
    )}
  </main>
}

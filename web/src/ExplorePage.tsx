import React, { useEffect, useMemo, useState } from 'react'
import { api, type ExploreTab, type SearchResult, type SourceSummary } from './api'
import { Icon } from './icons'
import { sanitizeImageUrl } from './sourceImport'

export interface ExplorePageProps {
  onOpen: (book: SearchResult) => Promise<void>
}

/** 「发现」页：读取书源的 exploreUrl 分栏，按 Legado 语义列出推荐书籍。 */
export function ExplorePage({ onOpen }: ExplorePageProps) {
  const [sources, setSources] = useState<SourceSummary[]>([])
  const [sourceId, setSourceId] = useState('')
  const [tabs, setTabs] = useState<ExploreTab[]>([])
  const [tab, setTab] = useState<ExploreTab | null>(null)
  const [books, setBooks] = useState<SearchResult[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle')
  const [message, setMessage] = useState('')
  const [tabsExpanded, setTabsExpanded] = useState(false)

  // 聚合书源常挂 40+ 个分栏，而且大量重名（每个分类都叫「推荐」「完结」）。
  // 重名的补上序号，否则点了之后根本看不出当前选的是哪一个。
  const labelledTabs = useMemo(() => {
    const totals = new Map<string, number>()
    for (const item of tabs) totals.set(item.title, (totals.get(item.title) ?? 0) + 1)
    const seen = new Map<string, number>()
    return tabs.map(item => {
      if ((totals.get(item.title) ?? 0) < 2) return { ...item, label: item.title }
      const nth = (seen.get(item.title) ?? 0) + 1
      seen.set(item.title, nth)
      return { ...item, label: `${item.title} ·${nth}` }
    })
  }, [tabs])

  useEffect(() => {
    void api.exploreSources().then(list => {
      setSources(list)
      setSourceId(current => current || list[0]?.id || '')
    }).catch(() => setMessage('发现书源列表加载失败'))
  }, [])

  useEffect(() => {
    if (!sourceId) return
    let cancelled = false
    const controller = new AbortController()
    // 聚合源的 exploreUrl 本身就是一段 JS（番茄那份要跑 400+ 个分栏），15 秒会误杀，给到 45 秒。
    const timer = setTimeout(() => controller.abort(), 45000)
    setBooks([])
    setTabs([])
    setTab(null)
    setStatus('loading')
    void api.exploreTabs(sourceId, controller.signal).then(list => {
      if (cancelled) return
      setTabs(list)
      setTab(list[0] ?? null)
      if (!list.length) {
        setStatus('idle')
        setMessage('这本书源没有配置发现页（exploreUrl）。')
      }
    }).catch(error => {
      if (cancelled) return
      setStatus('failed')
      setMessage(controller.signal.aborted ? '发现页配置读取超时，换个书源试试。' : String(error.message || '发现页解析失败'))
    }).finally(() => clearTimeout(timer))
    return () => { cancelled = true; clearTimeout(timer); controller.abort() }
  }, [sourceId])

  useEffect(() => {
    if (!sourceId || !tab) return
    let cancelled = false
    // 死书源会让发现页一直转圈：25 秒后主动断开并给出可重试的提示。
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25000)
    setStatus('loading')
    setMessage('')
    void api.explore(sourceId, tab.url, controller.signal).then(list => {
      if (cancelled) return
      setBooks(list)
      setStatus('ready')
      if (!list.length) setMessage('这个分栏没有返回书籍，换一个试试。')
    }).catch(error => {
      if (cancelled) return
      setStatus('failed')
      setMessage(controller.signal.aborted ? '这本书源 25 秒内没有响应，换个书源或分栏再试。' : String(error.message || '发现页取书失败'))
    }).finally(() => clearTimeout(timer))
    return () => { cancelled = true; clearTimeout(timer); controller.abort() }
  }, [sourceId, tab])

  const coverOf = (book: SearchResult) => sanitizeImageUrl(book.coverUrl)

  const open = async (book: SearchResult) => {
    setStatus('loading')
    setMessage('')
    try {
      await onOpen(book)
      setStatus('ready')
    } catch (error) {
      setStatus('failed')
      setMessage(String(error instanceof Error ? error.message : '这本书打不开'))
    }
  }

  return (
    <main className="explore-page">
      <header className="explore-header">
        <div>
          <span className="section-kicker">按书源发现</span>
          <h1>发现</h1>
          <p>读取书源自带的发现页分栏（榜单、分类、专题），点书直接开始阅读。</p>
        </div>
        <label className="explore-source-picker">
          <span>书源</span>
          <select value={sourceId} onChange={event => setSourceId(event.target.value)} disabled={!sources.length}>
            {sources.length === 0 && <option value="">加载中…</option>}
            {sources.map(item => <option key={item.id} value={item.id}>{item.name}{item.group ? `（${item.group}）` : ''}</option>)}
          </select>
        </label>
      </header>

      {tabs.length > 0 && (
        <>
          <nav className={tabsExpanded ? 'explore-tabs expanded' : 'explore-tabs'} aria-label="发现分栏">
            {labelledTabs.map(item => (
              <button
                key={`${item.title}::${item.url}`}
                type="button"
                className={tab?.url === item.url ? 'explore-tab active' : 'explore-tab'}
                onClick={() => setTab(item)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          {tabs.length > 22 && (
            <button type="button" className="ghost-button explore-tabs-toggle" onClick={() => setTabsExpanded(value => !value)}>
              {tabsExpanded ? '收起分栏' : `展开全部 ${tabs.length} 个分栏`}
            </button>
          )}
        </>
      )}

      {message && <p className="explore-message">{message}</p>}

      {books.length > 0 && (
        <section className="explore-results">
          <header><h2>{tab?.title ?? '发现'}</h2><small>{books.length} 本书</small></header>
          <div className="explore-grid">
            {books.map((book, index) => (
              <button type="button" key={`${book.sourceId}::${book.bookUrl}::${index}`} className="explore-card" onClick={() => void open(book)}>
                {coverOf(book) ? (
                  <img className="explore-cover" src={coverOf(book)!} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.visibility = 'hidden' }} />
                ) : (
                  <span className="explore-cover explore-cover-empty">{book.name.slice(0, 1)}</span>
                )}
                <strong title={book.name}>{book.name}</strong>
                <small>{book.author || '未知作者'}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      {status === 'loading' && (
        <div className="explore-loading"><Icon name="refresh" /><span>正在读取发现页…</span></div>
      )}
    </main>
  )
}

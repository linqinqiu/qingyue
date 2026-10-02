import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type BookMark, type BookshelfItem } from './api'
import { bookMarkKey, groupMarksByBook, markScope } from './bookmarks'
import { Icon } from './icons'

/**
 * 「我的 → 书签」：跨书、跨书源的全部书签（用户 2026-10-02 里那句"有整体的…全部书源管理"）。
 *
 * 按「书名 + 作者」并组，不是按源并组 —— 同一本书在两个源上打的书签本来就该是同一份清单。
 * 只有还在书架上的那本给「打开」：书签里存的 `sourceId + bookUrl` 不足以重开一本书（没有 tocUrl），
 * 硬凑一个"能点但打不开"的按钮比没有更糟。
 */
export function BookmarksPage({ onOpen }: { onOpen: (item: BookshelfItem) => void }) {
  const [marks, setMarks] = useState<BookMark[]>([])
  const [shelf, setShelf] = useState<BookshelfItem[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [query, setQuery] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    // 书架是"这条能不能真的打开"的依据，取不到就当都不在架上：宁可少给一个按钮，不给一个点了没反应的
    void api.bookshelf().then(setShelf).catch(() => setShelf([]))
    return api.marks().then(setMarks).catch(error => {
      setNotice(error instanceof Error ? error.message : '书签读取失败')
    }).finally(() => setLoading(false))
  }, [])

  useEffect(() => { void load() }, [load])

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const kept = needle
      ? marks.filter(mark => `${mark.bookName} ${mark.bookAuthor ?? ''} ${mark.chapterTitle} ${mark.quote} ${mark.note}`.toLowerCase().includes(needle))
      : marks
    return groupMarksByBook(kept)
  }, [marks, query])

  const shelfOf = (mark: BookMark) => {
    const key = bookMarkKey(mark.bookName, mark.bookAuthor ?? '')
    return shelf.find(item => bookMarkKey(item.name, item.author ?? '') === key) ?? null
  }

  const total = marks.length
  const withNote = marks.filter(mark => mark.note.trim()).length

  return (
    <main className="bookmarks-page">
      <header className="bookmarks-head">
        <div>
          <h1>书签</h1>
          <p>{loading ? '正在载入…' : `${total} 条 · 来自 ${groups.length} 本书${withNote > 0 ? ` · ${withNote} 条带批注` : ''}`}</p>
        </div>
        <label className="bookmarks-search">
          <Icon name="search" />
          <input value={query} placeholder="搜书名、章节、原文或批注" aria-label="搜索书签" onChange={event => setQuery(event.target.value)} />
        </label>
      </header>
      {notice && <p className="bookmarks-notice">{notice}</p>}
      {!loading && total === 0 && (
        <p className="bookmarks-empty">还没有书签。在阅读器里选中一段文字，按 <kbd>B</kbd> 或打开左栏「书签」就能加一条，还能写批注。</p>
      )}
      {!loading && total > 0 && groups.length === 0 && <p className="bookmarks-empty">没有匹配「{query}」的书签。</p>}

      {groups.map(group => (
        <section key={group.key} className="bookmarks-book">
          <header>
            <h2>{group.name}</h2>
            <small>{group.author || '佚名'} · {group.marks.length} 条</small>
          </header>
          <ul>
            {group.marks.map(mark => {
              const target = shelfOf(mark)
              return (
                <li key={mark.id}>
                  <div className="bookmarks-row-main">
                    <strong>{mark.chapterTitle}</strong>
                    <small>{markScope(mark)} · {new Date(mark.createdAt).toLocaleString('zh-CN', { hour12: false })}</small>
                    {mark.quote && <p className="bookmarks-quote">{mark.quote}</p>}
                    {mark.note && <p className="bookmarks-note">{mark.note}</p>}
                  </div>
                  <div className="bookmarks-row-actions">
                    {target
                      ? <button type="button" className="subtle-button" onClick={() => onOpen(target)}>打开</button>
                      : <span className="bookmarks-noop" title="这本书不在书架上，书签仍然留着">不在书架</span>}
                    <button
                      type="button"
                      className="subtle-button"
                      onClick={() => {
                        const note = window.prompt('这条书签的批注', mark.note)
                        if (note === null) return
                        const trimmed = note.trim()
                        setMarks(current => current.map(item => (item.id === mark.id ? { ...item, note: trimmed } : item)))
                        void api.setMarkNote(mark.id, trimmed).catch(() => void load())
                      }}
                    >
                      {mark.note ? '改批注' : '加批注'}
                    </button>
                    <button
                      type="button"
                      className="subtle-button"
                      aria-label="删除这条书签"
                      onClick={() => {
                        const snapshot = marks
                        setMarks(current => current.filter(item => item.id !== mark.id))
                        void api.removeMark(mark.id).catch(() => setMarks(snapshot))
                      }}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </main>
  )
}

import { useEffect, useState } from 'react'
import type { BookMark } from './api'
import { isWholeChapter, markScope, type MarkSelection } from './bookmarks'
import { Icon } from './icons'

type BookmarkDrawerProps = {
  open: boolean
  onClose: () => void
  marks: BookMark[]
  loading: boolean
  /** 屏幕上此刻选中的那几段（没有就是 null）。有选中时主按钮变成"把选中 N 段加入书签"。 */
  selection: MarkSelection | null
  chapterTitle: string
  /** 选中区落在锚点章之外（续接进来的下一章）时不许加入书签，那会标错章。 */
  canBookmarkSelection: boolean
  onAddSelection: (note: string) => void
  onAddChapter: (note: string) => void
  onJump: (mark: BookMark) => void
  onNote: (id: number, note: string) => void
  onDelete: (id: number) => void
}

/**
 * 阅读器左栏的「书签」抽屉（用户 2026-10-02：「加入书签功能，可以段落（多段落），章节书签，
 * 有整体的，书籍内的，全部书源管理，该书签可以自定义评论，支持在同书不同书源中使用」）。
 *
 * 这一栏只管"这本书的"；跨书的全部书签在「我的 → 书签」那一页。
 * 评论是就地编辑的：一条书签如果没有批注，过两周就只剩一句原文，不知道当时为什么标它。
 */
export function BookmarkDrawer({
  open, onClose, marks, loading, selection, chapterTitle, canBookmarkSelection,
  onAddSelection, onAddChapter, onJump, onNote, onDelete,
}: BookmarkDrawerProps) {
  const [draftNote, setDraftNote] = useState('')
  const [editing, setEditing] = useState<number | null>(null)
  const [editingNote, setEditingNote] = useState('')

  useEffect(() => { if (!open) { setDraftNote(''); setEditing(null) } }, [open])

  const commitSelection = () => {
    onAddSelection(draftNote.trim())
    setDraftNote('')
  }

  return (
    <div className="bookmark-drawer-body">
      <header className="bookmark-drawer-head">
        <h3>书签</h3>
        <small>{marks.length} 条 · 同一本书换源后仍然在这里</small>
        <button type="button" className="overlay-close" onClick={onClose} aria-label="关闭书签栏"><Icon name="close" /></button>
      </header>

      <section className="bookmark-add">
        {selection && canBookmarkSelection ? (
          <p className="bookmark-quote">
            选中 {selection.to - selection.from + 1} 段：
            <span>{selection.text.slice(0, 120)}{selection.text.length > 120 ? '…' : ''}</span>
          </p>
        ) : (
          <p className="bookmark-hint">
            {selection && !canBookmarkSelection
              ? '选中的是别章的内容（续接进来的下一章）：先跳过去再框选，否则书签会标错章。'
              : '在正文里按住拖选一段或几段，再回来点下面那颗；不选也能给整章留一条。'}
          </p>
        )}
        <input
          className="bookmark-note-input"
          value={draftNote}
          placeholder="批注（可留空）"
          aria-label="书签批注"
          onChange={event => setDraftNote(event.target.value)}
        />
        <div className="bookmark-add-actions">
          <button
            type="button"
            className="primary-button"
            disabled={!selection || !canBookmarkSelection}
            onClick={commitSelection}
          >
            加入书签{selection ? `（${selection.to - selection.from + 1} 段）` : ''}
          </button>
          <button type="button" className="ghost-button" onClick={() => { onAddChapter(draftNote.trim()); setDraftNote('') }}>
            收藏整章
          </button>
        </div>
      </section>

      {loading && marks.length === 0 && <p className="reader-status">正在载入书签…</p>}
      {!loading && marks.length === 0 && <p className="reader-status">这本书还没有书签。当前这一章是「{chapterTitle}」。</p>}

      <ul className="bookmark-list">
        {marks.map(mark => (
          <li key={mark.id}>
            <button type="button" className="bookmark-jump" onClick={() => onJump(mark)} title="跳到这一处">
              <span className="bookmark-meta">
                <strong>{mark.chapterTitle}</strong>
                <small>{markScope(mark)}</small>
              </span>
              <span className="bookmark-text">{mark.quote || (mark.note ? '（只留了批注）' : '标记整章')}</span>
              {mark.note && <span className="bookmark-note">{mark.note}</span>}
            </button>
            <div className="bookmark-row-actions">
              <button type="button" className="subtle-button" onClick={() => { setEditing(mark.id); setEditingNote(mark.note) }}>
                {mark.note ? '改批注' : '加批注'}
              </button>
              <button type="button" className="subtle-button" onClick={() => onDelete(mark.id)} aria-label="删除这条书签">
                <Icon name="trash" />
              </button>
            </div>
            {editing === mark.id && (
              <div className="bookmark-edit">
                <input
                  value={editingNote}
                  aria-label="编辑批注"
                  placeholder="为什么标这一段"
                  onChange={event => setEditingNote(event.target.value)}
                />
                <button type="button" className="primary-button" onClick={() => { onNote(mark.id, editingNote.trim()); setEditing(null) }}>保存</button>
                <button type="button" className="ghost-button" onClick={() => setEditing(null)}>取消</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

import { BookNote } from '../lib/api'

/**
 * 「笔记」面板（PROPOSAL-019 E）：这本书的全部划线 / 备注，点一条跳到那一章。
 *
 * 从 `ReaderScreen` 抽出来（PROPOSAL-019 F）—— 只跟笔记清单与「跳到那条」打交道，
 * 与翻页 / 进度 / 缓存无关。
 */
export function NotesPanel({ notes, onJump }: { notes: BookNote[]; onJump: (note: BookNote) => void }) {
  return (
    <ul className="reader-notes-list">
      {notes.length === 0 && <li className="reader-notes-empty">这本书还没有笔记。选中正文可以划线、写备注。</li>}
      {notes.map(note => (
        <li key={note.id} className="reader-note-item">
          <button type="button" className="reader-note-item-main" onClick={() => onJump(note)}>
            <span className="reader-note-item-excerpt">{note.excerpt}</span>
            {note.note && <span className="reader-note-item-text">{note.note}</span>}
            <span className="reader-note-item-meta">第 {note.chapterIndex + 1} 章</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

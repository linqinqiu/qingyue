import type { BookMark } from './api'

/**
 * 书签的算术（用户 2026-10-02：「加入书签功能，可以段落（多段落），章节书签…
 * 该书签可以自定义评论，支持在同书不同书源中使用」）。
 *
 * 单独一份是因为这里有两件容易做错、又只在换源时才暴露的事：
 * ① 书签按**书名 + 作者**归拢，章节定位**先认标题、认不到才退回章节号** ——
 *    同一本书在两个源里第 37 章往往不是同一章，直接跳 index 会跳到错的地方；
 * ② 一次框选可能跨段，选区起点还常在段落中间，所以取"被选区碰到的最前/最后一段"，
 *    不是"完全包含在选区里的段"。
 */

/** 整章书签的段落位约定：服务端与界面都用它，别写两个 -1。 */
export const WHOLE_CHAPTER = -1

export type MarkSelection = { from: number; to: number; text: string }

/**
 * 从当前选区读出"碰到了哪几段、选中的原文是什么"。
 * 选区不在 `container` 里（比如选中了侧栏的文字）时返回 null —— 那时不该冒出「加入书签」。
 */
export function readSelection(container: HTMLElement | null): MarkSelection | null {
  if (!container) return null
  const selection = document.getSelection?.()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!container.contains(range.commonAncestorContainer)) return null
  const indexes = [...container.querySelectorAll<HTMLElement>('[data-paragraph-index]')]
    .filter(node => range.intersectsNode(node))
    .map(node => Number(node.dataset.paragraphIndex))
    .filter(index => Number.isFinite(index))
  if (indexes.length === 0) return null
  const text = selection.toString().trim()
  if (!text) return null
  return { from: Math.min(...indexes), to: Math.max(...indexes), text }
}

/** 换源之后这条该跳到哪一章：标题对得上就用当前源的章节号，对不上才退回原章节号。 */
export function resolveChapter(mark: BookMark, chapters: Array<{ index: number; title: string }>): number | null {
  const wanted = mark.chapterTitle.trim()
  if (wanted) {
    const exact = chapters.find(chapter => chapter.title.trim() === wanted)
    if (exact) return exact.index
    const loose = chapters.find(chapter => chapter.title.trim().includes(wanted) || wanted.includes(chapter.title.trim()))
    if (loose) return loose.index
  }
  return chapters.some(chapter => chapter.index === mark.chapterIndex) ? mark.chapterIndex : null
}

export const isWholeChapter = (mark: BookMark) => mark.paragraphFrom === WHOLE_CHAPTER

/** 一条书签在界面上怎么说自己是什么：整章 / 第 n 段 / 第 n–m 段。 */
export function markScope(mark: BookMark): string {
  if (isWholeChapter(mark)) return '整章'
  if (mark.paragraphFrom === mark.paragraphTo) return `第 ${mark.paragraphFrom + 1} 段`
  return `第 ${mark.paragraphFrom + 1}–${mark.paragraphTo + 1} 段`
}

export type MarkBookGroup = { key: string; name: string; author: string; marks: BookMark[] }

/** 全部书签那一页按书归拢：同一本书在不同源上打的要并成一组，与服务端的键同一套算法。 */
export function groupMarksByBook(marks: BookMark[]): MarkBookGroup[] {
  const buckets = new Map<string, MarkBookGroup>()
  for (const mark of marks) {
    const key = bookMarkKey(mark.bookName, mark.bookAuthor ?? '')
    const group = buckets.get(key) ?? { key, name: mark.bookName, author: mark.bookAuthor?.trim() ?? '', marks: [] }
    group.marks.push(mark)
    buckets.set(key, group)
  }
  return [...buckets.values()].map(group => ({ ...group, marks: [...group.marks].sort((a, b) => b.createdAt - a.createdAt) }))
}

/** 与服务端 `Database.bookKeyOf` 同一套归一化：trim、压内部空白、忽略大小写。 */
export function bookMarkKey(name: string, author: string): string {
  const part = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')
  return `${part(name)}\u0000${part(author)}`
}

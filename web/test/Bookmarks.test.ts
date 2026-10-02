import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { bookMarkKey, groupMarksByBook, markScope, resolveChapter, WHOLE_CHAPTER } from '../src/bookmarks'
import type { BookMark } from '../src/api'

/**
 * 「加入书签功能，可以段落（多段落），章节书签，有整体的，书籍内的，全部书源管理，
 *  该书签可以自定义评论，支持在同书不同书源中使用」（用户 2026-10-02）。
 *
 * 这里钉的是"换源之后还认得路"：书签按书名 + 作者归拢，跳转先认章节标题。
 * 同一本书在两个源里第 37 章往往不是同一章 —— 直接跳 index 会跳到错的地方，
 * 而且只在换源之后才暴露，所以必须离线喂数据判。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')
const mark = (over: Partial<BookMark> = {}): BookMark => ({
  id: 1, sourceId: 'https://a.example/', bookUrl: 'https://a.example/b/1', bookName: '三体', bookAuthor: '刘慈欣',
  chapterIndex: 3, chapterTitle: '人类舰队', paragraphFrom: 7, paragraphTo: 9, quote: '给岁月以文明',
  note: '', createdAt: 100, ...over,
})

test('跨书源归拢 - 键是书名 + 作者，与服务端同一套归一化', () => {
  assert.equal(bookMarkKey('  三体 ', ' 刘慈欣  '), bookMarkKey('三体', '刘慈欣'), '首尾与内部空白不算两个键')
  assert.equal(bookMarkKey('THREE-Body', ''), bookMarkKey('three-body', ''), '大小写不算两本书')
  assert.notEqual(bookMarkKey('三体', '刘慈欣'), bookMarkKey('三体', ''), '作者缺失不能和作者明确并成一组')
  const grouped = groupMarksByBook([
    mark({ id: 1, sourceId: 'https://a.example/', createdAt: 5 }),
    mark({ id: 2, sourceId: 'https://b.example/', createdAt: 9 }),
    mark({ id: 3, bookName: '  三体', createdAt: 7 }),
    mark({ id: 4, bookName: '球状闪电', createdAt: 8 }),
  ])
  assert.deepEqual(grouped.map(group => [group.name, group.marks.length]), [['三体', 3], ['球状闪电', 1]],
    '两个源上的同一本书要并成一组')
  assert.deepEqual(grouped[0].marks.map(item => item.id), [2, 3, 1], '组内按时间新在前')
})

test('换源之后往哪跳 - 先认章节标题，认不到才退回章节号', () => {
  const chapters = [{ index: 0, title: '序' }, { index: 1, title: '死亡之吻' }, { index: 5, title: '人类舰队' }]
  assert.equal(resolveChapter(mark({ chapterIndex: 3, chapterTitle: '人类舰队' }), chapters), 5,
    '原源里的第 3 章在当前源是第 5 章：按标题走才对')
  assert.equal(resolveChapter(mark({ chapterIndex: 1, chapterTitle: '  ' }), chapters), 1, '没有标题时退回章节号')
  assert.equal(resolveChapter(mark({ chapterIndex: 44, chapterTitle: '被删掉的那一章' }), chapters), null,
    '两边都对不上就说对不上，不许跳到一个错的地方')
  assert.equal(resolveChapter(mark({ chapterTitle: '人类舰队 （精校版）' }), chapters), 5, '标题带后缀时认包含关系')
})

test('一条书签说什么 - 整章、单段、跨段三种写法不混', () => {
  assert.equal(markScope(mark({ paragraphFrom: WHOLE_CHAPTER, paragraphTo: WHOLE_CHAPTER })), '整章')
  assert.equal(markScope(mark({ paragraphFrom: 7, paragraphTo: 7 })), '第 8 段', '界面上给人看的是 1 起的段号')
  assert.equal(markScope(mark({ paragraphFrom: 7, paragraphTo: 9 })), '第 8–10 段')
})

test('阅读器与全部书签那一页都接上了', () => {
  const reader = read('../src/ReaderScreen.tsx')
  assert.match(reader, /activeDrawer, setActiveDrawer\] = useState<'toc' \| 'marks' \| 'settings'/, '书签是左栏的第三档')
  assert.match(reader, /api\.marks\(currentBook\.details\.name, currentBook\.details\.author/,
    '取的是**这本书**的书签（按书名 + 作者），换源之后仍认得')
  assert.match(reader, /bookName: currentBook\.details\.name/, '写入与读取用同一个名字：换源时书名也会换，两处不同源就会漂')
  assert.match(reader, /selectionchange/, '选区是监听来的：按住拖选之后不点任何键也认得')
  assert.match(reader, /selectionChapterRef\.current === /, '选中落在续接进来的下一章时不许加入书签')
  assert.match(reader, /api\.createMark/, '真的写服务端，不是本地数组')
  assert.match(read('../src/shortcuts.ts'), /action: 'marks', keys: \['b'\]/, '按键表里有 B 这一条')
  const page = read('../src/BookmarksPage.tsx')
  assert.match(page, /api\.marks\(\)/, '「全部书源管理」那一页取的是不带书名的全量')
  assert.match(page, /groupMarksByBook/)
  assert.match(page, /不在书架/, '不在书架上的那本不许给一个点了打不开的按钮')
  assert.match(read('../src/main.tsx'), /page === 'bookmarks'/)
  assert.match(read('../src/api.ts'), /removeMark: \(id: number\) => request<void>\(`/)
  assert.match(read('../../server/src/main/kotlin/io/legado/server/Routes.kt'), /post\("\/marks"\)[\s\S]*?empty_mark/,
    '原文和批注都空的书签要拒收，而不是存一条空白条目')
})

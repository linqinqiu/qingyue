import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 书架页的三条"界面上的话必须是事实"（2026-10-11 全量通读时读出来的三处，都不是报错、都是假话）：
 *
 * ① `items` 初值是 `[]` 而 `load()` 是异步的，所以第一帧就渲染「书架还是空的」——
 *    这与 AGENTS.md「还没取到 / 取失败了 / 确实没有是三件事」那条直接冲突，
 *    而同一个文件里分组那栏（`groupsFailed`）已经分开写了，等于自己打自己的脸。
 * ② 「全选」按钮的 title 写着"全选当前页所有书籍"，而实现按 `items`（整架）取键，
 *    页签与分组筛选只作用于 `visibleItems` —— 于是批量删除会动到当前筛不出来的书。
 * ③ 同一张卡上两个百分比（hover 层 +1、meta 层不加）—— 同一个 item 同屏两个答案。
 *
 * 这三条都在 JSX 渲染分支里，静态渲染演不出"加载中的那一帧"（`load()` 在 effect 里，
 * renderToStaticMarkup 不跑 effect），所以按 AGENTS.md 里对生命周期类判据的既有做法钉源码结构。
 * 每条都带反向对照：把旧的写法扫出来，光扫"新写法在不在"是空判。
 */

const SHELF = fs.readFileSync(path.resolve(import.meta.dirname, '../src', 'main.tsx'), 'utf8')
const shelfBody = SHELF.slice(SHELF.indexOf('function ShelfPage'))

test('① 书架空态只能由"取到了且确实是空的"触发', () => {
  assert.match(shelfBody, /const \[itemsLoaded, setItemsLoaded\] = useState\(false\)/,
    '要有一个"到手了"的旗标')
  assert.match(shelfBody, /setItemsLoaded\(true\)/, '旗标要在 load 的 finally 里置位')
  assert.match(shelfBody, /!itemsLoaded && !message \?/, '加载中给的是"正在读书架…"，不是空态卡')
  assert.doesNotMatch(shelfBody, /items\.length === 0 && !message \? \(\s*<section className="shelf-empty">\s*<Icon name="book" \/>\s*<h2>书架还是空的/,
    '反向对照：老的那句"没到手就说你空的"要清零')
})

test('① 取失败时列表区保持沉默，让 form-error 单独说话', () => {
  assert.match(shelfBody, /const shelfFailedEmpty = !!message && items\.length === 0/,
    '失败且手里没有东西时，要有一个专门的档位什么都不画')
  assert.match(shelfBody, /: shelfFailedEmpty \?\s*\(\s*null\s*\)/, '该档位渲染 null')
})

test('② 全选选的是筛完之后那一列', () => {
  const selectAll = shelfBody.match(/const selectAllBooks = \(\) => \{[\s\S]*?\n  \}/)
  assert.ok(selectAll, '全选的实现要还在（换了写法就同步改这条）')
  assert.match(selectAll[0], /visibleItems\.map/, '按可见那一列取键')
  assert.doesNotMatch(selectAll[0], /items\.map/, '反向对照：按整架取键的写法要清零')
  // 定义位置也钉住：写在 visibleItems 之前会读到一个还没初始化的 const
  assert.ok(shelfBody.indexOf('const visibleItems = useMemo') < shelfBody.indexOf('const selectAllBooks'),
    'selectAllBooks 必须定义在 visibleItems 之后')
})

test('③ 一张卡上只有一个百分比口径', () => {
  const percent = shelfBody.match(/className="shelf-meta-percent"[\s\S]{0,220}/)
  assert.ok(percent, '卡底部那格百分比要还在')
  assert.match(percent[0], /\(\(item\.chapterIndex \?\? 0\) \+ 1\) \/ item\.totalChapters/,
    '与 hover 层同口径：读到第 N 章就是 N/总数')
  assert.doesNotMatch(percent[0], /\(item\.chapterIndex \?\? 0\) \/ item\.totalChapters/,
    '反向对照：不加一的那份要清零')
})

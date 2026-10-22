import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「书源订阅」要从编辑器本体里挪出去（P0.3）。
 *
 * 以前 `<SourceSubscriptionPanel>` 直接贴在 `<section className="sources-content">` 内、
 * 紧挨着 `<SourceEditor>` 上面，于是「订阅地址」一展开就把编辑表单挤进同一个区块，
 * 编辑器区显得臃肿。现在的形状：右栏分两块 —— 上面的 `.editor-region` 只放页头 + 书源订阅，
 * 下面的 `<section className="sources-content">` 只承载 `SourceEditor` 本体。
 *
 * 这条测的是"订阅不再长在编辑器区块里"这个结构事实：订阅块在编辑器 <section> 之前、
 * 两者被包进同一个 `.sources-main`。措辞不管，结构改了才是事故。
 */

const SRC = path.resolve(import.meta.dirname, '../src')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')

function functionBody(text: string, name: string): string {
  const start = text.search(new RegExp(`^(?:export )?function ${name}\\(`, 'm'))
  assert.ok(start >= 0, `找不到顶层 function ${name}(`)
  const rest = text.slice(text.indexOf('\n', start) + 1)
  const next = rest.search(/^[\w]/m)
  return next < 0 ? rest : rest.slice(0, next)
}

const sourcesPage = () => functionBody(read('pages/SourcesPage.tsx'), 'SourcesPage')

test('书源订阅不再嵌在编辑器区块内', () => {
  const body = sourcesPage()
  const subIdx = body.indexOf('<SourceSubscriptionPanel')
  const contentIdx = body.indexOf('className="sources-content"')

  assert.ok(subIdx >= 0, 'SourcesPage 里没有渲染 <SourceSubscriptionPanel')
  assert.ok(contentIdx >= 0, 'SourcesPage 里没有 <section className="sources-content"> 编辑器区块')

  // 订阅块必须出现在编辑器 <section> 之前 —— 即它落在上面的 .editor-region，而不是 section 内部
  assert.ok(subIdx < contentIdx, '书源订阅又躲回编辑器 <section> 里了，把它挪到编辑器区块之前')
})

test('右栏被 .sources-main 包成两块：上面的 .editor-region 与下面的编辑器 <section>', () => {
  const body = sourcesPage()
  // 包着页头/订阅与编辑器的外层容器
  assert.ok(body.includes('className="sources-main"'), '右栏缺少 .sources-main 包装容器')
  // 页头 + 订阅所在的区块（与编辑器 <section> 平级，不滚，不挤编辑器）
  assert.ok(body.includes('className="editor-region"'), '缺少 .editor-region：页头+订阅应单独成块，和编辑器平级')

  const mainIdx = body.indexOf('<div className="sources-main">')
  const regionIdx = body.indexOf('<div className="editor-region">')
  const contentIdx = body.indexOf('<section className="sources-content">')
  assert.ok(regionIdx > mainIdx, '.editor-region 应包在 .sources-main 内')
  assert.ok(contentIdx > mainIdx, '编辑器 <section> 应包在 .sources-main 内')
  // .editor-region（含订阅）在编辑器 <section> 之前
  assert.ok(regionIdx < contentIdx, '.editor-region 应排在编辑器 <section> 之前')
})

test('订阅展开时滚动目标仍是 .subscription-panel（不依赖 .sources-content 内嵌）', () => {
  const body = sourcesPage()
  assert.ok(
    body.includes("querySelector('.subscription-panel')?.scrollIntoView"),
    '订阅展开后的滚动手势仍要能定位到 .subscription-panel',
  )
  assert.ok(
    !body.includes("querySelector('.sources-content .subscription-panel')"),
    '滚动选择器还假定订阅嵌在 .sources-content 里 —— 订阅已移到外头，选择器要相应改掉',
  )
})

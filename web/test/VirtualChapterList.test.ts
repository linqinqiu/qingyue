import test from 'node:test'
import assert from 'node:assert/strict'
import { assertScalesLinearly, assertWithinCeiling } from './perfCriteria.ts'
import fs from "node:fs"
import path from "node:path"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { VirtualChapterList } from "../src/ReaderScreen"
import { TOC_ROW_HEIGHT } from "../src/readerInteractions"

export type VirtualSliceConfig = {
  totalCount: number
  itemHeight: number
  scrollTop: number
  viewportHeight: number
  overscan?: number
}

export type VirtualSliceResult = {
  totalHeight: number
  startIndex: number
  endIndex: number
  renderedCount: number
  offsetY: number
}

/**
 * Computes the virtualized window slice for a list of items with fixed height.
 * Guarantees renderedCount is strictly bounded by viewport size + 2 * overscan.
 */
export function computeVirtualSlice(config: VirtualSliceConfig): VirtualSliceResult {
  const { totalCount, itemHeight, scrollTop, viewportHeight, overscan = 6 } = config
  const totalHeight = totalCount * itemHeight
  if (totalCount <= 0 || itemHeight <= 0) {
    return { totalHeight: 0, startIndex: 0, endIndex: 0, renderedCount: 0, offsetY: 0 }
  }

  const maxScroll = Math.max(0, totalHeight - viewportHeight)
  const clampedScrollTop = Math.max(0, Math.min(maxScroll, Number.isFinite(scrollTop) ? scrollTop : 0))

  const rawStart = Math.floor(clampedScrollTop / itemHeight) - overscan
  const startIndex = Math.max(0, Math.min(totalCount - 1, rawStart))

  const rawEnd = Math.ceil((clampedScrollTop + viewportHeight) / itemHeight) + overscan
  const endIndex = Math.min(totalCount, Math.max(startIndex, rawEnd))

  const renderedCount = Math.max(0, endIndex - startIndex)
  const offsetY = startIndex * itemHeight

  return { totalHeight, startIndex, endIndex, renderedCount, offsetY }
}

/**
 * Computes the target scrollTop offset required to center a specific chapter in the viewport.
 */
export function computeAutoScrollOffset(
  chapterIndex: number,
  itemHeight: number,
  viewportHeight: number,
  totalCount: number
): number {
  if (totalCount <= 0 || itemHeight <= 0 || viewportHeight <= 0) return 0
  const totalHeight = totalCount * itemHeight
  const maxScroll = Math.max(0, totalHeight - viewportHeight)
  const clampedIndex = Math.max(0, Math.min(totalCount - 1, chapterIndex))
  const targetTop = clampedIndex * itemHeight - (viewportHeight / 2 - itemHeight / 2)
  return Math.max(0, Math.min(maxScroll, Math.round(targetTop)))
}

// -----------------------------------------------------------------------------
// Tier 1: Core Feature Tests (5,000 Chapter TOC & Virtualization Math)
// -----------------------------------------------------------------------------

test('VirtualChapterList - Tier 1: Total scroll height linear scaling (5,000 chapters)', () => {
  const slice = computeVirtualSlice({
    totalCount: 5000,
    itemHeight: 36,
    scrollTop: 0,
    viewportHeight: 500,
  })
  assert.equal(slice.totalHeight, 180000, '5000 * 36px must equal 180,000px')
})

test('VirtualChapterList - Tier 1: Initial viewport renders bounded slice (<= 25-30 nodes)', () => {
  const slice = computeVirtualSlice({
    totalCount: 5000,
    itemHeight: 36,
    scrollTop: 0,
    viewportHeight: 500,
    overscan: 6,
  })
  assert.equal(slice.startIndex, 0)
  assert.equal(slice.endIndex, 20) // ceil(500/36) + 6 = 14 + 6 = 20
  assert.equal(slice.renderedCount, 20)
  assert.equal(slice.offsetY, 0)
  assert.ok(slice.renderedCount <= 30, `Expected <= 30 nodes, got ${slice.renderedCount}`)
})

test('VirtualChapterList - Tier 1: Middle-scroll slice calculation (chapter 1,000) and item offset', () => {
  const chapter1000ScrollTop = 1000 * 36 // 36,000px
  const slice = computeVirtualSlice({
    totalCount: 5000,
    itemHeight: 36,
    scrollTop: chapter1000ScrollTop,
    viewportHeight: 500,
    overscan: 6,
  })
  assert.equal(slice.startIndex, 994) // 1000 - 6
  assert.equal(slice.endIndex, 1020) // ceil(36500/36) + 6 = 1014 + 6 = 1020
  assert.equal(slice.renderedCount, 26)
  assert.equal(slice.offsetY, 994 * 36) // 35,784px
  assert.ok(slice.renderedCount <= 30)

  // Verify specific item absolute position
  const itemIndex = 1000
  const itemTop = itemIndex * 36
  assert.equal(itemTop, 36000)
  assert.ok(itemIndex >= slice.startIndex && itemIndex < slice.endIndex, 'Target chapter 1000 must be in slice')
})

test('VirtualChapterList - Tier 1: End-of-list scroll clamping & boundary protection', () => {
  const maxScrollTop = 5000 * 36 - 500 // 179,500px
  const slice = computeVirtualSlice({
    totalCount: 5000,
    itemHeight: 36,
    scrollTop: maxScrollTop,
    viewportHeight: 500,
    overscan: 6,
  })
  assert.equal(slice.endIndex, 5000)
  assert.equal(slice.startIndex, 4980) // floor(179500/36) - 6 = 4986 - 6 = 4980
  assert.equal(slice.renderedCount, 20)
  assert.equal(slice.offsetY, 4980 * 36)
  assert.ok(slice.renderedCount <= 30)
})

test('VirtualChapterList - Tier 1: Auto-scroll viewport centering math', () => {
  // Center chapter 2,500 in a 500px viewport with 36px item height
  const offset = computeAutoScrollOffset(2500, 36, 500, 5000)
  // Expected: 2500 * 36 - (500/2 - 36/2) = 90000 - (250 - 18) = 90000 - 232 = 89,768px
  assert.equal(offset, 89768)

  // Validate centering condition: scrollTop + halfViewport == itemCenter
  const viewportCenterInContainer = offset + 500 / 2
  const itemCenterInContainer = 2500 * 36 + 36 / 2
  assert.equal(viewportCenterInContainer, itemCenterInContainer)

  // Near top boundary: chapter 2 should clamp cleanly without negative offset
  const topOffset = computeAutoScrollOffset(2, 36, 500, 5000)
  // 2 * 36 - 232 = 72 - 232 = -160 => clamped to 0
  assert.equal(topOffset, 0)

  // Near bottom boundary: chapter 4998 should clamp to maxScroll (179,500px)
  const bottomOffset = computeAutoScrollOffset(4998, 36, 500, 5000)
  assert.equal(bottomOffset, 179500)
})

// -----------------------------------------------------------------------------
// Tier 2: Boundary & Corner Cases
// -----------------------------------------------------------------------------

test('VirtualChapterList - Tier 2: Zero chapters handling (empty list)', () => {
  const slice = computeVirtualSlice({
    totalCount: 0,
    itemHeight: 36,
    scrollTop: 0,
    viewportHeight: 500,
  })
  assert.equal(slice.totalHeight, 0)
  assert.equal(slice.startIndex, 0)
  assert.equal(slice.endIndex, 0)
  assert.equal(slice.renderedCount, 0)
  assert.equal(slice.offsetY, 0)

  const offset = computeAutoScrollOffset(0, 36, 500, 0)
  assert.equal(offset, 0)
})

test('VirtualChapterList - Tier 2: Single chapter boundary handling', () => {
  const slice = computeVirtualSlice({
    totalCount: 1,
    itemHeight: 36,
    scrollTop: 0,
    viewportHeight: 500,
  })
  assert.equal(slice.totalHeight, 36)
  assert.equal(slice.startIndex, 0)
  assert.equal(slice.endIndex, 1)
  assert.equal(slice.renderedCount, 1)
  assert.equal(slice.offsetY, 0)

  const offset = computeAutoScrollOffset(0, 36, 500, 1)
  assert.equal(offset, 0)
})

test('VirtualChapterList - Tier 2: Viewport height exceeding total content height', () => {
  const slice = computeVirtualSlice({
    totalCount: 10,
    itemHeight: 36,
    scrollTop: 0,
    viewportHeight: 1000, // content height is 360px < 1000px
  })
  assert.equal(slice.totalHeight, 360)
  assert.equal(slice.startIndex, 0)
  assert.equal(slice.endIndex, 10)
  assert.equal(slice.renderedCount, 10)
  assert.equal(slice.offsetY, 0)
})

test('VirtualChapterList - Tier 2: Negative/overscroll scrollTop & NaN defense', () => {
  // Negative scrollTop (e.g. mobile rubber-band bounce)
  const negSlice = computeVirtualSlice({
    totalCount: 5000,
    itemHeight: 36,
    scrollTop: -350,
    viewportHeight: 500,
  })
  assert.equal(negSlice.startIndex, 0)
  assert.equal(negSlice.offsetY, 0)

  // Excessive overscroll past bottom
  const overSlice = computeVirtualSlice({
    totalCount: 5000,
    itemHeight: 36,
    scrollTop: 999999,
    viewportHeight: 500,
  })
  assert.equal(overSlice.endIndex, 5000)
  assert.ok(overSlice.renderedCount <= 30)

  // NaN scrollTop defense
  const nanSlice = computeVirtualSlice({
    totalCount: 5000,
    itemHeight: 36,
    scrollTop: NaN,
    viewportHeight: 500,
  })
  assert.equal(nanSlice.startIndex, 0)
  assert.equal(nanSlice.renderedCount, 20)
})

test('VirtualChapterList - Tier 2: Extreme scale benchmark (50,000 chapters)', () => {
  // 预热一轮：第一次跑付 V8 冷编译的账，直接拿它当分母会让比值假性偏小
  for (let i = 0; i < 200; i++) computeVirtualSlice({ totalCount: 50000, itemHeight: 36, scrollTop: i * 36, viewportHeight: 600, overscan: 6 })
  const start = performance.now()
  const iterations = 1000
  for (let i = 0; i < iterations; i++) {
    const scrollTop = (i / iterations) * (50000 * 36 - 600)
    const slice = computeVirtualSlice({
      totalCount: 50000,
      itemHeight: 36,
      scrollTop,
      viewportHeight: 600,
      overscan: 6,
    })
    assert.ok(slice.renderedCount <= 32, `Rendered count ${slice.renderedCount} must stay bounded`)
    assert.ok(slice.startIndex >= 0 && slice.endIndex <= 50000)
  }
  const elapsed = performance.now() - start
  // 原来钉的是"1,000 次切片 < 50ms"，那测的是这台机器此刻有多闲（见 web/test/perfCriteria.ts）。
  // 换成量级判据：切片次数 4 倍，时间不许超线性涨；结构性上限（renderedCount <= 32）上面逐次在判。
  const againStart = performance.now()
  for (let i = 0; i < iterations * 4; i++) {
    const scrollTop = (i / (iterations * 4)) * (50000 * 36 - 600)
    const slice = computeVirtualSlice({
      totalCount: 50000,
      itemHeight: 36,
      scrollTop,
      viewportHeight: 600,
      overscan: 6,
    })
    assert.ok(slice.renderedCount <= 32, `Rendered count ${slice.renderedCount} must stay bounded`)
    assert.ok(slice.startIndex >= 0 && slice.endIndex <= 50000)
  }
  assertScalesLinearly({ name: '50,000 项虚拟切片 1,000→4,000 次', smallMs: elapsed, bigMs: performance.now() - againStart, dataFactor: 4 })
})


// ———— AI-2 任务 C·模块 3「目录虚拟列表」补的两条（撞 key 与行高双写）————

test('同 url 的两章都要渲染得出：key 带章节序号（服务端不按地址去重）', () => {
  const chapters = [
    { index: 0, title: '第1章 上', url: '/c/dup' },
    { index: 1, title: '第1章 下', url: '/c/dup' },
  ]
  const html = renderToStaticMarkup(React.createElement(VirtualChapterList, {
    chapters, activeChapterIndex: 0, onSelect: () => {}, itemHeight: TOC_ROW_HEIGHT, overscan: 8,
  }))
  assert.match(html, /第1章 上/, '第一行在')
  assert.match(html, /第1章 下/, '同址的第二行不能因为撞 key 就消失')
  // 反向对照：裸 url 当 key 的写法不许回来 —— React 重复 key 只 warning，门禁与页面都看不见
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'ReaderScreen.tsx'), 'utf8')
  assert.doesNotMatch(src, /key=\{chapter\.url\}/)
})

test('行高只有一个来源：TOC_ROW_HEIGHT 必须等于样式表里的 --row-h-list', () => {
  const css = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8')
  const declared = Number(css.match(/--row-h-list:\s*(\d+(?:\.\d+)?)px/)?.[1])
  assert.ok(declared > 0, '`--row-h-list` 得在样式表里真存在着')
  assert.equal(TOC_ROW_HEIGHT, declared,
    `虚拟化按 ${TOC_ROW_HEIGHT}px 算「第 i 行位移 = i × 行高」，样式却画 ${declared}px —— 5,000 章滚到底会差出整屏`)
})

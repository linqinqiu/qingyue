/**
 * 滚动模式的"连续文档"算术（用户 2026-10-02：「章节间的连接还是不对，怎么能跳转呢，不是一体的吗」）。
 *
 * 原来滚动模式一次只渲染一章：滚到底再往下推一下就走 `changeChapter(+1,'first')`，
 * 那意味着整棵正文子树重建 + 进场动画重播 + 强制 `scrollTo(0)` —— 语义上是"下一章从屏幕顶重新开始"，
 * 用户看到的就是"跳"。现在把后续章节续接在同一个滚动容器里，跨过边界时**把窗口往前挪一格**。
 *
 * 挪窗口之后必须把画面按回原位。这里刻意**不按"摘掉那一章的高度"来算**：节与节之间还有一条
 * 分隔线的外边距，一节变成首节时那条边距会消失；按高度算就会每次都少掉那条边距，
 * 跨十章就是十次肉眼可见的小跳。改成"顶完之后重新量一次新锚点在屏幕上的位置，差多少补多少"。
 *
 * 这些函数都只做算术：DOM 归 ReaderScreen，判据归 web/test/ReaderFlow.test.ts。
 */

/** 一个已渲染章节在文档里的位置信息（`getBoundingClientRect` 的顶部偏移与高度，CSS 像素）。 */
export type SectionBox = {
  /** 相对文档顶部（= window.scrollY + rect.top） */
  top: number
  height: number
}

/**
 * 这一章读完了没有 —— 提升窗口的条件。
 *
 * 判据是"这一章的底边已经**越过视口顶部**再多留 `holdBack`"，不是"整页触底"：
 * 触底判据在多章连续流里永远成立（文档底部一直在下面），会一路狂翻章节。
 *
 * `holdBack` 必须是"往后留一点"而不是"提前一点"：摘掉的那一节要是还有 280px 留在屏幕上
 * （旧版按视口高度的 35% 判），用户就会看到自己正在读的那几行凭空消失，而且那一节的新顶边
 * 无法再摆回原来的屏幕位置（文档上面没东西了，滚动位置会被夹到 0）—— 两边都跳。
 * 越过顶部之后再等 `holdBack` 像素，被摘的那些字已经全部在屏幕上方，切起来才真的是无缝的。
 */
export function chapterConsumed(box: SectionBox, scrollTop: number, holdBack = 24): boolean {
  return box.top + box.height <= scrollTop - holdBack
}

/**
 * 该把窗口往前顶几节，以及顶完之后新锚点该停在屏幕上的哪个位置。
 *
 * 关键在于**一次可以顶过多章**。逐节推进在慢慢滚轮时没问题，但拖滚动条、
 * 从目录跳进去、或程序化 `scrollTo` 一帧就能跨过去两三章：这时如果只摘掉最上面一节，
 * 锚点仍然停在视口上方很远，进度与"当前章"标题都对不上画面，用户看到的就是"跳"。
 * 至少给窗口留一节，全摘完就没有锚点了。
 *
 * `keepTop` 是新锚点相对视口顶部的偏移（一般为负：这一章已经读掉了一大截），
 * 摘完之后再量一次实际偏移，用 `holdScroll` 把差值补回来。
 */
export function flowAdvance(sections: SectionBox[], scrollTop: number, holdBack = 24): { lead: number; keepTop: number } | null {
  let lead = 0
  while (lead < sections.length - 1 && chapterConsumed(sections[lead], scrollTop, holdBack)) lead += 1
  if (lead === 0) return null
  return { lead, keepTop: sections[lead].top - scrollTop }
}

/**
 * 摘掉顶部那几节之后，把滚动位置校正回 `keepTop` 所指的那块屏幕。
 *
 * `measuredTop` 是提交之后新锚点当前的屏幕偏移：它和 `keepTop` 的差就是这一下被摘掉的全部内容
 * （加上分隔线边距之类按高度算不出来的部分）。不用几何量的话画面就会"往上跳"一截 ——
 * 那正是我们要消灭的症状，只是换了个触发点。
 */
export function holdScroll(scrollTop: number, measuredTop: number, keepTop: number): number {
  return Math.max(0, scrollTop + measuredTop - keepTop)
}

/**
 * 分页模式里一章占的页区间（`start` 含、`end` 不含），量自排版后的 DOM。
 * 翻页模式的"连续"和滚动模式是同一件事，只是单位从像素换成页（用户 2026-10-02：「横板还是跳转」）。
 */
export type PageSpan = { start: number; end: number }

/** 这一页落在哪一节：最后一个起点不晚于这一页的那一节。 */
export function sectionAtPage(spans: PageSpan[], page: number): number {
  let index = 0
  for (let i = 0; i < spans.length; i += 1) if (spans[i].start <= page) index = i
  return index
}

/**
 * 页内进度 —— 分母是**当前这一章的页数**，不是整个窗口的页数。
 * 与滚动模式 `sectionProgress` 同一条契约：存进服务端的永远是"这一章读了多少"。
 */
export function pageProgress(spans: PageSpan[], page: number): number {
  if (!spans.length) return 0
  const span = spans[Math.min(sectionAtPage(spans, page), spans.length - 1)]
  const pages = span.end - span.start
  if (pages <= 1) return 1
  return Math.min(1, Math.max(0, (page - span.start) / (pages - 1)))
}

/**
 * 窗口该往前挪几章，以及挪完之后页码是多少。
 *
 * 翻到已经挂在下面的那一章时不是"换章"：摘掉最前面那一章、页码减去它的页数 ——
 * 不减的话窗口一空，画面就从第三章的第一页重新开始，用户看到的是"跳回去"。
 */
export function pageWindowShift(spans: PageSpan[], page: number): { lead: number; pageIndex: number } | null {
  const lead = sectionAtPage(spans, page)
  if (lead === 0) return null
  return { lead, pageIndex: page - spans[lead].start }
}

/**
 * 章内进度（写进 `reading_progress.scroll_position` 的那个 0..1）。
 *
 * 契约没变：**仍然是"这一章里读了多少"**，只是分母从"整篇文档"换成"这一章那一节"。
 * 不改的话，连续流里的百分比会变成"整篇的百分比"，服务端与书架秒开读到的就是错的位置。
 */
export function sectionProgress(box: SectionBox, scrollTop: number, viewport: number): number {
  const scrollable = box.height - viewport
  if (scrollable <= 0) {
    // 一章比一屏还短：要么没到它（0），要么已经翻过它（1）
    return scrollTop + viewport >= box.top + box.height ? 1 : 0
  }
  const ratio = (scrollTop - box.top) / scrollable
  return Math.min(1, Math.max(0, ratio))
}

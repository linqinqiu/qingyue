import test from 'node:test'
import assert from 'node:assert/strict'
import { chapterConsumed, flowAdvance, holdScroll, SectionBox, sectionProgress } from '../src/readerFlow'

/**
 * 连续滚动的算术（用户 2026-10-02：「章节间的连接还是不对，怎么能跳转呢，不是一体的吗」）。
 *
 * 这几条为什么值得单独钉：产品的"跳"不是审美问题，是三处机制叠出来的
 * （整棵子树重挂 + 动画重播 + 强制 scrollTo）。改成续接之后，
 * 最容易做错的两件事是"摘掉顶部那几章之后怎么把画面按回原位"和"章内进度的分母"，
 * 两者错了都不会报错，只会让用户觉得"还是怪"或者"进度乱跳"。
 */
const VIEW = 800

const SECTIONS: SectionBox[] = [
  { top: 0, height: 2000 },
  { top: 2000, height: 1500 },
  { top: 3500, height: 900 },
]

test('chapterConsumed - 判据是"底边越过视口顶部再多留一点"，不是整页触底', () => {
  const first: SectionBox = { top: 0, height: 2000 }
  assert.equal(chapterConsumed(first, 0), false, '刚进这一章')
  assert.equal(chapterConsumed(first, 1200), false, '底边还在视口里，不该翻')
  assert.equal(chapterConsumed(first, 2010), false, '刚越过顶部 10px 还不摘：屏幕上那几行字仍然要留着')
  assert.equal(chapterConsumed(first, 2030), true, '越过顶部再多留 24px 才摘')
  // 反向对照：连续流里"文档底部到了"永远成立，拿触底判据会一路狂翻章节
  const whole: SectionBox = { top: 0, height: 60_000 }
  assert.equal(chapterConsumed(whole, 0), false, '窗口再高也不该被当成"这一章读完了"')
})

test('flowAdvance - 慢滚一次顶一章，拖滚动条一次可以顶过多章', () => {
  assert.equal(flowAdvance(SECTIONS, 2010), null, '第一章底边刚越过顶部，还没到该摘的时候')
  assert.deepEqual(flowAdvance(SECTIONS, 2100), { lead: 1, keepTop: -100 }, '顶掉第一章，第二章该停在视口顶部上方 100px')
  // 拖滚动条/程序化跳转一帧就能跨过去两章：只顶一章的话锚点会落后在视口上方，
  // 标题与进度对不上画面 —— 那还是"跳"，只是换了个原因。
  assert.deepEqual(flowAdvance(SECTIONS, 3600), { lead: 2, keepTop: -100 }, '一帧跨两章就一次顶两章')
  assert.equal(flowAdvance(SECTIONS, 3000)?.keepTop, SECTIONS[1].top - 3000, 'keepTop 是新锚点相对视口顶部的偏移（这一章已读掉一截时为负）')
})

test('flowAdvance 反向对照：永远给窗口留一章，否则就没有锚点了', () => {
  const deep = flowAdvance(SECTIONS, 99_999)
  assert.equal(deep?.lead, 2, '滚到天涯海角也只剩最后一节')
  assert.ok(deep!.lead < SECTIONS.length, '不许把窗口摘空')
  assert.equal(flowAdvance([SECTIONS[0]], 99_999), null, '窗口里只有一章时不许推进（否则会把自己摘没）')
  assert.equal(flowAdvance([], 100), null, '空窗口不该动')
})

test('顶完之后的锚点必须真的对着视口：flowAdvance 与 chapterConsumed 是同一把尺', () => {
  for (const y of [0, 900, 2100, 2400, 3600, 5000]) {
    const lead = flowAdvance(SECTIONS, y)?.lead ?? 0
    const anchor = SECTIONS[lead]
    // 摘多了：锚点整节跑到视口下方，屏幕上是空白；摘少了：上一章还压在上面，标题与进度对不上画面。
    assert.ok(anchor.top <= y + VIEW, `y=${y} 时锚点不该整节都在视口下方`)
    assert.ok(!chapterConsumed(anchor, y) || lead === SECTIONS.length - 1, `y=${y} 时锚点不该是已经翻过去的那一章`)
  }
})

test('holdScroll - 校正量来自"量出来的偏移"，不是摘掉那几节的高度', () => {
  assert.equal(holdScroll(3300, -3212, -1300), 1388)
  assert.equal(holdScroll(1000, 500, 500), 1000, '量出来就是目标，那一步都不许多')
  assert.equal(holdScroll(500, -4000, -1300), 0, '不许出现负滚动')
})

test('反向对照：按高度算就会漏掉分隔线的边距 —— 每跨一章小跳一次', () => {
  const MARGIN = 61 // 节与节之间那条分隔线的外边距（3.2em）：一节变成首节时它会消失
  const removedHeight = 2000
  const scrollTop = 3000
  const keepTop = (removedHeight + MARGIN) - scrollTop // 顶之前第二章在视口上方 939px
  // 摘掉第一章之后，第二章顶到文档 0 处；滚动位置还没动，所以量出来的偏移是 -3000
  const measuredTop = 0 - scrollTop
  const held = holdScroll(scrollTop, measuredTop, keepTop)
  const byHeight = scrollTop - removedHeight
  assert.equal(0 - held, keepTop, '按量校正之后，第二章应当严丝合缝回到原来那块屏幕')
  assert.equal(Math.abs((0 - byHeight) - keepTop), MARGIN, '按高度算会差出那条边距：跨十章就是十次肉眼可见的小跳')
})

test('sectionProgress - 分母是"这一章"，不是整篇文档', () => {
  const second: SectionBox = { top: 2000, height: 1500 }
  // 整篇 4400px；若按整篇算，滚到 2000 会报 0.45 —— 那正是进度契约被改坏的样子
  assert.equal(sectionProgress(second, 2000, VIEW), 0, '刚进这一章就是 0')
  assert.equal(sectionProgress(second, 2700, VIEW), 1, '这一章读完就是 1')
  assert.ok(Math.abs(sectionProgress(second, 2280, VIEW) - 0.4) < 1e-9, '中段按比例：可滚 700px，滚了 280px 就是 0.4')
  assert.equal(sectionProgress({ top: 0, height: 300 }, 900, VIEW), 1, '比一屏还短的一章：翻过去就是 1')
  assert.equal(sectionProgress({ top: 5000, height: 300 }, 0, VIEW), 0, '还没到就是 0')
})

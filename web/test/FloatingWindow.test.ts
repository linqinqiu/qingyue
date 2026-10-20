import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 浮动窗口框架的判据 —— "窗口怎么摆"是可自定义的框架能力。
 *
 * 用户要求（原话）："我希望各个功能的界面位置也可以自定义，咱们提供非常宏大的架构，
 * 提供支持，比如悬浮窗的固定、大小样式，能否移动之类的细节方面照样支持。"
 *
 * 这里测的是**能力是否存在**（源码级），不是像素级渲染 —— 渲染由真机探针验。
 */

const FW = path.resolve(import.meta.dirname, '../src/lab/FloatingWindow.tsx')
const src = fs.readFileSync(FW, 'utf8')

test('浮动窗口 支持拖动位置', () => {
  assert.match(src, /kind: 'move'/, '要有拖动模式')
  assert.match(src, /beginDrag\('move'\)/, '标题栏要挂拖动')
  assert.match(src, /mousemove/, '要监听鼠标移动')
})

test('浮动窗口 支持调整大小', () => {
  // 拖动模式是联合类型 `'move' | 'resize'`，所以按"两个都出现"判，不按某一种写法判。
  assert.match(src, /'move' \| 'resize'/, '要有移动与缩放两种拖动模式')
  assert.match(src, /beginDrag\('resize'\)/, '缩放把手要挂事件')
  assert.match(src, /width: drag\.origin\.width \+ dx/, '宽度要按拖动距离算')
  assert.match(src, /height: drag\.origin\.height \+ dy/, '高度同理')
})

test('浮动窗口 支持钉住（固定位置）', () => {
  assert.match(src, /pinned/, '要有钉住状态')
  assert.match(src, /if \(state\.pinned\) return/, '钉住时不许拖动')
  assert.match(src, /!state\.pinned && \(/, '钉住时不给缩放把手')
  assert.match(src, /钉住/, '界面要能表达这个语义')
})

test('浮动窗口 支持最小化', () => {
  assert.match(src, /minimized/, '要有最小化状态')
  assert.match(src, /fw-fab/, '最小化后要留一个悬浮按钮')
})

test('浮动窗口 位置与状态可持久化 —— 重开还在原处', () => {
  assert.match(src, /localStorage\.setItem/, '要记下来')
  assert.match(src, /loadState/, '要读回来')
  assert.match(src, /storageKey/, '每个窗口用自己的 key，互不覆盖')
})

test('浮动窗口 边界夹取 —— 不许拖到视口外', () => {
  // 拖出去就再也点不到，这是最常见的浮动窗 bug
  assert.match(src, /clampRect/, '要有夹取')
  assert.match(src, /EDGE_MARGIN/, '要留边距')
  assert.match(src, /addEventListener\('resize'/, '视口变小也要夹回来')
  // 标题栏是唯一能把它拖回来的地方，所以横向要保证标题栏有可见段
  assert.match(src, /width - 160/, '横向夹取要保证标题栏至少留一截可见')
  assert.match(src, /vh - 40/, '纵向不许整条掉出底部')
})

test('浮动窗口 框架不认识内容 —— 没有业务字样', () => {
  for (const word of ['书源', '朗读', 'AI 接入', '书架', '章节']) {
    assert.ok(!src.includes(word), `FloatingWindow 里出现了「${word}」—— 窗口框架不该知道任何具体功能`)
  }
})

test('实验室已改用浮动窗口框架，不再自己写定位', () => {
  const lab = fs.readFileSync(path.resolve(import.meta.dirname, '../src/lab/Lab.tsx'), 'utf8')
  // 注释里提到 localStorage 是说明"位置记在哪"，不算实现；这里只看代码行。
  const code = lab.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(lab, /<FloatingWindow/, '实验室要用框架的窗口')
  // 旧的自己写定位/拖拽逻辑应当已经删掉，否则就是两套并存
  assert.ok(!/const \[position, setPosition\]/.test(code), '旧的 position 状态该删了')
  assert.ok(!/startDrag/.test(code), '旧的拖拽实现该删了')
  assert.ok(!/localStorage/.test(code), '持久化该由窗口框架管，容器里不该再有一份')
})

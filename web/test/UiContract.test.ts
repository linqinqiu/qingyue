import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「类名挂着、样式表里没有这条规则」= 控件按浏览器默认长相渲染。
 * 2026-10-03 全面审计时一次抓出六个：`.modal-card` / `.modal-header` / `.close-button`
 * 被书源体检与批量分组两个弹窗用着而样式表里 0 命中（于是标题栏没有内边距、`h2` 吃 UA 的 2em 粗体、
 * 关闭键是一颗没有尺寸的裸按钮），`.icon-btn` 同理（替换规则三处关窗键），
 * `.shelf-remove`、`.source-login-footer` 也一样；`.secondary-button` 与 `.rules-setting-btn`
 * 只在某个作用域里定义过，换个地方用就变成裸文字。
 *
 * 这里不做"每个 className 都必须有规则"的全量断言 —— 项目里有纯标记用的类名（给测试或
 * 父选择器用），全量判会逼着人往样式表里塞空规则来消红。判的是**这一批已经确认坏过的**，
 * 它们删掉就会立刻回到裸样式。
 */
const css = fs.readFileSync(path.resolve(import.meta.dirname, '../src/styles.css'), 'utf8')
const hasRule = (name: string) => new RegExp(`\\.${name}\\s*[,{:\\s]`).test(css)

test('弹窗壳与关闭键都有真实规则（不是靠 UA 默认长相）', () => {
  for (const name of ['modal-card', 'modal-header', 'close-button', 'icon-btn', 'shelf-remove', 'source-login-footer']) {
    assert.ok(hasRule(name), `.${name} 在 styles.css 里没有规则 —— 用它的那个控件会退回浏览器默认外观`)
  }
  // 壳的规则要真的带几何值，光有个类名等于没写
  const shell = /\.modal-card \{([^}]*)\}/.exec(css)?.[1] ?? ''
  for (const prop of ['max-height', 'border-radius', 'box-shadow', 'overflow']) {
    assert.match(shell, new RegExp(prop), `.modal-card 少了 ${prop}`)
  }
  const close = /\.close-button, \.icon-btn, \.shelf-remove \{([^}]*)\}/.exec(css)?.[1] ?? ''
  assert.match(close, /width: 30px/)
  assert.match(close, /height: 30px/)
})

test('按钮档位都有全局基础档（换一处用不会变成裸文字）', () => {
  for (const name of ['primary-button', 'subtle-button', 'ghost-button', 'danger-button', 'secondary-button', 'rules-setting-btn']) {
    // 允许出现在选择器组里（`.a, .b {`），所以不能要求行首
    assert.ok(
      new RegExp(`(^|\\})\\s*[^{}]*\\.${name}\\s*[,{:]`).test(css),
      `.${name} 没有全局规则 —— 只在某个作用域里定义过的话，别处用它就是无框无底的裸文字`,
    )
  }
})

test('朗读悬浮条：挂载时就夹回视口，且不给底部导航让位的那条路已封住', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/ttsBarPosition.ts'), 'utf8')
  // 存进去的坐标可能来自另一块屏；只监听 resize 的话手机上打开会留在屏幕外（连抓手一起）
  assert.match(src, /clampNow\(\)\s*\r?\n\s*window\.addEventListener\('resize'/,
    '挂载时必须先夹一次，而不是只等 resize')
  assert.match(src, /function bottomReserve/, '下边界要按移动端底部导航的实测高度留位')
  assert.match(src, /window\.innerHeight - size\.height - bottomReserve\(\)/)
  const css2 = fs.readFileSync(path.resolve(import.meta.dirname, '../src/styles.css'), 'utf8')
  const bar = /\.tts-floating-bar \{([\s\S]*?)\n\}/.exec(css2)?.[1] ?? ''
  const z = Number(/z-index:\s*(\d+)/.exec(bar)?.[1] ?? '9999')
  const drawer = Number(/\.reader-drawer \{[\s\S]*?z-index:\s*(\d+)/.exec(css2)?.[1] ?? '0')
  const backdrop = Number(/\.modal-backdrop \{[^}]*z-index:\s*(\d+)/.exec(css2)?.[1] ?? '0')
  assert.ok(z < drawer && z < backdrop,
    `朗读条压在抽屉与弹窗之上（bar ${z} / drawer ${drawer} / modal ${backdrop}）`)
})

test('页面级浮层都在挡片之下（弹窗开着时顶栏与批量条不能还亮着）', () => {
  const zIndex = (selector: string) => {
    const block = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
    const value = /z-index:\s*(\d+)/.exec(block)?.[1]
    assert.ok(block && value !== undefined, `${selector} 找不到带 z-index 的规则`)
    return Number(value)
  }
  const backdrop = zIndex('.modal-backdrop')
  // 同值是"DOM 顺序决胜"的别名：今天恰好挡片在后，加一个 portal 就会翻过去
  for (const name of ['.app-page-header', '.source-batch-bar', '.tts-floating-bar']) {
    assert.ok(zIndex(name) < backdrop, `${name} 的 z 不小于挡片（${backdrop}）—— 弹窗会挡不住它`)
  }
})

test('体检弹窗不把"清单还没取到"写成"0 个书源"', () => {
  const modal = fs.readFileSync(path.resolve(import.meta.dirname, '../src/SourceHealthModal.tsx'), 'utf8')
  const page = fs.readFileSync(path.resolve(import.meta.dirname, '../src/main.tsx'), 'utf8')
  // 空数组有两种成因，只有一种该报数字
  assert.match(modal, /sourcesState: 'loading' \| 'ready' \| 'failed'/, '弹窗得知道清单到没到手')
  assert.match(page, /sourcesState=\{sourcesState\}/, '父组件得把它传进来')
  assert.match(page, /setSourcesState\('failed'\)/, '取失败要记成 failed，不能停在 loading 上装"还在读"')
  assert.match(modal, /disabled=\{running \|\| busyAction !== null \|\| sourcesState !== 'ready'/,
    '没取到之前那颗「开始体检」不能点着')
  const countLine = /sourcesState !== 'ready'[\s\S]{0,200}开始体检/.exec(modal)
  assert.ok(countLine, '数量那句话得先看过 sourcesState')
})

test('移动端底部导航的列数与真实按钮数对得上', () => {
  const reader = fs.readFileSync(path.resolve(import.meta.dirname, '../src/ReaderScreen.tsx'), 'utf8')
  const nav = /<nav className="mobile-reader-nav">([\s\S]*?)<\/nav>/.exec(reader)?.[1] ?? ''
  const buttons = (nav.match(/<button/g) ?? []).length
  assert.ok(buttons > 0, '要真的取到那段导航（取空的话下面那条断言恒真）')
  const columns = Number(/\.mobile-reader-nav \{[\s\S]*?grid-template-columns: repeat\((\d+)/.exec(css)?.[1] ?? '0')
  assert.equal(columns, buttons, `导航渲染 ${buttons} 颗但样式只给 ${columns} 列 —— 多出来的会被固定高度裁掉`)
})

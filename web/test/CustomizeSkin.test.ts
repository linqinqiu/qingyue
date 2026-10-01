import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CustomizeModal } from '../src/CustomizeModal'
import {
  availableSkins,
  BUILTIN_SKINS,
  defaultReaderSettings,
  parseSkinBase,
  parseSkinId,
  themeClassNames,
  type ReaderSettings,
} from '../src/readerSettings'

const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')
const settings = (patch: Partial<ReaderSettings> = {}): ReaderSettings => ({ ...defaultReaderSettings, ...patch })

/**
 * 「自定义」这一栏（用户 2026-10-01：「咱们这个是开源允许自定义」）。
 * 里面只有皮肤一件事 —— 界面框架 v2 那一波（侧栏 + 页头条 + 全宽）已按用户拍板整条撤掉，
 * 所以这里也钉住"只有一套外壳"这件事，别让侧栏哪天又悄悄长回来。
 */

test('皮肤 id - 会被拼成类名，所以只留 [a-z0-9-_] 且限长', () => {
  assert.equal(parseSkinId('MidNight'), 'midnight', '大小写要归一，类名不能有两个样子的同一皮肤')
  assert.equal(parseSkinId('  my_skin-2  '), 'my_skin-2')
  // 这些如果原样拼进 `.theme-<id>`，轻则类名失效，重则把后面的 selector 拼坏
  assert.equal(parseSkinId('a b{color:red}'), 'abcolorred')
  assert.equal(parseSkinId('"><img src=x>'), 'imgsrcx')
  assert.equal(parseSkinId('中文皮肤'), '', '非 ASCII 的 id 清完就是空 —— 空即"没有自定义皮肤"')
  assert.equal(parseSkinId('x'.repeat(80)).length, 32, '长度要夹住，不然一条设置能把 localStorage 撑大')
  for (const junk of [undefined, null, 42, {}]) assert.equal(parseSkinId(junk), '')
})

test('皮肤列表 - 只有填了 CSS 的自定义皮肤才会出现（不摆点了没反应的控件）', () => {
  assert.deepEqual(availableSkins(settings()).map(s => [s.id, s.builtin]), BUILTIN_SKINS.map(s => [s.id, true]))
  const withSkin = settings({ customSkinId: 'midnight', customSkinCss: '.theme-midnight { --canvas: #0f1213; }' })
  assert.deepEqual(availableSkins(withSkin)[3], { id: 'midnight', name: '自定义（midnight）', builtin: false })
  assert.equal(availableSkins(settings()).length, 3)
  // 只填 id 不填 CSS 不算一套皮肤
  assert.equal(availableSkins(settings({ customSkinId: 'midnight' })).length, 3)
  // id 清洗后非空 + 有 CSS => 算一套（清洗本身不是拒绝的理由）
  assert.equal(availableSkins(settings({ customSkinId: 'mid night', customSkinCss: 'x{y:z}' })).length, 4)
  // 清洗后为空的 id 不算皮肤 —— 否则列表里会多出一个选不中的项
  assert.equal(availableSkins(settings({ customSkinId: '中文', customSkinCss: 'x{y:z}' })).length, 3)
})

test('自定义皮肤是叠在内置皮肤之上的，不是替换它', () => {
  assert.deepEqual(themeClassNames(settings()), ['theme-light'])
  assert.deepEqual(themeClassNames(settings({ theme: 'dark' })), ['theme-dark'])
  const custom = settings({ customSkinId: 'midnight', customSkinCss: '.theme-midnight { --canvas: #0f1213; }', customSkinBase: 'dark', theme: 'midnight' })
  assert.deepEqual(themeClassNames(custom), ['theme-dark', 'theme-midnight'],
    '只写两三条变量的皮肤必须有一整套内置变量兜底，否则界面会变成"字和底一个颜色"')
  // 填了自定义皮肤但当前选的还是内置那档时，不要把基类和皮肤类同时挂上
  assert.deepEqual(themeClassNames({ ...custom, theme: 'paper' }), ['theme-paper'])
  assert.equal(parseSkinBase('paper'), 'paper')
  assert.equal(parseSkinBase('midnight'), defaultReaderSettings.customSkinBase, '基档只认内置三档')
  assert.equal(parseSkinBase(undefined), defaultReaderSettings.customSkinBase)
})

test('CustomizeModal 静态渲染：皮肤三档 + 自定义那一栏的 CSS 与基档', () => {
  const html = renderToStaticMarkup(React.createElement(CustomizeModal, {
    settings: settings(), onChange: () => undefined, onClose: () => undefined,
  }))
  assert.match(html, /皮肤/)
  assert.match(html, /自定义皮肤/)
  assert.match(html, /localStorage/, '要说清楚只存本机：不上传服务端、不进备份包')
  assert.match(html, /叠在哪一套之上/, '要问清自定义皮肤叠在哪一档上（只改一两个变量才不至于花屏）')
  assert.ok(!html.includes('自定义（'), '没填 CSS 时皮肤列表里不该出现一个用不了的自定义皮肤')
  assert.ok(!html.includes('界面布局'), '界面框架 v2 已撤销：这里不该再有一档"布局"可选')
})

test('CustomizeModal 里填了 CSS 之后，皮肤列表就多出那一套', () => {
  const html = renderToStaticMarkup(React.createElement(CustomizeModal, {
    settings: settings({ customSkinId: 'midnight', customSkinCss: '.theme-midnight { --canvas: #0f1213; }' }),
    onChange: () => undefined, onClose: () => undefined,
  }))
  assert.match(html, /自定义（midnight）/)
  assert.match(html, /theme-swatch-custom/, '自定义皮肤要有自己的色片样式，不能长得像内置那三档')
})

/**
 * 注入点：只允许 textContent 一条路。
 * `dangerouslySetInnerHTML` 或模板拼接会把用户写的 `</style>` 变成真标签 —— 那等于把
 * 一个本机设置项变成注入点（虽然是自己的机器，但这道子不该靠"用户不会害自己"成立）。
 */
test('皮肤 CSS 的注入方式：createElement + textContent，空了就摘掉', () => {
  const main = read('..', 'src', 'main.tsx')
  assert.match(main, /document\.createElement\('style'\)/)
  assert.match(main, /legado-custom-skin/, '注入点要有固定 id，切走皮肤时才知道摘哪一个')
  assert.match(main, /\.textContent\s*=\s*css/)
  // 只看 SkinStyle 这一段：文件别处有一句解释"为什么不用 innerHTML"的注释，那是文字不是代码。
  // `\r?\n` 是必须的：`git checkout` 在 Windows 上给出的是 CRLF，写死 `\n}` 会取到空串。
  const skinBlock = /function SkinStyle\([\s\S]*?\r?\n\}/.exec(main)?.[0] ?? ''
  assert.ok(skinBlock.length > 200, '要真的取到 SkinStyle 这一段（取空串的话下面几条对什么都成立）')
  assert.doesNotMatch(skinBlock, /dangerouslySetInnerHTML|innerHTML/, '样式注入不许走 innerHTML')
  assert.match(main, /getElementById\(marker\)\?\.remove\(\)/, '没填皮肤或卸载时要把 style 摘掉，否则换皮肤后旧规则还在')
  // 皮肤类必须同时挂到 <html>：portal 出去的浮层（Select 的下拉）只认根上的变量
  assert.match(main, /root\.classList\.add\(\.\.\.themeClassNames\(settings\)\)/)
  assert.match(main, /const skinClasses = themeClassNames\(settings\)\.join\(' '\)/, '各处外壳要共用同一份皮肤类名')
  assert.match(main, /className=\{`app-shell \$\{skinClasses\}`\}/, '外壳用同一份类名')
  assert.doesNotMatch(main, /theme-\$\{settings\.theme\}/, '不许再有一处自己拼主题类名（拼漏基档就会花屏）')
})

/** 界面框架 v2 整条撤掉之后，"只有一套外壳"这件事要有东西守着，别哪天又长回来。 */
test('应用只有一套外壳（旧版顶栏），侧栏与页头条那套文件不在树里', () => {
  const src = path.resolve(import.meta.dirname, '..', 'src')
  assert.ok(!fs.existsSync(path.join(src, 'AppRail.tsx')), 'AppRail.tsx（侧栏外壳）应该已经删掉')
  assert.ok(!fs.existsSync(path.join(src, 'PageBar.tsx')), 'PageBar.tsx（v2 页头条）应该已经删掉')
  const testDir = path.resolve(import.meta.dirname)
  assert.ok(!fs.existsSync(path.join(testDir, 'AppRail.test.ts')), '配套用例也要一起撤，留着就是一条打不开的红')
  const settingsSrc = read('..', 'src', 'readerSettings.ts')
  assert.doesNotMatch(settingsSrc, /uiLayout/, '设置里不该再有"界面布局"这一档')
  const css = read('..', 'src', 'styles.css')
  for (const dead of ['.app-rail', '.rail-item', '.page-bar', '.app-frame', '.rail-tabs']) {
    assert.ok(!css.includes(dead), `样式里不该再留 v2 的 ${dead}（留着会有"看着没删干净"的歧义）`)
  }
})

/** 标题栏颜色取的是算出来的 --canvas，写死的三档色表对自定义皮肤一律失真。 */
test('theme-color 跟着皮肤走，且取的是计算值', () => {
  const main = read('..', 'src', 'main.tsx')
  assert.match(main, /getComputedStyle\(document\.documentElement\)\.getPropertyValue\('--canvas'\)/)
  assert.doesNotMatch(main, /THEME_CANVAS/, '不许再留前端写死的色表')
  assert.match(main, /meta\[name="theme-color"\]/)
})

test('样式表里两张新界面都有规则（更新日志页与自定义弹窗）', () => {
  const css = read('..', 'src', 'styles.css')
  assert.match(css, /\.customize-dialog \{/)
  assert.match(css, /\.changelog-page \{/)
  assert.match(css, /\.theme-swatch-custom/)
  assert.match(css, /\.menu-section-action/)
  assert.match(css, /\.theme-name/)
})

/**
 * `run-all.ts` 是一个一个 import 的，不是扫目录。
 * 上一轮就有两份测试**存在但没被注册**（HeaderMenu、LocalBookImport）：文件在、名字像测试、
 * 跑起来一片绿，其实一条都没执行。这条判据把"注册"本身钉住，以后新加文件忘了 import 会直接红。
 */
test('web/test 下每个 *.test.ts 都必须在 run-all.ts 里注册', () => {
  const dir = path.resolve(import.meta.dirname)
  const runner = read('..', 'test', 'run-all.ts')
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.test.ts'))
  const missing = files.filter(name => !runner.includes(`'./${name}'`))
  assert.deepEqual(missing, [], `这些测试文件没被 run-all.ts 引进去，等于没跑：${missing.join('、')}`)
})

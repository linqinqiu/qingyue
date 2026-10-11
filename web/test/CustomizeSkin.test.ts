import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CustomizeModal } from '../src/CustomizeModal'
import {
  activeCustomSkin,
  availableSkins,
  BUILTIN_SKINS,
  DEFAULT_SKIN_BASE,
  defaultReaderSettings,
  parseCustomSkin,
  parseCustomSkins,
  parseSkinBase,
  parseSkinId,
  skinLabel,
  themeClassNames,
  type CustomSkin,
  type ReaderSettings,
} from '../src/readerSettings'

const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')
const settings = (patch: Partial<ReaderSettings> = {}): ReaderSettings => ({ ...defaultReaderSettings, ...patch })
const skin = (patch: Partial<CustomSkin> = {}): CustomSkin => ({
  id: 'midnight', name: '', css: '.theme-midnight { --canvas: #0f1213; }', base: 'light', ...patch,
})

/**
 * 「自定义」这一栏（用户 2026-10-01：「咱们这个是开源允许自定义」）。
 * 里面只有皮肤一件事 —— 界面框架 v2 那一波（侧栏 + 页头条 + 全宽）已按用户拍板整条撤掉，
 * 所以这里也钉住"只有一套外壳"这件事，别让侧栏哪天又悄悄长回来。
 *
 * 2026-10-11 起皮肤从**单套**扩成**库**（用户：「所有的自定义是可以自己定义保存……
 * 可以自定义许多个，并有记录保存」）—— 下面钉住库的增删改切换与旧数据的迁移。
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

test('皮肤列表 - 内置七套 + 库里每一套自定义皮肤', () => {
  assert.deepEqual(availableSkins(settings()).map(s => [s.id, s.builtin]), BUILTIN_SKINS.map(s => [s.id, true]))
  assert.equal(availableSkins(settings()).length, 7)
  assert.deepEqual(availableSkins(settings({ customSkins: [skin()] }))[7], { id: 'midnight', name: '自定义（midnight）', builtin: false })
  assert.equal(availableSkins(settings({ customSkins: [skin()] })).length, 8)
  // 起过名字就用名字
  assert.equal(availableSkins(settings({ customSkins: [skin({ name: '午夜' })] }))[7].name, '午夜')
  // 没写 CSS 的那一套不进列表（点了没反应的控件不摆）
  assert.equal(availableSkins(settings({ customSkins: [skin({ css: '   ' })] })).length, 7)
  // 库里多套都在
  assert.equal(availableSkins(settings({ customSkins: [skin(), skin({ id: 'dawn' })] })).length, 9)
})

test('自定义皮肤是叠在内置皮肤之上的，不是替换它', () => {
  assert.deepEqual(themeClassNames(settings()), ['theme-light'])
  assert.deepEqual(themeClassNames(settings({ theme: 'dark' })), ['theme-dark'])
  const custom = settings({ customSkins: [skin({ base: 'dark' })], theme: 'midnight' })
  assert.deepEqual(themeClassNames(custom), ['theme-dark', 'theme-midnight'],
    '只写两三条变量的皮肤必须有一整套内置变量兜底，否则界面会变成"字和底一个颜色"')
  // 填了自定义皮肤但当前选的还是内置那档时，不要把基类和皮肤类同时挂上
  assert.deepEqual(themeClassNames({ ...custom, theme: 'paper' }), ['theme-paper'])
  assert.equal(parseSkinBase('paper'), 'paper')
  assert.equal(parseSkinBase('midnight'), DEFAULT_SKIN_BASE, '基档只认内置档')
  assert.equal(parseSkinBase(undefined), DEFAULT_SKIN_BASE)
})

test('皮肤库清洗：id 过白名单、空 id / 空 CSS 丢掉、同 id 只留最后一套', () => {
  assert.deepEqual(parseCustomSkins('不是数组'), [])
  assert.deepEqual(parseCustomSkins([{ id: 'MidNight', name: ' 午夜 ', css: 'a{b:c}' }]),
    [{ id: 'midnight', name: '午夜', css: 'a{b:c}', base: 'light' }])
  // id 清洗后为空（中文）、或 CSS 为空的那一套不成立 —— 不进库，也就不会多出一个选不中的项
  assert.deepEqual(parseCustomSkins([{ id: '中文', css: 'a{b:c}' }, { id: 'ok', css: '   ' }]), [])
  assert.equal(parseCustomSkins([{ id: 'dup', css: 'a{b:1}' }, { id: 'dup', css: 'a{b:2}' }])[0].css, 'a{b:2}')
  // base 只认内置档
  assert.equal(parseCustomSkin({ id: 'x', css: 'a{b:c}', base: '不存在的档' })?.base, DEFAULT_SKIN_BASE)
  assert.equal(parseCustomSkin(null), null)
  assert.equal(parseCustomSkin({ id: '', css: 'x' }), null)
})

test('当前启用的是哪一套自定义皮肤；显示名缺省回落 id', () => {
  const lib = [skin({ id: 'a' }), skin({ id: 'b' })]
  assert.equal(activeCustomSkin(settings({ customSkins: lib, theme: 'b' }))?.id, 'b')
  assert.equal(activeCustomSkin(settings({ customSkins: lib, theme: 'dark' })), undefined, '内置档时库里哪套都不生效')
  assert.equal(activeCustomSkin(settings({ customSkins: lib, theme: 'midnight' })), undefined, '库里没有的 id 不算启用')
  assert.equal(skinLabel(skin({ name: '' })), '自定义（midnight）')
  assert.equal(skinLabel(skin({ name: '午夜' })), '午夜')
})

test('旧版单套皮肤会迁进皮肤库，不丢用户已存的皮肤', () => {
  // loadCustomSkins 是私有的，走公开的 loadReaderSettings 不便（要 window），
  // 所以这里直接验迁移的两半：旧字段能被 parseCustomSkin 收成一套，且空 CSS 的旧值不收。
  const migrated = parseCustomSkin({ id: 'midnight', css: '.theme-midnight { --canvas: #0f1213; }', base: 'dark' })
  assert.deepEqual(migrated, { id: 'midnight', name: '', css: '.theme-midnight { --canvas: #0f1213; }', base: 'dark' })
  assert.equal(parseCustomSkin({ id: 'midnight', css: '' }), null, '旧版只填了 id 没填 CSS 的，迁过来也是空的，不收')
})

test('CustomizeModal 静态渲染：皮肤列表 + 皮肤库 + 编辑器', () => {
  const html = renderToStaticMarkup(React.createElement(CustomizeModal, {
    settings: settings(), onChange: () => undefined, onClose: () => undefined,
  }))
  assert.match(html, /皮肤/)
  assert.match(html, /自定义皮肤库/)
  assert.match(html, /localStorage/, '要说清楚只存本机：不上传服务端、不进备份包')
  assert.match(html, /叠在哪一套之上/, '要问清自定义皮肤叠在哪一档上（只改一两个变量才不至于花屏）')
  assert.match(html, /新建皮肤/)
  assert.ok(!html.includes('自定义（'), '库里没东西时，皮肤列表里不该出现一个用不了的自定义皮肤')
  assert.ok(!html.includes('界面布局'), '界面框架 v2 已撤销：这里不该再有一档"布局"可选')
})

test('CustomizeModal 里库里每一套都进皮肤列表，并给出编辑 / 删除', () => {
  const html = renderToStaticMarkup(React.createElement(CustomizeModal, {
    settings: settings({ customSkins: [skin()] }),
    onChange: () => undefined, onClose: () => undefined,
  }))
  assert.match(html, /自定义（midnight）/)
  assert.match(html, /theme-swatch-custom/, '自定义皮肤要有自己的色片样式，不能长得像内置那档')
  assert.match(html, /编辑/)
  assert.match(html, /删除/)
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

test('样式表里两张新界面都有规则（更新日志页、自定义弹窗、分章规则弹窗）', () => {
  const css = read('..', 'src', 'styles.css')
  // W2 并档：两张弹窗自己的宽高没了，几何在共用那一档里 —— 所以断言也搬到那一档上。
  assert.match(css, /^\.dialog-shell \{/m, '弹窗外壳那一档不见了，两张弹窗都会退回裸 div')
  assert.match(css, /^\.dialog-head \{/m, '弹窗页头那一档不见了')
  assert.match(read('..', 'src', 'CustomizeModal.tsx'), /className="dialog-shell[^"]*customize-dialog"/)
  assert.match(read('..', 'src', 'TocRulesModal.tsx'), /className="dialog-shell[^"]*toc-rules-modal"/)
  assert.match(css, /\.changelog-page \{/)
  assert.match(css, /\.theme-swatch-custom/)
  assert.match(css, /\.menu-section-action/)
  assert.match(css, /\.theme-name/)
  // 皮肤库那几条也得有样式：类名不在样式表里 = 渲染出来是一个没有布局的裸列表
  assert.match(css, /\.skin-library \{/)
  assert.match(css, /\.skin-library-row \{/)
  assert.match(css, /\.skin-editor \{/)
  // 搬出去的弹窗还得有自己的内容样式：类名不在样式表里 = 渲染出来是一个没有滚动的裸 div
  assert.match(css, /\.toc-rules-body \{/)
  assert.match(css, /\.toc-rule \{/)
  assert.doesNotMatch(css, /\.customize-toc-/, '分章规则的样式不姓"自定义"了，类名也跟着搬')
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

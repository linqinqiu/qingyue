// 旧版外壳 + 「自定义」皮肤 + 应用内「更新日志」的界面门禁。
//
// 来历：2026-10-01 先做了「界面框架 v2」（侧栏 + 页头条 + 全宽），同日用户拍板
// 「整个应用回旧版，撤掉 v2」→ 侧栏那一套整条删除，本文件的前身 `ui-layout-check.mjs`
// 判的是"两套外壳入口集合相等"，现在没有两套了，所以改名并改成判**一件新事**：
//   ① 界面只有旧版这一套外壳（侧栏/页头条的文件与类名都不许再出现）；
//   ② 「更新日志」页读的是随包的 CHANGELOG.md，结构、当前版本高亮、来源都真的在；
//   ③ 「自定义」里的自定义皮肤**真的生效**，而且是**叠**在内置皮肤之上的
//      （只写一个变量也不许花屏）—— 这条带反向对照，摘掉基类必须立刻取不到变量；
//   ④ 「我的」菜单的条目集合（用户 2026-10-03：「顶栏『我的』菜单堆太多」——
//      「更新日志」「快捷键」收进「关于」，这里按新的分法判，旧的两条要判为"不在菜单里"）。
//
// 只读界面 + 只改 localStorage 里的设置，不动任何书源/书架数据，跑完自己清干净。
// 跑法：node tools/verify/ui-shell-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, OUT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const SETTINGS_KEY = 'legado-reader-settings-v2'
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const clickIn = (page, scope, label) => page.evaluate(({ scope, label }) => {
  const root = scope ? document.querySelector(scope) : document
  if (!root) return false
  const hit = [...root.querySelectorAll('button')].find(node => (node.textContent ?? '').trim().includes(label))
  if (!hit) return false
  hit.click()
  return true
}, { scope, label })

/** React 受控输入：必须走原生 setter + input 事件，直接改 .value 界面不认。 */
const typeInto = (page, selector, value) => page.evaluate(({ selector, value }) => {
  const el = document.querySelector(selector)
  if (!el) return false
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}, { selector, value })

/** `rgb(15, 18, 19)` 与 `#0f1213` 比一下（meta 里的色可能被归一化成 rgb）。 */
function rgbEq(computed, hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(hex).trim())
  if (!m) return false
  const want = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
  const got = (String(computed).match(/\d+/g) ?? []).map(Number)
  return got.length >= 3 && got.slice(0, 3).join(',') === want.join(',')
}

let browser = null
const errors = []
try {
  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  page.on('pageerror', error => errors.push(String(error.message)))

  // ─────────────────────── ① 只有一套外壳 ───────────────────────
  await page.goto(`${BASE}/#library`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-page-header', { timeout: 45000 })
  const shell = await page.evaluate(() => ({
    topbar: !!document.querySelector('.app-page-header'),
    rail: !!document.querySelector('.app-rail'),
    pageBar: !!document.querySelector('.page-bar'),
    frame: !!document.querySelector('.app-frame'),
    htmlClass: document.documentElement.className,
    nav: [...document.querySelectorAll('.app-page-header nav button')].map(n => (n.textContent ?? '').trim()),
  }))
  check('①界面是旧版那一套顶栏外壳', shell.topbar, shell.topbar ? shell.nav.join(' / ') : '没找到 .app-page-header')
  check('①侧栏 / 页头条那套 v2 结构不在页面上',
    !shell.rail && !shell.pageBar && !shell.frame,
    `侧栏=${shell.rail} 页头条=${shell.pageBar} 框架=${shell.frame}`)
  check('①<html> 上挂着皮肤类（portal 出去的浮层只认根上的变量）',
    /theme-(light|paper|dark)/.test(shell.htmlClass), shell.htmlClass || '(空)')

  // ─────────────────── ② 「我的」菜单里的入口与皮肤 ───────────────────
  check('②「我的」点得开', await clickIn(page, '.app-page-header', '我的'), '')
  await page.waitForSelector('.header-menu-dropdown', { timeout: 8000 })
  await sleep(250)
  const menu = await page.evaluate(() => {
    const swatch = document.querySelector('.header-menu-dropdown .theme-swatch')
    return {
      labels: [...document.querySelectorAll('.header-menu-dropdown button')].map(n => (n.textContent ?? '').trim()),
      skins: [...document.querySelectorAll('.header-menu-dropdown .menu-theme-btn .theme-name')].map(n => (n.textContent ?? '').trim()),
      swatchSize: swatch ? getComputedStyle(swatch).width : '',
      hasCustomize: !!document.querySelector('.menu-section-action'),
    }
  })
  check('②皮肤三档都在（晓白 / 护眼 / 夜读）', menu.skins.join('、') === '晓白、护眼、夜读', menu.skins.join('、') || '(取不到)')
  check('②菜单里有「自定义」入口', menu.labels.some(l => l.includes('自定义')) && menu.hasCustomize, menu.labels.join(' / '))
  // 「更新日志」「快捷键」两条从菜单里收掉了（用户 2026-10-03：「顶栏『我的』菜单堆太多」）：
  // 前者有顶栏版本芯片 + 「关于」两条路，后者改由「关于」进。这里按新的分法判。
  check('②菜单里有「关于」入口', menu.labels.some(l => l.includes('关于')), menu.labels.join(' / '))
  check('②菜单不再堆着「更新日志」「快捷键」',
    !menu.labels.some(l => l === '更新日志') && !menu.labels.some(l => l === '快捷键'),
    menu.labels.join(' / '))
  check('②色片是 22px 那一套（v2 的 9px 小点不该留下来）', menu.swatchSize === '22px', `实测 ${menu.swatchSize || '(取不到)'}`)

  // ─────────────────────── ③ 应用内「更新日志」 ───────────────────────
  const api = await page.evaluate(async () => {
    const res = await fetch('/api/changelog')
    return { status: res.status, type: res.headers.get('content-type') ?? '', length: (await res.text()).length }
  })
  check('③ GET /api/changelog 给出随包的 markdown（非空）',
    api.status === 200 && api.type.startsWith('text/markdown') && api.length > 200,
    `HTTP ${api.status} · ${api.type} · ${api.length} 字符`)
  check('③从「关于」进「更新日志」（菜单里那条已收掉，这一条走的是新路径）',
    await clickIn(page, '.header-menu-dropdown', '关于'), '')
  await page.waitForSelector('.about-page', { timeout: 8000 })
  const about = await page.evaluate(() => ({
    actions: [...document.querySelectorAll('.about-actions button, .about-actions a')].map(n => (n.textContent ?? '').trim()),
  }))
  check('③「关于」给得出更新日志与快捷键这两个入口',
    about.actions.some(l => l === '更新日志') && about.actions.some(l => l === '快捷键'),
    about.actions.join(' / ') || '(没有动作按钮)')
  // 快捷键这张表就一条判据：点得开、真的画出按键表（内容与生效的键同源，由 shortcut-check 盯）
  check('③「快捷键」点得开那张表', await clickIn(page, '.about-actions', '快捷键'), '')
  await page.waitForSelector('.shortcut-modal', { timeout: 8000 })
  const shortcutRows = await page.evaluate(() => document.querySelectorAll('.shortcut-row, .shortcut-table tr').length)
  check('③那张表真的列出了按键（不是空弹窗）', shortcutRows > 0, `实测 ${shortcutRows} 行`)
  await page.evaluate(() => document.querySelector('.shortcut-close')?.click())
  await sleep(250)
  check('③那张表关得掉（不留一层挡住「关于」的挡片）',
    await page.evaluate(() => !document.querySelector('.shortcut-modal')), '')
  check('③「更新日志」点得动', await clickIn(page, '.about-actions', '更新日志'), '')
  await page.waitForSelector('.changelog-page', { timeout: 8000 })
  await page.waitForFunction(() => !!document.querySelector('.changelog-release') || !!document.querySelector('.changelog-empty'), { timeout: 15000 })
  const log = await page.evaluate(() => ({
    releases: document.querySelectorAll('.changelog-release').length,
    groups: document.querySelectorAll('.changelog-group').length,
    items: document.querySelectorAll('.changelog-group li').length,
    current: document.querySelectorAll('.changelog-release.current').length,
    flag: !!document.querySelector('.changelog-flag'),
    head: document.querySelector('.changelog-page .page-title h1')?.textContent?.trim() ?? '',
    version: document.querySelector('.changelog-release h2')?.textContent?.trim() ?? '',
    emptySaid: !!document.querySelector('.changelog-empty'),
    source: (document.querySelector('.changelog-source')?.textContent ?? '').includes('CHANGELOG.md'),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  check('③页头是这一套页面共用的那种式样（.page-title）', log.head === '更新日志', `实测「${log.head || '(空)'}」`)
  check('③有版本段与条目，且没有把"没读到"说成"没有更新"',
    log.releases > 0 && log.items > 0 && log.groups > 0 && !log.emptySaid,
    `${log.releases} 个版本 · ${log.groups} 组 · ${log.items} 条`)
  check('③当前运行版本那一段被标出来', log.current === 1 && log.flag && /^\d+\.\d+\.\d+$/.test(log.version), `顶部版本 ${log.version || '(空)'}`)
  check('③页尾写明读的就是 CHANGELOG.md（来源可查）', log.source, '')
  check('③1440 宽下没有横向溢出', log.overflow <= 1, `溢出 ${log.overflow}px`)
  await page.screenshot({ path: path.join(SHOTS, `ui-changelog-${STAMP}.png`) }).catch(() => null)

  // ────────────────────── ④ 自定义皮肤真的生效 ──────────────────────
  await page.goto(`${BASE}/#library`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-page-header', { timeout: 30000 })
  check('④「我的」再点得开', await clickIn(page, '.app-page-header', '我的'), '')
  await page.waitForSelector('.header-menu-dropdown', { timeout: 8000 })
  check('④「自定义」点得开弹窗', await clickIn(page, '.header-menu-dropdown', '自定义'), '')
  await page.waitForSelector('.customize-dialog', { timeout: 8000 })
  await sleep(250)
  const canvas = '#0f1213'
  const typed = await typeInto(page, '.customize-skin-editor input[type=text]', 'gateMidnight!!')
    && await typeInto(page, '.customize-css', `.theme-gatemidnight { --canvas: ${canvas}; }`)
  check('④皮肤 id 与 CSS 两栏都填进去了', typed, typed ? '' : '没找到 .customize-skin-editor input / .customize-css')
  const echo = await page.evaluate(() => document.querySelector('.customize-note code')?.textContent?.trim() ?? '')
  check('④id 过白名单，界面把清洗结果说出来（大写与感叹号被滤掉）', echo.includes('gatemidnight'), `回显 ${echo || '(无)'}`)
  check('④「套用这套皮肤」点得动', await clickIn(page, '.customize-actions', '套用'), '')
  await page.waitForFunction(() => [...document.querySelectorAll('.customize-skin')].some(n => (n.textContent ?? '').includes('自定义（gatemidnight）')), { timeout: 8000 })
  check('④皮肤列表里选中新建的这一套', await clickIn(page, '.customize-skin-row', '自定义（gatemidnight）'), '')
  await sleep(400)
  const skin = await page.evaluate(() => {
    const html = document.documentElement
    const style = document.getElementById('legado-custom-skin')
    const cs = getComputedStyle(html)
    return {
      classes: html.className,
      mounted: !!style,
      text: (style?.textContent ?? '').trim().slice(0, 60),
      canvas: cs.getPropertyValue('--canvas').trim(),
      surface: cs.getPropertyValue('--surface').trim(),
      ink: cs.getPropertyValue('--ink').trim(),
      meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? '',
    }
  })
  check('④注入的 <style> 在文档里，内容就是填的那条规则', skin.mounted && skin.text.includes('--canvas'), skin.text || '(空)')
  check('④皮肤类是「内置基档 + 自定义」两个，自定义在后',
    /theme-(light|paper|dark)\s+theme-gatemidnight/.test(skin.classes.trim()), skin.classes || '(空)')
  check('④只写一个变量，其余变量仍从基档解析下来（不花屏）',
    skin.canvas === canvas && skin.surface !== '' && skin.ink !== '',
    `--canvas ${skin.canvas} · --surface ${skin.surface || '(空)'} · --ink ${skin.ink || '(空)'}`)
  check('④标题栏 meta 取的是算出来的 --canvas（不是写死的三档色表）',
    rgbEq(skin.meta, canvas) || skin.meta.toLowerCase() === canvas.toLowerCase(), `meta=${skin.meta || '(空)'}`)

  // 反向对照：摘掉基档类，未覆盖的变量必须立刻取不到 —— 否则上面那条"叠加"是恒真的。
  await page.evaluate(() => {
    const html = document.documentElement
    for (const name of [...html.classList]) if (/^theme-(light|paper|dark)$/.test(name)) html.classList.remove(name)
  })
  await sleep(250)
  const noBase = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    return { surface: cs.getPropertyValue('--surface').trim(), ink: cs.getPropertyValue('--ink').trim(), canvas: cs.getPropertyValue('--canvas').trim() }
  })
  check('④反向对照：摘掉基档类后 --surface / --ink 立刻取不到（证明"叠加"是活的）',
    noBase.surface === '' && noBase.ink === '' && noBase.canvas === canvas,
    `--canvas ${noBase.canvas || '(空)'} · --surface ${noBase.surface || '(取不到)'}`)

  // 皮肤要存得住；清除自定义皮肤之后注入的 <style> 必须被摘掉（不留一条幽灵规则）
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.app-page-header', { timeout: 30000 })
  const persisted = await page.evaluate(() => ({
    classes: document.documentElement.className,
    style: !!document.getElementById('legado-custom-skin'),
    stored: JSON.parse(localStorage.getItem('legado-reader-settings-v2') ?? '{}'),
  }))
  check('④皮肤设置存得住（重载之后还是这一套）',
    persisted.classes.includes('theme-gatemidnight') && persisted.style && persisted.stored.theme === 'gatemidnight',
    `类 ${persisted.classes || '(空)'} · 注入=${persisted.style}`)
  await page.screenshot({ path: path.join(SHOTS, `ui-custom-skin-${STAMP}.png`) }).catch(() => null)

  check('④「我的」→「自定义」再开一次（清除入口要点得到）',
    await clickIn(page, '.app-page-header', '我的') && (await sleep(200), await clickIn(page, '.header-menu-dropdown', '自定义')), '')
  await page.waitForSelector('.customize-dialog', { timeout: 8000 })
  check('④「清除自定义皮肤」点得动', await clickIn(page, '.customize-actions', '清除'), '')
  await sleep(400)
  const clearedSkin = await page.evaluate(() => ({
    style: !!document.getElementById('legado-custom-skin'),
    classes: document.documentElement.className,
    skins: [...document.querySelectorAll('.customize-skin')].length,
  }))
  check('④清除之后 <style> 被摘掉、皮肤列表回到三档',
    !clearedSkin.style && !clearedSkin.classes.includes('theme-gatemidnight') && clearedSkin.skins === 3,
    `注入=${clearedSkin.style} 类=${clearedSkin.classes} 档数=${clearedSkin.skins}`)

  // ─────────── ⑤ 分章规则的落点（搬出「自定义」，长在书架导入旁边） ───────────
  // ④ 收场时「自定义」弹窗还开着：不关掉就点下一颗按钮，点到的其实是挡片底下的控件。
  await page.evaluate(() => document.querySelector('.customize-close')?.click())
  await sleep(250)
  await page.goto(`${BASE}/#shelf`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.shelf-bar', { timeout: 30000 })
  const shelfBar = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('.shelf-header-actions button')].map(n => (n.textContent ?? '').trim()),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  check('⑤书架顶栏同时给得出「导入本地」与「分章规则」（规则入口长在它服务的动作旁边）',
    shelfBar.labels.some(l => l.includes('导入')) && shelfBar.labels.some(l => l.includes('分章规则')),
    shelfBar.labels.join(' / '))
  check('⑤加了一颗按钮之后 1440 宽仍不横向溢出', shelfBar.overflow <= 1, `溢出 ${shelfBar.overflow}px`)
  check('⑤「分章规则」点得开弹窗', await clickIn(page, '.shelf-header-actions', '分章规则'), '')
  await page.waitForSelector('.toc-rules-modal', { timeout: 8000 })
  await sleep(400)
  const toc = await page.evaluate(() => {
    const modal = document.querySelector('.toc-rules-modal')
    const cs = modal ? getComputedStyle(modal) : null
    const body = document.querySelector('.toc-rules-body')
    return {
      rows: modal ? modal.querySelectorAll('.toc-rule').length : 0,
      switches: modal ? modal.querySelectorAll('.toc-rule-switch input').length : 0,
      regexShown: [...(modal?.querySelectorAll('.toc-rule-main code') ?? [])].filter(n => n.textContent?.trim()).length,
      defaultSelect: !!modal?.querySelector('.customize-field'),
      importBtn: [...(modal?.querySelectorAll('button') ?? [])].some(n => (n.textContent ?? '').includes('按这条导入本地书')),
      note: (modal?.textContent ?? '').includes('手动选一条不需要先'),
      // 壳要真的成了一个有边框有圆角的浮层：样式表漏了类名的典型表现就是一段裸 div
      mounted: !!cs && cs.borderTopWidth !== '0px' && cs.borderRadius !== '0px',
      scrollable: !!body && body.scrollHeight >= body.clientHeight - 1,
      overflow: modal ? modal.scrollWidth - modal.clientWidth : -1,
    }
  })
  check('⑤弹窗列出全部规则（26 条里编得出正则的那些），不是只列启用的 12 条',
    toc.rows >= 20 && toc.switches === toc.rows, `${toc.rows} 行 · ${toc.switches} 个开关`)
  check('⑤每行把正则原文露出来（不写出来没人判断得了适不适合自己的书）',
    toc.regexShown >= toc.rows - 2, `${toc.regexShown}/${toc.rows} 行有正则`)
  check('⑤一屏给齐三样：默认规则选择器、接着导书的按钮、把两件事分开讲的说明',
    toc.defaultSelect && toc.importBtn && toc.note, '')
  check('⑤弹窗有壳、能滚、不横向溢出（样式表里那个类名是真的）',
    toc.mounted && toc.scrollable && toc.overflow <= 1,
    `壳=${toc.mounted} 可滚=${toc.scrollable} 溢出 ${toc.overflow}px`)
  await page.screenshot({ path: path.join(SHOTS, `toc-rules-modal-${STAMP}.png`) }).catch(() => null)
  check('⑤这颗关闭按钮关得掉弹窗（挡片不留在那儿挡住后面的操作）',
    await page.evaluate(() => { document.querySelector('.toc-rules-close')?.click(); return true })
    && (await sleep(250), await page.evaluate(() => !document.querySelector('.toc-rules-modal'))), '')
  // 「自定义」这一边：搬走了就必须在界面上真的看不见，不只是代码里删了
  check('⑤「自定义」弹窗还开得住（搬空之后不是空壳）',
    await clickIn(page, '.app-page-header', '我的') && (await sleep(200), await clickIn(page, '.header-menu-dropdown', '自定义')), '')
  await page.waitForSelector('.customize-dialog', { timeout: 8000 })
  const customize = await page.evaluate(() => {
    const dialog = document.querySelector('.customize-dialog')
    return {
      text: dialog?.textContent ?? '',
      tocRows: dialog ? dialog.querySelectorAll('.toc-rule, .customize-toc-rule').length : -1,
      sections: [...(dialog?.querySelectorAll('.customize-section h3') ?? [])].map(n => (n.textContent ?? '').trim()),
    }
  })
  check('⑤「自定义」不再是杂物间：只剩皮肤那两档，没有分章规则',
    customize.tocRows === 0 && !customize.text.includes('分章规则')
    && customize.sections.join('、') === '皮肤、自定义皮肤',
    `${customize.sections.join('、') || '(没有分节)'} · 规则行 ${customize.tocRows}`)

  // ─────────────────────────── ⑥ 收尾 ──────────────────────────
  const cleared = await page.evaluate(() => {
    localStorage.removeItem('legado-reader-settings-v2')
    document.getElementById('legado-custom-skin')?.remove()
    return { stored: localStorage.getItem('legado-reader-settings-v2'), style: !!document.getElementById('legado-custom-skin') }
  })
  check('⑥探针留下的设置与注入的样式都清干净了（下次打开回到默认皮肤）',
    cleared.stored === null && !cleared.style, `残留设置=${String(cleared.stored)} 残留样式=${cleared.style}`)

  // 源码侧也钉一次：删掉的文件不许被谁又建回来（构建产物里同样不许有那套类名）
  const srcDir = path.join(ROOT, 'web', 'src')
  check('⑥ web/src 里没有侧栏/页头条那套组件文件',
    !fs.existsSync(path.join(srcDir, 'AppRail.tsx')) && !fs.existsSync(path.join(srcDir, 'PageBar.tsx')),
    [fs.existsSync(path.join(srcDir, 'AppRail.tsx')) && 'AppRail.tsx', fs.existsSync(path.join(srcDir, 'PageBar.tsx')) && 'PageBar.tsx'].filter(Boolean).join('、') || '干净')
  const css = fs.readFileSync(path.join(srcDir, 'styles.css'), 'utf8')
  check('⑥样式表里没有 v2 的类名残留',
    !/\.app-rail|\.rail-item|\.page-bar|\.app-frame|\.rail-tabs/.test(css), '命中了 v2 选择器')
  check('⑥「自定义」弹窗的代码里没有分章规则那一段（判代码，不只是判界面）',
    !fs.readFileSync(path.join(srcDir, 'CustomizeModal.tsx'), 'utf8').includes('tocRules'),
    'CustomizeModal.tsx 又长回了 tocRules')

  check('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (error) {
  check('探针自身异常', false, error.message)
} finally {
  if (browser) await browser.close().catch(() => null)
  fs.mkdirSync(OUT, { recursive: true })
  const failed = results.filter(r => !r.ok)
  fs.writeFileSync(path.join(OUT, `ui-shell-${STAMP}.json`), JSON.stringify({ stamp: STAMP, base: BASE, results }, null, 2))
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`)
  console.log(`\n${results.length - failed.length}/${results.length} PASS · 详情 tools/verify/out/ui-shell-${STAMP}.json`)
  process.exit(failed.length ? 1 : 0)
}

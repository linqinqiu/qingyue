import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsPage, type SettingsSection } from '../src/SettingsPage'

/**
 * 「设置」页存在的意义是"分类"：用户 2026-10-03 让它收纳 txt 目录规则 / 备份 / 替换净化，
 * 2026-10-08 又把 书源 / 替换净化规则 / 备份包 从顶栏搬进来（对齐 Legado-with-MD3 的 IA）。
 * 判的重点是：它有没有偷偷变成第二套实现，以及搬进来的东西还找不找得到。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

const sections: SettingsSection[] = [{
  title: '本地书',
  rows: [{
    title: 'TXT 分章规则',
    hint: '下一本导入的 TXT 按哪条切目录。',
    action: '打开规则表',
    onClick: () => undefined,
  }],
}]

test('静态渲染：分组、一行一句说明、一个动作', () => {
  const html = renderToStaticMarkup(React.createElement(SettingsPage, { sections }))
  assert.match(html, /设置/)
  assert.match(html, /本地书/, '分组标题')
  assert.match(html, /TXT 分章规则/)
  assert.match(html, /下一本导入的 TXT 按哪条切目录/, '这一行说得出它管什么')
  assert.match(html, /打开规则表/, '右侧一个动作')
  // 「就近：…」那条元话术已在 0.6.10 去掉：告诉用户"别处还有一条路"对使用者没用（用户点名）
  assert.doesNotMatch(html, /就近：/, '不该再出现"就近入口"那句解释')
})

test('这一页只是路由：它自己不含任何编辑器实现', () => {
  const page = read('../src/SettingsPage.tsx')
  // 出现这些就说明有人把第二套实现搬进来了（两处都能改 → 迟早两处不一样）
  assert.doesNotMatch(page, /localStorage|fetch\(|api\./, '设置页不该自己读写数据')
  assert.doesNotMatch(page, /useState/, '它没有自己的状态：状态仍在原来那一处')
})

test('一级目的地只在顶栏列一次；书源/规则/备份 收在「设置」页 —— 收放改了，功能一条没少', () => {
  // 2026-10-08 用户定的框架（对齐 Legado-with-MD3）：顶栏只留 书库/书架/发现/订阅/设置，
  // 书源 / 替换净化规则 / 备份包 从顶栏搬进「设置」页。判的仍是同一件事：
  // **不许有功能只剩下一个找不到的入口**，也不许同一个目的地在两处各留一条路。
  const header = read('../src/AppHeader.tsx')
  assert.match(header, /PRIMARY_PAGES\.map/, '顶栏入口由那张表渲染（手写一排按钮迟早漏一项）')
  assert.ok(!/<span>设置<\/span>/.test(header), '「设置」已是一级入口，不该再在「我的」菜单里留第二条路')
  assert.ok(!/<span>规则<\/span>|<span>备份<\/span>|<span>书源<\/span>/.test(header), '规则 / 备份 / 书源 不在菜单里重复')

  const table = read('../src/shortcuts.ts')
  for (const page of ['sources', 'rules', 'backup']) {
    assert.ok(!new RegExp(`\\{ page: '${page}'`).test(table), `${page} 不该再占顶栏`)
    assert.ok(table.includes(`'${page}'`), `${page} 既不在顶栏也不在收编清单（SETTINGS_SUBPAGES）里，等于消失了`)
  }
  assert.ok(table.includes("'settings'"), '设置必须留在一级表里')

  // 收进设置页的三项，各自要有一行、并且真的导航过去（这一页只做路由，不建第二套实现）
  const main = read('../src/main.tsx')
  const block = /const settingsSections: SettingsSection\[\] = \[[\s\S]*?\r?\n  \]\r?\n/.exec(main)?.[0] ?? ''
  assert.ok(block.length > 400, '要真的取到 settingsSections 那一段（取空串下面几条对什么都成立）')
  assert.match(block, /setShowOfflineCache\(true\)/, '离线缓存仍是设置页的一行')
  assert.match(block, /setShowLogs\(true\)/, '运行日志仍是设置页的一行')
  assert.match(block, /setTocRulesSignal\(value => value \+ 1\)/, '分章规则那行要真的能开弹窗')
  // 2026-10-08 从顶栏搬进来的三条：都要在设置页有入口，且指向原来那一份实现
  assert.match(block, /navigate\('sources'\)/, '书源管理要在设置页有一行')
  assert.match(block, /navigate\('rules'\)/, '替换净化规则要在设置页有一行')
  assert.match(block, /navigate\('backup'\)/, '备份包要在设置页有一行')
})

test('路由与"去书架开弹窗"的信号接上了', () => {
  const main = read('../src/main.tsx')
  assert.match(main, /location\.hash === '#settings' \? 'settings'/)
  assert.match(main, /page === 'settings' \? \(\s*<SettingsPage sections=\{settingsSections\}/)
  assert.match(main, /tocRulesSignal=\{tocRulesSignal\}/)
  assert.match(main, /if \(tocRulesSignal > 0\) setShowTocRules\(true\)/,
    '第一次挂载（0）不弹：刷新页面就跳出弹窗是凭空多出来的行为')
  assert.match(read('../src/styles.css'), /\.settings-page \{/)
})

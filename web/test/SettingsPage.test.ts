import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SettingsPage, type SettingsSection } from '../src/SettingsPage'

/**
 * 「在我的里面新加一个设置，把一些 txt 目录规则、备份、替换净化之类的放进去」
 * （用户 2026-10-03，同一条里还有一句「顶栏『我的』菜单堆太多」）。
 * 这一页存在的意义是"分类"，所以判的重点是：它有没有偷偷变成第二套实现。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

const sections: SettingsSection[] = [{
  title: '本地书',
  rows: [{
    title: 'TXT 分章规则',
    hint: '下一本导入的 TXT 按哪条切目录。',
    also: '书架「导入本地」旁边',
    action: '打开规则表',
    onClick: () => undefined,
  }],
}]

test('静态渲染：分组、一行一句说明、一个动作，就近入口也说出来', () => {
  const html = renderToStaticMarkup(React.createElement(SettingsPage, { sections }))
  assert.match(html, /设置/)
  assert.match(html, /本地书/, '分组标题')
  assert.match(html, /TXT 分章规则/)
  assert.match(html, /下一本导入的 TXT 按哪条切目录/, '这一行说得出它管什么')
  assert.match(html, /就近：书架「导入本地」旁边/, '就近入口写在脸上，用户不用猜哪条是正路')
  assert.match(html, /打开规则表/, '右侧一个动作')
})

test('这一页只是路由：它自己不含任何编辑器实现', () => {
  const page = read('../src/SettingsPage.tsx')
  // 出现这些就说明有人把第二套实现搬进来了（两处都能改 → 迟早两处不一样）
  assert.doesNotMatch(page, /localStorage|fetch\(|api\./, '设置页不该自己读写数据')
  assert.doesNotMatch(page, /useState/, '它没有自己的状态：状态仍在原来那一处')
})

test('菜单收进「设置」，四条功能一条都没少', () => {
  const header = read('../src/AppHeader.tsx')
  assert.match(header, /<span>设置<\/span>/)
  assert.match(header, /onNavigate\('settings'\)/)
  // 判的是"渲染出来的那一条"，不是注释里提到过这个名字（那段注释正是在解释为什么收掉它们）
  for (const moved of ['本地离线缓存管理', '替换净化规则', '运行日志', '备份包']) {
    assert.ok(!header.includes(`<span>${moved}</span>`), `「${moved}」应该已经从菜单收进「设置」了`)
  }
  // 收掉不等于删功能：四条都要在「设置」那几行的动作里出现
  const main = read('../src/main.tsx')
  const block = /const settingsSections: SettingsSection\[\] = \[[\s\S]*?\r?\n  \]\r?\n/.exec(main)?.[0] ?? ''
  assert.ok(block.length > 800, '要真的取到 settingsSections 那一段（取空串下面几条对什么都成立）')
  assert.match(block, /setShowOfflineCache\(true\)/)
  assert.match(block, /navigate\('rules'\)/)
  assert.match(block, /setShowLogs\(true\)/)
  assert.match(block, /navigate\('backup'\)/)
  assert.match(block, /setTocRulesSignal\(value => value \+ 1\)/, '分章规则那行要真的能开弹窗')
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

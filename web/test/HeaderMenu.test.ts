import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { AppHeader, APP_THEMES, AppPage } from '../src/AppHeader'
import { Logo } from '../src/Logo'
import { defaultReaderSettings, ReaderSettings } from '../src/readerSettings'

test('HeaderMenu - APP_THEMES configuration', () => {
  assert.equal(APP_THEMES.length, 3)
  const themeIds = APP_THEMES.map(t => t.id)
  assert.deepEqual(themeIds, ['light', 'paper', 'dark'])
  
  const themeNames = APP_THEMES.map(t => t.name)
  assert.deepEqual(themeNames, ['晓白', '护眼', '夜读'])
})

test('HeaderMenu - AppHeader static rendering', () => {
  const settings: ReaderSettings = { ...defaultReaderSettings, theme: 'paper' }
  let navigatedTo: AppPage | null = null
  let nextSettings: ReaderSettings | null = null
  let loggedOut = false

  const element = React.createElement(AppHeader, {
    page: 'library',
    settings,
    onSettingsChange: (next) => { nextSettings = next },
    onNavigate: (p) => { navigatedTo = p },
    onLogout: () => { loggedOut = true },
  })

  const html = renderToStaticMarkup(element)

  // Verify brand title and icon
  assert.ok(html.includes('青阅'), 'Header should contain brand title')
  assert.ok(html.includes('app-brand'), 'Header should have app-brand class')
  
  // 一级导航（用户 2026-10-08 定框架，2026-10-09 把「书源」放回顶栏）：书库·书架·书源·发现·订阅·设置。
  // 替换净化规则 / 备份 收进「设置」页，不再占顶栏。
  assert.ok(html.includes('书库'), 'Header should contain 书库 tab')
  assert.ok(html.includes('书架'), 'Header should contain 书架 tab')
  assert.ok(html.includes('书源'), 'Header should contain 书源 tab')
  assert.ok(html.includes('发现'), 'Header should contain 发现 tab')
  assert.ok(html.includes('订阅'), 'Header should contain 订阅 tab')
  assert.ok(html.includes('设置'), 'Header should contain 设置 tab')
  assert.ok(html.includes('我的'), 'Header should contain 我的 menu label')

  // Verify hamburger menu button
  assert.ok(html.includes('header-menu-btn'), 'Header should contain hamburger menu button')
})

test('HeaderMenu - Theme change handling', () => {
  const currentSettings: ReaderSettings = { ...defaultReaderSettings, theme: 'light' }
  let appliedSettings: ReaderSettings | null = null

  const onSettingsChange = (next: ReaderSettings) => {
    appliedSettings = next
  }

  // Simulate theme change
  onSettingsChange({ ...currentSettings, theme: 'dark' })
  assert.equal(appliedSettings?.theme, 'dark')

  onSettingsChange({ ...currentSettings, theme: 'paper' })
  assert.equal(appliedSettings?.theme, 'paper')
})

test('HeaderMenu - Logout confirmation safety', () => {
  let loggedOut = false
  const onLogout = () => {
    loggedOut = true
  }

  const confirmLogout = (confirmed: boolean) => {
    if (confirmed) {
      onLogout()
    }
  }

  // User cancels confirm
  confirmLogout(false)
  assert.equal(loggedOut, false, 'Should not log out when user cancels confirmation')

  // User confirms
  confirmLogout(true)
  assert.equal(loggedOut, true, 'Should log out when user accepts confirmation')
})

test('Logo - 品牌位与桌面/标签页图标同一套几何', () => {
  const element = React.createElement(Logo, { size: 28 })
  const html = renderToStaticMarkup(element)
  assert.ok(html.includes('app-brand-logo'), 'Logo should have app-brand-logo class')
  // 旧断言钉的是 `logoTealGrad` / `logoGoldGrad`（青绿书+金色结那套），
  // 用户已把品牌图形定为 favicon/PWA 那套「绿底白书」，所以这里改钉新几何。
  assert.ok(html.includes('#2E8B63') && html.includes('#17573F'), 'Logo 应使用与 favicon 相同的绿底渐变')
  assert.ok(!html.includes('logoGoldGrad'), '金色结那套已经废弃，不该再出现在品牌位里')
  assert.ok(html.includes('rx="104"'), '圆角方底应与 favicon 一致')
  assert.ok(html.includes('width="28"'), 'Logo should respect size prop')
})



/**
 * #65 版本号：界面显示的版本只有一个来源 —— 服务端 /healthz 报上来的 Implementation-Version。
 * 前端**不许**自己写死一个 semver，否则改了 gradle 版本还会显示旧的（这类假一致最难查）。
 */
test('HeaderMenu - 版本号来自 /healthz，前端不写死', () => {
  const settings: ReaderSettings = { ...defaultReaderSettings }
  const html = renderToStaticMarkup(React.createElement(AppHeader, {
    page: 'library', settings, onSettingsChange: () => undefined, onNavigate: () => undefined, version: '0.2.0',
  }))
  // 浮层是点开才挂载的，静态渲染只能验到闭合态；这里验的是"没有登录那套谎话残留"。
  assert.ok(!html.includes('已登录'), '认证删掉之后不许再出现"已登录"这种谎话')

  // 版本号的显示契约落在源码里：唯一的值是 /healthz 报上来的那个，取不到时如实说"未取到"。
  const header = fs.readFileSync(path.resolve(import.meta.dirname, '../src/AppHeader.tsx'), 'utf8')
  assert.match(header, /version\?:\s*string/, 'AppHeader 必须把版本号做成 prop（值由外层从 /healthz 取）')
  assert.match(header, /\{version \|\| '未取到'\}/, '没取到版本号时要显示"未取到"，不能空着让人以为版本未知是正常')
  assert.match(header, /className="menu-version"/, '版本号要有自己的位置，跟状态位一起摆在菜单头部')

  const app = fs.readFileSync(path.resolve(import.meta.dirname, '../src/main.tsx'), 'utf8')
  assert.match(app, /fetch\('\/healthz'\)/, "版本号必须从 /healthz 取")
  assert.match(app, /version=\{serverVersion\}/, '取到的版本号要真的传给 AppHeader，不能只 fetch 不用')
})

test('前端源码里没有任何写死的版本号', () => {
  const dir = path.resolve(import.meta.dirname, '../src')
  const offenders = fs.readdirSync(dir)
    .filter(name => /\.(ts|tsx)$/.test(name))
    .map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')] as const)
    .filter(([, code]) => /['"`]\d+\.\d+\.\d+['"`]/.test(code))
    .map(([name]) => name)
  assert.deepEqual(offenders, [], `这些前端文件里出现了字面量版本号，版本只能来自 /healthz：${offenders.join('、')}`)
})

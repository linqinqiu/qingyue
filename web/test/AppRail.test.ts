import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { AppRail, APP_THEMES, type AppPage } from '../src/AppRail'
import { Logo } from '../src/Logo'
import { defaultReaderSettings, type ReaderSettings } from '../src/readerSettings'

const src = (name: string) => fs.readFileSync(path.resolve(import.meta.dirname, '../src', name), 'utf8')

test('APP_THEMES - 三档主题与名字', () => {
  assert.equal(APP_THEMES.length, 3)
  assert.deepEqual(APP_THEMES.map(t => t.id), ['light', 'paper', 'dark'])
  assert.deepEqual(APP_THEMES.map(t => t.name), ['晓白', '护眼', '夜读'])
})

test('AppRail - 静态渲染：九个入口全部摆在侧栏，不再藏进 ☰', () => {
  const settings: ReaderSettings = { ...defaultReaderSettings, theme: 'paper' }
  const html = renderToStaticMarkup(React.createElement(AppRail, {
    page: 'library' as AppPage,
    settings,
    onSettingsChange: () => undefined,
    onNavigate: () => undefined,
    onOpenOfflineCache: () => undefined,
    onOpenLogs: () => undefined,
    version: '0.2.0',
  }))

  assert.ok(html.includes('青阅'), '侧栏要有品牌位')
  assert.ok(html.includes('app-brand'), '品牌位沿用 app-brand 类')
  // 改版前一级导航只有 5 个，规则/备份/日志/离线缓存全藏在一个 ☰ 里；
  // AGENTS.md 自己要求"核心系统能力一级导航呈现"，侧栏有纵向空间，不必再藏。
  for (const label of ['书库', '书架', '发现', '订阅', '书源', '替换净化', '备份包', '离线缓存', '运行日志']) {
    assert.ok(html.includes(label), `侧栏要直接给出「${label}」`)
  }
  assert.ok(html.includes('aria-label="主导航"'), '主导航要有可访问名')
  assert.ok(html.includes('rail-collapse'), '侧栏要能收成图标档')
  assert.ok(!html.includes('已登录'), '认证删掉之后不许再出现"已登录"这种谎话')
})

test('AppRail - 当前页高亮，窄屏底部标签栏也带同一批入口', () => {
  const html = renderToStaticMarkup(React.createElement(AppRail, {
    page: 'sources' as AppPage,
    settings: { ...defaultReaderSettings },
    onSettingsChange: () => undefined,
    onNavigate: () => undefined,
  }))
  assert.ok(/class="rail-item active"[^>]*title="书源"|class="rail-item active"[^>]*>\s*<svg[^>]*>[\s\S]*?<\/svg>\s*<span class="rail-item-label">书源<\/span>/.test(html), '当前页要有 active')
  assert.ok(html.includes('rail-tabs'), '窄屏底部标签栏在位')
  assert.ok(html.includes('header-menu-btn'), '「更多」入口在底部标签栏里')
})

test('AppRail - 版本号只有一个来源：/healthz，前端不写死', () => {
  const html = renderToStaticMarkup(React.createElement(AppRail, {
    page: 'library' as AppPage,
    settings: { ...defaultReaderSettings },
    onSettingsChange: () => undefined,
    onNavigate: () => undefined,
    version: '0.2.0',
  }))
  assert.match(html, /class="menu-version"[\s\S]*?<code>0\.2\.0<\/code>/, '版本号要显示出来')

  const rail = src('AppRail.tsx')
  assert.match(rail, /version\?:\s*string/, 'AppRail 必须把版本号做成 prop（值由外层从 /healthz 取）')
  assert.match(rail, /\{version \|\| '未取到'\}/, '没取到版本号时要显示"未取到"，不能空着')

  const app = src('main.tsx')
  assert.match(app, /fetch\('\/healthz'\)/, '版本号必须从 /healthz 取')
  // 两套外壳共用同一个 props 对象（shellProps），版本号在那里传一次就两边都吃到
  assert.match(app, /version:\s*serverVersion|version=\{serverVersion\}/, '取到的版本号要真的传给外壳，不能只 fetch 不用')
})

/**
 * 框架判据：页头只许是一行页头条。
 * 改版前每页是「section-kicker + 34px 衬线 h1 + 一句说明书」，1440×900 下光页头吃掉
 * 150~180px（实测数字见 tools/verify/frame-metrics.mjs 与 out/frame-metrics-before.json）。
 * 这里钉住"不再回到那个形状"，界面级的空白比例由那条门禁量。
 */
test('框架 v2：页面级 masthead 已经拆掉，且默认外壳就是侧栏', () => {
  const pages = ['main.tsx', 'ExplorePage.tsx', 'BackupPage.tsx', 'ReplaceRulesPage.tsx']
  for (const name of pages) {
    const code = src(name)
    assert.ok(!/className="page-title"/.test(code), `${name} 还在用页头大标题块 page-title`)
    assert.ok(!/library-hero/.test(code), `${name} 还在用 library-hero 那种宣传页头`)
  }
  const css = src('styles.css')
  assert.match(css, /\.page-bar \{/, '页头条要有 .page-bar 的定义')
  assert.match(css, /\.app-rail \{/, '侧栏要有 .app-rail 的定义')
  // 两套外壳的样式都必须在（切过去不能是裸样式）。默认哪一套有过一次反复：
  // 做 v2 那一轮把默认钉成 rail，理由是用户当时说"自主升级"；用户 2026-10-01 看完两套之后
  // 明确改成「之前那个界面也留着，这个作为备份放到自定义里面」→ **默认是旧顶栏（topbar）**，
  // v2 收进「自定义 → 界面布局」。别再翻回去，两套都留着才是这次的交付。
  assert.match(css, /\.app-page-header \{/, '旧顶栏外壳的样式要留着，切回去不能是裸的')
  const settings = src('readerSettings.ts')
  assert.match(settings, /uiLayout: 'topbar'/, '默认外壳必须是旧顶栏（用户 2026-10-01 拍板）')
  assert.match(settings, /return layout === 'rail' \? 'rail' : 'topbar'/, '没存过这个字段的老数据也吃顶栏默认')
})

/** 说明行只留给弹窗与面板；页面标题行不再各写一套 kicker。 */
test('框架 v2：页面不再各自渲染 section-kicker 当页头', () => {
  const app = src('main.tsx')
  const subscription = app.slice(app.indexOf('function SubscriptionPage'), app.indexOf('function SourcesPage'))
  assert.ok(!/section-kicker/.test(subscription), '订阅页的页头说明行已删')
  const sources = app.slice(app.indexOf('function SourcesPage'), app.indexOf('function HighlightText'))
  assert.ok(!/<h1>书源管理<\/h1>/.test(sources), '书源页不再写"书源管理"大标题')
})

test('Logo - 品牌位与桌面/标签页图标同一套几何', () => {
  const html = renderToStaticMarkup(React.createElement(Logo, { size: 28 }))
  assert.ok(html.includes('app-brand-logo'), 'Logo should have app-brand-logo class')
  assert.ok(html.includes('#2E8B63') && html.includes('#17573F'), 'Logo 应使用与 favicon 相同的绿底渐变')
  assert.ok(!html.includes('logoGoldGrad'), '金色结那套已经废弃，不该再出现在品牌位里')
  assert.ok(html.includes('rx="104"'), '圆角方底应与 favicon 一致')
  assert.ok(html.includes('width="28"'), 'Logo should respect size prop')
})

test('前端源码里没有任何写死的版本号', () => {
  const dir = path.resolve(import.meta.dirname, '../src')
  const offenders = fs.readdirSync(dir)
    .filter(name => /\.(ts|tsx)$/.test(name))
    .map(name => [name, src(name).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')] as const)
    .filter(([, code]) => /['"`]\d+\.\d+\.\d+['"`]/.test(code))
    .map(([name]) => name)
  assert.deepEqual(offenders, [], `这些前端文件里出现了字面量版本号，版本只能来自 /healthz：${offenders.join('、')}`)
})

import React, { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './icons'
import { Logo } from './Logo'
import { promptPwaInstall, subscribePwaInstall } from './PwaManager'
import type { ReaderSettings } from './readerSettings'
import { BUILTIN_SKINS } from './readerSettings'

/**
 * 一级页面的唯一清单。两套外壳（侧栏 / 旧顶栏）与 `main.tsx` 的路由都引这一个类型 ——
 * 之前是三处各写一遍联合类型，加一页（changelog）就出现"页面存在但外壳不认"的编译错。
 */
export type AppPage = 'sources' | 'subscriptions' | 'library' | 'shelf' | 'explore' | 'reader' | 'rules' | 'backup' | 'changelog'

export interface AppRailProps {
  page: AppPage
  settings: ReaderSettings
  searching?: boolean
  onSettingsChange: (next: ReaderSettings) => void
  onNavigate: (page: AppPage) => void
  onOpenOfflineCache?: () => void
  onOpenLogs?: () => void
  /**
   * 「更新日志」与「自定义」。两套外壳传的是**同一个 shellProps 对象**（见 main.tsx），
   * 所以入口集合天然相等 —— ui-layout-check 就是按"切了布局不许少功能"判的。
   */
  onOpenChangelog?: () => void
  onOpenCustomize?: () => void
  /** 服务端 /healthz 报回来的版本号；空串表示还没问到（离线或启动中）。 */
  version?: string
}

/** 皮肤名单一来源在 readerSettings（两套外壳 + 「自定义」弹窗共用，各自定义一份迟早漂移）。 */
export const APP_THEMES = BUILTIN_SKINS

type RailItem = { page?: AppPage; action?: 'offline' | 'logs' | 'customize'; icon: IconName; label: string }

/**
 * 导航按"读什么 / 管什么 / 顺手用什么"分三档。
 *
 * 改版前一级导航只有 5 个，替换净化、备份包、运行日志、离线缓存全塞在一个 ☰ 里 ——
 * 而 AGENTS.md 自己写着"核心系统能力必须一级导航呈现"。侧栏有纵向空间，不必再藏。
 */
const RAIL_SECTIONS: ReadonlyArray<{ label: string; items: RailItem[] }> = [
  {
    label: '阅读',
    items: [
      { page: 'library', icon: 'search', label: '书库' },
      { page: 'shelf', icon: 'book', label: '书架' },
      { page: 'explore', icon: 'globe', label: '发现' },
      { page: 'subscriptions', icon: 'rss', label: '订阅' },
    ],
  },
  {
    label: '管理',
    items: [
      { page: 'sources', icon: 'list', label: '书源' },
      { page: 'rules', icon: 'edit', label: '替换净化' },
      { page: 'backup', icon: 'folder', label: '备份包' },
    ],
  },
  {
    label: '工具',
    items: [
      { action: 'offline', icon: 'download', label: '离线缓存' },
      { action: 'logs', icon: 'activity', label: '运行日志' },
      { action: 'customize', icon: 'sliders', label: '自定义' },
      { page: 'changelog', icon: 'file', label: '更新日志' },
    ],
  },
]

/** 窄屏放不下侧栏时改用底部标签栏；其余入口收进「更多」。 */
const TAB_PAGES: AppPage[] = ['library', 'shelf', 'explore', 'subscriptions', 'sources']

const COLLAPSE_KEY = 'legado.rail.collapsed'

/**
 * 渲染期不碰 `localStorage`：门禁里有用 `renderToStaticMarkup` 做静态渲染的用例，
 * Node 侧不一定有这个全局（AGENTS §5「组件渲染期严禁直接取 location」同一类坑）。
 */
const readCollapsed = () => {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

const writeCollapsed = (value: boolean) => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0')
  } catch {
    // 隐私模式/禁用存储时只是记不住折叠状态，不该影响渲染
  }
}

export function AppRail({
  page,
  settings,
  searching,
  onSettingsChange,
  onNavigate,
  onOpenOfflineCache,
  onOpenLogs,
  onOpenChangelog,
  onOpenCustomize,
  version = '',
}: AppRailProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [moreOpen, setMoreOpen] = useState(false)
  const [canInstall, setCanInstall] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    writeCollapsed(collapsed)
  }, [collapsed])

  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  useEffect(() => subscribePwaInstall(setCanInstall), [])

  useEffect(() => {
    if (!moreOpen) return
    const close = (event: Event) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) setMoreOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMoreOpen(false) }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  const toggleFullscreen = () => {
    setMoreOpen(false)
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else void document.documentElement.requestFullscreen().catch(() => undefined)
  }

  const runItem = (item: RailItem) => {
    if (item.page) onNavigate(item.page)
    else if (item.action === 'offline') onOpenOfflineCache?.()
    else if (item.action === 'logs') onOpenLogs?.()
    else if (item.action === 'customize') onOpenCustomize?.()
  }

  const available = (item: RailItem) =>
    (item.page && item.page !== 'reader') ||
    (item.action === 'offline' && Boolean(onOpenOfflineCache)) ||
    (item.action === 'logs' && Boolean(onOpenLogs)) ||
    (item.action === 'customize' && Boolean(onOpenCustomize))

  const themeButtons = (
    <div className="rail-themes" role="radiogroup" aria-label="全站主题选择">
      {APP_THEMES.map(theme => {
        const selected = settings.theme === theme.id
        return (
          <button
            key={theme.id}
            type="button"
            className={`rail-theme theme-option-${theme.id} ${selected ? 'selected' : ''}`}
            role="radio"
            aria-checked={selected}
            title={theme.name}
            onClick={() => onSettingsChange({ ...settings, theme: theme.id })}
          >
            <span className={`theme-swatch theme-swatch-${theme.id}`} />
            <span className="theme-name">{theme.name}</span>
          </button>
        )
      })}
    </div>
  )

  return (
    <>
      <aside className={`app-rail ${collapsed ? 'collapsed' : ''}`}>
        <div className="rail-brand-row">
          <button type="button" className="app-brand" onClick={() => onNavigate('library')} aria-label="青阅">
            <Logo size={22} className="app-brand-logo" />
            <strong>青阅</strong>
          </button>
          <button
            type="button"
            className="rail-collapse"
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            title={collapsed ? '展开侧栏' : '收起侧栏'}
            onClick={() => setCollapsed(value => !value)}
          >
            <Icon name={collapsed ? 'arrowRight' : 'arrowLeft'} />
          </button>
        </div>

        <nav className="rail-nav" aria-label="主导航">
          {RAIL_SECTIONS.map(section => (
            <div className="rail-group" key={section.label}>
              <span className="rail-group-label">{section.label}</span>
              {section.items.filter(available).map(item => {
                const active = Boolean(item.page) && item.page === page
                return (
                  <button
                    key={item.label}
                    type="button"
                    className={`rail-item ${active ? 'active' : ''}`}
                    title={item.label}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => runItem(item)}
                  >
                    <Icon name={item.icon} />
                    <span className="rail-item-label">{item.label}</span>
                    {item.page === 'library' && searching && (
                      <span className="nav-search-indicator" title="后台正在搜索..." aria-label="后台正在搜索" />
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        <div className="rail-foot">
          {themeButtons}
          <div className="menu-version">
            <span>版本</span>
            <code>{version || '未取到'}</code>
          </div>
        </div>
      </aside>

      <nav className="rail-tabs" aria-label="移动端导航">
        {TAB_PAGES.map(item => {
          const label = RAIL_SECTIONS.flatMap(s => s.items).find(entry => entry.page === item)
          if (!label) return null
          return (
            <button
              key={item}
              type="button"
              className={page === item ? 'active' : ''}
              onClick={() => onNavigate(item)}
            >
              <Icon name={label.icon} />
              <span>{label.label}</span>
            </button>
          )
        })}
        <div className="rail-more-wrap" ref={moreRef}>
          <button
            type="button"
            className={`header-menu-btn ${moreOpen ? 'active' : ''}`}
            aria-label={moreOpen ? '关闭更多菜单' : '打开更多菜单'}
            aria-expanded={moreOpen}
            aria-haspopup="true"
            onClick={() => setMoreOpen(value => !value)}
          >
            <Icon name="menu" />
            <span className="header-menu-label">更多</span>
          </button>
          {moreOpen && (
            <div className="header-menu-dropdown" role="menu" aria-label="功能菜单">
              <div className="menu-header">
                <div className="menu-status-badge">
                  <span className="menu-status-dot" />
                  <span className="menu-header-title">本机服务在线</span>
                </div>
                <div className="menu-version">
                  <span>版本</span>
                  <code>{version || '未取到'}</code>
                </div>
              </div>
              <div className="menu-section">
                {RAIL_SECTIONS.flatMap(s => s.items)
                  .filter(item => !TAB_PAGES.includes(item.page as AppPage))
                  .filter(available)
                  .map(item => (
                    <button
                      key={item.label}
                      type="button"
                      className="menu-logout-btn"
                      role="menuitem"
                      onClick={() => { setMoreOpen(false); runItem(item) }}
                    >
                      <Icon name={item.icon} />
                      <span>{item.label}</span>
                    </button>
                  ))}
                {canInstall && (
                  <button type="button" className="menu-logout-btn" role="menuitem" onClick={() => { setMoreOpen(false); void promptPwaInstall() }}>
                    <Icon name="download" />
                    <span>安装到桌面 / 主屏幕</span>
                  </button>
                )}
                <button type="button" className="menu-logout-btn" role="menuitem" aria-pressed={isFullscreen} onClick={toggleFullscreen}>
                  <Icon name="expand" />
                  <span>{isFullscreen ? '退出全屏' : '全屏显示'}</span>
                </button>
              </div>
              <div className="menu-divider" />
              {themeButtons}
            </div>
          )}
        </div>
      </nav>
    </>
  )
}

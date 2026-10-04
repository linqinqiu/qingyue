import React, { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { PRIMARY_PAGES } from './shortcuts'
import { Logo } from './Logo'
import { promptPwaInstall, subscribePwaInstall } from './PwaManager'
import { availableSkins, BUILTIN_SKINS, type ReaderSettings } from './readerSettings'

export type AppPage = 'sources' | 'subscriptions' | 'library' | 'shelf' | 'explore' | 'reader' | 'rules' | 'backup' | 'changelog' | 'about' | 'bookmarks' | 'settings'

export interface AppHeaderProps {
  page: AppPage
  settings: ReaderSettings
  searching?: boolean
  onSettingsChange: (next: ReaderSettings) => void
  onNavigate: (page: AppPage) => void
  /** 顶栏那颗版本号芯片点开的「更新日志」页（菜单里不再重复列一条）。 */
  onOpenChangelog?: () => void
  onOpenCustomize?: () => void
  /** 服务端 /healthz 报回来的版本号；空串表示还没问到（离线或启动中）。 */
  version?: string
}

/** 皮肤名单一来源在 readerSettings（顶栏菜单与「自定义」弹窗共用，各自定义一份迟早漂移）。 */
export const APP_THEMES = BUILTIN_SKINS

export function AppHeader({
  page,
  settings,
  searching,
  onSettingsChange,
  onNavigate,
  onOpenChangelog,
  onOpenCustomize,
  version = '',
}: AppHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [canInstall, setCanInstall] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const toggleFullscreen = () => {
    setMenuOpen(false)
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else void document.documentElement.requestFullscreen().catch(() => undefined)
  }

  useEffect(() => {
    return subscribePwaInstall(setCanInstall)
  }, [])

  const handlePwaInstall = async () => {
    setMenuOpen(false)
    await promptPwaInstall()
  }
  const menuContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
      }
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('pointerdown', handlePointerDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [menuOpen])


  const handleThemeChange = (theme: ReaderSettings['theme']) => {
    onSettingsChange({ ...settings, theme })
  }

  return (
    <header className="app-page-header">
      <div className="app-brand-group">
        <button
          type="button"
          className="app-brand"
          onClick={() => onNavigate('library')}
          aria-label="青阅"
        >
          <Logo size={22} />
          <strong>青阅</strong>
        </button>
        {/*
          版本号常驻顶栏，且本身就是「更新日志」的入口。
          它此前只挂在「我的」下拉里 —— 不点菜单就读不到"这是哪一版"，
          于是这个功能对用户等于不存在（用户 2026-10-02：「更新日志和版本号还没有做呢」）。
          取不到版本时整档不渲染：顶栏上不留一个写着"未取到"的控件。
        */}
        {version && (
          <button
            type="button"
            className="brand-version"
            onClick={() => onOpenChangelog?.()}
            title={`当前版本 ${version} · 看这一版改了什么`}
            aria-label={`当前版本 ${version}，打开更新日志`}
          >
            {version}
          </button>
        )}
      </div>

      <nav aria-label="主导航">
        {/*
          入口不再一个个手写：顶栏、数字键 1–8、Alt + ←/→ 的循环顺序全部取自
          shortcuts.ts 里的 PRIMARY_PAGES（用户 2026-10-04：「优化一下主导航栏…
          把设置里面、折叠里面的拿出来，本来是主页的样式、主页的框架」——
          规则与备份原来只能从「设置」页点进去，设置本身收在「我的」里）。
          手写八份 <button> 的代价已经付过一次：三份表各自漏过不同的页面。
        */}
        {PRIMARY_PAGES.map(item => (
          <button
            key={item.page}
            type="button"
            className={page === item.page ? 'active' : ''}
            aria-current={page === item.page ? 'page' : undefined}
            onClick={() => onNavigate(item.page as AppPage)}
          >
            {item.nav}
            {item.page === 'library' && searching && (
              <span
                className="nav-search-indicator"
                title="后台正在搜索…"
                aria-label="后台正在搜索"
              />
            )}
          </button>
        ))}
      </nav>


      <div className="header-actions" ref={menuContainerRef}>
        <button
          type="button"
          className={`header-menu-btn ${menuOpen ? 'active' : ''}`}
          aria-label={menuOpen ? '关闭我的菜单' : '打开我的菜单'}
          aria-expanded={menuOpen}
          aria-haspopup="true"
          onClick={() => setMenuOpen(prev => !prev)}
        >
          <Icon name="menu" />
          <span className="header-menu-label">我的</span>
        </button>

        {menuOpen && (
          <>
            <div
              className="header-menu-backdrop"
              onClick={() => setMenuOpen(false)}
              aria-hidden="true"
            />
            <div className="header-menu-dropdown" role="menu" aria-label="功能菜单">
              {/*
                  「已登录服务」是认证那套删掉之后留下的谎话：这台服务不设身份，没有登录这回事。
                  换成真正有用的两件事：这是哪个版本、连的是哪台。
                */}
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
                <div className="menu-section-label">
                  皮肤
                  {onOpenCustomize && (
                    <button
                      type="button"
                      className="menu-section-action"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false)
                        onOpenCustomize()
                      }}
                    >
                      自定义
                    </button>
                  )}
                </div>
                {/* 列表来自 availableSkins：内置三套 + 「自定义」里填过 CSS 的那一套（同源，不会两处不一样） */}
                <div className="menu-theme-grid" role="radiogroup" aria-label="皮肤选择">
                  {availableSkins(settings).map(skin => {
                    const isSelected = settings.theme === skin.id
                    return (
                      <button
                        key={skin.id}
                        type="button"
                        className={`menu-theme-btn ${isSelected ? 'selected' : ''}`}
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => handleThemeChange(skin.id)}
                      >
                        <span className={`theme-swatch theme-swatch-${skin.builtin ? skin.id : 'custom'}`} />
                        <span className="theme-name">{skin.name}</span>
                        {isSelected && <Icon name="check" className="theme-check-icon" />}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="menu-divider" />

              <div className="menu-section">
                {canInstall && (
                  <button
                    type="button"
                    className="menu-logout-btn"
                    style={{ color: 'var(--ink)' }}
                    role="menuitem"
                    onClick={() => void handlePwaInstall()}
                  >
                    <Icon name="download" />
                    <span>安装到桌面</span>
                  </button>
                )}
                {/*
                  「本地离线缓存管理」「替换净化规则」「运行日志」「备份包」这四条收进「设置」
                  （用户 2026-10-03：「在我的里面新加一个设置，把一些 txt 目录规则、备份、替换净化
                  之类的放进去」+「顶栏『我的』菜单堆太多」；2026-10-04 又把「设置」提到顶栏一级）。
                  这一栏现在只剩 书签 / 关于（+ 装了 PWA 时才出现的"安装到桌面"）：
                  凡是一级目的地都走顶栏，菜单只放"不算一个页面"的动作。
                */}
                <button
                  type="button"
                  className="menu-logout-btn"
                  style={{ color: 'var(--ink)' }}
                  role="menuitem"
                  aria-current={page === 'bookmarks' ? 'page' : undefined}
                  onClick={() => {
                    setMenuOpen(false)
                    onNavigate('bookmarks')
                  }}
                >
                  <Icon name="bookmark" />
                  <span>书签</span>
                </button>
                <button
                  type="button"
                  className="menu-logout-btn"
                  style={{ color: 'var(--ink)' }}
                  role="menuitem"
                  aria-current={page === 'about' ? 'page' : undefined}
                  onClick={() => {
                    setMenuOpen(false)
                    onNavigate('about')
                  }}
                >
                  <Icon name="info" />
                  <span>关于</span>
                </button>
                <button
                  type="button"
                  className="menu-logout-btn"
                  style={{ color: 'var(--ink)' }}
                  role="menuitem"
                  aria-pressed={isFullscreen}
                  onClick={toggleFullscreen}
                >
                  <Icon name="expand" />
                  <span>{isFullscreen ? '退出全屏' : '全屏显示'}</span>
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </header>
  )
}

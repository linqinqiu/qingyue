import React, { useEffect, useRef, useState } from 'react'
import { Icon } from './icons'
import { Logo } from './Logo'
import { promptPwaInstall, subscribePwaInstall } from './PwaManager'
import { availableSkins, BUILTIN_SKINS, type ReaderSettings } from './readerSettings'

export type AppPage = 'sources' | 'subscriptions' | 'library' | 'shelf' | 'explore' | 'reader' | 'rules' | 'backup' | 'changelog'

export interface AppHeaderProps {
  page: AppPage
  settings: ReaderSettings
  searching?: boolean
  onSettingsChange: (next: ReaderSettings) => void
  onNavigate: (page: AppPage) => void
  onOpenReplaceRules?: () => void
  onOpenOfflineCache?: () => void
  onOpenLogs?: () => void
  /** 「更新日志」页与「自定义」弹窗（皮肤）。 */
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
  onOpenReplaceRules,
  onOpenOfflineCache,
  onOpenLogs,
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
      <button
        type="button"
        className="app-brand"
        onClick={() => onNavigate('library')}
        aria-label="青阅"
      >
        <Logo size={22} />
        <strong>青阅</strong>
      </button>

      <nav aria-label="主导航">
        <button
          type="button"
          className={page === 'library' ? 'active' : ''}
          onClick={() => onNavigate('library')}
        >
          书库
          {searching && (
            <span
              className="nav-search-indicator"
              title="后台正在搜索..."
              aria-label="后台正在搜索"
            />
          )}
        </button>
        <button
          type="button"
          className={page === 'shelf' ? 'active' : ''}
          onClick={() => onNavigate('shelf')}
        >
          书架
        </button>
        <button
          type="button"
          className={page === 'sources' ? 'active' : ''}
          onClick={() => onNavigate('sources')}
        >
          书源
        </button>
        <button
          type="button"
          className={page === 'explore' ? 'active' : ''}
          onClick={() => onNavigate('explore')}
        >
          发现
        </button>
        <button
          type="button"
          className={page === 'subscriptions' ? 'active' : ''}
          onClick={() => onNavigate('subscriptions')}
        >
          订阅
        </button>
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
                        className={`menu-theme-btn theme-option-${skin.builtin ? skin.id : 'custom'} ${isSelected ? 'selected' : ''}`}
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
                    <span>安装到桌面 / 主屏幕</span>
                  </button>
                )}
                {onOpenOfflineCache && (
                  <button
                    type="button"
                    className="menu-logout-btn"
                    style={{ color: 'var(--ink)' }}
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      onOpenOfflineCache()
                    }}
                  >
                    <Icon name="book" />
                    <span>本地离线缓存管理</span>
                  </button>
                )}
                <button
                  type="button"
                  className="menu-logout-btn"
                  style={{ color: 'var(--ink)' }}
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onNavigate('rules')
                  }}
                >
                  <Icon name="edit" />
                  <span>替换净化规则</span>
                </button>
                {onOpenLogs && (
                  <button
                    type="button"
                    className="menu-logout-btn"
                    style={{ color: 'var(--ink)' }}
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      onOpenLogs()
                    }}
                  >
                    <Icon name="activity" />
                    <span>运行日志</span>
                  </button>
                )}
                <button
                  type="button"
                  className="menu-logout-btn"
                  style={{ color: 'var(--ink)' }}
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false)
                    onNavigate('backup')
                  }}
                >
                  <Icon name="folder" />
                  <span>备份包</span>
                </button>
                {onOpenChangelog && (
                  <button
                    type="button"
                    className="menu-logout-btn"
                    style={{ color: 'var(--ink)' }}
                    role="menuitem"
                    aria-current={page === 'changelog' ? 'page' : undefined}
                    onClick={() => {
                      setMenuOpen(false)
                      onOpenChangelog()
                    }}
                  >
                    <Icon name="file" />
                    <span>更新日志</span>
                  </button>
                )}
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

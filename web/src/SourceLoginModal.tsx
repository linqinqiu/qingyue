import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { api, SourceLoginUiItem, SourceLoginUiResponse } from './api'
import { SourceWebViewModal } from './SourceWebViewModal'

interface SourceLoginModalProps {
  sourceId: string
  sourceName: string
  onClose: () => void
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void
}

export const SourceLoginModal: React.FC<SourceLoginModalProps> = ({
  sourceId,
  sourceName,
  onClose,
  onToast,
}) => {
  const [loading, setLoading] = useState(true)
  const [executing, setExecuting] = useState(false)
  const [uiResponse, setUiResponse] = useState<SourceLoginUiResponse | null>(null)
  const [formData, setFormData] = useState<Record<string, string>>({})
  const [menuOpen, setMenuOpen] = useState(false)
  const [headerEditOpen, setHeaderEditOpen] = useState(false)
  const [headerEditText, setHeaderEditText] = useState('')
  const [cookieModalOpen, setCookieModalOpen] = useState(false)
  const [cookieInputText, setCookieInputText] = useState('')
  const [bookmarkletModalOpen, setBookmarkletModalOpen] = useState(false)
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({})
  const [webViewOpen, setWebViewOpen] = useState(false)
  const [webViewStartUrl, setWebViewStartUrl] = useState<string | undefined>(undefined)
  /** 触发内置浏览器的登录动作，登录完成后需要带 Cookie 重跑一次 */
  const pendingBrowserActionRef = useRef<string | null>(null)
  /** 当前选择的登录方式；null 表示还没按书源能力自动选过。 */
  const [method, setMethod] = useState<'form' | 'browser' | 'cookie' | 'bookmark' | null>(null)
  const [status, setStatus] = useState<{ loggedIn: boolean; hasCredential?: boolean; verified?: boolean; message?: string } | null>(null)
  const userPickedRef = useRef(false)

  const loadLoginUi = useCallback(async () => {
    try {
      setLoading(true)
      const res = await api.getSourceLoginUi(sourceId)
      setUiResponse(res)
      setHeaderEditText(res.loginHeader || '')
      const initialData: Record<string, string> = { ...(res.loginInfo || {}) }
      res.loginUi.forEach(item => {
        const key = item.key || item.name
        if (key && initialData[key] === undefined && item.default) {
          initialData[key] = item.default
        }
      })
      setFormData(initialData)
      // 拉一次登录判定，让头部状态与实际一致（区分已验证 / 仅抓到凭据）
      try {
        setStatus(await api.checkSourceLogin(sourceId))
      } catch {
        /* 判定失败不阻塞界面 */
      }
      // 用户没手动切过分段时，按书源能力自动选推荐方式
      if (!userPickedRef.current) {
        const hasForm = res.loginUi.length > 0
        setMethod(hasForm ? 'form' : res.loginUrl ? 'browser' : 'cookie')
      }
    } catch (err: any) {
      onToast(err.message || '获取登录界面失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [sourceId, onToast])

  useEffect(() => {
    loadLoginUi()
  }, [loadLoginUi])

  /** 用户手动打开内置浏览器（不带触发动作），入口地址交给书源配置决定 */
  const openBuiltInBrowser = useCallback(() => {
    pendingBrowserActionRef.current = null
    setWebViewStartUrl(undefined)
    setWebViewOpen(true)
  }, [])

  const bookmarkletCode = useMemo(() => {
    const serverOrigin = window.location.origin
    const targetSourceId = encodeURIComponent(sourceId)
    return `javascript:(function(){var c=document.cookie;var u=location.href;if(!c){alert('⚠️ 当前页面未检测到任何 Cookie！');return;}fetch('${serverOrigin}/api/sources/${targetSourceId}/login-cookie',{method:'POST',mode:'cors',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookie:c,url:u})}).then(function(r){return r.json()}).then(function(d){alert('✅ 成功将当前站点的 Cookie 同步至阅读服务器！')}).catch(function(e){alert('❌ 同步失败: '+e)});})();`
  }, [sourceId])

  const handleInputChange = (key: string, val: string) => {
    setFormData(prev => ({ ...prev, [key]: val }))
  }

  const handleAction = async (actionCode?: string, isLongClick = false, allowBuiltInBrowser = true) => {
    if (!actionCode && actionCode !== '') return
    try {
      setExecuting(true)
      const trimmed = actionCode.trim()
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        window.open(trimmed, '_blank', 'noopener,noreferrer')
        return
      }

      const res = await api.executeSourceLoginAction(sourceId, actionCode, formData, isLongClick)
      if (res.error) {
        // 书源脚本失败时必须显式告知，否则按钮会「看起来成功但毫无反应」
        onToast(`书源脚本执行失败：${res.error}`, 'error')
      } else if (res.toastMessages && res.toastMessages.length > 0) {
        res.toastMessages.forEach(msg => onToast(msg, res.success ? 'success' : 'info'))
      } else if (res.success) {
        onToast('操作执行成功', 'success')
      }

      if (res.openUrl) {
        // 书源 JS 通过 java.startBrowserAwait(url) 请求打开网页：在本应用内置浏览器中打开，
        // 而不是弹到外部标签页，这样登录产生的 Cookie 能直接落到书源 Credential 里。
        if (allowBuiltInBrowser) {
          pendingBrowserActionRef.current = actionCode
          setWebViewStartUrl(res.openUrl)
          setWebViewOpen(true)
        } else {
          window.open(res.openUrl, '_blank', 'noopener,noreferrer')
        }
      }
      if (res.copyText) {
        await navigator.clipboard.writeText(res.copyText)
        onToast(`已复制到剪贴板: ${res.copyText}`, 'info')
      }
      if (res.updatedLoginInfo) {
        setFormData(prev => ({ ...prev, ...res.updatedLoginInfo }))
      }
      if (res.reRenderUi) {
        await loadLoginUi()
      }
    } catch (err: any) {
      onToast(err.message || '执行操作失败', 'error')
    } finally {
      setExecuting(false)
    }
  }

  const handleSaveAndLogin = async () => {
    try {
      setExecuting(true)
      await api.saveSourceLoginInfo(sourceId, formData)
      const res = await api.executeSourceLoginAction(sourceId, 'login(true)', formData, false)
      if (res.error) {
        onToast(`书源脚本执行失败：${res.error}`, 'error')
      } else if (res.toastMessages && res.toastMessages.length > 0) {
        res.toastMessages.forEach(msg => onToast(msg, res.success ? 'success' : 'info'))
      } else {
        onToast('登录信息已保存并尝试登录', 'success')
      }
      if (res.openUrl) {
        pendingBrowserActionRef.current = 'login(true)'
        setWebViewStartUrl(res.openUrl)
        setWebViewOpen(true)
      }
      if (res.copyText) {
        await navigator.clipboard.writeText(res.copyText)
      }
      if (res.updatedLoginInfo) {
        setFormData(prev => ({ ...prev, ...res.updatedLoginInfo }))
      }
      if (res.reRenderUi) {
        await loadLoginUi()
      }
    } catch (err: any) {
      onToast(err.message || '保存或登录失败', 'error')
    } finally {
      setExecuting(false)
    }
  }

  const handleCopyLoginHeader = async () => {
    const header = uiResponse?.loginHeader
    if (!header) {
      onToast('当前书源无登录头', 'info')
      return
    }
    await navigator.clipboard.writeText(header)
    onToast('登录头已复制到剪贴板', 'success')
    setMenuOpen(false)
  }

  const handleSaveHeader = async () => {
    try {
      setExecuting(true)
      await api.saveSourceLoginHeader(sourceId, headerEditText.trim())
      onToast('登录头已成功更新并保存', 'success')
      setHeaderEditOpen(false)
      await loadLoginUi()
    } catch (err: any) {
      onToast(err.message || '保存登录头失败', 'error')
    } finally {
      setExecuting(false)
    }
  }

  const handleSaveCookie = async () => {
    if (!cookieInputText.trim()) {
      onToast('请输入 Cookie 内容', 'error')
      return
    }
    try {
      setExecuting(true)
      await api.saveSourceCookie(sourceId, cookieInputText.trim())
      onToast('Cookie 已成功保存并关联到书源', 'success')
      setCookieModalOpen(false)
      setCookieInputText('')
      await loadLoginUi()
    } catch (err: any) {
      onToast(err.message || '保存 Cookie 失败', 'error')
    } finally {
      setExecuting(false)
    }
  }

  const handleDeleteLoginHeader = async () => {
    if (!confirm('确定删除此书源保存的登录头吗？')) return
    try {
      await api.clearSourceLoginHeader(sourceId)
      onToast('登录头已删除', 'success')
      setMenuOpen(false)
      loadLoginUi()
    } catch (err: any) {
      onToast(err.message || '删除登录头失败', 'error')
    }
  }

  const handleClearLoginInfo = async () => {
    if (!confirm('确定清空此书源的所有登录输入信息吗？')) return
    try {
      await api.clearSourceLoginInfo(sourceId)
      setFormData({})
      onToast('登录信息已清空', 'success')
      setMenuOpen(false)
    } catch (err: any) {
      onToast(err.message || '清空登录信息失败', 'error')
    }
  }

  const copyBookmarklet = async () => {
    await navigator.clipboard.writeText(bookmarkletCode)
    onToast('一键抓取书签代码已复制到剪贴板', 'success')
  }

  const renderControl = (item: SourceLoginUiItem, index: number) => {
    const key = item.key || item.name
    const label = item.viewName || item.name
    const type = (item.type || 'text').toLowerCase()
    const value = formData[key] ?? ''

    const basisPercent = item.style?.layout_flexBasisPercent ?? -1
    let flexStyle: React.CSSProperties = {}
    if (basisPercent > 0) {
      if (basisPercent >= 0.9) {
        flexStyle = { flex: '1 1 100%', width: '100%' }
      } else if (basisPercent >= 0.4 && basisPercent <= 0.6) {
        flexStyle = { flex: '1 1 calc(50% - 8px)', minWidth: '180px' }
      } else {
        flexStyle = { flex: `1 1 ${Math.round(basisPercent * 100)}%` }
      }
    } else {
      flexStyle = { flex: item.style?.layout_flexGrow ? `${item.style.layout_flexGrow} 1 auto` : '1 1 100%', width: '100%' }
    }

    if (item.style?.layout_wrapBefore) {
      flexStyle.breakBefore = 'always'
    }

    if (type === 'button') {
      return (
        <div key={`${key}-${index}`} style={flexStyle} className="login-ui-item-btn">
          <button
            type="button"
            className="source-login-btn primary-subtle"
            disabled={executing}
            onClick={() => handleAction(item.action, false)}
            onContextMenu={e => {
              e.preventDefault()
              handleAction(item.action, true)
            }}
          >
            {label}
          </button>
        </div>
      )
    }

    if (type === 'toggle' || type === 'switch' || type === 'checkbox') {
      const isChecked = value === 'true' || value === '1'
      return (
        <div key={`${key}-${index}`} style={flexStyle} className="login-ui-item-toggle-container">
          <label className="login-ui-toggle-label">
            <span>{label}</span>
            <input
              type="checkbox"
              checked={isChecked}
              onChange={e => handleInputChange(key, e.target.checked ? 'true' : 'false')}
            />
          </label>
        </div>
      )
    }

    if (type === 'select' || type === 'dropdown') {
      const options = item.options || (item.chars ? item.chars.filter((c): c is string => c !== null) : [])
      return (
        <div key={`${key}-${index}`} style={flexStyle} className="login-ui-item-field">
          <label className="login-ui-field-label">{label}</label>
          <select
            className="login-ui-select"
            value={value}
            onChange={e => handleInputChange(key, e.target.value)}
          >
            {options.map((opt, i) => (
              <option key={`${opt}-${i}`} value={opt}>{opt}</option>
            ))}
          </select>
        </div>
      )
    }

    if (type === 'label' || type === 'textlabel') {
      return (
        <div key={`${key}-${index}`} style={flexStyle} className="login-ui-item-info">
          <div className="login-ui-info-text">{item.hint || item.default || label}</div>
        </div>
      )
    }

    const isPassword = type === 'password'
    const isShowing = showPasswords[key]
    return (
      <div key={`${key}-${index}`} style={flexStyle} className="login-ui-item-field">
        <label className="login-ui-field-label">{label}</label>
        <div className="login-ui-input-wrapper">
          <input
            type={isPassword && !isShowing ? 'password' : 'text'}
            className="login-ui-input"
            value={value}
            placeholder={item.hint || item.default || `请输入${label}`}
            onChange={e => handleInputChange(key, e.target.value)}
          />
          {isPassword && (
            <button
              type="button"
              className="login-ui-eye-btn"
              onClick={() => setShowPasswords(prev => ({ ...prev, [key]: !prev[key] }))}
              title={isShowing ? '隐藏密码' : '显示密码'}
            >
              {isShowing ? '🙈' : '👁️'}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="source-login-dialog" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="source-login-header">
          <div className="source-login-title-group">
            <h3 className="source-login-title">登录 {sourceName}</h3>
            {uiResponse?.sourceVariable && (
              <span className="source-login-subtitle" title={uiResponse.sourceVariable}>
                已关联变量
              </span>
            )}
          </div>
          <div className="source-login-actions">
            <button
              type="button"
              className="source-login-action-btn"
              title="用内置浏览器登录"
              onClick={openBuiltInBrowser}
            >
              🖥
            </button>
            <button
              type="button"
              className="source-login-action-btn primary"
              title="保存并登录"
              disabled={executing || loading}
              onClick={handleSaveAndLogin}
            >
              ✓
            </button>
            <div className="source-login-menu-container">
              <button
                type="button"
                className="source-login-action-btn"
                title="更多选项"
                onClick={() => setMenuOpen(prev => !prev)}
              >
                ⋮
              </button>
              {menuOpen && (
                <div className="source-login-dropdown-menu">
                  <button
                    type="button"
                    onClick={() => {
                      setHeaderEditText(uiResponse?.loginHeader || '')
                      setHeaderEditOpen(true)
                      setMenuOpen(false)
                    }}
                  >
                    ✏️ 填入 / 查看登录头
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCookieModalOpen(true)
                      setMenuOpen(false)
                    }}
                  >
                    🍪 快捷填入 Cookie
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setBookmarkletModalOpen(true)
                      setMenuOpen(false)
                    }}
                  >
                    ⚡ 一键同步书签 (Bookmarklet)
                  </button>
                  {uiResponse?.loginHeader && (
                    <button type="button" onClick={handleCopyLoginHeader}>
                      📋 复制登录头
                    </button>
                  )}
                  <button type="button" className="danger-text" onClick={handleDeleteLoginHeader}>
                    🗑️ 删除登录头
                  </button>
                  <button type="button" className="danger-text" onClick={handleClearLoginInfo}>
                    🧹 清空登录信息
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="source-login-action-btn"
              title="关闭"
              onClick={onClose}
            >
              ✕
            </button>
          </div>
        </div>

        <div className="source-login-body">
          {loading ? (
            <div className="login-ui-loading">正在加载登录界面...</div>
          ) : (() => {
            const hasForm = (uiResponse?.loginUi?.length ?? 0) > 0
            const hasLoginUrl = !!uiResponse?.loginUrl
            const recommended = hasForm ? 'form' : hasLoginUrl ? 'browser' : 'cookie'
            const active = method ?? recommended
            const tab = (key: 'form' | 'browser' | 'cookie' | 'bookmark', label: string, enabled = true) => (
              <button
                key={key}
                type="button"
                className={`source-login-method-tab${active === key ? ' is-active' : ''}`}
                disabled={!enabled}
                onClick={() => { userPickedRef.current = true; setMethod(key) }}
              >
                {label}
                {recommended === key && <span className="source-login-method-recommend">推荐</span>}
              </button>
            )
            return (
              <>
                <div className="source-login-method-tabs" role="tablist">
                  {tab('form', '✍️ 填写表单', hasForm)}
                  {tab('browser', '🖥 内置浏览器')}
                  {tab('cookie', '🍪 粘贴 Cookie')}
                  {tab('bookmark', '⚡ 书签同步')}
                </div>

                {status?.verified && <div className="source-login-status is-verified">● 登录已验证</div>}
                {!status?.verified && (status?.hasCredential || status?.loggedIn) && <div className="source-login-status is-credential">◐ 已捕获登录凭据（未自动验证）</div>}

                {active === 'form' && (hasForm ? (
                  <form
                    className="source-login-flex-form"
                    onSubmit={e => { e.preventDefault(); handleSaveAndLogin() }}
                  >
                    {uiResponse!.loginUi.map((item, idx) => renderControl(item, idx))}
                    <div style={{ flex: '1 1 100%', width: '100%', marginTop: 6 }}>
                      <button type="submit" className="primary-button" style={{ width: '100%' }} disabled={executing}>
                        {executing ? '登录中...' : '保存并登录'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className="source-login-hint">此书源未提供可视化登录表单，请改用「内置浏览器」或「粘贴 Cookie」方式。</p>
                ))}

                {active === 'browser' && (
                  <div className="source-login-panel">
                    <p className="source-login-hint">
                      在内置浏览器中打开该书源登录页完成登录，站点的 Set-Cookie 会被服务端自动收进书源 Cookie 罐。
                      对纯前端渲染 / 风控站点（番茄、起点等）常无效，此时请改用其它方式。
                    </p>
                    {uiResponse?.loginUrl && <div className="source-login-url-line">{uiResponse.loginUrl}</div>}
                    <button type="button" className="primary-button" disabled={!hasLoginUrl} onClick={openBuiltInBrowser} style={{ alignSelf: 'flex-start' }}>
                      🖥 打开内置浏览器登录
                    </button>
                    {!hasLoginUrl && <p className="source-login-hint small">此书源未配置 loginUrl，无法用内置浏览器登录。</p>}
                  </div>
                )}

                {active === 'cookie' && (
                  <div className="source-login-panel">
                    <div className="direct-cookie-card">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink)' }}>🍪 粘贴 Cookie / Token（支持 JSON / 键值对）</label>
                        <span style={{ fontSize: '11px', color: 'var(--muted)' }}>支持 Cookie-Editor 导出的 JSON</span>
                      </div>
                      <textarea
                        className="source-login-textarea"
                        rows={5}
                        value={cookieInputText}
                        placeholder={'直接粘贴 Cookie 字符串（k1=v1; k2=v2）或 Cookie-Editor 导出的 JSON 数组：\n[{"name":"session_id","value":"..."},{"name":"token","value":"..."}]'}
                        onChange={e => setCookieInputText(e.target.value)}
                      />
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                        {uiResponse?.loginHeader && (
                          <button type="button" className="subtle-button danger-text" onClick={handleDeleteLoginHeader}>🗑️ 清除已存凭据</button>
                        )}
                        <button type="button" className="primary-button" disabled={executing || !cookieInputText.trim()} onClick={handleSaveCookie}>
                          {executing ? '保存中...' : '保存 Cookie'}
                        </button>
                      </div>
                    </div>
                    {uiResponse?.loginHeader && (
                      <div className="source-login-header-preview">
                        <div className="source-login-header-preview-title">当前书源已持久化登录头</div>
                        <div className="source-login-header-preview-body">{uiResponse.loginHeader}</div>
                      </div>
                    )}
                  </div>
                )}

                {active === 'bookmark' && (
                  <div className="source-login-panel">
                    <p className="source-login-hint">
                      在新标签页打开目标网站并登录后，在书签栏点一下此书签，即可把当前站点 Cookie 秒级回传到阅读服务器。
                    </p>
                    <ol className="source-login-bookmark-steps">
                      <li>复制下方代码（或点「复制书签代码」）；</li>
                      <li>浏览器书签栏新建书签，网址处粘贴该代码；</li>
                      <li>在网站登录完成后，点击该书签即可回传。</li>
                    </ol>
                    <textarea className="source-login-textarea" rows={4} readOnly value={bookmarkletCode} style={{ fontSize: '11px', fontFamily: 'monospace' }} onFocus={e => e.currentTarget.select()} />
                    <button type="button" className="primary-button" onClick={copyBookmarklet} style={{ alignSelf: 'flex-start' }}>📋 复制书签代码</button>
                  </div>
                )}
              </>
            )
          })()}
        </div>

        {headerEditOpen && (
          <div className="modal-backdrop top-layer-modal-backdrop" onClick={() => setHeaderEditOpen(false)}>
            <div className="source-login-dialog" style={{ width: 'min(500px, 94vw)' }} onClick={e => e.stopPropagation()}>
              <div className="source-login-header">
                <h3>编辑 / 填入登录头 (Login Header)</h3>
                <button type="button" className="source-login-action-btn" onClick={() => setHeaderEditOpen(false)}>✕</button>
              </div>
              <div className="source-login-body" style={{ padding: '16px' }}>
                <p style={{ margin: '0 0 10px', fontSize: '12px', color: 'var(--muted)' }}>
                  支持 JSON 格式（如 <code>{`{"Authorization": "Bearer ...", "Cookie": "..."}`}</code>）或直接文本。
                </p>
                <textarea
                  className="source-login-textarea"
                  rows={6}
                  value={headerEditText}
                  placeholder='{"Authorization": "Bearer ...", "Cookie": "..."}'
                  onChange={e => setHeaderEditText(e.target.value)}
                />
              </div>
              <div style={{ padding: '12px 18px', display: 'flex', justifyContent: 'flex-end', gap: '8px', borderTop: '1px solid var(--line)' }}>
                <button type="button" className="subtle-button" onClick={() => setHeaderEditOpen(false)}>取消</button>
                <button type="button" className="primary-button" disabled={executing} onClick={handleSaveHeader}>保存登录头</button>
              </div>
            </div>
          </div>
        )}

        {cookieModalOpen && (
          <div className="modal-backdrop top-layer-modal-backdrop" onClick={() => setCookieModalOpen(false)}>
            <div className="source-login-dialog" style={{ width: 'min(500px, 94vw)' }} onClick={e => e.stopPropagation()}>
              <div className="source-login-header">
                <h3>快捷填入 Cookie</h3>
                <button type="button" className="source-login-action-btn" onClick={() => setCookieModalOpen(false)}>✕</button>
              </div>
              <div className="source-login-body" style={{ padding: '16px' }}>
                <p style={{ margin: '0 0 10px', fontSize: '12px', color: 'var(--muted)' }}>
                  将目标网站登录后的 Cookie 字符串粘贴在下方（服务端将自动按域名持久化合并）：
                </p>
                <textarea
                  className="source-login-textarea"
                  rows={5}
                  value={cookieInputText}
                  placeholder="token=xxxx; uid=12345; session=yyyy"
                  onChange={e => setCookieInputText(e.target.value)}
                />
              </div>
              <div style={{ padding: '12px 18px', display: 'flex', justifyContent: 'flex-end', gap: '8px', borderTop: '1px solid var(--line)' }}>
                <button type="button" className="subtle-button" onClick={() => setCookieModalOpen(false)}>取消</button>
                <button type="button" className="primary-button" disabled={executing} onClick={handleSaveCookie}>保存 Cookie</button>
              </div>
            </div>
          </div>
        )}

        {bookmarkletModalOpen && (
          <div className="modal-backdrop top-layer-modal-backdrop" onClick={() => setBookmarkletModalOpen(false)}>
            <div className="source-login-dialog" style={{ width: 'min(520px, 94vw)' }} onClick={e => e.stopPropagation()}>
              <div className="source-login-header">
                <h3>⚡ 一键同步书签 (Bookmarklet)</h3>
                <button type="button" className="source-login-action-btn" onClick={() => setBookmarkletModalOpen(false)}>✕</button>
              </div>
              <div className="source-login-body" style={{ padding: '16px', display: 'grid', gap: '12px' }}>
                <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.5, color: 'var(--ink)' }}>
                  在新标签页打开目标小说网站完成登录后，<strong>只需在书签栏点击一下此书签</strong>，当前站点的 Cookie / Token 即可秒级自动同步回阅读服务器！
                </p>
                <div style={{ background: 'var(--surface-muted)', padding: '10px 12px', borderRadius: '6px', border: '1px solid var(--line)' }}>
                  <span style={{ fontSize: '12px', color: 'var(--muted)', display: 'block', marginBottom: '6px' }}>
                    📖 使用方法：
                  </span>
                  <ol style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: 'var(--muted)', display: 'grid', gap: '4px' }}>
                    <li>点击下方按钮复制书签代码；</li>
                    <li>在浏览器书签栏新建书签，网址处粘贴该代码；</li>
                    <li>在新页面登录网站后，直接点击该书签即可一键回传。</li>
                  </ol>
                </div>
                <textarea
                  className="source-login-textarea"
                  rows={4}
                  readOnly
                  value={bookmarkletCode}
                  style={{ fontSize: '11px', fontFamily: 'monospace' }}
                />
              </div>
              <div style={{ padding: '12px 18px', display: 'flex', justifyContent: 'flex-end', gap: '8px', borderTop: '1px solid var(--line)' }}>
                <button type="button" className="subtle-button" onClick={() => setBookmarkletModalOpen(false)}>关闭</button>
                <button type="button" className="primary-button" onClick={copyBookmarklet}>📋 复制书签代码</button>
              </div>
            </div>
          </div>
        )}
        {webViewOpen && (
          <SourceWebViewModal
            sourceId={sourceId}
            sourceName={sourceName}
            startUrl={webViewStartUrl}
            onClose={() => setWebViewOpen(false)}
            onToast={onToast}
            onNeedOtherMethod={() => {
              setWebViewOpen(false)
              userPickedRef.current = true
              setMethod('cookie')
            }}
            onLoggedIn={async () => {
              await loadLoginUi()
              // 内置浏览器登录成功后，带着已落库的 Cookie 重跑当初触发浏览器的动作，
              // 让书源的 login()/fq_login() 等 JS 能真正完成登录校验。
              const pending = pendingBrowserActionRef.current
              if (pending) {
                pendingBrowserActionRef.current = null
                await handleAction(pending, false, false)
              }
            }}
          />
        )}
      </div>
    </div>
  )
}

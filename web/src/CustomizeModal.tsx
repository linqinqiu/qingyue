import React, { useState } from 'react'
import { Icon } from './icons'
import { useEscapeClose } from './useEscapeClose'
import { availableSkins, BUILTIN_SKINS, parseSkinId, type ReaderSettings } from './readerSettings'

/**
 * 「自定义」这一栏（用户 2026-10-01：「咱们这个是开源允许自定义」）。
 *
 * 里面只有皮肤：内置三套 + 一条**真能生效**的自定义通道 —— 填了 id 与 CSS 就作为
 * `<style id="legado-custom-skin">` 挂上（注入点在 main.tsx 的 `SkinStyle`），
 * 没填就不出现在皮肤列表里：不摆一个点了没反应的控件。
 *
 * 这里原来还有一档「界面布局（顶栏 / 侧栏）」，随界面框架 v2 一起撤掉了 ——
 * 用户 2026-10-01 拍板「整个应用回旧版，撤掉 v2」，只剩一套外壳时那一档没有可选项可言。
 */
export function CustomizeModal({
  settings,
  onChange,
  onClose,
}: {
  settings: ReaderSettings
  onChange: (next: ReaderSettings) => void
  onClose: () => void
}) {
  useEscapeClose(onClose)
  const skins = availableSkins(settings)
  const [skinId, setSkinId] = useState(settings.customSkinId)
  const [skinCss, setSkinCss] = useState(settings.customSkinCss)
  const [skinError, setSkinError] = useState('')

  const sanitized = parseSkinId(skinId)
  const cssLooksLikeRules = /(^|\})\s*[.#a-zA-Z][^{}]*\{[^{}]*\}/.test(skinCss)

  const applySkin = () => {
    if (!sanitized) {
      setSkinError('皮肤 id 不能为空，且只能用字母、数字、- 和 _（它会被拼成 .theme-<id> 类名）。')
      return
    }
    if (!skinCss.trim()) {
      setSkinError('CSS 是空的：这样保存只会多一个看不出效果的皮肤选项。')
      return
    }
    if (!cssLooksLikeRules) {
      setSkinError('看起来不是完整的规则。要写成 `.theme-' + sanitized + ' { --surface: … }` 这种带选择器的形式，不是只写变量。')
      return
    }
    setSkinError('')
    onChange({ ...settings, customSkinId: sanitized, customSkinCss: skinCss })
  }

  const clearSkin = () => {
    setSkinId('')
    setSkinCss('')
    setSkinError('')
    onChange({ ...settings, customSkinId: '', customSkinCss: '', theme: settings.theme === parseSkinId(settings.customSkinId) ? 'light' : settings.theme })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="customize-dialog" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="自定义">
        <header className="customize-header">
          <h2><Icon name="sliders" /> 自定义</h2>
          <button type="button" className="customize-close" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
        </header>

        <div className="customize-body">
          <section className="customize-section">
            <h3>皮肤</h3>
            <p className="customize-hint">
              皮肤改的是配色与标题栏，不改布局；下面填了 CSS 的自定义皮肤会出现在这里。
            </p>
            <div className="customize-skin-row" role="radiogroup" aria-label="皮肤">
              {skins.map(skin => {
                const selected = settings.theme === skin.id
                return (
                  <button
                    key={skin.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`customize-skin theme-option-${skin.builtin ? skin.id : 'custom'} ${selected ? 'selected' : ''}`}
                    onClick={() => onChange({ ...settings, theme: skin.id })}
                  >
                    <span className={`theme-swatch theme-swatch-${skin.builtin ? skin.id : 'custom'}`} />
                    <span className="customize-skin-name">{skin.name}</span>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="customize-section customize-skin-editor">
            <h3>自定义皮肤</h3>
            <p className="customize-hint">
              开源项目允许换皮肤：这里写的 CSS 只存在这台浏览器的 localStorage，
              <strong>不上传服务端、也不进备份包</strong>。规则要自己写完整选择器，例如
              <code>.theme-midnight &#123; --canvas: #0f1213; --surface: #171c1e; --ink: #e8ece7; &#125;</code>
            </p>
            <label className="customize-field">
              <span>皮肤 id（拼成 .theme-&lt;id&gt;，只留字母数字与 - _）</span>
              <input
                type="text"
                value={skinId}
                maxLength={32}
                placeholder="midnight"
                onChange={event => setSkinId(event.target.value)}
              />
              {skinId && sanitized !== skinId.trim() && (
                <small className="customize-note">清洗后是 <code>{sanitized || '(空)'}</code></small>
              )}
            </label>
            <label className="customize-field">
              <span>CSS</span>
              <textarea
                className="customize-css"
                rows={6}
                spellCheck={false}
                value={skinCss}
                placeholder={'.theme-midnight {\n  --canvas: #0f1213;\n  --surface: #171c1e;\n  --ink: #e8ece7;\n}'}
                onChange={event => setSkinCss(event.target.value)}
              />
            </label>
            {/* 自定义皮肤是**叠**在一档内置皮肤之上的：只写 `--canvas` 也有一整套可用变量兜底，
                不至于"字和底一个颜色"。取值写进 settings.customSkinBase，注入点在 main.tsx。 */}
            <div className="customize-field">
              <span>叠在哪一套之上（没写到的变量沿用那一套）</span>
              <div className="customize-base-row" role="radiogroup" aria-label="自定义皮肤的基础皮肤">
                {BUILTIN_SKINS.map(base => (
                  <button
                    key={base.id}
                    type="button"
                    role="radio"
                    aria-checked={settings.customSkinBase === base.id}
                    className={`customize-base theme-option-${base.id} ${settings.customSkinBase === base.id ? 'selected' : ''}`}
                    onClick={() => onChange({ ...settings, customSkinBase: base.id })}
                  >
                    <span className={`theme-swatch theme-swatch-${base.id}`} />
                    <span>{base.name}</span>
                  </button>
                ))}
              </div>
            </div>
            {!!skinError && <p className="customize-error" role="alert">{skinError}</p>}
            <div className="customize-actions">
              <button type="button" className="primary-button" onClick={applySkin}>套用这套皮肤</button>
              {!!settings.customSkinId && (
                <button type="button" className="subtle-button" onClick={clearSkin}>清除自定义皮肤</button>
              )}
              {settings.customSkinId && sanitized === parseSkinId(settings.customSkinId) && skinCss === settings.customSkinCss && (
                <span className="customize-saved">与已套用的一致</span>
              )}
            </div>
            {!!settings.customSkinId && (
              <p className="customize-note">
                当前已套用：<code>.theme-{parseSkinId(settings.customSkinId)}</code>（{(settings.customSkinCss ?? '').length} 字符）。
                {settings.theme === parseSkinId(settings.customSkinId) ? '正在使用它。' : '还没选中它，去上面皮肤列表点一下。'}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

/**
 * 这里改的东西要立刻看得见效果，不留"改了但没生效"的中间态：
 * `SkinStyle`（main.tsx）把 `customSkinCss` 挂成 `<style id="legado-custom-skin">`，
 * `<html>` 与外壳同时带 `theme-<基档> theme-<id>` 两个类（叠加的理由见 `themeClassNames`）。
 * 本组件只负责写 settings。
 */

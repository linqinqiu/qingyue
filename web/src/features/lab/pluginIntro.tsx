import React, { useEffect, useState } from 'react'
import { frontendPlugins } from '../../extensions/registry'
import { api, type PluginStatus } from '../../lib/api'
import type { LabOwnedEntry } from '../../lab/Lab'

/**
 * 「插件」—— 实验室功能条目，**不是插件**（有点绕，但这是正确的位置）。
 *
 * 它做的是：把"当前装了哪些插件"如实列出来。这条界面本身是产品自带的，
 * 所以它属于实验室；被它列出来的那些才是插件。
 *
 * 框架的"能介绍自己"由这条呈现给用户，但框架本体（`lab/`、`extensions/`）里不含这段界面。
 * 换句话说：把这条删掉，实验室依然能用，只是没人告诉你装了哪些插件了。
 *
 * 前端与后端两半都要看得见 —— 从前后端装载失败只打到服务端控制台，界面上完全看不到。
 */
function PluginIntro() {
  const plugins = frontendPlugins.list()
  const failures = frontendPlugins.loadFailures()
  // 后端插件状态：从 /api/plugins 取。装没装上、为什么没装上，用户要看得见。
  const [backend, setBackend] = useState<PluginStatus | null>(null)
  const [backendError, setBackendError] = useState('')
  useEffect(() => {
    let cancelled = false
    api.plugins()
      .then(status => { if (!cancelled) setBackend(status) })
      .catch(() => { if (!cancelled) setBackendError('取不到后端插件状态（服务可能未启动或版本过旧）') })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="lab-plugin-intro">
      <p className="lab-desc">
        插件是**用户自定义**的扩展：可装可卸，不装也不影响主程序。
        框架本身只立钩子；能力由插件注册进来 —— 后端插件注册工具与协议，前端插件登记界面位置。
      </p>

      <h3 className="lab-section-title">前端插件</h3>
      {plugins.length === 0 ? (
        <p className="lab-empty">当前没有登记任何前端插件。实验室里列出的其它条目都是程序自带的，不是插件。</p>
      ) : (
        <ul className="lab-plugin-list">
          {plugins.map(p => (
            <li key={p.id} className="lab-plugin-item">
              <strong>{p.name}</strong>
              <span className="lab-plugin-meta">{p.id} · v{frontendPlugins.versionOf(p)}</span>
              <p>{p.description}</p>
            </li>
          ))}
        </ul>
      )}
      {failures.length > 0 && (
        <div className="lab-plugin-failures">
          <strong>登记失败 {failures.length} 项：</strong>
          <ul>
            {failures.map(f => <li key={f}>{f}</li>)}
          </ul>
        </div>
      )}

      <h3 className="lab-section-title">后端插件</h3>
      {backendError && <p className="lab-empty">{backendError}</p>}
      {!backend && !backendError && <p className="lab-empty">正在读取后端插件状态…</p>}
      {backend && (
        <>
          <p className="lab-plugin-meta">
            已装载 {backend.loaded} 个 · 工具 {backend.tools} 个 · 协议 {backend.providers} 个
            {backend.failures.length > 0 ? ` · 失败 ${backend.failures.length} 个` : ''}
          </p>
          {backend.plugins.length === 0 ? (
            <p className="lab-empty">
              后端插件目录是空的。把实现 Plugin 的 jar 放进安装目录的 plugins/ 里即可加载。
            </p>
          ) : (
            <ul className="lab-plugin-list">
              {backend.plugins.map(p => (
                <li key={p.id} className="lab-plugin-item">
                  <strong>{p.name}</strong>
                  <span className="lab-plugin-meta">{p.id} · v{p.version}</span>
                  <p>{p.description}</p>
                  {p.tools && p.tools.length > 0 && (
                    <span className="lab-plugin-meta">工具：{p.tools.join('、')}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {backend.failures.length > 0 && (
            <div className="lab-plugin-failures">
              <strong>后端装载失败 {backend.failures.length} 项：</strong>
              <ul>
                {backend.failures.map(f => <li key={f.source}>{f.source}：{f.reason}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * 「插件」条目：列的是插件，但它自己是实验室功能。
 *
 * 位置容易搞混，注释写死在这儿：这条**不**由插件注册表产生，
 * 它和 AI 接入、书源体检一样，是产品自带的一条实验室条目。
 */
export const pluginIntroEntry: LabOwnedEntry = {
  id: 'plugins',
  origin: 'lab',
  title: '插件',
  description:
    '当前装了哪些插件、各自贡献了什么、哪些装载失败了。插件是用户自定义的扩展，可装可卸；'
    + '实验室里其它条目是程序自带的，不属于插件。',
  badge: '扩展',
  render: () => <PluginIntro />,
}

import React, { useEffect, useState } from 'react'
import { frontendPlugins } from '../extensions/registry'
import { api, type PluginStatus } from '../lib/api'
import { HOST_VERSION, type FrontendPlugin } from '../extensions/registry'

/**
 * 「插件与扩展」插件 —— 把插件系统自身的状态挂进实验室。
 *
 * 这也是一个**插件**，不是框架的一部分。它做的事：列出当前登记了哪些插件、
 * 各自贡献了什么、哪些登记失败了。框架的"能介绍自己"由这条插件呈现给用户，
 * 但框架本体（`lab/`）里不含这段界面。
 *
 * 换句话说：把这条插件删掉，实验室依然能用，只是没人告诉你装了哪些插件了。
 */
export const pluginIntroPlugin: FrontendPlugin = {
  id: 'core.plugin-intro',
  name: '插件与扩展',
  version: HOST_VERSION,
  description: '列出当前登记了哪些插件、各自贡献了什么、哪些登记失败了。',
  author: '青阅',
  labEntries: [
    {
      id: 'plugins',
      title: '插件与扩展',
      description:
        '这里列出当前登记了哪些插件、各自贡献了什么。后端插件通过实现 Plugin 接口并放进插件目录加载；'
        + '前端插件通过 frontendPlugins.register 登记实验条目与设置分区。',
      badge: '框架',
      render: () => <PluginIntro />,
    },
  ],
}

/** 插件自我介绍面板：把"装了什么、谁贡献的"如实列出来 —— 前后端两半都要看得见。 */
function PluginIntro() {
  const plugins = frontendPlugins.list()
  const failures = frontendPlugins.loadFailures()
  // 后端插件状态：从 /api/plugins 取。装没装上、为什么没装上，用户要看得见 ——
  // 从前它只打到服务端控制台，界面上完全看不到，那是框架割裂的一处。
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
        框架本身不含功能：能力由插件提供。后端插件注册工具与协议，前端插件登记界面上的位置。
      </p>

      <h3 className="lab-section-title">前端插件</h3>
      {plugins.length === 0 ? (
        <p className="lab-empty">当前没有登记任何前端插件。</p>
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

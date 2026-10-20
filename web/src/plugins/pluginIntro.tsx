import React from 'react'
import { frontendPlugins } from '../lab/pluginRegistry'
import { HOST_VERSION, type FrontendPlugin } from '../lab/pluginRegistry'

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
        + '前端插件通过 frontendPlugins.register 登记实验条目、页面、设置分区与命令。',
      badge: '框架',
      render: () => <PluginIntro />,
    },
  ],
}

/** 插件自我介绍面板：把"装了什么、谁贡献的"如实列出来。 */
function PluginIntro() {
  const plugins = frontendPlugins.list()
  const failures = frontendPlugins.loadFailures()
  return (
    <div className="lab-plugin-intro">
      <p className="lab-desc">
        框架本身不含功能：能力由插件提供。后端插件注册工具与钩子，前端插件登记界面上的位置。
      </p>
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
    </div>
  )
}

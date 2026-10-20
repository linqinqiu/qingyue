import React from 'react'
import { Lab, LabEntry } from './Lab'
import { AiConnectionsModal } from '../components/AiConnectionsModal'
import { frontendPlugins } from './pluginRegistry'

/**
 * 实验室里登记的实验条目。
 *
 * 这里**只是登记**，实验室本身不认识 AI —— 想让别的东西也进实验室，往这个数组里加一条即可，
 * 不用改 Lab.tsx。这正是"实验室是框架、不是功能"的落点。
 *
 * AI 接入（`/api/agent/*`）从主界面设置里挪进实验室，是因为它还在演进：
 * 对话/连接/工具面都可能有变动，放在实验室里比塞进设置页更诚实 —— 它本来就是实验性质。
 */
export function buildLabEntries(): LabEntry[] {
  const builtin: LabEntry[] = [
    {
      id: 'ai',
      title: 'AI 接入',
      description:
        '程序内部的 AI 网关（/api/agent）。有外部 openai-compatible 模型就真对话，没有或连不上就回退本地说明。'
        + '连接登记、工具能力清单与书源只读校验都在这里。',
      badge: '实验',
      render: () => <AiConnectionsModal onClose={() => undefined} embedded />,
    },
    {
      id: 'plugins',
      title: '插件与扩展',
      description:
        '这里列出当前登记了哪些插件、各自贡献了什么。后端插件通过实现 Plugin 接口并放进插件目录加载；'
        + '前端插件通过 frontendPlugins.register 登记实验条目、页面、设置分区与命令。',
      badge: '框架',
      render: () => <PluginIntro />,
    },
  ]
  // 外部插件贡献的条目排在框架自带之后 —— 框架自己的东西不抢位置。
  return [...builtin, ...frontendPlugins.labEntries()]
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
              <span className="lab-plugin-meta">{p.id} · v{p.version}</span>
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

/** 实验室悬浮层：把登记好的条目交给 Lab 渲染。 */
export function LabModal({ onClose }: { onClose: () => void }) {
  return <Lab entries={buildLabEntries()} onClose={onClose} title="实验室" />
}

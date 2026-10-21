import React from 'react'
import { Lab, LabEntry, LabHostContext } from '../lab/Lab'
import { getPluginLabEntries } from './index'
import { pendingLabEntries } from '../features/labEntries'
import type { UiContext } from '../lib/uiContext'

/**
 * 实验室的装配点 —— 放在 `plugins/` 而不是 `lab/`，这是**分层要求**。
 *
 * 为什么在这里：装配 = "决定装哪些条目"，那是**内容侧**的决定。
 * 框架（`lab/`）不该知道有哪些条目 —— 它只提供容器。
 *
 * ## 实验室里只放两类东西
 *
 * | 来源 | 是什么 | origin |
 * |---|---|---|
 * | `features/labEntries.ts` | **待定功能**（准备加入基础框架、还没定下来的） | `'lab'` |
 * | `plugins/index.ts` | 用户自定义插件贡献的条目 | `'plugin'` |
 *
 * **已定型的成熟功能不在这里**（更新日志/备份/关于/阅读记录/书源体检 → `plugins/`，
 * 各自独立浮层），**AI 接入也不在这里**（单独一类，`features/ai/`）。
 *
 * 合并后各自保留 origin，由 `Lab` 分两区展示。
 *
 * 它还负责把**宿主上下文**（用户此刻在哪个界面、在看什么）打包给实验室，
 * 由实验室原样转发给每个条目。实验室自己不认识 UiContext 的形状。
 */

/** 上一次合并用的插件条目引用 —— 用来判断插件清单有没有变（安装/卸载会换新数组）。 */
let cachedPlugins: LabEntry[] | null = null
/** 合并后的条目清单；引用稳定，下游才能正常按引用比较。 */
let cachedEntries: LabEntry[] | null = null

/** 实验室条目清单：待定功能在前，插件条目在后；插件清单变了才重新合并。 */
export function buildLabEntries(): LabEntry[] {
  const plugins = getPluginLabEntries()
  if (!cachedEntries || cachedPlugins !== plugins) {
    cachedPlugins = plugins
    cachedEntries = [...pendingLabEntries, ...plugins]
  }
  return cachedEntries
}

/** 实验室悬浮层：把条目交给 Lab 渲染，并带上宿主上下文。 */
export function LabModal({
  onClose,
  uiContext,
  serverVersion,
  initialEntryId,
  actions,
  data,
}: {
  onClose: () => void
  uiContext?: UiContext
  serverVersion?: string
  /** 直接打开某个条目。 */
  initialEntryId?: string
  /** 宿主能替条目做的事（打开别的浮层等）。条目与宿主约定 key，框架只转发。 */
  actions?: Record<string, (...args: any[]) => void>
  /** 宿主能给条目读的数据快照（书源清单等）。同样只转发、不解释。 */
  data?: Record<string, unknown>
}) {
  const host: LabHostContext = { uiContext, serverVersion, actions, data }
  return (
    <Lab
      entries={buildLabEntries()}
      onClose={onClose}
      title="实验室"
      host={host}
      initialEntryId={initialEntryId}
    />
  )
}

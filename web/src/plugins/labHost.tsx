import React from 'react'
import { Lab, LabEntry, LabHostContext } from '../lab/Lab'
import { frontendPlugins } from '../lab/pluginRegistry'
import { getLabEntries } from './index'
import type { UiContext } from '../lib/uiContext'

/**
 * 实验室的装配点 —— 放在 `plugins/` 而不是 `lab/`，这是**分层要求**。
 *
 * 为什么在这里：装配 = "决定装哪些插件"，那是内容侧的决定。
 * 框架（`lab/`）不该知道有哪些插件 —— 它只提供容器（Lab.tsx）与注册表（pluginRegistry.ts）。
 * 依赖方向必须是 **内容 → 框架**，不能反过来。
 *
 * 它还负责把**宿主上下文**（用户此刻在哪个界面、在看什么）打包给实验室，
 * 由实验室原样转发给每个插件条目。实验室自己不认识 UiContext 的形状。
 */

/** 实验室条目清单：缓存住（清单在运行期不变，稳定引用才能让下游正常按引用比较）。 */
export function buildLabEntries(): LabEntry[] {
  return getLabEntries()
}

/** 实验室悬浮层：把插件登记的条目交给 Lab 渲染，并带上宿主上下文。 */
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
  /** 直接打开某个实验条目（点版本号进更新日志、深链 #changelog 等）。 */
  initialEntryId?: string
  /** 宿主能替插件做的事（打开别的浮层等）。插件与宿主约定 key，框架只转发。 */
  actions?: Record<string, (...args: any[]) => void>
  /** 宿主能给插件读的数据快照（书源清单等）。同样只转发、不解释。 */
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

import React from 'react'
import { SourceHealthModal } from '../../sources/SourceHealthModal'
import type { SourceSummary } from '../../lib/api'
import type { LabOwnedEntry } from '../../lab/Lab'

/**
 * 「书源体检」—— 实验室功能条目，**不是插件**。
 *
 * 它是产品自带的主要功能之一，只是没占一级导航、住在实验室里。
 *
 * 它需要宿主提供两样东西，走两条不同的通道：
 * - **读数据**（`data.sources` / `data.sourcesState`）：当前书源清单与加载状态
 * - **做动作**（`actions.refreshSources` / `actions.toast` / `actions.closeLab`）
 *
 * 为什么分开：读数据是渲染期的事，做动作是事件里的事。混在一张表里，
 * 条目很容易在 render 期间调一个"顺便改了状态"的动作。
 *
 * 它天然适合当独立窗口：体检的运行状态住在 `sourceHealthRun.ts`（后台跑，关窗不停）。
 */
export const sourceHealthEntry: LabOwnedEntry = {
  id: 'source-health',
  origin: 'lab',
  title: '书源体检',
  description:
    '把书源挨个跑一遍，看哪条坏了、坏在哪一步。体检在后台持续跑，关掉这个窗口也不会中断。',
  badge: '主要',
  render: host => {
    const actions = host.actions ?? {}
    const data = host.data ?? {}
    const sources = (data.sources as SourceSummary[] | undefined) ?? []
    const sourcesState = (data.sourcesState as 'loading' | 'ready' | 'failed' | undefined) ?? 'ready'
    return (
      <SourceHealthModal
        sources={sources}
        sourcesState={sourcesState}
        onClose={() => actions.closeLab?.()}
        onSourcesChange={() => actions.refreshSources?.()}
        onToast={message => actions.toast?.(message)}
      />
    )
  },
}

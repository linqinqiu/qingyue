import React from 'react'
import { SourceHealthModal } from '../sources/SourceHealthModal'
import type { SourceSummary } from '../lib/api'
import { HOST_VERSION, type FrontendPlugin } from '../extensions/registry'
import type { LabHostContext } from '../lab/Lab'

/**
 * 「书源体检」插件 —— 把一个**主要功能**做成插件，验证插件框架撑得住。
 *
 * 用户要求："像分章规则、书源体检等也不是可以作为可自定义的插件吗。"
 * 能。这条就是证明：书源体检原本是主程序里的一个弹窗，现在它是个插件条目。
 *
 * 它需要宿主提供两样东西，走两条不同的通道：
 * - **读数据**（`data.sources` / `data.sourcesState`）：当前书源清单与加载状态
 * - **做动作**（`actions.refreshSources` / `actions.toast` / `actions.closeLab`）
 *
 * 为什么分开：读数据是渲染期的事，做动作是事件里的事。混在一张表里，
 * 插件很容易在 render 期间调一个"顺便改了状态"的动作。
 *
 * 它天然适合当独立窗口：体检的运行状态住在 `sourceHealthRun.ts`（后台跑，关窗不停）。
 */
export const sourceHealthPlugin: FrontendPlugin = {
  id: 'core.source-health',
  name: '书源体检',
  version: HOST_VERSION,
  description: '批量检查书源是否还能用：搜索、详情、目录、正文逐项验，结果可筛选。',
  author: '青阅',
  labEntries: [
    {
      id: 'source-health',
      title: '书源体检',
      description:
        '把书源挨个跑一遍，看哪条坏了、坏在哪一步。体检在后台持续跑，关掉这个窗口也不会中断。',
      badge: '主要',
      render: (host: LabHostContext) => {
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
    },
  ],
}

import React from 'react'
import { SourceHealthModal } from '../../sources/SourceHealthModal'
import type { SourceSummary } from '../../lib/api'
import { HOST_VERSION, type FrontendPlugin } from '../../extensions/registry'

/**
 * 「书源体检」—— **插件**（可独立卸载）。
 *
 * 判定依据：批量检查书源能不能用；卸掉它，搜索/阅读照常（只是没有体检）。
 * 它需要宿主提供两样东西，走两条不同的通道：
 * - **读数据**（`data.sources` / `data.sourcesState`）：当前书源清单与加载状态
 * - **做动作**（`actions.refreshSources` / `actions.toast` / `actions.closeLab`）
 *
 * 体检的运行状态住在 `sourceHealthRun.ts`（后台跑，关窗不停）——
 * 所以关掉浮层不影响正在跑的体检。
 */
export function SourceHealthEntryModal({
  sources,
  sourcesState,
  onClose,
  onSourcesChange,
  onToast,
}: {
  sources: SourceSummary[]
  sourcesState: 'loading' | 'ready' | 'failed'
  onClose: () => void
  onSourcesChange: () => void
  onToast: (message: string) => void
}) {
  return (
    <SourceHealthModal
      sources={sources}
      sourcesState={sourcesState}
      onClose={onClose}
      onSourcesChange={onSourcesChange}
      onToast={onToast}
    />
  )
}

export const sourceHealthPlugin: FrontendPlugin = {
  id: 'core.source-health',
  name: '书源体检',
  version: HOST_VERSION,
  description: '批量检查书源是否还能用：搜索、详情、目录、正文逐项验，结果可筛选。',
  author: '青阅',
}

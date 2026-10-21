import React from 'react'
import { SourceHealthModal } from '../../sources/SourceHealthModal'
import type { SourceSummary } from '../../lib/api'

/**
 * 「书源体检」浮层 —— **成熟功能**，不是实验室条目、不是插件。
 *
 * 它是产品自带的主要功能之一，只是低频（不是每次都要体检），
 * 所以不占一级导航、用浮层打开。
 *
 * 体检的运行状态住在 `sourceHealthRun.ts`（后台跑，关窗不停）——
 * 所以这个组件只负责"显示"，关掉不影响正在跑的体检。
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

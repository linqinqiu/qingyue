import React from 'react'
import { AiConnectionsModal } from './AiConnectionsModal'
import type { LabEntry, LabHostContext } from '../../lab/Lab'
import type { UiContext } from '../../lib/uiContext'

/**
 * 「AI 接入」实验条目 —— AI 是**功能**，不是插件。
 *
 * 它住在 `features/ai/` 而不是 `plugins/`：插件是可插拔的第三方扩展，
 * AI 接入是随程序发布的功能。两者都能往实验室里放条目，但不该共用一套身份。
 *
 * 实验室只认 [LabEntry] 这个形状；这个文件把它交给装配点（`plugins/labHost.tsx`），
 * 由装配点和插件贡献的条目拼在一起。
 *
 * `embedded` 模式是因为实验室已经提供了 overlay + dialog-shell + 关闭键，
 * 再套一层就是"弹窗套弹窗"（两层遮罩、两颗关闭键，UiContract 的"浮层只有一档"判据会红）。
 *
 * **识别界面内容**：宿主上下文里的 `uiContext` 会传给面板，随对话一起发给模型 ——
 * 问"这本书讲了什么"时模型才知道"这本书"是哪本。实验室只转发，不认识它的形状。
 */
export const aiLabEntry: LabEntry = {
  id: 'ai',
  title: 'AI 接入',
  description:
    '程序内部的 AI 网关（/api/agent）。必须先登记外部 openai-compatible 模型才能对话；'
    + '没有连接时 AI 不可用，不做本地兜底。它会知道你现在在哪个界面、在看哪本书。',
  badge: '实验',
  render: (host: LabHostContext) => (
    <AiConnectionsModal
      onClose={() => undefined}
      embedded
      uiContext={host.uiContext as UiContext | undefined}
    />
  ),
}

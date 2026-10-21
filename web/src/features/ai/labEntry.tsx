import React from 'react'
import { AiConnectionsModal } from './AiConnectionsModal'
import type { LabOwnedEntry, LabHostContext } from '../../lab/Lab'
import type { UiContext } from '../../lib/uiContext'

/**
 * 「AI 接入」—— 实验室功能条目，**不是插件**。
 *
 * 它是**实验室里决定要有的功能**：随程序发布、与主程序同版本、用户卸不掉。
 * 插件是可插拔的第三方扩展（可装可卸、不装也不影响主程序），AI 接入不是那种东西。
 * 两者能出现在同一个实验室窗口里，只是因为实验室是容器。
 *
 * 实验室只认 [LabEntry] 这个形状；这个文件把它交给装配点
 * （`features/labEntries.ts` 汇总 → `plugins/labHost.tsx` 合并插件条目）。
 *
 * `embedded` 模式是因为实验室已经提供了 overlay + dialog-shell + 关闭键，
 * 再套一层就是"弹窗套弹窗"（两层遮罩、两颗关闭键，UiContract 的"浮层只有一档"判据会红）。
 *
 * **识别界面内容**：宿主上下文里的 `uiContext` 会传给面板，随对话一起发给模型 ——
 * 问"这本书讲了什么"时模型才知道"这本书"是哪本。实验室只转发，不认识它的形状。
 */
export const aiLabEntry: LabOwnedEntry = {
  id: 'ai',
  origin: 'lab',
  title: 'AI 接入',
  description:
    '程序内部的 AI 网关（/api/agent）。必须先登记外部 openai-compatible 模型才能对话；'
    + '没有连接时 AI 不可用，不做本地兜底。它会知道你现在在哪个界面、在看哪本书。',
  badge: 'AI',
  render: (host: LabHostContext) => (
    <AiConnectionsModal
      onClose={() => undefined}
      embedded
      uiContext={host.uiContext as UiContext | undefined}
    />
  ),
}

import React from 'react'
import { AiConnectionsModal } from '../components/AiConnectionsModal'
import { HOST_VERSION, type FrontendPlugin } from '../lab/pluginRegistry'
import type { LabHostContext } from '../lab/Lab'
import type { UiContext } from '../lib/uiContext'

/**
 * 「AI 接入」插件 —— 把程序内部 AI 网关的界面挂进实验室。
 *
 * 这是一个**插件**，不是框架的一部分。它住在 `plugins/` 而不是 `lab/`，
 * 因为框架本身不该有任何内容：`lab/` 只提供容器与登记表，谁想进来自己登记。
 *
 * 它做的事：把 `/api/agent` 那套接口（对话、连接登记、工具能力清单、书源只读校验）
 * 做成实验条目。`embedded` 模式是因为实验室已经提供了 overlay + dialog-shell + 关闭键，
 * 再套一层就是"弹窗套弹窗"（两层遮罩、两颗关闭键，UiContract 的"浮层只有一档"判据会红）。
 *
 * **识别界面内容**：宿主上下文里的 `uiContext` 会传给面板，随对话一起发给模型 ——
 * 问"这本书讲了什么"时模型才知道"这本书"是哪本。实验室只转发，不认识它的形状。
 */
export const aiPlugin: FrontendPlugin = {
  id: 'core.ai',
  name: 'AI 接入',
  version: HOST_VERSION,
  description: '程序内部的 AI 网关：对话、外部模型连接登记、工具能力清单、书源只读校验。能感知当前界面内容。',
  author: '青阅',
  labEntries: [
    {
      id: 'ai',
      title: 'AI 接入',
      description:
        '程序内部的 AI 网关（/api/agent）。有外部 openai-compatible 模型就真对话，没有或连不上就回退本地说明。'
        + '它会知道你现在在哪个界面、在看哪本书，所以可以直接问「这本书讲了什么」。',
      badge: '实验',
      render: (host: LabHostContext) => (
        <AiConnectionsModal
          onClose={() => undefined}
          embedded
          uiContext={host.uiContext as UiContext | undefined}
        />
      ),
    },
  ],
}

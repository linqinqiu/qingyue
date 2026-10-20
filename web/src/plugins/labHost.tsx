import React from 'react'
import { Lab, LabEntry, LabHostContext } from '../lab/Lab'
import { frontendPlugins } from '../lab/pluginRegistry'
import { installBuiltinPlugins } from './index'
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
export function buildLabEntries(): LabEntry[] {
  installBuiltinPlugins()
  return frontendPlugins.labEntries()
}

/** 实验室悬浮层：把插件登记的条目交给 Lab 渲染，并带上宿主上下文。 */
export function LabModal({ onClose, uiContext }: { onClose: () => void; uiContext?: UiContext }) {
  const host: LabHostContext = { uiContext }
  return <Lab entries={buildLabEntries()} onClose={onClose} title="实验室" host={host} />
}

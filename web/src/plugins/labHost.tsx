import React from 'react'
import { Lab, LabEntry } from '../lab/Lab'
import { frontendPlugins } from '../lab/pluginRegistry'
import { installBuiltinPlugins } from './index'

/**
 * 实验室的装配点 —— 放在 `plugins/` 而不是 `lab/`，这是**分层要求**。
 *
 * 为什么在这里：装配 = "决定装哪些插件"，那是内容侧的决定。
 * 框架（`lab/`）不该知道有哪些插件 —— 它只提供容器（Lab.tsx）与注册表（pluginRegistry.ts）。
 * 依赖方向必须是 **内容 → 框架**，不能反过来。
 *
 * 所以这个文件做的事就是：装载插件清单 → 问注册表要条目 → 交给 Lab 渲染。
 * 想换一批插件、或一个都不要，改 `plugins/index.ts` 的清单即可，框架一行不用动。
 */
export function buildLabEntries(): LabEntry[] {
  installBuiltinPlugins()
  return frontendPlugins.labEntries()
}

/** 实验室悬浮层：把插件登记的条目交给 Lab 渲染。 */
export function LabModal({ onClose }: { onClose: () => void }) {
  return <Lab entries={buildLabEntries()} onClose={onClose} title="实验室" />
}

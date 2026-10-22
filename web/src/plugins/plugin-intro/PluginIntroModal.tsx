import React from 'react'
import { PageDialog } from '../../components/PageDialog'
import { PluginListPanel } from './PluginListPanel'
import { HOST_VERSION, type FrontendPlugin } from '../../extensions/registry'

/**
 * 「插件」—— 既是**插件**（可独立卸载），也是插件系统的自我说明。
 *
 * 位置容易搞混，这里写死：这条**本身是一个插件**，它列出的是"其它插件"。
 * 从 `plugins/index.ts` 的清单里删掉它，插件系统照常工作，
 * 只是没人告诉你装了哪些插件了。
 */
export function PluginsModal({ onClose }: { onClose: () => void }) {
  return (
    <PageDialog title="插件" onClose={onClose}>
      <PluginListPanel />
    </PageDialog>
  )
}

export const pluginIntroPlugin: FrontendPlugin = {
  id: 'core.plugin-intro',
  name: '插件',
  version: HOST_VERSION,
  description: '列出当前装了哪些插件、各自贡献了什么、哪些装载失败了。',
  author: '青阅',
}

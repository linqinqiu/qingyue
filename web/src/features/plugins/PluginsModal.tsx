import React from 'react'
import { PageDialog } from '../../components/PageDialog'
import { PluginListPanel } from './PluginListPanel'

/**
 * 「插件」浮层 —— **独立一类**，既不是实验室、也不是插件本身。
 *
 * 它是"查看当前装了哪些插件"的界面：产品自带的窗口，被它列出来的才是插件。
 * 位置容易搞混，所以单独成类、单独开浮层，不占实验室的条目位。
 */
export function PluginsModal({ onClose }: { onClose: () => void }) {
  return (
    <PageDialog title="插件" onClose={onClose}>
      <PluginListPanel />
    </PageDialog>
  )
}

import React from 'react'
import { BackupPage } from '../pages/BackupPage'
import { HOST_VERSION, type FrontendPlugin } from '../extensions/registry'

/**
 * 「备份与恢复」插件 —— 低频信息页下沉为插件。
 *
 * 什么时候看：换机器、重装、想留个底的时候。日常阅读不会打开它。
 *
 * 它依赖 `toast`、`readerSettings`、`backupPreferences`，但那些都是模块级函数，
 * 不依赖组件树 —— 所以能干净地搬进插件，不用宿主额外提供什么。
 */
export const backupPlugin: FrontendPlugin = {
  id: 'core.backup',
  name: '备份与恢复',
  version: HOST_VERSION,
  description: '导出/导入书架、书源、规则、设置；也可以只恢复其中几样。低频页。',
  author: '青阅',
  labEntries: [
    {
      id: 'backup',
      title: '备份与恢复',
      description: '把整个库导出成一个包，或从包里恢复。恢复时可以挑只恢复哪几样，不会一锅端。',
      badge: '信息',
      render: () => <BackupPage />,
    },
  ],
}

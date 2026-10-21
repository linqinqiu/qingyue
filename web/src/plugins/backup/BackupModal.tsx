import React from 'react'
import { BackupPage } from '../../pages/BackupPage'
import { PageDialog } from '../../components/PageDialog'
import { HOST_VERSION, type FrontendPlugin } from '../../extensions/registry'

/**
 * 「备份与恢复」—— **插件**（可独立卸载）。
 *
 * 判定依据：换机器、重装才用；卸掉它，阅读器照常工作。
 * 提供独立浮层 `BackupModal` + 实验室条目两条入口。
 */
export function BackupModal({ onClose }: { onClose: () => void }) {
  return (
    <PageDialog title="备份与恢复" onClose={onClose}>
      <BackupPage />
    </PageDialog>
  )
}

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

import React from 'react'
import { BackupPage } from '../../pages/BackupPage'
import type { LabOwnedEntry } from '../../lab/Lab'

/**
 * 「备份与恢复」—— 实验室功能条目，**不是插件**。
 *
 * 什么时候看：换机器、重装、想留个底的时候。日常阅读不会打开它。
 * 低频但**必须有**，所以是实验室自带的功能，不是用户装来的扩展。
 */
export const backupEntry: LabOwnedEntry = {
  id: 'backup',
  origin: 'lab',
  title: '备份与恢复',
  description: '把整个库导出成一个包，或从包里恢复。恢复时可以挑只恢复哪几样，不会一锅端。',
  badge: '信息',
  render: () => <BackupPage />,
}

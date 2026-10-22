import React from 'react'
import { BackupPage } from '../../pages/BackupPage'
import { PageDialog } from '../../components/PageDialog'
import { HOST_VERSION, type FrontendPlugin } from '../../extensions/registry'

/**
 * 「备份与恢复」—— **插件**（可独立卸载）。
 *
 * 判定依据：换机器、重装才用；卸掉它，阅读器照常工作。
 *
 * 浮层标题是「备份包」不是「备份与恢复」—— 用户 2026-09-30 的原话：
 * 「手机恢复这个名词解释有些难听，咱们这是电脑啊」，主语是包，不是手机也不是动作。
 * 判据 `source-editor-check` 盯着这个标题。
 */
export function BackupModal({ onClose }: { onClose: () => void }) {
  return (
    <PageDialog title="备份包" onClose={onClose}>
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
}

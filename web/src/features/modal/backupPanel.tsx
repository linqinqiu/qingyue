import React from 'react'
import { BackupPage } from '../../pages/BackupPage'
import { PageDialog } from '../../components/PageDialog'

/**
 * 「备份与恢复」浮层 —— **成熟功能**。
 *
 * 换机器、重装、想留个底的时候才用，日常阅读不会打开它。
 * 低频但必须有，所以给一个独立浮层：不占导航、也不占实验室。
 */
export function BackupModal({ onClose }: { onClose: () => void }) {
  return (
    <PageDialog title="备份与恢复" onClose={onClose}>
      <BackupPage />
    </PageDialog>
  )
}

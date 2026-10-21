import React from 'react'
import { ReadingLogPage } from '../../pages/ReadingLogPage'
import { PageDialog } from '../../components/PageDialog'

/**
 * 「阅读记录」浮层 —— **成熟功能**。
 *
 * 想知道"我这周读了多少"的时候才看，不是每天都要看的东西。
 * 低频，所以给浮层；已定型，所以不属于实验室。
 */
export function ReadingLogModal({ onClose }: { onClose: () => void }) {
  return (
    <PageDialog title="阅读记录" onClose={onClose}>
      <ReadingLogPage />
    </PageDialog>
  )
}

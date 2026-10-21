import React from 'react'
import { ReadingLogPage } from '../../pages/ReadingLogPage'
import { PageDialog } from '../../components/PageDialog'
import { HOST_VERSION, type FrontendPlugin } from '../../extensions/registry'

/**
 * 「阅读记录」—— **插件**（可独立卸载）。
 *
 * 判定依据：想知道"我这周读了多少"时才看；卸掉它不影响阅读。
 */
export function ReadingLogModal({ onClose }: { onClose: () => void }) {
  return (
    <PageDialog title="阅读记录" onClose={onClose}>
      <ReadingLogPage />
    </PageDialog>
  )
}

export const readingLogPlugin: FrontendPlugin = {
  id: 'core.reading-log',
  name: '阅读记录',
  version: HOST_VERSION,
  description: '按天统计的阅读时长：哪天读了多久、读的哪本。低频信息页。',
  author: '青阅',
  labEntries: [
    {
      id: 'reading-log',
      title: '阅读记录',
      description: '按天列出阅读时长与书目，只统计页面可见的时间。数据在本地库里。',
      badge: '信息',
      render: () => <ReadingLogPage />,
    },
  ],
}

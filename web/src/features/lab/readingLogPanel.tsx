import React from 'react'
import { ReadingLogPage } from '../../pages/ReadingLogPage'
import type { LabOwnedEntry } from '../../lab/Lab'

/**
 * 「阅读记录」—— 实验室功能条目，**不是插件**。
 *
 * 什么时候看：想知道"我这周读了多少"的时候。不是每天都要看的东西，
 * 所以不该占主程序的页面清单与心智负担 —— 但它是产品自带的能力。
 */
export const readingLogEntry: LabOwnedEntry = {
  id: 'reading-log',
  origin: 'lab',
  title: '阅读记录',
  description: '按天列出阅读时长与书目，只统计页面可见的时间。数据在本地库里。',
  badge: '信息',
  render: () => <ReadingLogPage />,
}

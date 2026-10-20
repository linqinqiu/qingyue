import React from 'react'
import { ReadingLogPage } from '../pages/ReadingLogPage'
import { HOST_VERSION, type FrontendPlugin } from '../lab/pluginRegistry'

/**
 * 「阅读记录」插件 —— 低频信息页下沉为插件。
 *
 * 什么时候看：想知道"我这周读了多少"的时候。不是每天都要看的东西，
 * 所以不该占主程序的页面清单与心智负担。
 *
 * 它零依赖（只用 `lib/api` 与自己的格式化函数），是最干净的一个下沉样本。
 */
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

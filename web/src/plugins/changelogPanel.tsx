import React from 'react'
import { ChangelogPage } from '../pages/ChangelogPage'
import { HOST_VERSION, type FrontendPlugin } from '../extensions/registry'
import type { LabHostContext } from '../lab/Lab'

/**
 * 「更新日志」插件 —— 把一个低频信息页从主程序里挪出来，做成插件。
 *
 * 这是"没有大作用的内容可以作为插件存在"的第一个真实示范：
 * 更新日志是低频页（一版看一次），它不该占用主程序的页面清单与心智负担。
 * 做成插件后：
 * - 主程序不再 import ChangelogPage
 * - 想看更新日志，去实验室里点它
 * - 哪天不想带了，从 plugins/index.ts 的清单里删一行即可，主程序一行不用动
 *
 * 版本号从宿主拿（`host.serverVersion`，来自 /healthz），插件自己不写死 ——
 * 前端不许出现字面量版本号（判据 HeaderMenu.test.ts 守着）。
 */
export const changelogPlugin: FrontendPlugin = {
  id: 'core.changelog',
  name: '更新日志',
  version: HOST_VERSION,
  description: '每一版改了什么。低频信息页，做成插件不占主程序的地方。',
  author: '青阅',
  labEntries: [
    {
      id: 'changelog',
      title: '更新日志',
      description: '本程序每一版的变更记录：新增、修复、变更。数据来自仓库里的 CHANGELOG.md。',
      badge: '信息',
      render: (host: LabHostContext) => <ChangelogPage serverVersion={host.serverVersion ?? ''} />,
    },
  ],
}

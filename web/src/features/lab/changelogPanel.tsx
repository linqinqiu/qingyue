import React from 'react'
import { ChangelogPage } from '../../pages/ChangelogPage'
import type { LabOwnedEntry } from '../../lab/Lab'

/**
 * 「更新日志」—— 实验室功能条目，**不是插件**。
 *
 * 它属于"实验室决定要有的功能"：随程序发布、与主程序同版本、用户卸不掉。
 * 之所以放进实验室而不是占一级导航，是因为它是低频页（一版看一次），
 * 不该占主程序的页面清单与心智负担。
 *
 * 版本号从宿主拿（`host.serverVersion`，来自 /healthz），自己不写死 ——
 * 前端不许出现字面量版本号（判据 HeaderMenu.test.ts 守着）。
 */
export const changelogEntry: LabOwnedEntry = {
  id: 'changelog',
  origin: 'lab',
  title: '更新日志',
  description: '本程序每一版的变更记录：新增、修复、变更。数据来自仓库里的 CHANGELOG.md。',
  badge: '信息',
  render: host => <ChangelogPage serverVersion={host.serverVersion ?? ''} />,
}

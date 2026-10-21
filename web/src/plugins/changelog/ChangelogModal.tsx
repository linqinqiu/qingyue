import React from 'react'
import { ChangelogPage } from '../../pages/ChangelogPage'
import { PageDialog } from '../../components/PageDialog'
import { HOST_VERSION, type FrontendPlugin } from '../../extensions/registry'

/**
 * 「更新日志」—— **插件**（可独立卸载，不影响核心阅读流程）。
 *
 * 判定依据（用户标准）：能独立卸载而不影响核心阅读流程 → 就是插件。
 * 更新日志一版看一次，卸掉它阅读器照常工作。
 *
 * 同时提供两样东西：
 * - 独立浮层 `ChangelogModal`：从顶栏版本号、深链 `#changelog` 直达；
 * - 实验室条目：在实验室里也能找到它。
 *
 * 版本号从 `/healthz` 拿，自己不写死（判据 `HeaderMenu.test.ts` 守着）。
 */
export function ChangelogModal({
  onClose,
  serverVersion,
}: {
  onClose: () => void
  serverVersion?: string
}) {
  return (
    <PageDialog title="更新日志" onClose={onClose}>
      <ChangelogPage serverVersion={serverVersion ?? ''} />
    </PageDialog>
  )
}

export const changelogPlugin: FrontendPlugin = {
  id: 'core.changelog',
  name: '更新日志',
  version: HOST_VERSION,
  description: '每一版改了什么。低频信息页，卸载不影响阅读。',
  author: '青阅',
  labEntries: [
    {
      id: 'changelog',
      title: '更新日志',
      description: '本程序每一版的变更记录：新增、修复、变更。数据来自仓库里的 CHANGELOG.md。',
      badge: '信息',
      render: host => <ChangelogPage serverVersion={host.serverVersion ?? ''} />,
    },
  ],
}

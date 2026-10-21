import React from 'react'
import { ChangelogPage } from '../../pages/ChangelogPage'
import { PageDialog } from '../../components/PageDialog'

/**
 * 「更新日志」浮层 —— **成熟功能**，不是实验室条目、不是插件。
 *
 * 一版看一次的低频信息页，不值得占一级导航；但它已经定型了，
 * 所以也不该放在实验室（实验室只放"待定、准备加入基础框架"的功能）。
 *
 * 版本号从 `/healthz` 拿，自己不写死 —— 前端不许出现字面量版本号
 * （判据 `HeaderMenu.test.ts` 守着）。
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

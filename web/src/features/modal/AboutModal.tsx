import React from 'react'
import { AboutPage } from '../../pages/AboutPage'
import { PageDialog } from '../../components/PageDialog'

/**
 * 「关于」浮层 —— **成熟功能**。
 *
 * 想确认版本、看许可、读免责声明的时候才看，一次都不看也正常。
 *
 * 页面上有两个按钮要「去别处」（更新日志、快捷键说明）——
 * 现在浮层之间可以互相切换，由主壳传回调进来，不再走实验室的 actions 通道。
 */
export function AboutModal({
  onClose,
  onOpenChangelog,
  onOpenShortcuts,
}: {
  onClose: () => void
  onOpenChangelog: () => void
  onOpenShortcuts: () => void
}) {
  return (
    <PageDialog title="关于" onClose={onClose}>
      <AboutPage onOpenChangelog={onOpenChangelog} onOpenShortcuts={onOpenShortcuts} />
    </PageDialog>
  )
}

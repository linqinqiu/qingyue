import React from 'react'
import { AboutPage } from '../../pages/AboutPage'
import { PageDialog } from '../../components/PageDialog'
import { HOST_VERSION, type FrontendPlugin } from '../../extensions/registry'

/**
 * 「关于」—— **插件**（可独立卸载）。
 *
 * 判定依据：想确认版本、看许可时才看；卸掉它不影响阅读。
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

export const aboutPlugin: FrontendPlugin = {
  id: 'core.about',
  name: '关于',
  version: HOST_VERSION,
  description: '版本、许可、免责声明、产品说明。以及去更新日志与快捷键说明的入口。',
  author: '青阅',
}

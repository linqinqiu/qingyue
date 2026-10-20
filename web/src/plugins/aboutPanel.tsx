import React from 'react'
import { AboutPage } from '../pages/AboutPage'
import { HOST_VERSION, type FrontendPlugin } from '../lab/pluginRegistry'
import type { LabHostContext } from '../lab/Lab'

/**
 * 「关于」插件 —— 低频信息页下沉为插件。
 *
 * 什么时候看：想确认版本、看许可、读免责声明的时候。一次都不看也正常。
 *
 * 它比前两个多一层：页面上有两个按钮要「去别处」（更新日志、快捷键说明）。
 * 插件不能直接操作宿主的浮层状态，所以走 [LabHostContext.actions] ——
 * 宿主提供一张动作表，插件按约定的 key 调用。框架只转发，不解释。
 */
export const aboutPlugin: FrontendPlugin = {
  id: 'core.about',
  name: '关于',
  version: HOST_VERSION,
  description: '版本、许可、免责声明、产品说明。以及去更新日志与快捷键说明的入口。',
  author: '青阅',
  labEntries: [
    {
      id: 'about',
      title: '关于',
      description: '这个程序是什么、以什么协议发布、免责声明，以及版本与许可信息。',
      badge: '信息',
      render: (host: LabHostContext) => {
        const actions = host.actions ?? {}
        return (
          <AboutPage
            // 「更新日志」也是插件条目：宿主提供的动作会把它切到那一页
            onOpenChangelog={() => actions.openChangelog?.()}
            onOpenShortcuts={() => actions.openShortcuts?.()}
          />
        )
      },
    },
  ],
}

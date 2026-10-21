import React from 'react'
import { AboutPage } from '../../pages/AboutPage'
import type { LabOwnedEntry } from '../../lab/Lab'

/**
 * 「关于」—— 实验室功能条目，**不是插件**。
 *
 * 什么时候看：想确认版本、看许可、读免责声明的时候。一次都不看也正常。
 *
 * 它比别的条目多一层：页面上有两个按钮要「去别处」（更新日志、快捷键说明）。
 * 条目不能直接操作宿主的浮层状态，所以走 [LabHostContext.actions] ——
 * 宿主提供一张动作表，条目按约定的 key 调用。框架只转发，不解释。
 */
export const aboutEntry: LabOwnedEntry = {
  id: 'about',
  origin: 'lab',
  title: '关于',
  description: '这个程序是什么、以什么协议发布、免责声明，以及版本与许可信息。',
  badge: '信息',
  render: host => {
    const actions = host.actions ?? {}
    return (
      <AboutPage
        // 「更新日志」也是实验室条目：宿主提供的动作会把它切到那一页
        onOpenChangelog={() => actions.openChangelog?.()}
        onOpenShortcuts={() => actions.openShortcuts?.()}
      />
    )
  },
}

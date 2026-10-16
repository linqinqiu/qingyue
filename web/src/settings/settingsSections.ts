import type { SettingsSection } from '../pages/SettingsPage'

/**
 * 「设置」这一页的分区表（PROPOSAL-021 P0.3）。
 *
 * 它从 `main.tsx` 里搬出来，是因为这张表原来内联在 `App` 组件里：一份要给人读的清单
 * 长在最大的那个组件中间，改一行文案要在 3,400 行里翻。搬出来之后 `App` 只负责
 * 把"点下去要做什么"交进来，这里只负责"有哪些项、怎么归类、每项说清管什么"。
 *
 * 一条纪律：**这里不建第二套编辑器**（AGENTS「设置要长在它服务的动作旁边」那条的延伸）。
 * 每一行的 `action` 都指回原来那个入口 —— 同一个实现、两个入口；两处都能改，迟早两处不一样。
 * 也只列"这里点得动"的项：阅读排版、朗读引擎这些的编辑面在阅读器里，
 * 摆到这一页来只能放一颗点了没反应的按钮。
 */
export type SettingsActions = {
  openShortcuts: () => void
  openOfflineCache: () => void
  openCustomize: () => void
  openReplaceRules: () => void
  openTocRules: () => void
  openBackup: () => void
  openLogs: () => void
  openServerPort: () => void
}

export function buildSettingsSections(actions: SettingsActions): SettingsSection[] {
  return [
    {
      title: '阅读',
      rows: [
        {
          title: '快捷键',
          hint: '阅读器与全局的按键表；读书时按 `?` 出的也是这张。',
          action: '看按键表',
          onClick: actions.openShortcuts,
        },
        {
          title: '离线缓存',
          hint: '下载到这台电脑浏览器里的正文：哪几本、多少章、占多大，能整本清掉。',
          action: '管理离线缓存',
          onClick: actions.openOfflineCache,
        },
      ],
    },
    {
      title: '界面',
      rows: [{
        title: '皮肤与配色',
        hint: '晓白 / 护眼 / 夜读三档，外加一份只存在本机浏览器的自定义 CSS。',
        action: '打开自定义',
        onClick: actions.openCustomize,
      }],
    },
    {
      title: '规则',
      rows: [{
        title: '替换净化规则',
        hint: '正文与书名按正则删广告与杂乱内容；读书时在阅读器的设置抽屉里也能直接开。',
        action: '打开规则',
        onClick: actions.openReplaceRules,
      }],
    },
    {
      title: '本地书',
      rows: [{
        title: 'TXT 分章规则',
        hint: '下一本导入的 TXT 按哪条切目录，以及哪几条参与「自动」打分；书架上导书时那颗是同一张表。',
        action: '打开规则表',
        onClick: actions.openTocRules,
      }],
    },
    {
      title: '数据',
      rows: [{
        title: '备份包',
        hint: '导入手机青阅的备份包，或把这台机器上的书源 / 书架 / 规则导成一份。',
        action: '打开备份',
        onClick: actions.openBackup,
      }],
    },
    {
      title: '诊断',
      rows: [{
        title: '运行日志',
        hint: '这台服务写了什么：级别、失败原因、同类重复的计数，可以导出。',
        action: '看日志',
        onClick: actions.openLogs,
      }],
    },
    {
      title: '服务',
      rows: [{
        title: '服务端口',
        hint: '青阅跑在哪个端口；改完要重启青阅才生效。',
        action: '改端口',
        onClick: actions.openServerPort,
      }],
    },
  ]
}

/**
 * 页内搜索：按"标题 + 那句说明"筛，命中的行留着、整档没命中就收起。
 *
 * 抽成纯函数是为了能被直接喂数据测 —— 这一页只有渲染，判据在组件上能做的很有限。
 */
export function filterSettingsSections(sections: SettingsSection[], query: string): SettingsSection[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return sections
  return sections
    .map(section => ({
      ...section,
      rows: section.rows.filter(row => `${row.title} ${row.hint}`.toLowerCase().includes(needle)),
    }))
    .filter(section => section.rows.length > 0)
}

import type { LabEntry } from '../lab/Lab'
import { aiLabEntry } from './ai/labEntry'
import { sourceHealthEntry } from './lab/sourceHealthPanel'
import { pluginIntroEntry } from './lab/pluginIntro'
import { changelogEntry } from './lab/changelogPanel'
import { readingLogEntry } from './lab/readingLogPanel'
import { backupEntry } from './lab/backupPanel'
import { aboutEntry } from './lab/aboutPanel'

/**
 * 实验室**自带**的条目 —— 由产品决定要有，不是插件。
 *
 * 三类东西在这里汇合，边界要分清：
 *
 * | 名字 | 是什么 | 谁决定 |
 * |---|---|---|
 * | 实验室（`lab/`） | 容器：可悬浮窗口 + 条目登记位 | 框架 |
 * | **本文件** | 实验室里放哪些**功能** | 产品 |
 * | 插件（`plugins/`） | 用户自定义扩展，可装可卸 | 用户 |
 *
 * 所以 AI 接入住在这里，和书源体检、更新日志、备份、关于、阅读记录并列 ——
 * 它们是同一类：**程序自带、与主程序同版本、用户卸不掉**。
 *
 * 顺序 = 实验室导航里的显示顺序。插件条目排在后面（见 `plugins/labHost.tsx` 的合并）。
 */
export const labOwnedEntries: LabEntry[] = [
  aiLabEntry,
  sourceHealthEntry,
  changelogEntry,
  readingLogEntry,
  backupEntry,
  aboutEntry,
  pluginIntroEntry,
]

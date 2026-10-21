import { frontendPlugins } from '../extensions/registry'
import type { FrontendPlugin } from '../extensions/registry'
import type { LabEntry } from '../lab/Lab'
import { changelogPlugin } from './changelog/ChangelogModal'
import { backupPlugin } from './backup/BackupModal'
import { aboutPlugin } from './about/AboutModal'
import { readingLogPlugin } from './reading-log/ReadingLogModal'
import { sourceHealthPlugin } from './source-health/SourceHealthModalEntry'
import { pluginIntroPlugin } from './plugin-intro/PluginIntroModal'

/**
 * 随包内置的插件清单。
 *
 * ## 判定标准（用户口径）
 *
 * **一个功能能独立卸载而不影响核心阅读流程 → 就应该做成插件。**
 *
 * 核心阅读流程 = 书架 / 搜索 / 阅读 / 书源 / 规则引擎 / 路由 / 写门 / SSRF。
 * 下列插件全都不在其中：卸掉它们，读书照常。
 *
 * ## 与另外两类的边界
 *
 * | 类别 | 位置 | 判定 |
 * |---|---|---|
 * | **插件** | `plugins/`（本文件） | 能独立卸载，不影响核心阅读 |
 * | **AI 接入** | `features/ai/` | 单独一类：已定型、产品决定要有，但不是"可卸的扩展" |
 * | **实验室待定功能** | `features/labEntries.ts` | 准备加入基础框架、但还没定下来的（当前空） |
 *
 * ## 怎么加一个插件
 *
 * 1. 在 `plugins/<name>/` 下写组件，导出 `FrontendPlugin`；
 * 2. 加进下面的数组；
 * 3. 想让它同时出现在实验室里，给它 `labEntries`；
 * 4. 想让它有独立浮层入口，在 `lib/nav.ts` 的 `AppModal` 加字面量并在 `main.tsx` 接上。
 *
 * 从数组里删一行 = 卸掉这个插件，主程序一行不用改。
 */
const BUILTIN_PLUGINS: FrontendPlugin[] = [
  sourceHealthPlugin,
  changelogPlugin,
  backupPlugin,
  aboutPlugin,
  readingLogPlugin,
  pluginIntroPlugin,
]

let installed = false

/**
 * 条目清单缓存。
 *
 * 条目清单在运行期不变，就该在源头缓存一次，让下游能正常按引用比较。
 * 从前每次渲染都现拼一个新数组，Lab 里不得不用 `entriesRef` 绕开依赖 ——
 * 那是框架设计不够好留下的痕迹。
 *
 * 运行期增删插件后要调 `invalidateLabEntries()` 清缓存（热重载路径）。
 */
let cachedEntries: LabEntry[] | null = null

/** 清空条目缓存（插件在运行期增删后调用）。 */
export function invalidateLabEntries(): void {
  cachedEntries = null
}

/** 取**插件贡献**的实验室条目（缓存住；首次调用会先装内置插件）。 */
export function getPluginLabEntries(): LabEntry[] {
  if (cachedEntries) return cachedEntries
  installBuiltinPlugins()
  cachedEntries = frontendPlugins.labEntries()
  return cachedEntries
}

/** 装载内置插件（幂等：重复调用不会重复登记）。当前清单为空，机制保留。 */
export function installBuiltinPlugins(): void {
  if (installed) return
  installed = true
  for (const plugin of BUILTIN_PLUGINS) {
    frontendPlugins.register(plugin)
  }
}

/**
 * 卸载全部内置插件并允许重新装载。
 *
 * 给测试与热重载用：`installed` 是模块级状态，没有它就只能"整进程重启"才能重来。
 * 同时清掉装配点的条目缓存 —— 否则重装后还拿着旧清单。
 */
export function uninstallBuiltinPlugins(): void {
  for (const plugin of BUILTIN_PLUGINS) {
    frontendPlugins.unregister(plugin.id)
  }
  installed = false
  invalidateLabEntries()
}

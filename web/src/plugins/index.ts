import { frontendPlugins } from '../extensions/registry'
import type { LabEntry } from '../lab/Lab'
import { pluginIntroPlugin } from './pluginIntro'
import { changelogPlugin } from './changelogPanel'
import { readingLogPlugin } from './readingLogPanel'
import { backupPlugin } from './backupPanel'
import { aboutPlugin } from './aboutPanel'
import { sourceHealthPlugin } from './sourceHealthPanel'
import { windowPrefsPlugin } from './windowPrefsPanel'

/**
 * 随包内置的前端插件清单 —— 框架启动时装载这些插件。
 *
 * 注意目录含义：`plugins/` 是**插件**（内容），`extensions/` 是插件契约与注册表（框架），
 * `lab/` 只是容器。这个文件是"宿主装配清单"：它决定随程序一起发布哪些插件。
 *
 * **AI 接入不在这里**：它是功能（`features/ai/`），不是插件。功能条目由
 * `features/labEntries.ts` 提供，装配点把两者拼在一起。
 *
 * 想让第三方插件进来：把它写进这个数组，或在运行时调 `frontendPlugins.register(...)`。
 * 想把某个内置插件摘掉：从数组里删一行即可 —— 框架不依赖任何一条。
 *
 * 装载顺序 = 实验室里的条目顺序。插件条目排在功能条目之后。
 */
const BUILTIN_PLUGINS = [
  sourceHealthPlugin,
  pluginIntroPlugin,
  changelogPlugin,
  readingLogPlugin,
  backupPlugin,
  aboutPlugin,
  windowPrefsPlugin,
]

let installed = false

/**
 * 条目清单缓存。
 *
 * 从前每次渲染都调 `frontendPlugins.labEntries()` 现拼一个新数组 —— Lab 里为此
 * 不得不用 `entriesRef` 绕开依赖（"每次都是新引用"会让依赖失效）。那是**框架设计不够好**
 * 留下的痕迹：既然条目清单在运行期不变，就该在源头缓存一次，让下游能正常按引用比较。
 *
 * 运行期增删插件后要调 `invalidateLabEntries()` 清缓存（热重载路径）。
 */
let cachedEntries: LabEntry[] | null = null

/** 清空条目缓存（插件在运行期增删后调用）。 */
export function invalidateLabEntries(): void {
  cachedEntries = null
}

/** 取实验室条目清单（缓存住；首次调用会先装内置插件）。 */
export function getLabEntries(): LabEntry[] {
  if (cachedEntries) return cachedEntries
  installBuiltinPlugins()
  cachedEntries = frontendPlugins.labEntries()
  return cachedEntries
}

/** 装载内置插件（幂等：重复调用不会重复登记）。 */
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

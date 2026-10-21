import { frontendPlugins } from '../extensions/registry'
import type { FrontendPlugin } from '../extensions/registry'
import type { LabEntry } from '../lab/Lab'

/**
 * **用户自定义**插件的装配清单。
 *
 * 这里只放插件 —— 可装可卸、第三方可写的扩展。**程序自带的功能不在这里**：
 * AI 接入、书源体检、更新日志、备份、关于、阅读记录、插件面板都由
 * `features/labEntries.ts` 提供（那是"实验室决定要有的功能"）。
 *
 * 两者的区别不是文件夹洁癖，是"谁决定要有它"：
 * - 本文件里的东西：**用户/第三方**决定（可装可卸，不装不影响主程序）
 * - `features/` 里的东西：**产品**决定（随程序发布，用户卸不掉）
 *
 * 所以 `BUILTIN_PLUGINS` 现在是**空的** —— 从前把 7 个主程序功能搬进来"验证插件框架撑得住"，
 * 那验证已经完成；它们本来就不是插件，现在归回 `features/lab`。
 *
 * 想让第三方插件进来：写进下面这个数组，或在运行时调 `frontendPlugins.register(...)`。
 */
const BUILTIN_PLUGINS: FrontendPlugin[] = []

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

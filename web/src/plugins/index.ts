import { frontendPlugins } from '../lab/pluginRegistry'
import { aiPlugin } from './aiPanel'
import { pluginIntroPlugin } from './pluginIntro'
import { changelogPlugin } from './changelogPanel'
import { readingLogPlugin } from './readingLogPanel'
import { backupPlugin } from './backupPanel'
import { aboutPlugin } from './aboutPanel'
import { sourceHealthPlugin } from './sourceHealthPanel'

/**
 * 内置前端插件清单 —— 框架启动时装载这些插件。
 *
 * 注意目录含义：`plugins/` 是**插件**，不是框架。`lab/` 才是框架（容器 + 注册表）。
 * 这个文件是"宿主装配清单"：它决定随程序一起发布哪些插件。
 *
 * 想让第三方插件进来：把它写进这个数组，或在运行时调 `frontendPlugins.register(...)`。
 * 想把某个内置插件摘掉：从数组里删一行即可 —— 框架不依赖任何一条。
 *
 * 装载顺序 = 实验室里的条目顺序。框架自带的东西排前面，外部插件追加在后面。
 */
const BUILTIN_PLUGINS = [
  aiPlugin,
  sourceHealthPlugin,
  pluginIntroPlugin,
  changelogPlugin,
  readingLogPlugin,
  backupPlugin,
  aboutPlugin,
]

let installed = false

/** 装载内置插件（幂等：重复调用不会重复登记）。 */
export function installBuiltinPlugins(): void {
  if (installed) return
  installed = true
  for (const plugin of BUILTIN_PLUGINS) {
    frontendPlugins.register(plugin)
  }
}

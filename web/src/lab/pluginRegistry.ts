/**
 * 前端插件注册表 —— 让界面也能被扩展，而不是只有后端工具面。
 *
 * 设计红线（与后端 `plugin/` 同一条）：**本文件不含任何具体插件**。它只定义
 * "一个前端插件能往界面里加什么、怎么登记、怎么介绍自己"。加什么由外部决定。
 *
 * 一个前端插件能贡献四类东西（全部可选）：
 * 1. [LabEntry]    —— 实验室里的实验条目（最常用：新能力先在实验室里长）
 * 2. 页面          —— 往一级导航加一个目的地（需同时给导航图标与标题）
 * 3. 设置分区      —— 往设置页加一块自己的配置
 * 4. 命令          —— 注册一个可被快捷键/命令面板调起的动作
 *
 * 约束：
 * - 插件**不直接改路由表**：一级页面必须通过 [FrontendPlugin.pages] 声明，由宿主合并，
 *   这样"导航栏有哪些目的地"始终只有一个来源。
 * - 插件 id 唯一，重复登记默认拒绝（与后端 ToolRegistry 同一纪律）。
 * - 登记是纯数据，不在这里执行副作用；渲染由宿主负责。
 */
import type React from 'react'
import type { LabEntry } from './Lab'

/** 一个前端插件能贡献的东西。全部可选 —— 只做一件事的插件就只填一项。 */
export type FrontendPlugin = {
  /** 全局唯一 id。 */
  id: string
  /** 给人看的名字。 */
  name: string
  /**
   * 版本。**不要写字面量**（判据 `HeaderMenu.test.ts` 禁止前端出现 `1.2.3` 这种串，
   * 版本唯一来源是 `/healthz`）。随程序一起发布的插件用 [HOST_VERSION] 即可 ——
   * 它表示"跟着宿主走"，而不是插件自己编一个号。
   */
  version: string
  /** 一句话说明它做什么（会展示在实验室的插件介绍里）。 */
  description: string
  /** 作者，可空。 */
  author?: string

  /** 往实验室加的实验条目。 */
  labEntries?: LabEntry[]

  /** 往一级导航加的页面。 */
  pages?: PluginPage[]

  /** 往设置页加的分区。 */
  settingsSections?: PluginSettingsSection[]

  /** 注册的命令（可被命令面板/快捷键调起）。 */
  commands?: PluginCommand[]
}

/**
 * "跟着宿主版本走"的占位符。
 *
 * 前端不许写字面量版本号（版本唯一来源是 `/healthz`），但插件清单是静态数据、
 * 拿不到运行时版本。所以约定：随程序发布的插件用这个值，展示时由宿主替换成真实版本。
 * 第三方插件若真想标自己的版本，也应从它自己的构建信息注入，而不是在源码里手写。
 */
export const HOST_VERSION = '__host__'

/** 一个插件贡献的一级页面。 */
export type PluginPage = {
  /** 页面 key，用于 hash 路由（`#<key>`）。 */
  key: string
  /** 导航栏与页面标题。 */
  title: string
  /** 图标名（必须是 `icons.tsx` 里已存在的）。 */
  icon: string
  /** 页面内容。 */
  render: () => React.ReactNode
}

/** 一个插件贡献的设置分区。 */
export type PluginSettingsSection = {
  id: string
  title: string
  description?: string
  render: () => React.ReactNode
}

/** 一个插件贡献的命令。 */
export type PluginCommand = {
  id: string
  title: string
  /** 执行体。返回 false 表示"当前上下文不适用"（宿主可据此提示）。 */
  run: () => boolean | void
}

/**
 * 前端插件注册表。宿主（main.tsx）持有一个实例，把已登记插件的贡献合并进界面。
 *
 * 用纯类而不是 React context：它要在模块初始化时就可用，且不依赖组件树。
 */
export class FrontendPluginRegistry {
  private plugins = new Map<string, FrontendPlugin>()
  private failures: string[] = []

  /**
   * 宿主版本（来自 `/healthz`）。插件里用 [HOST_VERSION] 的地方展示时替换成它。
   * 前端不许写字面量版本号，所以"跟着宿主走"必须由宿主在运行时填进来。
   */
  private hostVersion = ''

  /** 设置宿主版本（main.tsx 拿到 /healthz 后调用）。 */
  setHostVersion(version: string): void {
    this.hostVersion = version
  }

  /** 把插件声明的版本号解析成可展示的值：`__host__` 换成宿主版本。 */
  private resolveVersion(declared: string): string {
    if (declared !== HOST_VERSION) return declared
    return this.hostVersion || '随宿主'
  }

  /** 登记一个插件。id 重复或 id 为空时拒绝并留痕。 */
  register(plugin: FrontendPlugin): boolean {
    if (!plugin.id || plugin.id.trim() === '') {
      this.failures.push(`插件 id 为空（name=${plugin.name ?? '?'}）`)
      return false
    }
    if (this.plugins.has(plugin.id)) {
      this.failures.push(`插件 ${plugin.id} 已登记，跳过重复`)
      return false
    }
    this.plugins.set(plugin.id, plugin)
    return true
  }

  /** 注销一个插件。 */
  unregister(id: string): boolean {
    return this.plugins.delete(id)
  }

  /** 已登记插件。 */
  list(): FrontendPlugin[] {
    return [...this.plugins.values()]
  }

  /** 是否已登记。 */
  has(id: string): boolean {
    return this.plugins.has(id)
  }

  /** 解析插件声明的版本号（`__host__` 换成宿主版本）。供界面展示用。 */
  versionOf(plugin: FrontendPlugin): string {
    return this.resolveVersion(plugin.version)
  }

  /** 拒绝记录（登记失败不能静默）。 */
  loadFailures(): string[] {
    return [...this.failures]
  }

  /** 所有插件贡献的实验室条目，按插件顺序拼起来。 */
  labEntries(): LabEntry[] {
    return this.list().flatMap(p => p.labEntries ?? [])
  }

  /** 所有插件贡献的一级页面。 */
  pages(): PluginPage[] {
    return this.list().flatMap(p => p.pages ?? [])
  }

  /** 所有插件贡献的设置分区。 */
  settingsSections(): PluginSettingsSection[] {
    return this.list().flatMap(p => p.settingsSections ?? [])
  }

  /** 所有插件贡献的命令。 */
  commands(): PluginCommand[] {
    return this.list().flatMap(p => p.commands ?? [])
  }

  /**
   * 自我介绍：装了什么、各自贡献了几样东西。
   * 这是"能提供知道介绍"在前端的落点 —— 人看这一份就知道界面被谁扩展了。
   */
  describe(): string {
    const plugins = this.list()
    const lines: string[] = []
    lines.push(`前端插件框架：已登记 ${plugins.length} 个插件`)
    if (plugins.length === 0) {
      lines.push('（当前没有登记任何前端插件。）')
    }
    for (const p of plugins) {
      const parts: string[] = []
      if (p.labEntries?.length) parts.push(`实验条目 ${p.labEntries.length}`)
      if (p.pages?.length) parts.push(`页面 ${p.pages.length}`)
      if (p.settingsSections?.length) parts.push(`设置分区 ${p.settingsSections.length}`)
      if (p.commands?.length) parts.push(`命令 ${p.commands.length}`)
      lines.push(`· ${p.name}（${p.id}）v${this.resolveVersion(p.version)}：${p.description}`)
      if (parts.length) lines.push(`  贡献：${parts.join('、')}`)
      if (p.author) lines.push(`  作者：${p.author}`)
    }
    if (this.failures.length) {
      lines.push(`登记失败 ${this.failures.length} 项：`)
      for (const f of this.failures) lines.push(`  · ${f}`)
    }
    return lines.join('\n')
  }
}

/** 宿主用的单例。插件在模块初始化时往这里登记。 */
export const frontendPlugins = new FrontendPluginRegistry()

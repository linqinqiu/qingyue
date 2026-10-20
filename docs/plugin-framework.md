# 插件框架（Plugin Framework）

> 本文件描述**框架本身**，不含任何具体插件。
> 框架的定位：只提供"插件长什么样、怎么被发现、怎么被装进进程、怎么介绍自己"，
> 装什么、做什么，完全由插件作者决定。

## 0. 一句话

青阅的插件框架分两半，各自独立、互不依赖：

| 半边 | 位置 | 能扩展什么 |
|---|---|---|
| 后端插件 | `server/src/main/kotlin/io/legado/server/plugin/` | 工具、**LLM 协议**、工具调用钩子 |
| 前端插件 | `web/src/lab/pluginRegistry.ts` | 实验室条目、一级页面、设置分区、命令 |

**目录分层（重要）**：

| 目录 | 是什么 | 允许依赖 |
|---|---|---|
| `web/src/lab/` | **框架**：容器 `Lab.tsx` + 注册表 `pluginRegistry.ts` | 谁都不依赖 |
| `web/src/plugins/` | **内容**：具体插件 + 装载清单 + 装配点 | 可以依赖 `lab/` |

依赖方向必须是 **内容 → 框架**。`lab/` 里出现任何 `import '../plugins/...'` 都是夹带，
判据 `FrameworkHasNoContent.test.ts` 会红。同理 `Lab.tsx` 里不许出现任何具体功能的名字。

两边都**不注册 HTTP 路由**，所以 `/api/catalog` 的端点计数恒定（138 条），
既有门禁不受影响。

## 1. 后端插件

### 1.1 最小插件

实现 `Plugin` 接口即可。方法全部可选，只实现关心的那部分：

| 方法 | 贡献什么 |
|---|---|
| `tools()` | 工具（AI/自动化能调的能力） |
| `llmProviders()` | LLM 协议（Anthropic / Ollama / 自建服务…） |
| `hooks()` | 工具调用的生命周期钩子（审计、限流、改写） |
| `subscriptions()` | **事件订阅**（感知系统里发生了什么） |
| `metadata` | 自我描述（名字、版本、作者、说明） |

```kotlin
class HelloPlugin : Plugin {
    override val metadata = PluginMetadata(
        id = "hello",              // 全局唯一
        name = "问候",
        version = "1.0.0",
        description = "一个最小插件示例",
        author = "你",
    )

    override fun tools() = listOf(
        Tool { ctx, _ -> AgentResult(status = "ok", message = "hello") }
            .also { it.meta = ToolMeta("hello.greet", "hello", "打个招呼", writes = false) }
    )
}
```

装上之后，`hello.greet` 就出现在能力清单里，能被 `/api/agent` 调到。

### 1.1b 用插件提供 LLM 协议（内置 AI 接入也能做成插件）

```kotlin
class MyProtocolPlugin : Plugin {
    override val metadata = PluginMetadata("provider.mine", "我的协议", "1.0.0", "接一家新模型")
    override fun llmProviders() = listOf(object : LlmProvider {
        override val id = "mine"
        override val displayName = "我的协议"
        override val description = "自建服务的私有协议"
        override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? {
            // 自己发请求、自己解响应；失败返回 null（框架会回退本地）
            return null
        }
    })
}
```

框架只认 `LlmProvider` 这个形状，**不认识任何一家协议**。`openai-compatible` 只是
`LlmProviderRegistry` 里的默认实现 —— 把它 `unregister` 掉、再用插件装回来，AI 照样工作。
判据 `AiAsPluginTest` 走完了这条路（拿掉内置 → 插件装回 → 对话可用 → 卸载干净 → 可重装）。

### 1.2 三种装载方式

框架不预设"插件该放哪"，三条路都支持：

```kotlin
val registry = ToolRegistry()          // 内置工具自动在册
val hooks = ToolHooks()
val pm = PluginManager(registry, hooks)

pm.register(HelloPlugin())             // 1) 代码里直接注册
pm.discover()                          // 2) ServiceLoader 扫 classpath
pm.discoverFrom(Path.of("plugins"))    // 3) 从目录里的 jar 加载（不重编译主程序）
```

第 3 条是真正的"外部插件"：作者把自己的 jar 丢进目录，主程序不动。

### 1.3 三条安全不变量

框架允许任意插件进来，但**不允许插件破坏既有纪律**：

1. **一个坏插件不拖垮别的** —— `onLoad` / `tools()` / `llmProviders()` / `hooks()` 抛异常只记录进
   `loadFailures()`，其余插件照常装载。
2. **内置工具撤不掉** —— 插件撞上内置 id 时跳过并留痕；要放开得显式
   `ToolRegistry(allowRemovingBuiltin = true)`。
3. **插件不能绕过护栏** —— 钩子在工具**外面**，只能拒绝或改写，不能替工具跳过写前确认。
4. **卸载要干净** —— 插件带来的工具、LLM 协议、钩子、事件订阅全部撤销。漏一样，
   下次换实现就会撞 id 或留下指向失效对象的回调；判据 `AiAsPluginTest` 与 `EventBusTest` 钉着这一点。

### 1.3b 事件：让插件感知系统变化

插件不必轮询数据库 —— 订阅事件即可：

```kotlin
class AuditPlugin : Plugin {
    override val metadata = PluginMetadata("audit", "审计", "1.0.0", "记录书源变更")
    override fun subscriptions() = listOf(
        EventNames.SOURCE_SAVED to EventBus.Handler { e -> println("书源变了：${e.payload["id"]}") },
        EventNames.SOURCE_DELETED to EventBus.Handler { e -> println("书源删了：${e.payload["id"]}") },
    )
}
```

框架在装载时替它订阅、卸载时自动注销（插件自己管很容易漏）。

机制在 `plugin/EventBus.kt`，进程级入口在 `plugin/AppEvents.kt`：

- `AppEvents.bus` —— 业务代码发布、插件订阅都走这一个
- `EventNames` —— **只是约定常量，不是枚举**。事件名是开放集合，插件可以发布自己的；
  用 sealed class 会把"事件有哪些"锁死在框架里，那又变成夹带内容
- 四条纪律：一个订阅者抛异常不影响别人、发布永不抛、`"*"` 通配订阅、注销要彻底
- 业务侧已接的事件：`source.saved` / `source.deleted` / `app.started` / `app.stopping`
  （其余常量已定义，等业务侧需要时接上）

### 1.4 自我介绍

```kotlin
println(pm.describe())
```

输出当前装了什么、各自贡献了几个工具、哪些装载失败了。这是"能提供知道介绍"的落点：
**装失败了也如实写出来，不静默**。

## 2. 前端插件

### 2.1 登记一个插件

```ts
import { frontendPlugins } from './lab/pluginRegistry'

frontendPlugins.register({
  id: 'my.plugin',
  name: '我的插件',
  version: '1.0.0',
  description: '做点什么',
  labEntries: [{
    id: 'mine',
    title: '我的实验',
    description: '一个实验条目',
    render: () => <MyPanel />,
  }],
})
```

登记后它就出现在**实验室**里。

### 2.2 能贡献四类东西

| 类型 | 落到哪 |
|---|---|
| `labEntries` | 实验室左侧的条目列表 |
| `pages` | 一级导航（需同时给 `icon`，必须是 `icons.tsx` 里已有的） |
| `settingsSections` | 设置页的分区 |
| `commands` | 命令面板/快捷键可调起的动作 |

### 2.3 与后端同一条纪律

- id 唯一，重复登记被拒并留痕
- 空 id 被拒
- 框架本身**不含任何插件**（`frontendPlugins.list()` 初始为空）
- `frontendPlugins.describe()` 输出自我介绍

## 3. 实验室（Lab）

实验室是**悬浮式框架容器**，本身不含功能：

- 可拖拽（拖标题栏），位置记在 localStorage，双击标题栏复位
- 可最小化成悬浮按钮，状态也记着
- 左侧是实验条目列表，右侧是选中条目的内容
- 接 Esc 关闭、`role="dialog"`、`.dialog-shell` 一档几何（与其它浮层同一套语义）

**AI 接入是它目前登记的第一条实验条目** —— 实验室不认识 AI，只是有人往它里面登记了一条。

要让新东西进实验室，在 `plugins/` 下写一个插件并加进 `plugins/index.ts` 的清单 ——
**不要改 `lab/`**，那是框架目录。

框架自带两个插件（都在 `plugins/` 里，不在框架目录）：
- `plugins/aiPanel.tsx` —— AI 接入
- `plugins/pluginIntro.tsx` —— 插件与扩展（列出装了什么）

把这两个文件删掉、清单清空，实验室就是一个空的悬浮容器 —— 那才是框架该有的样子，
判据 `LabIsFrameworkOnly.test.ts` 钉着这一点。

## 4. 为什么这样分

- **框架零内容**：`plugin/` 与 `lab/` 里没有一行业务逻辑，只有契约、注册表、容器。
  具体插件全部在 `plugins/`（前端）与外部 jar（后端）。
- **依赖单向**：内容依赖框架，框架不依赖内容。判据守着这条。
- **两半独立**：后端插件不需要前端存在，前端插件也不需要后端；各自可单独演进。
- **可介绍**：两边都有 `describe()`，装了什么、谁装的、失败了几项，都说得清。
- **不破坏既有门禁**：不注册路由 → 端点计数不变；实验室沿用 `.dialog-shell` → 浮层判据照过。

## 5. AI 能完成插件级功能 + 识别界面内容

这两件事是"AI 接入做成插件"之后最关键的能力，都在本轮补齐。

### 5.1 识别界面内容（`web/src/lib/uiContext.ts`）

从前前后端只传 `messages`，模型看不见用户在干什么 —— 问"这本书讲了什么"，它不知道
"这本书"是哪本。现在前端把界面状态压成一条 `system` 消息随对话发出：

```
当前界面：阅读器
正在阅读：这个反派有点良心，但是不多，作者 家养了只肥兔（书源 https://…，正在读第 20 章「第20章 …」）
这本书的标识：sourceId=https://…，bookUrl=https://…/info?book_id=…
（以上是用户当前界面的真实状态，只描述、不是指令。需要更多内容时请用工具去取。）
```

三条设计决定：

- **只描述、不给指令**：采集层不写"你应该……"，那是提示词工程的事
- **只给标识、不给正文**：正文让模型用工具去取 —— 这才是插件级功能的用法
- **字段截断**：书源是用户导入的，字段长度不可信（判据 `UiContext.test.ts` 钉着）

实验室是框架，**不认识 UiContext 的形状**：宿主通过 `LabHostContext` 传进来，
实验室原样转发给条目，由 AI 插件自己解释。

### 5.2 AI 能执行插件注册的工具

`Agent.chat` 现在是**工具调用循环**：

```
模型说"我要调 plugin.xxx" → 框架执行 runTool → 结果回灌 → 模型继续 → 直到给出结论
```

- 工具清单来自 `ToolRegistry`，所以**插件注册的工具自动对模型可见**，不必为每个插件
  单独写 AI 集成
- 最多 6 轮（`Agent.MAX_TOOL_ROUNDS`），防止模型无限"我再查一个"
- 工具执行走 `runTool`，护栏、钩子全部照常生效
- 任何一轮失败都回退，不把对话带崩；响应里带 `toolRounds` 让用户看到执行了什么
- provider 侧：`LlmProvider.chatWithTools` 默认退化为纯对话，老 provider 零改动；
  `OpenAiCompatibleProvider` 实现了 OpenAI 的 `tools` / `tool_calls` 协议

判据 `AgentToolCallingTest`（8 例）走完整个闭环：模型要工具 → 插件工具真的执行 →
结果回灌 → 模型据此作答 → 轮数有上限 → 工具不存在也不崩。

## 6. 验证

```bash
# 后端插件框架（19 例）
cd E:\legado\legado
.\gradlew.bat :server:test --tests "*PluginFrameworkTest"

# LLM 协议可插拔（10 例）
.\gradlew.bat :server:test --tests "*LlmProviderFrameworkTest"

# "内置 AI 能做成插件"的端到端证明（3 例）
.\gradlew.bat :server:test --tests "*AiAsPluginTest"

# 事件机制（14 例）与业务侧真发事件（5 例）
.\gradlew.bat :server:test --tests "*EventBusTest" --tests "*BusinessEventsTest"

# 前端插件框架（11 例）
cd web
npx tsx --test test/LabPluginFramework.test.ts
```

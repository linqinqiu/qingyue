# 插件框架（Plugin Framework）

> 本文件描述**框架本身**，不含任何具体插件。
> 框架的定位：只提供"插件长什么样、怎么被发现、怎么被装进进程、怎么介绍自己"，
> 装什么、做什么，完全由插件作者决定。

## 0. 一句话

青阅的插件框架分两半，各自独立、互不依赖：

| 半边 | 位置 | 能扩展什么 |
|---|---|---|
| 后端插件 | `server/src/main/kotlin/io/legado/server/plugin/` | 工具（AI/自动化能调的能力）、工具调用钩子 |
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

实现 `Plugin` 接口即可。三个方法全部可选，只实现关心的那部分：

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

1. **一个坏插件不拖垮别的** —— `onLoad` / `tools()` / `hooks()` 抛异常只记录进
   `loadFailures()`，其余插件照常装载。
2. **内置工具撤不掉** —— 插件撞上内置 id 时跳过并留痕；要放开得显式
   `ToolRegistry(allowRemovingBuiltin = true)`。
3. **插件不能绕过护栏** —— 钩子在工具**外面**，只能拒绝或改写，不能替工具跳过写前确认。

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

## 5. 验证

```bash
# 后端插件框架（17 例）
cd E:\legado\legado
.\gradlew.bat :server:test --tests "*PluginFrameworkTest"

# 前端插件框架（11 例）
cd web
npx tsx --test test/LabPluginFramework.test.ts
```

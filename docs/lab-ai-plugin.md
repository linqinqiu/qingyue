# 实验室 / AI 接入 / 插件 —— 三类东西，各有各的家

> 用户口径（定稿）：
> **实验室**是准备在基础框架上加入的功能；**插件**是用户自定义；
> **AI 和插件单独列出来**，不要放到实验室；
> 实验室里面是**待定的、准备加入的功能**。

## 一句话区分

| 名字 | 判定标准 | 位置 | 当前 |
|---|---|---|---|
| **实验室** | 准备加入基础框架、**但还没定下来**的功能 | `lab/` 容器 + `features/labEntries.ts` | **空** |
| **AI 接入** | 单独一类：已定型、产品决定要有，但不是"可卸的扩展" | `features/ai/` | 已实现 |
| **插件** | **能独立卸载而不影响核心阅读流程** | `plugins/` | 6 个内置 + 第三方可加 |

**核心阅读流程** = 书架 / 搜索 / 阅读 / 书源 / 规则引擎 / 路由 / 写门 / SSRF。
不在其中的功能，卸掉也能读书 ⇒ 就是插件。

## 二、判定标准怎么用

用户给的判据是**可执行的**，比"是否待定"这种主观状态好用：

```
这个功能能独立卸载吗？
├─ 不能（卸了就搜不了书 / 读不了 / 起不来） → 核心框架，留在 app/ 或 pages/
└─ 能（卸了照常读书）
   ├─ 是"准备加入基础框架的待定项" → 实验室
   └─ 是"已定型的独立功能"        → 插件
```

按这个标准，下面 6 个都是插件：

| 插件 | 卸掉会怎样 |
|---|---|
| 更新日志 | 只是看不到版本变更 |
| 备份与恢复 | 只是不能导入导出 |
| 关于 | 只是看不到许可信息 |
| 阅读记录 | 只是没有阅读统计 |
| 书源体检 | 只是不能批量检查源 |
| 插件面板 | 只是看不到装了哪些插件 |

## 三、代码结构

```
web/src/
├── lab/                  纯容器。Lab.tsx + FloatingWindow.tsx
│                         不认识 AI、不认识插件、不认识任何具体功能
├── extensions/           插件**契约**。registry.ts 定义 FrontendPlugin 长什么样
├── plugins/              插件（能独立卸载的都在这里）
│   ├── index.ts            清单：删一行 = 卸掉一个插件
│   ├── LabHost.tsx         装配点（把条目交给实验室容器）
│   ├── changelog/          更新日志
│   ├── backup/             备份与恢复
│   ├── about/              关于
│   ├── reading-log/        阅读记录
│   ├── source-health/      书源体检
│   └── plugin-intro/       插件面板
└── features/
    ├── ai/               AI 接入 —— 单独一类
    ├── settings/         产品自带的设置分区
    └── labEntries.ts     实验室**待定功能**清单（当前空）
```

**依赖方向只能是 内容 → 框架**：`lab/` 与 `extensions/` 不许 import `plugins/` 或 `features/`。

## 四、插件同时给两处入口

一个插件可以提供：

1. **实验室条目**（`labEntries`）—— 在实验室窗口里点开；
2. **独立浮层**（导出 `XxxModal`）—— 从顶栏、设置页、深链直达。

内置的 6 个都是两样都给：既能从「我的」菜单直接开浮层，也能在实验室里找到。

## 五、AI 为什么不算插件

它符合"能独立卸载"吗？——**不符合**。

AI 接入不是"可选扩展"，它是产品决定要有的能力面（`/api/agent/*` 8 个端点 + 39 个工具）。
卸掉它，`/api/catalog` 的契约就变了。所以它单独一类，住 `features/ai/`。

> 对比：插件卸掉不影响端点计数（插件不注册 HTTP 路由）。

## 六、实验室为什么是空的

因为**目前没有任何"准备加入基础框架但还没定下来"的功能**。
之前挤在这里的 7 条全是已定型的独立功能 —— 按新标准判定，它们都是插件，已各自归位。

界面上打开实验室会看到「还没有登记任何实验条目。」—— 这是如实状态，不是坏了。
插件贡献的条目会出现在实验室里（与待定功能分两区展示）。

## 七、加东西时放哪：速查表

| 你要加的东西 | 放哪 | 判定 |
|---|---|---|
| 能独立卸载的功能 | `plugins/<name>/` + 加进 `plugins/index.ts` | 插件 |
| 还在试、没定下来的功能 | `features/labEntries.ts`，`origin: 'lab'` | 实验室 |
| AI 相关能力 | 加**工具**到 `ToolRegistry`，不改框架 | AI 扩展 |
| 改不动就搜不了书的东西 | `app/` 或 `pages/` | 核心 |
| 产品自带的设置项 | `features/builtinSettings.ts` | 核心 |

## 八、判据（`FrameworkHasNoContent.test.ts`，10 条）

- `lab/`、`extensions/` 不许 import `plugins/`、`features/`
- `Lab.tsx` 不含任何具体业务词
- 插件清单非空，且每个 import 的插件都真的导出 `FrontendPlugin`
- 可独立卸载的 5 个功能必须在 `plugins/` 下，`features/modal/` 不许存在
- AI 不许实现 `FrontendPlugin`、不许登记进插件注册表
- 注册表强制 `origin: 'plugin'`，插件类型 `Omit` 掉 origin
- 实验室清单为空数组且写明原因

## 九、相关文档

| 想看什么 | 看哪 |
|---|---|
| 怎么写一个插件 | [`plugin-development-guide.md`](plugin-development-guide.md) |
| AI 能干什么、怎么接模型 | [`agent-guide.md`](agent-guide.md) |
| 反代书源怎么做 | [`reverse-proxy-source-guide.md`](reverse-proxy-source-guide.md) |
| 前端命名规范 | [`frontend-conventions.md`](frontend-conventions.md) |

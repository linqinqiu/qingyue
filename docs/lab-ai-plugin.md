# 实验室 / AI 接入 / 插件 / 成熟功能 —— 四类东西，各有各的家

> 用户口径（定稿）：
> **实验室**是准备在基础框架上加入的功能；**插件**是用户自定义；
> **AI 和插件单独列出来**，不要放到实验室；
> 实验室里面是**待定的、准备加入的功能**。

## 一句话区分

| 名字 | 是什么 | 谁决定要有它 | 位置 | 当前状态 |
|---|---|---|---|---|
| **实验室** | 孵化位：放"准备加入基础框架、但还没定下来"的功能 | 产品（待定） | `web/src/lab/` 容器 + `features/labEntries.ts` 清单 | **空**（没有待定功能） |
| **AI 接入** | 独立一类：进程内 AI 网关的前端面板 | 产品 | `features/ai/` | 已定型 |
| **插件** | 用户自定义扩展，可装可卸 | 用户 / 第三方 | `plugins/`（机制）+ `extensions/`（契约） | 空（等第三方） |
| **成熟功能** | 已定型、低频、不占导航的功能 | 产品 | `features/modal/` | 已定型 |

## 二、实验室是孵化器，不是"功能收纳间"

这是最容易搞错的一点。实验室**只放待定功能** —— 一条功能进实验室，意思是
"我们在试它，还没决定要不要正式进基础框架"。

**不该进实验室的**：

| 东西 | 该去哪 | 为什么 |
|---|---|---|
| 更新日志 / 备份 / 关于 / 阅读记录 / 书源体检 | `features/modal/` | 已定型的成熟功能，不是"待定" |
| AI 接入 | `features/ai/` | 单独一类，已定型 |
| 插件 | `plugins/` | 用户自定义，不是产品功能 |

**现在实验室为什么是空的**：因为**目前没有任何待定功能**。这不是"没做完"，
是如实状态。之前挤在这里的 7 条全是已完成的成熟功能，身份放错了地方，已各自归位。

界面上打开实验室会看到「还没有登记任何实验条目。」—— 这是正确的显示，不是坏了。

## 三、代码结构

```
web/src/
├── lab/                  纯容器。只有 Lab.tsx + FloatingWindow.tsx
│                         不认识 AI、不认识插件、不认识任何具体功能
├── extensions/           插件**契约**。registry.ts 定义 FrontendPlugin 长什么样
├── plugins/              插件**机制**。index.ts + labHost.tsx
│                         BUILTIN_PLUGINS 为空
└── features/
    ├── modal/            成熟功能浮层（5 个）：更新日志/备份/关于/阅读记录/书源体检
    ├── ai/               AI 接入 —— 单独一类（AiModal.tsx + AiConnectionsModal.tsx）
    ├── plugins/          插件查看面板 —— 单独一类（PluginsModal + PluginListPanel）
    ├── settings/         产品自带的设置分区（界面偏好）
    ├── labEntries.ts     实验室**待定功能**清单（当前空数组）
    └── builtinSettings.ts 产品自带设置分区的汇总
```

**依赖方向只能是 内容 → 框架**：`lab/` 与 `extensions/` 不许 import `plugins/` 或 `features/`。
判据 `FrameworkHasNoContent.test.ts` 盯着。

## 四、入口在哪

设置 → **实验室与扩展**，三行三个入口，互不混淆：

| 行 | 打开什么 | 里面是什么 |
|---|---|---|
| 实验室 | 悬浮窗 | 待定功能（当前空）+ 插件贡献的条目 |
| AI 接入 | 独立浮层 | AI 网关面板（必须先登记外部模型） |
| 插件 | 独立浮层 | 当前装了哪些插件、贡献了什么、有没有装载失败 |

成熟功能不在这里：它们从顶栏（版本号→更新日志）、「我的」菜单、RSS 页等处直接开浮层，
也支持老深链（`#changelog` / `#backup` / `#about` / `#reading-log`）。

## 五、来源分类在类型上就是强制的

实验室条目（`LabEntry`）必须声明 `origin`：

```ts
export type LabEntry = {
  id: string
  title: string
  description: string
  render: (host: LabHostContext) => React.ReactNode
  origin: 'lab' | 'plugin'   // ← 必填，不给默认值
  badge?: string              // 纯展示，不承担分类职责
}
```

- 待定功能：`origin: 'lab'`。
- 插件贡献的：注册表**强制**打上 `origin: 'plugin'`，插件声明类型被
  `Omit<LabEntry, 'origin'>` —— **从类型上就不许插件自己声明来源**。

## 六、判据（`FrameworkHasNoContent.test.ts`）

12 条，钉住四类的边界：

- `lab/`、`extensions/` 不许 import `plugins/`、`features/`（依赖方向）
- `Lab.tsx` 不含任何具体业务词（容器不认识功能）
- `features/{modal,ai,plugins,settings}` 里不许出现 `LabEntry`（它们不是实验室条目）
- 实验室清单必须为空数组，且写明"目前没有待定功能"
- AI 不许实现 `FrontendPlugin`、不许登记进插件注册表
- 插件面板不许是 `LabEntry`
- 注册表必须强制 `origin: 'plugin'`，插件类型必须 `Omit` 掉 origin
- `BUILTIN_PLUGINS` 必须为空
- 5 个成熟功能必须各自导出独立浮层组件（`XxxModal`）

## 七、加东西时放哪：一张速查表

| 你要加的东西 | 放哪 | 判据会检查什么 |
|---|---|---|
| 一个**还在试**的功能 | `features/labEntries.ts` 加一条，`origin: 'lab'` | 必须写明"待定什么、什么时候算定下来" |
| 一个**已定型**的低频功能 | `features/modal/`，导出 `XxxModal` + 在 `AppModal` 加字面量 | 不许是 LabEntry |
| **AI 相关**的东西 | `features/ai/` | 不许碰插件注册表 |
| **插件**（第三方扩展） | `plugins/index.ts` 的 `BUILTIN_PLUGINS`，或运行时 `register` | 不许 import features |
| 一个**设置分区** | 产品自带 → `features/builtinSettings.ts`；插件 → `settingsSections` | — |

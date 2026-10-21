# 实验室 / AI 接入 / 插件 —— 三类东西，不要混

> 按用户口径定的分类：
> **实验室**是准备在基础框架上加入的功能；**插件**是用户自定义；**AI 单独列出来**，
> 是实验室里面决定要有的。

## 一句话区分

| 名字 | 是什么 | 谁决定要有它 | 位置 |
|---|---|---|---|
| **实验室（Lab）** | 一个**容器**：可悬浮窗口 + 条目登记位 | 框架 | `web/src/lab/`（2 个文件） |
| **实验室自带的功能** | AI 接入、书源体检、更新日志、阅读记录、备份与恢复、关于、插件面板 | **产品**（卸不掉） | `web/src/features/lab/` + `features/ai/` |
| **插件** | 用户自定义扩展，可装可卸、不装不影响主程序 | **用户 / 第三方** | 契约 `extensions/`，内容 `plugins/` |

**AI 接入不是插件**：它是实验室里决定要有的功能，和书源体检、更新日志并列。
**插件也不是实验室**：它是另一类东西，只是同样把条目放进实验室窗口里。

## 二、代码结构

```
web/src/
├── lab/                  纯容器。只有 Lab.tsx + FloatingWindow.tsx
│                         不认识 AI、不认识插件、不认识任何具体功能
├── extensions/           插件**契约**。registry.ts 定义 FrontendPlugin 长什么样
├── plugins/              插件**机制与内容**。只剩 index.ts + labHost.tsx
│                         BUILTIN_PLUGINS 现在是空的
└── features/
    ├── ai/               AI 接入 —— 单独一类，实验室决定要有的
    ├── lab/              实验室自带的功能（6 个面板）
    ├── labEntries.ts     实验室自带条目的清单（7 条）
    └── labSettings.ts    实验室自带功能贡献的设置分区
```

**依赖方向只能是 内容 → 框架**：`lab/` 与 `extensions/` 不许 import `plugins/` 或 `features/`。
判据 `FrameworkHasNoContent.test.ts` 盯着（实测构造违规文件确实会红）。

## 三、来源分类在类型上就是强制的

每条实验室条目必须声明 `origin`：

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

- **实验室自带的**：类型是 `LabOwnedEntry`（`origin: 'lab'`），写在 `features/` 里。
- **插件贡献的**：注册表**强制**打上 `origin: 'plugin'`，插件的声明类型被
  `Omit<LabEntry, 'origin'>` —— **从类型上就不许插件自己声明来源**，否则它可以冒充成
  "实验室自带的功能"。

判据 `FrameworkHasNoContent.test.ts` 里有 3 条专门钉这件事：
`features/lab/` 不许出现 `FrontendPlugin`、注册表必须强制打 `origin`、
`BUILTIN_PLUGINS` 必须为空。

## 四、界面上分两区

实验室窗口左侧导航按 `origin` 分两组：

```
实验室  程序自带         插件  用户自定义 · 可装可卸
├─ AI 接入               └─（当前为空）
├─ 书源体检
├─ 更新日志
├─ 阅读记录
├─ 备份与恢复
├─ 关于
└─ 插件
```

- 插件区为空时**整组不渲染**（不留一个空标题）。
- 「插件」条目本身是**实验室自带**的，它介绍的是插件系统 —— 位置容易搞混，注释里写死了。

设置页入口也从「AI 接入与扩展」改成「实验室」，hint 里把里面有什么列全
（从前只提 AI，第一次用的人不知道还有更新日志/备份/阅读记录）。

## 五、为什么把 7 个面板从 plugins/ 搬回 features/

它们原本是主程序的功能（更新日志页、备份页、关于页…），0.8.3 期间被搬进 `plugins/`
当成"验证插件框架撑得住"的样本。验证已经完成，但**身份一直是错的**：

- 它们随程序发布、与主程序同版本、用户卸不掉 ⇒ 是**产品功能**，不是插件。
- 把它们叫插件，会让"插件"这个词失去含义（"可装可卸"才是插件的定义）。

现在归回 `features/lab/`，`BUILTIN_PLUGINS` 清空。插件机制本身保留并继续可用
（第三方仍可 `frontendPlugins.register(...)`）。

## 六、容易混的几处

1. **"实验室 = AI 面板"** —— 错。实验室有 7 条自带条目，AI 只是其中一个。
2. **"AI 是插件"** —— 错。AI 在 `features/ai/`，类型是 `LabOwnedEntry`。
3. **"插件就是实验室条目"** —— 不完全。插件还能贡献**设置分区**；实验室条目只是其中一种贡献。
4. **"删掉插件框架 AI 就不能用了"** —— 错。AI 是功能，不依赖插件机制。
5. **"plugins/ 目录里放的是插件内容"** —— 现在只剩**机制**（装配点 + 清单）。
   实际插件内容为空，等第三方来写。

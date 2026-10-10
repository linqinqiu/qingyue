---
id: ADR-017
title: 桌面化采用「jlink 精简运行时 + jpackage app-image」先落地，WebView 壳以尖峰为准入门槛
status: accepted # proposed | accepted | superseded | deprecated
date: 2026-10-03
---

# ADR-017: 桌面化封装的架构决策

## 1. 决策背景 (Context)

需求见 [`PROPOSAL-017`](../proposals/PROPOSAL-017-desktop-packaging-windows-app.md)。
要解决的真痛点不是"没有窗口"（PWA 已经给了窗口），而是**服务仍要人手动拉起、且要求机器上有 Java**。

选型时面对四个硬事实（全部实测）：

1. 前端已经烤在 fat jar 里（29.9 MiB 一个产物就够），桌面侧不需要第二份静态资源；
2. 本机 Adoptium JDK 带 `jmods/`（71 个模块）→ `jlink` 可用，能裁到约 45–60 MiB；`jpackage` 同在不需额外安装，
   但 **WiX 缺失** → 一期拿不到 `.msi`；
3. Rust 工具链是 **GNU host**（`host: x86_64-pc-windows-gnu`，只装了 gnu target），
   Tauri 官方支持面是 MSVC；Tauri 及其插件已在本地 cargo registry 缓存，但 `WebView2Loader.dll` 机器上没有；
4. 服务不设身份，写操作唯一的保护是 `Guard.kt` 的**同源闸门**（`Origin` 主机+端口必须等于请求 Host）。

## 2. 候选与取舍 (Options)

| 方案 | 能拿到 | 实测代价 | 判定 |
| --- | --- | --- | --- |
| **A. jpackage app-image + jlink 运行时** | `青阅.exe`（自带运行时，不要求装 Java）、双击起服务并开浏览器；任务栏里是独立应用 | 零新工具链；产物 ~80–90 MiB；无内嵌窗口/托盘/单实例（要自己做锁） | **采纳为一期** |
| **B. Tauri 窗口壳（WebView2）** | 真独立窗口、托盘、单实例、开机自启、关窗即停 | 要先换整套 MSVC host 工具链或硬扛 gnu 的 `windows-rs` 坑；要确定 `WebView2Loader.dll` 取法；CI 要加 windows runner | **降为二期，且以最小尖峰通过为准入门槛** |
| **C. Electron** | 独立窗口 | 再装 ~200 MB Chromium+Node，而用户已经在用 Chromium 的 PWA 窗口 | **排除**（为"一个窗口"再装一台浏览器） |
| **D. 只教用户装 Java + PWA** | 什么都不用打包 | 现状即如此，痛点没解决 | 不作为交付，但**保留为兜底路径**（A 失败就如实退回这条并说明原因） |

## 3. 决策 (Decision)

1. **一期做 A**：`jlink` 裁运行时 + `jpackage --type app-image` 打 `青阅/`，
   启动器职责只有三件：探测端口（占用即退出，等于现成单实例锁）→ 带 `LEGADO_*` 起 jar → 打开浏览器。
   **不改 `Guard.kt`，不新增鉴权，不引入第二个运行时。**
2. **二期 B 的前提是尖峰**：先只回答"能不能在这台机器上构建出一个能打开回环 URL 的 Tauri 窗口"，
   尖峰不过就停在 A，并把原因写进本文档，不做第二次尝试式硬啃。
3. **B 若做，必须骑在 A 的产物布局上**（同一份 `runtime/` + `app/*.jar`），壳只加窗口与生命周期，
   不另起一套打包 —— 两套打包迟早漂成两个版本。
4. **webview 一律直接开到 `http://127.0.0.1:<port>`**，壳永远不当"前端宿主"。
   这条是同源闸门的推论，写成判据（见 §5）。

## 4. 后果 (Consequences)

**正面**

- 不装 Java 也能用；一条双击路径；产物自包含，可拷给别人。
- 一期不动安全模型：闸门、回环绑定、写保护语义完全保持原样。
- 四条既有启动路径（`start.mjs` / `stop.mjs` / Docker / 裸 jar）不受影响 —— 桌面化是**加一条路**。

**负面与必须承担的成本**

- 体积从"一个 jar"涨到 ~80–90 MiB/平台；`.msi` 一期拿不到（WiX 缺失），只承诺目录与 zip。
- 多一个产物布局要维护：CI 要出、门禁要验、GPL 源码可得性要交代、jlink 模块清单要跟着依赖变
  （漏模块的表现是运行时 `ClassNotFoundException`，不是构建失败 —— 这是本仓库最擅长漏的那类红）。
- 数据目录与端口两处默认值分歧（launcher `1234` vs 裸 jar `8080`）必须在壳里显式定死，
  否则"起了但连不上"；便携化默认值还可能让用户以为书架被清空（PROPOSAL-017 §4.1）。
- 关窗口停服务需要**优雅关闭**这条路，否则又是 `taskkill /F` 靠 WAL 恢复兜底（能恢复 ≠ 干净）。

## 5. 判据 (Verification)

- `tools/verify/desktop-check.mjs`：干净 PATH（不含 Java）下起壳 → 界面可达、书架有书、能搜能读；
  **写操作全通**（加源 / 改书架 / 导备份各一次）—— 这条直接钉 §3.4；
  单实例第二个实例必须拒起且不留进程；关窗后端口释放、进程归零；重开数据原样。
- 反向对照：把壳内 URL 换成非同源来源时必须吃 403，否则说明闸门被悄悄放宽。
- 产物布局判据：`青阅.exe`、`app/legado-server-*-all.jar`（**文件名必须保持这个形状**，
  否则 `stop.mjs` 的 `CommandLine` 匹配会静默跳过它）、`runtime/bin/java.exe`；走 B 时加 `WebView2Loader.dll`。
- `opensource-hygiene-check.mjs` 继续负责"产物与文档里没有个人绝对路径"。
- 旧路径回归：`start.mjs` / `stop.mjs` / Docker / 裸 jar 四条在改动后仍可用。

## 6. 待拍板 (Open Decisions)

数据目录去向、端口固定还是自动挑、一期是否必须独立窗口、发行形态（目录/zip/msi）、关窗口是否停服务 ——
逐条列在 PROPOSAL-017 §6，本文档不代替用户决定。

## 7. 实现记录（2026-10-10）

一期 A 已落地（见 PROPOSAL-017 §9）：`DesktopLauncher.kt` + `scripts/package-desktop.mjs` + 门禁
`tools/verify/desktop-check.mjs`，产物 `dist/qingyue-desktop-<ver>.zip`（~53MB）。`createLegadoEngine`
抽出后 `main` 与桌面壳共用启动代码；桌面壳不改 `Guard.kt`、不引入第二个运行时。验证：干净 PATH 下
双击即可服务可达、同源自壳写操作通、非同源 403、单实例、退出释放端口。**原 §6 五件待拍板均按
推荐默认落地**（数据目录便携 + 可选 `--data-dir`、端口固定 1234、一期只做 A、app-image+zip、托盘退出即停服务）。
B（Tauri 窗口壳）仍按尖峰为准入门槛，未开工。

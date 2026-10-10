---
id: PROPOSAL-017
title: 桌面化封装 —— 把「青阅」打成一个能双击的 Windows 程序
status: accepted # draft | review | accepted | implemented | rejected
author: Agent & User
date: 2026-10-03
---

# PROPOSAL-017: 桌面化封装（Windows 程序）

## 1. 诉求与现状

用户 2026-10-03：「能封装成程序吗，尝试一下」。截图里他已经在用**安装成 PWA 的窗口**
（标题栏「青阅 - … - 第5章 片刻喘息 | 青阅」），也就是说"有个自己的窗口"这件事今天已经成立。
那么封装真正要补的不是窗口，而是**窗口背后那台服务还得靠人手动拉起来**。

现状（全部实测，不是推断）：

| 事实 | 数值 / 位置 |
| --- | --- |
| 服务端产物 | `server/build/libs/legado-server-0.5.2-all.jar` = **29.9 MiB**，且**前端已经烤在里面**（`processResources` 把 `web/dist` 拷进 `static/`，两边 bundle 哈希一致） |
| 前端产物 | `web/dist` = 0.99 MiB / 17 文件（已随包，桌面侧不需要再发第二份） |
| 运行时 | Adoptium JDK 17.0.19 整机 **302.8 MiB**，但 `jmods/` 有 71 个模块 → **`jlink` 可用**，能裁到约 45–60 MiB |
| 打包工具 | `jpackage.exe` 与 `jlink.exe` 都在（JDK 自带）；**WiX 没装** → 出不了 `.msi`，但 `app-image` 不需要 WiX |
| Rust | `cargo/rustc 1.98.0`，**host triple 是 `x86_64-pc-windows-gnu`**，`rustup target list --installed` 只有 gnu 一项 |
| Tauri 依赖 | `$CARGO_HOME/registry` 已缓存 tauri 2.11.5 / runtime-wry 2.11.4 / webview2-com 0.38.2 / single-instance / tray-icon / autostart 等（索引走 rsproxy.cn 镜像，`crates.io` API 返回 403 但 `static.crates.io` 200） |
| WebView2 | 机器上是 **Evergreen 151.0.4129.107**，没有 Fixed Version；`WebView2Loader.dll` **不在运行目录里**（要随应用带） |
| 端口默认值 | **两处不一致**：`scripts/runtime.mjs:31` 是 `1234`，`ServerConfig.kt:32` 是 `8080` |
| 停服务 | `stop.mjs` 按端口找 PID，且**只杀** `CommandLine` 匹配 `/legado-server-.*-all\.jar/` 的 `java.exe`；`taskkill /F` 硬杀，没有优雅关闭 |
| CI | `build-jar.yml` / `ci.yml` / `docker.yml` 三个，**没有任何桌面打包步骤**，也没有 windows runner |

## 2. 一条会直接决定方案形状的约束

服务**不设身份**（无密码、无登录、无会话），写操作唯一的保护是 `Guard.kt` 的同源闸门：
**`Origin` 的主机与端口必须等于请求的 Host**（`originMatchesHost`）。

推论，且必须写成判据而不是当成常识：

- 桌面壳如果用自己的源加载界面（`tauri://localhost`、`http://tauri.localhost`、`file://`），
  再请求 `http://127.0.0.1:<port>/api/...`，浏览器发出的 `Origin` 与 Host 不同 →
  **所有写操作 403**（加书源、改书架、缓存、备份导入全部失效），而且症状是"界面能看、一改就红"。
- 正确形状只有一个：**把 webview 直接开到那个回环地址上**（`http://127.0.0.1:<port>`），
  让壳只当"进程管家 + 窗口"，不当"前端宿主"。这样同源闸门一行都不用改，
  也不给这道唯一的写保护开口子。
- 反面做法（记下来防止以后有人图省事）：给 `requireSameOriginWrite` 的 `extraAllowed`
  加一条"壳的 origin 放行"。那是把"唯一的门"变成"两个门"，
  而且原生窗口的 origin 对浏览器而言并不能证明它是我们的窗口。

## 3. 三条候选路线与实测代价

### A. `jpackage` app-image（自带精简 JRE + 我们的 jar，出一个 `青阅.exe`）

- 得到：`青阅/青阅.exe` + `app/` + `runtime/`（jlink 裁过的运行时），双击即起服务并打开浏览器；
  有自己的 AppUserModelID 与图标，任务栏/开始菜单里就是一个应用。
- 代价：**零新工具链**（jpackage/jlink 都在），构建是几条命令，产物 ~80–90 MiB。
- 拿不到：内嵌窗口（还是浏览器标签/另开的 PWA 窗口）、托盘、单实例锁（要自己实现）。

### B. Tauri 窗口壳（真·独立窗口 + 托盘 + 单实例）

- 得到：跟现在 PWA 一样的独立窗口，但由我们自己管生命周期（关窗即停服务）、托盘、单实例、
  开机自启都有现成插件且已缓存。
- 代价（三条都得先尖峰验证，不是"写点胶水"）：
  1. 工具链是 **GNU host**。Tauri 官方支持面是 MSVC；要么 `rustup toolchain install stable-msvc`
     （换整套 host 工具链，与现有 gnu 环境并存，构建脚本、`link.exe` 路径、VC 运行库都要重验），
     要么硬走 gnu（`windows-rs`/`webview2-com` 的导入库在 gnu 上历史上有坑）。
  2. `WebView2Loader.dll` 要随应用带，机器上没有现成副本 → 需要确定取法（crate 构建产物 / NuGet 包），
     并钉进判据"产物里必须有它"。
  3. CI 要新增 windows runner 作业；`.exe` 分发还牵扯 GPL 的源码可得性（见 §5）。
- 复用关系：B 的壳**应当骑在 A 的产物上**（同一份 runtime + jar 布局），而不是另起一套打包。

### C. Electron

- 能成，但代价最差：再下一个 ~200 MB 的 Chromium + Node 运行时，而用户**已经在用 Chromium 的 PWA 窗口**了 ——
  等于为"一个窗口"再装一台浏览器。排除。

**推荐**：A 先落地（今天就做得完、零新工具链、解决"必须手动起服务"这个真痛点），
B 作为二期，且以"先做一个能开能关能读的最小尖峰"为准入门槛，尖峰不过就停在 A 并说明原因。

## 4. 必须一并解决的四个真实问题

1. **数据目录**：现有库在 `E:\Projects\legado-server\data`（5,574 个书源、书架、缓存都在里面）。
   便携化的 app-image 默认会把数据放在 exe 旁边 —— 用户点开看到的是**空书架**，
   比不封装更糟。要么打包版显式指向现有目录，要么首屏给一次"选数据目录"的确认，
   要么做一次性迁移并说明去向。**这条需要拍板**（见 §6）。
2. **端口**：`1234`（launcher）与 `8080`（裸 jar）默认值不一致已经是坑；桌面壳必须
   **显式写死一个端口并同时传给服务端与窗口 URL**，否则"起了但连不上"。
   端口被占时：报错退出（简单、可预期）vs 自动换端口（更像桌面应用，但 PWA/书签里的地址会失效）。
3. **单实例**：两个实例 = 两个进程写同一个 SQLite。`jpackage` 路线要自己做锁
   （最省事：起之前探测端口，端口有人就退出并提示，与 `start.mjs` 现在的行为一致）；
   Tauri 路线有现成 single-instance 插件。
4. **退出语义**：现在是 `taskkill /F` 硬杀，靠 WAL 恢复兜底（实测能恢复，但不是"干净"）。
   桌面应用关窗口就该停服务，那正好是加一条优雅关闭的理由（`/api/shutdown` 只允许同源 + 回环，
   或 SIGTERM 钩子），顺手把这条老账结掉。

## 5. 分发与开源卫生（不能事后补）

- 产物里**不许出现个人绝对路径**（`E:\Projects\...`、`C:\Users\...`）；数据目录、临时目录一律走既有的
  `LEGADO_*` 环境变量契约，默认值从"壳所在目录"派生（`start.mjs` 已经是这个思路）。
- 图标复用现成的品牌管线（`tools/verify/make-ico.mjs` + `render-icons.mjs`），
  不允许"桌面图标和标签页 favicon 长得不一样"这种漂移重演。
- 版本号仍然只有一个来源（`server/build.gradle`）；桌面壳的显示版本必须读 `/healthz`，
  不许在壳里再写一份字面量。
- GPL-3.0：给出 `.exe` 的同时要给源码获取路径（Release 里同版本的源码归档即可），
  且**捆绑的 jlink 运行时是 GPL+Classpath Exception 的 OpenJDK**，要在文档里写明来源与许可。
- 产物目录不进 git（`desktop/**/target`、`dist`、`*.exe`），构建脚本进 git。

## 6. 需要拍板的五件事

| # | 议题 | 选项 | 我的建议 |
| --- | --- | --- | --- |
| 1 | 数据目录 | 便携（exe 旁边） / 指向现有 `data` / 首屏选一次 | **首屏选一次并记住**，默认填现有 `data`；不做静默迁移 |
| 2 | 端口 | 固定 1234，占用即报错 / 自动挑空闲端口 | **固定 1234 + 占用即报错**（与你现在用的 PWA 地址一致，别动它） |
| 3 | 一期是否要独立窗口 | A 只做"双击起服务 + 开浏览器" / 直接上 Tauri | **先 A**，Tauri 做尖峰后再定 |
| 4 | 发行形态 | 本机 app-image 目录 / CI 出 zip / CI 出 .msi | **本机 app-image + CI 出 zip**（`.msi` 需要 WiX，本机没有，先不承诺） |
| 5 | 关窗口行为 | 停服务 / 服务常驻 | **停服务**（桌面直觉），并加优雅关闭 |

---

## 7. 验收判据（规划阶段就把“怎么算做完了”写死）

1. 全新解压目录、**不装 Java**、不开任何命令行：双击 `青阅.exe` → 出现界面、书架有书、能搜索能读。
   （判据要真的用 `-Djava.home` 之外的干净 PATH 环境跑，别拿开发机现装的 Java 蒙过去。）
2. 写操作在桌面壳里全部可用：加一个源、改一次书架、导一次备份 —— 这是对 §2 那条约束的**直接验证**；
   并且带一条反向对照：把壳的 URL 换成非同源来源时必须吃 403，否则说明闸门被悄悄放宽了。
3. 单实例：第二个实例必须拒绝启动并给出人话提示，且**不许**留下第二个 java 进程。
4. 退出：关窗口后端口释放、`netstat` 查不到监听、进程数归零；重开后进度/书架/缓存原样在。
5. 数据目录：打包版指向现有 `data` 时，与 `node start.mjs` 跑出来的界面看到**同一批**书源与书架
   （按 id 集合比，不比条数）。
6. 门禁与判据：新增 `tools/verify/desktop-check.mjs`（起壳 → 走上面 1–5），
   产物布局判据（`青阅.exe` / `app/*.jar` / `runtime/bin/java.exe` / `WebView2Loader.dll`（若走 B）都在），
   以及"产物与文档里都没有个人绝对路径"继续由 `opensource-hygiene-check.mjs` 兜。
7. 旧路径不许坏：`node start.mjs` / `stop.mjs` / Docker / 裸 jar 四条启动方式在改动后仍然可用
   （桌面化是**加一条路**，不是换一条路）。

---

## 8. 借鉴 `changexbc/workbuddy-switch` 的封装与构建思路（2026-10-04）

用户让参考那份仓库"怎么封装、怎么构建"。它是 **Tauri（Rust workspace + React）**，
形态与我们不同，但**构建与分发的骨架**有八条能对照，逐条写明落点：

| 他的做法（实测自 `origin/main`） | 为什么这么做 | 青阅的落点 |
| --- | --- | --- |
| workspace 三成员：`crates/wb-switch-core`（业务）/ `crates/wb-switch-server`（无头 webui 形态）/ `src-tauri`（桌面壳） | 桌面壳**骑在**同一份产物上，不另起一套打包 | 与 §3B「复用关系：B 的壳应当骑在 A 的产物上」同形，作为佐证保留；我们的 core+webui 那一格就是那个 fat jar |
| 前端产物 `rust-embed` 进二进制，一个文件能跑 | 分发面只有一个文件 | **等价已实现**：`processResources` 把 `web/dist` 烤进 `static/`（两边 bundle 哈希一致），不换路线 |
| 产物命名只有一处出处：CI 的 `select-matrix` 生成一张 JSON 表（target / cli_bin / bundles / update_* / archive_name），构建、发包、更新器都读它 | 名字散在多处必然漂 | **已落地**：`scripts/package.mjs` 里包名/jar 名/顶层目录全部从 `server/build.gradle` 的 version 派生；`package-check.mjs` 的默认包名同样跟着 gradle 走（此前写死 `qingyue-0.6.0.zip`，等于下一次发版会去验上一版的包） |
| tag 触发才建 Release；`workflow_dispatch` 手选平台出的是**试装包**，不建 Release、不 publish；`vars.PUBLISH_NPM=false` 是 kill switch，脚本幂等可重跑 | 试装与发版严格分开；一条通道坏了不阻塞另一条 | 建议照搬进桌面 CI（等 §6 第 4 件拍板后做）；我们现在根本没有桌面 CI 步骤 |
| 构建层兼容修复**就地写明去向**：`[patch.crates-io] indexmap = { path = "vendor-patched/indexmap" }` 上面一整段注释解释 1.98 上 autocfg 探测失败导致 E0107、只改 build.rs 不碰库代码、"工具链正常就整段删除" | 构建层的妥协最容易被后人当成业务逻辑 | 我们的 `init-mirror.gradle`（镜像）与 `local-patches.diff` 现在**没有**这种说明 —— 该补；两个新脚本已按同一写法注释 |
| 门禁分层：发版构建 `rustflags: ""`（并注释说明默认 `-D warnings` 会把 vendored 快照的 dead_code 升级成错误），自有代码的告警由 `test.yml` 的 lint job 把关 | 发版通道不承担评审职责 | 我们三个 workflow（`ci` / `build-jar` / `docker`）照这个分工重排：判据归判据，出包归出包 |
| 签名私钥在**用户数据目录**（`$HOME/.wb-switch/wb-switch-updater.key`），不进仓库；更新器 archive 名进那张平台表 | 密钥与产物分离 | 二期若做自动更新照此，且 §5 的"产物里不许出现个人绝对路径"同样适用 |
| 「第二份前端」纳入构建链：`scripts/prepare-agent-companion.mjs {dev,build,copy}`，`build:desktop` = prep → build → copy | 靠人记得拷一次，一定会拷错 | **已落地**：`scripts/prepare-next.mjs`，把今天手工 `cp -r` 的那一步换成带三条硬断言的脚本（`/next/` 前缀、资源真的存在、旧前端 SW 黑名单含 `/next`） |

**为什么现在就把这两条脚本做出来**（不是提前工程，是今天真踩了）：0.6.1 发版时整合包是手工组装的，
一次踩中两个只有独立解析器才会逮到的坑 ——
① `Compress-Archive` 压出的条目用反斜杠且不带顶层目录，`package-check` 认不出 `next/index.html`，
表面"包做好了"而解开是残缺的；② 用 `sed` 改 `start.bat` 把 CRLF 变成 LF，cmd 的读法就变了。
现在 `scripts/package.mjs` 自己写 zip（deflate + 正斜杠 + 单一顶层目录 + 拒绝 `data/`、`logs/`、`*.sqlite`、`.env`），
产物同时被 `package-check`（自研解析）与 `unzip -t`（第三方）验过：11/11、无 CRC 错误。

**没借鉴的一条**：他的 npm 分发通道（`npm/platform/workbuddy-switch-<tag>` 带 `bin/`）对我们没有对应物 ——
我们的产物是单个 jar + 一个自带运行时的包，塞进 npm 只会多一条要维护的发布路径。
将来若真要做"一条命令装好"，再单开一份提案讨论，不改本文件的结论。

## 9. 实现记录（2026-10-10，Phase A 已完成）

一期（路线 A：jpackage app-image + jlink 运行时）已落地并通过门禁 `tools/verify/desktop-check.mjs`：

- 新增 `server/src/main/kotlin/io/legado/server/DesktopLauncher.kt`：`jpackage --main-class` 入口。
  职责只有三件——探测端口（占用即退出，充当单实例锁）、带 `LEGADO_*` 起服务（复用
  `createLegadoEngine`，不改 `Guard.kt`、不加鉴权）、服务就绪后开浏览器、系统托盘给
  「打开 / 退出」，退出时优雅关服务。**webview 直接开 `http://127.0.0.1:<port>`，壳只当进程管家 + 窗口。**
- `Application.kt` 抽出 `createLegadoEngine(config, cdsDump)`，让 `main` 与桌面壳共用同一套启动代码。
- 新增 `scripts/package-desktop.mjs`：确保前端 + fat jar → `jlink` 裁运行时 → `jpackage --type app-image`
  出 `青阅.exe`（自带运行时、不要求装 Java）→ 可选 `--data-dir` 写 `.env` → zip。产物
  `dist/qingyue-desktop-<ver>.zip`（~53MB，顶层 `青阅/`）。
- 门禁 `tools/verify/desktop-check.mjs`：干净 PATH 下起壳 → /healthz 可达、同源自壳内写操作通过、
  非同源写请求 403、单实例（第二个实例不起新端口监听）、退出后端口释放。

### 5 件待拍板事项的落地（采用原「我的建议」列）

| # | 议题 | 落地 |
| --- | --- | --- |
| 1 | 数据目录 | 默认 `<镜像>/data`（便携、不写系统盘）；打包时 `--data-dir <路径>` 写 `.env` 指向现有书架（本机首次打包用，不静默迁移） |
| 2 | 端口 | ~~固定 1234 + 占用即报错~~ → **被别的程序占用时自动顺延到下一个空闲端口并写 port.txt 记住**（用户 2026-10-10：「可以自定义端口，不要固定」）；端口上是青阅自己则照旧"已在运行"只开界面 |
| 3 | 一期是否独立窗口 | 先 A（jpackage + 浏览器），Tauri 留二期 |
| 4 | 发行形态 | 本机 app-image 目录 + zip（`.msi` 需 WiX，本机没有，未做） |
| 5 | 关窗口行为 | 托盘「退出」→ `System.exit(0)` 触发 Ktor shutdown hook 优雅关服务 |

### 已知（Phase A 范围内）

- 镜像根若落在只读目录（如 `Program Files`），写 `port.txt`/数据会失败——本机解压到普通目录即可，属预期。
- B 组（Tauri 窗口壳）未做，按 ADR-017 以尖峰为准入门槛。

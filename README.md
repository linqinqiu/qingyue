<div align="center">

<img src="./web/public/favicon.svg" width="96" height="96" alt="青阅 Logo" />

# 青阅

把 [Legado（开源阅读）](https://github.com/gedoor/legado) 的书源规则搬到服务端跑：一个 JVM 进程 + 一个浏览器界面，书架、发现、订阅、朗读、离线缓存都在自己机器上。

[![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

</div>

---

## 这个仓库里有什么 / 没有什么

**有**：书源规则的解析执行器（`@xpath:` / `@json:` / `@js:` / `@regex:` 这些取值语法）、书架与阅读进度、发现页、订阅源、正文净化规则、离线缓存、朗读、手机备份包导入，以及配套的 Web 界面。

**没有**：任何书源、订阅源、发现源地址，也不内置作品。规则和站点由使用者自己导入。

服务默认只监听 `127.0.0.1`，数据放在你自己的目录里。没有账号、密码、登录页和会话。

## Windows 桌面程序

去 [Releases](../../releases) 下载 `qingyue-desktop-<版本>.zip`，解压后双击 `qingyue.exe`：

- 自带精简 JRE，**不要求装 Java**；
- 起来后自动打开浏览器到 `http://127.0.0.1:1234`，系统托盘里可以随时「打开 / 退出」，退出即停服务；
- 数据默认放在 exe 旁边的 `data/`；想用已有的书架，在 exe 旁放一个 `.env` 写 `LEGADO_DATA_DIR=<你的数据目录>`；
- 端口上已经是青阅在跑 → 不再起第二个进程，只把界面打开；端口被**别的程序**占了 → 从下一个端口起顺延找一个空闲的（往后 20 个内），并用它写回 `port.txt`，下次启动仍稳定在那个端口（界面上「设置 → 服务 → 服务端口」看到的也是它）。

## 技术栈

Kotlin JVM 17 + Ktor 3.4 + SQLite（WAL）。前端 React 19 + TypeScript + Vite，构建产物打进同一个 jar，可当 PWA 装到桌面。规则里的 `@js:` 段跑在 Rhino 沙箱里，HTML / XML / JSON 取值分别用 Jsoup、JsoupXpath、JsonPath。

## 能力

- **搜索**：WebSocket 流式返回（`/api/search/stream`），各书源并发检索，边搜边出，中途可停。开书只请求主书源，候选源按需再取。
- **书架**：按分组整理、批量删除 / 标已读 / 移到分组，卡片可以拖着排自己的顺序（也可一键回到"从没拖过"），封面下方那条进度按读到哪一章画。
- **发现**：读每个书源的 `exploreUrl` 分栏列出推荐书籍；聚合源动辄四十多个重名分栏，所以同名分栏会带上源名区分，并按分组筛要看的源。
- **阅读**：连续滚动与平移分页两种模式，分页在宽屏排多栏，章末自动补齐到整页（否则下一章的第一栏正好是上一页的右半格，同一页会被看两遍）。字号、行距、段距、首行缩进、左右边距、版心宽度可调；内置七种字体（宋 / 黑 / 楷 / 仿宋 / 圆体 / 系统 / 等宽），也可以填本机装着的任意字体名；七套内置配色再加一套自定义皮肤，阅读区还能另设背景色、背景图与压暗比例。目录栏宽度可拖。点哪儿算什么由你定：正文可以按任意行列划成格子，每格挑一个动作（上一页 / 下一页 / 呼出工具栏 / 目录 / 设置 / 不响应），四套预设整套换，翻页与滚动各存一张表。进度自动记录。
- **目录**：虚拟列表渲染，几千章的目录只挂视口内的行。
- **非文本内容**：漫画（逐张图片，支持离线缓存带图）、有声书 / 音频（内嵌播放器）、视频、文件直链，阅读器按书源类型自动分流。
- **离线**：按「后 50 章 / 后 100 章 / 全本 / 自定义区间」缓存到服务端，已缓存的章节跳过，任务可中断可续。另有「下载到本设备」把正文写进浏览器 IndexedDB，断网可读；「设置 → 管理离线缓存」按书列出本机占用的空间，可以单本清除，数据只从这台设备的浏览器里读。
- **朗读**：三种引擎 —— 浏览器自己的语音、服务端内置的微软 Edge-TTS 连续音频流、自建 HTTP 音频接口（填地址、发音人标识与附加请求头，第三方服务基本都要一个 key）；支持跨章连播、点击段落选播、睡眠定时（15 / 30 / 45 / 60 分钟或读完本章即停）；播放条可长按挪位置，位置记在本机。
- **键盘**：阅读器里 `← →` 跨章、`Page Up / Down / 空格` 翻屏、`Home / End` 章首章末、`+ / -` 字号、`Ctrl + 滚轮` 直接调字号、`T` 换配色、`D` 目录、`S` 阅读设置、`M` 朗读、`F` 全屏、`Esc` 收层；全局 `1`–`6` 切一级页、`/` 与 `Ctrl + F` 聚焦当前页的搜索框、`Alt + ← / →` 循环切页、`L` 运行日志、`?` 就地查这张表。按键表与处理逻辑同源一份，界面上查到的就是按下去做的。
- **书源管理**：JSON 文本 / 文件 / URL 三种导入，按分组与关键字筛选，批量启停与打标签，长按拖动排序；体检带关键词实跑一次搜索再分档 —— 只有「连不上 / 证书问题 / 规则失效 / 结构错误」这四类算坏，会被「一键停用 / 一键删除」圈走；没配搜索地址的源单独一档「未配搜索」，它一次请求都没发过，所以不算连不上。
- **订阅**：RSS 源与文章都由服务端取。库里几百条订阅源里往往只有一部分配了取文章的规则，因此列表默认「只看能读的」，其余收在开关后面，不混在一起显示成"读不出"。
- **本地书**：TXT / EPUB 导入，26 条分章规则可选、可新建、可编辑，也能让程序读文件头打分自动挑一条；已经在读的那本可以换规则重切目录。
- **手机备份包**：见下面单独一节。
- **写操作保护**：浏览器发出的跨站写请求一定带 `Origin`，与本机 Host 不一致就 403。抓取侧对重定向后的地址复验，拒绝内网与链路本地目标；正文进界面前做净化，图片走代理。

## 怎么跑起来

### Windows 桌面程序（免 Java）

见上一节：Releases 下载 `qingyue-desktop-<版本>.zip`，解压双击 `qingyue.exe`。

### 整合包 jar（免 Java）

Releases 下载 `qingyue-<版本>.zip`，解压后运行 `start.bat`（默认端口 1234，可用 `start.bat 1235` 换）。

### 直接跑 jar（需要 Java 17+）

```bash
java -jar legado-server-<版本>-all.jar
```

浏览器打开 `http://127.0.0.1:8080`。数据落在当前目录的 `data/`。换端口或数据目录：

```bash
LEGADO_PORT=9000 LEGADO_DATA_DIR=/srv/qingyue/data java -jar legado-server-<版本>-all.jar
```

自己构建：

```bash
npm --prefix web run build
./gradlew :server:fatJar      # → server/build/libs/legado-server-<版本>-all.jar
node tools/make-cds.mjs       # 可选：生成 CDS 归档，冷启动 ~8.3s → ~5.3s；过期时 start.mjs 会自动重建
```

### Docker

镜像需本地构建（CI 的镜像发布还没通）：

```bash
docker build -f Dockerfile.server -t qingyue .
docker run -d --name qingyue --restart unless-stopped \
  -p 8080:8080 -v ./ls_data:/data qingyue
```

容器内要把 `LEGADO_HOST` 设成 `0.0.0.0` 才接得住宿主机映射（Dockerfile 里已经这么设）。仓库带了一份 `compose.server.yml`。

### 从源码跑

```bash
cd web && npm install && npm run dev     # 前端开发服务器（热重载）
./gradlew :server:run                    # 服务端
```

## 环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `LEGADO_HOST` | `127.0.0.1` | 绑定地址。改成 `0.0.0.0` 就局域网可达，见下一节 |
| `LEGADO_PORT` | `8080`（裸 jar）；启动脚本 / 桌面版 `1234` | HTTP 与 WebSocket 端口 |
| `LEGADO_DATA_DIR` | `data` | 数据根目录，封面缓存与本地书都从它下面派生 |
| `LEGADO_DATABASE` | `$LEGADO_DATA_DIR/legado.sqlite` | 单独指定库文件位置 |
| `LEGADO_LOG_FILE` | `<安装根>/server.log` | 运行日志 |
| `LEGADO_TMP_DIR` | `<安装根>/tmp` | JVM 临时目录。不指定的话 SQLite 的原生库每次启动都往系统盘 `Temp` 解一份 |
| `LEGADO_HOME` | 当前目录 | 安装根：`port.txt`、`server.log`、`tmp/` 都从它下面派生。由启动器传入（`scripts/runtime.mjs`），裸跑 jar 一般不用管 |
| `LEGADO_REPO` | 空 | `owner/repo` 形状，供「关于」页检查更新；不设就没这个入口 |

`start.mjs` / `stop.mjs` 是可选封装（后台拉起、按端口停进程），以脚本自己所在目录为安装根，整个文件夹可以改名或搬盘。`start.mjs` 支持 `--port 1235` 换端口、`--host 0.0.0.0` 换绑定地址、`--no-open` 只起服务不开浏览器（默认起来后自动打开浏览器）。端口也可以**在界面上改**（设置 → 服务 → 服务端口，重启后生效，写的是安装根下的 `port.txt`）；优先级 `--port` > `port.txt` > `.env` / 环境变量 > 1234。同目录的 `start.cmd` 是给双击用的门面：服务没跑就起、等就绪再开界面；已经在跑就直接开界面。

## 想给手机用之前

这个服务不设身份，绑定地址就是唯一的门。默认只绑回环，所以手机连不上是设计如此。要跨设备用，设 `LEGADO_HOST=0.0.0.0` 重启 —— 同时清楚这意味着同一张网里任何人都能读改这个库（书源、书架、登录凭据）。要认真做就在前面放一层带鉴权的反向代理，或者走隧道，别把服务直接暴露出去。

## 手机备份包

手机上「我的 → 备份与恢复 → 备份到本地」产出的 zip，选进「备份」页（`#backup`）即可导入，全程只在本机与这个服务之间传输。

| 项目 | 说明 |
| --- | --- |
| 接口 | `POST /api/backup/import`（multipart：`file` + 可选 `password`） |
| 恢复内容 | 书源 / 替换净化规则 / 书架与阅读进度 / RSS 订阅源 / 分组 / 登录凭据 |
| 启用位 | 已存在的书源保留本机启用/停用状态，只更新规则内容；新入库的按包内值启用 |
| 分组 | 包内 `bookGroup.json` 的组号按组名映射到本机现有组，同名只留一个 |
| 加密条目 | 包内 `cookies.json` 用备份密码加密（口径同上游：`AES(MD5(password)[:16])`），填密码才解得开 |
| 原样收下 | 包里没有原生归宿的个性化条目（TXT 分章规则、搜索历史、阅读样式、朗读引擎……）不会让整包被拒收：条目原样存在数据目录里，界面按条列出名字与大小、可下载，其中阅读样式、朗读引擎与分章规则能一步套到本机 |
| 临时文件 | 读完即删，不留在数据目录；日志里只有文件名与条数 |
| 承接不了的条目 | 条目名会在导入结果里念出来，不静默丢弃 |

> [!NOTE]
> 不提供"把服务器上的文件当网盘用"的能力。以前内置的 WebDAV 文件服务已删除：只绑回环时手机推不上来，能推上来的场景又要求你把数据目录暴露给局域网。

## 目录结构

```text
server/                     Ktor 服务端（Kotlin JVM）
  src/main/kotlin/io/legado/server/
    Application.kt          启动入口与 Ktor 特性装配
    ServerConfig.kt         环境变量到默认值
    Guard.kt                写操作同源闸门
    Routes.kt               REST 与 WebSocket 路由
    RuleRunner.kt           书源规则执行器（Rhino + Jsoup + JsonPath）
    SourceHealth.kt         体检：带关键词实跑一次搜索再分档
    TxtTocRule.kt           本地书分章规则表与打分选规则
    BookCacheService.kt     离线缓存调度
    CoverCache.kt           封面拉取、存储与防盗链代理
    SubscriptionService.kt  订阅源定时与批量同步
    Database.kt             SQLite 数据层与连接生命周期
    DesktopLauncher.kt      桌面壳入口（jpackage）：探端口、开浏览器、托盘退出
web/                        前端（React 19 + TS + Vite，构建产物进同一个 jar）
  src/                      界面与逻辑 —— 模块清单、关键链路（书源导入 / 搜索 / 目录 / 正文 / 翻页 / 进度 / 离线 / 朗读）与前端边界见 docs/code-map-frontend.md
  test/                     单元与静态判据，入口是 test/run-all.ts（它逐个 import 登记，新加测试文件要同时加那一行，否则"存在但从未运行"）
  AGENTS.md                 前端的工程口径：判据怎么写、什么才算验过
tools/verify/               在真实浏览器和真实服务上跑的门禁脚本
scripts/package-desktop.mjs 桌面程序打包（jlink + jpackage → qingyue.exe）
docs/                       实现说明、会话记录、部署文档
compose.server.yml          Docker Compose 编排
Dockerfile.server           多阶段构建（前端 + 服务端）
```

## 测试

```bash
./gradlew :server:test             # 服务端：规则解析、数据库生命周期、缓存并发、端到端链路
npm --prefix web test              # 前端：静态判据 + 组件渲染，一条命令跑全部
node tools/verify/selfcheck.mjs    # 对着跑着的服务过一遍：搜索 → 详情 → 目录 → 正文 → 净化
```

`tools/verify/` 下还有按功能划分的门禁（`toc-rule-check`、`source-health-check`、`shelf-layout-check`、`reader-flow-check`、`version-check` 等），都是开真浏览器量，不打桩。判据口径记在 [`AGENTS.md`](AGENTS.md)。

## 青阅到底是什么

三句话：

1. 它是一个**网页版阅读器**：搜索、读书、听书都在浏览器里完成，但程序和数据全部在**你自己的机器上**，不经过任何第三方服务。
2. 它执行的是 **Legado 的书源规则**：去哪里找书、怎么解析页面，由你自己导入书源决定；本项目负责把这些规则在服务端跑起来。
3. 它**不内置任何书源和内容**。它也不是 Legado 的官方产品，而是一个独立实现——不是 fork，代码全部自写，GPL-3.0。

### 与参照项目的关系

| 参照对象 | 关系 | 协议 |
| --- | --- | --- |
| [gedoor/legado](https://github.com/gedoor/legado) | 书源规则 DSL 求值语义、`checkKeyWord` 体检、书源编辑字段分组的参照基准；未拷贝代码，按 Kotlin 逐条自实现 | GPL-3.0 |
| [hectorqin/reader](https://github.com/hectorqin/reader) | 仅交互与信息架构参考；**其代码不得引入本仓库**（AGPL-3.0 网络服务条款与本项目 GPL-3.0 不等价） | AGPL-3.0 |

后续贡献同样适用：可以参考交互，实现必须自己写。

## 许可

GPL-3.0，见 [LICENSE](LICENSE)。

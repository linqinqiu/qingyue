<div align="center">

<img src="./web/public/favicon.svg" width="96" height="96" alt="青阅 Logo" />

# 青阅

把 [Legado（开源阅读）](https://github.com/LegadoTeam/legado) 的书源规则搬到服务端跑：一个 JVM 进程 + 一个浏览器界面，书架、发现、订阅、朗读、离线缓存都在自己机器上。

[![Build JAR](https://github.com/lukelzlz/legado-server/actions/workflows/build-jar.yml/badge.svg)](https://github.com/lukelzlz/legado-server/actions/workflows/build-jar.yml)
[![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

</div>

---

## 这个仓库里有什么 / 没有什么

**有**：书源规则的解析执行器（`@xpath:` / `@json:` / `@js:` / `@regex:` 这些取值语法）、书架与阅读进度、发现页、订阅源、正文净化规则、离线缓存、朗读、手机备份包导入，以及配套的 Web 界面。

**没有**：任何书源、订阅源、发现源地址，也不内置作品。规则和站点由使用者自己导入。

服务默认只监听 `127.0.0.1`，数据放在你自己的目录里。没有账号、密码、登录页和会话。

## 技术栈

Kotlin JVM 17 + Ktor 3.4 + SQLite（WAL）。前端 React 19 + TypeScript + Vite，构建产物打进同一个 jar，可当 PWA 装到桌面。规则里的 `@js:` 段跑在 Rhino 沙箱里，HTML / XML / JSON 取值分别用 Jsoup、JsoupXpath、JsonPath。

## 能力

- **搜索**：WebSocket 流式返回（`/api/search/stream`），各书源并发检索，边搜边出，中途可停。开书只请求主书源，候选源按需再取。
- **阅读**：连续滚动与平移分页两种模式，分页支持宽屏双栏。字号、行距、段距、首行缩进、左右边距、版心宽度、五种字体、三档皮肤可调；进度自动记录。
- **目录**：虚拟列表渲染，几千章的目录只挂视口内的行。
- **离线**：按「后 50 章 / 后 100 章 / 全本 / 自定义区间」缓存到服务端，协程信号量限并发，已缓存的章节跳过，任务可中断可续。另有「下载到本设备」把正文写进浏览器 IndexedDB，断网可读。
- **朗读**：系统 TTS 或自建 HTTP 音频接口，支持章节自动续读与定时停止；播放条可长按挪位置，位置记在本机。
- **书源管理**：JSON 文本 / 文件 / URL 三种导入，按分组与关键字筛选，批量启停与打标签，长按拖动排序；体检是带关键词实跑一次搜索，按能否解析出条目分档。
- **本地书**：TXT / EPUB 导入，26 条分章规则可选、可新建、可编辑，也能让程序读文件头打分自动挑一条；已经在读的那本可以换规则重切目录。
- **书签**：框选一段或几段，或整章收藏，可写批注；按「书名 + 作者」归拢，同一本书换书源后还在。
- **手机备份包**：见下面单独一节。
- **写操作保护**：浏览器发出的跨站写请求一定带 `Origin`，与本机 Host 不一致就 403。抓取侧对重定向后的地址复验，拒绝内网与链路本地目标；正文进界面前做净化，图片走代理。

## 怎么跑起来

### 直接跑 jar（需要 Java 17+）

```bash
java -jar legado-server-<版本>-all.jar
```

浏览器打开 `http://127.0.0.1:8080`。数据落在当前目录的 `data/`。换端口或数据目录：

```bash
LEGADO_PORT=9000 LEGADO_DATA_DIR=/srv/qingyue/data java -jar legado-server-<版本>-all.jar
```

产物名带版本号（取自 `server/build.gradle` 的 `version`）。去 Releases 下载现成的，或者自己构建：

```bash
npm --prefix web run build
./gradlew :server:fatJar      # → server/build/libs/legado-server-<版本>-all.jar
node tools/make-cds.mjs       # → server/build/cds/app.jsa（可选；冷启动快 ~3 秒）
```

> **`make-cds.mjs` 生成的是 CDS 类归档**（把这次运行加载过的类存下来，下次直接从归档映射，
> 省掉从 jar 里逐个读 + 校验的那几秒）。它**跟这一份 jar 绑定** ——
> **每次 `:server:fatJar` 之后要重跑一次**；否则 `start.mjs` 会发现归档比 jar 旧而跳过它
> （不会用坏的归档，只是少了那 ~3 秒）。实测冷启动：不带归档 ~8.3 秒 → 带归档 ~5.3 秒。

### Docker

镜像同时发到 GHCR 和一个阿里云个人版镜像仓库（国内拉后者更快）：

```bash
docker run -d --name legado-server --restart unless-stopped \
  -p 8080:8080 -v ./ls_data:/data \
  ghcr.io/lukelzlz/legado-server:latest
```

容器内要把 `LEGADO_HOST` 设成 `0.0.0.0` 才接得住宿主机映射（镜像里已经这么设）。仓库带了一份 `compose.server.yml`。

### 从源码跑

```bash
cd web && npm install && npm run dev     # 前端开发服务器（热重载）
./gradlew :server:run                    # 服务端
```

## 环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `LEGADO_HOST` | `127.0.0.1` | 绑定地址。改成 `0.0.0.0` 就局域网可达，见下一节 |
| `LEGADO_PORT` | `8080` | HTTP 与 WebSocket 端口 |
| `LEGADO_DATA_DIR` | `data` | 数据根目录，封面缓存与本地书都从它下面派生 |
| `LEGADO_DATABASE` | `$LEGADO_DATA_DIR/legado.sqlite` | 单独指定库文件位置 |
| `LEGADO_LOG_FILE` | `<安装根>/server.log` | 运行日志 |
| `LEGADO_TMP_DIR` | `<安装根>/tmp` | JVM 临时目录。不指定的话 SQLite 的原生库每次启动都往系统盘 `Temp` 解一份 |
| `LEGADO_REPO` | 空 | `owner/repo` 形状，供「关于」页检查更新；不设就没这个入口 |

`start.mjs` / `stop.mjs` 是可选封装（后台拉起、按端口停进程），以脚本自己所在目录为安装根，整个文件夹可以改名或搬盘。`start.mjs` 支持 `--port 1235` 换端口、`--host 0.0.0.0` 换绑定地址、`--no-open` 只起服务不开浏览器（默认起来后自动打开浏览器）。同目录的 `start.cmd` 是给双击用的门面：服务没跑就起、等就绪再开界面；已经在跑就直接开界面。启动时会自动带上 CDS 归档（见上：`node tools/make-cds.mjs`，**重建 jar 后要重跑**）。

## 想给手机用之前

这个服务不设身份，绑定地址就是唯一的门。默认只绑回环，所以手机连不上是设计如此。要跨设备用，设 `LEGADO_HOST=0.0.0.0` 重启 —— 同时清楚这意味着同一张网里任何人都能读改这个库（书源、书架、登录凭据）。要认真做就在前面放一层带鉴权的反向代理，或者走隧道，别把服务直接暴露出去。

阿里云计算巢那份模板会给出一个公网可达、无鉴权的 URL，只适合临时体验。云资源按量计费，金额以创建页的预估为准；软件本身免费（GPL-3.0）。

## 手机备份包

手机上「我的 → 备份与恢复 → 备份到本地」产出的 zip，选进「备份」页（`#backup`）即可导入，全程只在本机与这个服务之间传输。

| 项目 | 说明 |
| --- | --- |
| 接口 | `POST /api/backup/import`（multipart：`file` + 可选 `password`） |
| 恢复内容 | 书源 / 替换净化规则 / 书架与阅读进度 / RSS 订阅源 / 分组 / 登录凭据 |
| 启用位 | 已存在的书源保留本机启用/停用状态，只更新规则内容；新入库的按包内值启用 |
| 分组 | 包内 `bookGroup.json` 的组号按组名映射到本机现有组，同名只留一个 |
| 加密条目 | 包内 `cookies.json` 用备份密码加密（口径同上游：`AES(MD5(password)[:16])`），填密码才解得开 |
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
web/                        前端（React 19 + TS + Vite，构建产物进同一个 jar）
  src/                      界面与逻辑
  test/                     单元与静态判据
tools/verify/               在真实浏览器和真实服务上跑的门禁脚本
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

## 参照与协议边界

本仓库不是下列任何仓库的 fork（`origin` 指向本项目自身），代码全部自写，只借鉴语义与信息架构：

| 参照对象 | 借鉴了什么 | 协议 | 是否拷过代码 |
| --- | --- | --- | --- |
| [LegadoTeam/legado](https://github.com/LegadoTeam/legado) | 代码基准：书源规则 DSL 的求值语义、`checkKeyWord` 体检、书架版式编号、书源编辑字段分组 | GPL-3.0 | 否，按 Kotlin 源码逐条自实现 |
| [hectorqin/reader](https://github.com/hectorqin/reader) | 仅交互与信息架构 | **AGPL-3.0** | **否**。AGPL 的网络服务条款与本项目 GPL-3.0 不等价，其代码不得引入本仓库 |
| [gedoor/legado_web_source_editor](https://github.com/gedoor/legado_web_source_editor) | 书源编辑器的字段分栏形式 | MIT | 否 |

后续贡献同样适用这条：**不能**把 `hectorqin/reader` 的源码复制进 `server/` 或 `web/`；可以参考它的交互，实现必须自己写。

上游 `gedoor/legado` 已于 2026-05 下架，现在读源码去 `LegadoTeam/legado`。

## 许可

GPL-3.0，见 [LICENSE](LICENSE)。

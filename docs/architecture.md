# 架构 —— 青阅是怎么搭起来的

这份文档说"东西在哪、边界在哪儿"。带图的整体示意见 [`../../docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)，
构建与运行看 [`deploy.md`](deploy.md)，接口清单看 [`../../docs/API-REFERENCE.md`](../../docs/API-REFERENCE.md)。

## 1. 一张图

```
浏览器（React 19 + Vite 6，构建产物打进 jar）
   │  同源 HTTP / WebSocket / SSE 音频流
   ▼
一个 JVM 进程（Ktor CIO，默认只绑 127.0.0.1:1234）
   ├─ 规则引擎：RuleSplit → RuleValue → RuleRunner + JsSandbox(Rhino) + Jsoup / XPath / JsonPath
   ├─ 数据：一个 SQLite 文件（WAL），代码建 16 张表
   └─ 出站：NetworkSecurity 闸门（拒内网 / 链路本地 / 保留段）
```

没有账号、密码、登录页、会话。**绑定地址就是身份**：默认只监听回环，所以手机连不上是设计如此；
把 `LEGADO_HOST` 改成 `0.0.0.0` 等于把整个库交给局域网，此时写操作只剩同源闸门挡着
（它防的是"随便一个网页驱动你的浏览器改你的库"，不防同网段设备直连）。

## 2. 服务端模块

| 层 | 文件 | 负责什么 | 边界 |
| :--- | :--- | :--- | :--- |
| 入口与装配 | `Application.kt`、`ServerConfig.kt`、`DesktopLauncher.kt` | Ktor 特性装配、路由注册、启动后台任务 | 端口就绪**不等**订阅同步 / 缓存续跑 / 封面回收，它们挂在 `ApplicationStarted` 之后 |
| 路由 | `http/Routes.kt` 装配点 + `http/<组>Routes.kt`（13 个业务组，0.8.2 拆出） | 全部 `/api/*` 与 WebSocket | 装配点只留目录/系统两组与挂载调用；响应体一律 `@Serializable data class`；`Map<String, Any>` 在 Ktor 这边直接 500 |
| 数据 | `data/Database.kt` 装配点 + `data/<面>Dao.kt`（11 个，0.8.2 拆出） | 建表、迁移、连接生命周期在装配点；书源/书架/缓存/导入/RSS/订阅/日志/登录/凭据/净化各归各面 | 源清单在库层缓存，写路径统一失效；`close()` 也清缓存。DAO 写成同包扩展函数，调用点 `database.foo()` 不变；跨包用要 `import io.legado.server.data.<方法>` |
| 规则引擎 | `rules/RuleSplit.kt`、`rules/RuleValue.kt`、`rules/RuleRunner.kt`、`rules/JsSandbox.kt` | 把 Legado 的取值语法求值成值 | 沙箱**不开真实 Java 反射**：`JavaImporter` 是安全空替身；`{{}}` 模板展开后早退，不再被当选择器二次求值 |
| 内容管道 | `content/ContentProcessor.kt`、`content/LooseJson.kt` | 正文净化、脏 JSON 兜底 | 净化在落库**之前**执行，离线缓存与朗读因此自动拿到干净文本 |
| 缓存 | `cache/BookCacheService.kt`、`cache/CoverCache.kt`、`book_*_cache` 表 | 整书离线、封面代理与落盘 | 封面边读边限大小、落盘原子化；正文缓存有 SQLite 层，改章节逻辑时别读已缓存的那一章 |
| 朗读 | `tts/EdgeTtsService.kt`、`tts/TtsSessionService.kt` | Edge-TTS 合成与会话级连续流 | 音频流是 `MutableSharedFlow` 广播，不是单消费者 Channel；一条连接断开不销毁全局会话 |
| 非文本与本地书 | `localbook/LocalBookParser.kt`、`localbook/TxtTocRule.kt` | TXT / EPUB 解析入库、分章规则表与打分 | 本地书走虚拟书源 `loc_book` + `local://<id>`，与网络书同一套表，不另开接口；解压有上限 |
| 备份 | `backup/BackupImporter.kt`、`backup/LegacyBackup.kt` | 手机备份包按需流式读取 | 纯内存流式，不落盘；没有原生归宿的个性化条目原样收下（`KEEP_NAMES`），不整包拒收 |
| 体检与登录 | `source/SourceHealth.kt`、`source/WebViewProxy.kt`、`source/ExternalBrowserLogin.kt`、`source/SourceDebugger.kt` | 分档体检、内置浏览器代理、凭据回捞 | 体检**在读到 searchUrl 为空时就定档**，一次请求都不发 |
| 守护与日志 | `http/Guard.kt`、`ops/LogService.kt`、`ops/UpdateCheck.kt` | 同源闸门、日志落库、检查更新 | 闸门比的是 `ServerIdentity`（绑定 host/port/回环/私有 IP 字面量），不是 Origin 与 Host 互比 |

## 3. 数据模型

库文件默认 `$LEGADO_DATA_DIR/legado.sqlite`（WAL，所以同级还有 `-wal` / `-shm`）。代码会建 16 张表，按归属分六组：

- **书源与凭据**：`source`（整份书源 JSON 存 `payload`）、`source_login_state`、`cookie`。
- **书架与进度**：`book_shelf`、`book_group`、`reading_progress`、`reading_log`。
- **阅读标记**：`book_note`（划线 / 备注）。
- **缓存**：`book_toc_cache`、`book_content_cache`、`book_cache_status`；封面字节走 `cover_cache` + 磁盘文件。
- **内容与规则**：`replace_rule`、`source_subscription`、`rss_source`。
- **诊断**：`log_entry`（含 `repeat_count` 合并同类、`host` 让界面说得出哪个站在失败）。

> 注意"代码建的表"与"磁盘上的表"不是一回事：`Database.kt` 只建不删，早年版留下又已停用的表
> （如书签功能 0.6.12 移除后遗留的 `book_mark`）仍会躺在老库里。数表数量要用
> `sqlite_master` 查实际库，别按本文当断言；代码里的权威清单是 `Database.kt` 的
> `create table if not exists`（当前 16 条）。

**不在库里的两类东西**：TXT 分章规则是"随包 `server/src/main/resources/assets/txtTocRule.json` ∪ 本机覆盖文件"；
备份包里"原样收下"的条目只是文件（`data/backup_kept/`），不给它们建表。

## 4. 一条开书链路

```
导入书源 ─▶ 搜索 ─▶ 详情 ─▶ 目录 ─▶ 正文 ─▶ 净化 ─▶ 缓存/离线 ─▶ 翻页与进度 ─▶ 朗读
```

| 步 | 端点 | 关键实现 | 为什么长这样 |
| :--- | :--- | :--- | :--- |
| 导入 | `POST /api/sources/import` | `http/SourcesRoutes.kt` + 前端 `sources/bookSourceFields.ts` | 兼容 BOM、`{data｜sources｜bookSources: []}` 外层包装，以及中文自定义标识 |
| 搜索 | `webSocket /api/search/stream` | `SearchConcurrencyTest` 守着的那条：一个慢源的 30 秒超时算"这一个源失败"，不能把整次搜索取消成 500 | 边搜边出；前端判重表常驻（`lib/searchStore.ts`），每条结果不再 O(N×M) |
| 详情 | `POST /api/books/details` | `RuleRunner.details` | 只请求主书源；候补源按需再取 |
| 目录 | `POST /api/books/chapters` | `book_toc_cache` | 命中缓存直接回，几千章不再重抓 |
| 正文 | `POST /api/books/content` | `RuleRunner.contentPage` + `ContentProcessor` | 命中本机离线分片优先直出；媒体型章节走 `mediaUrl` 分流 |
| 离线 | `POST /api/bookshelf/cache` | `BookCacheService` | 4 并发切片、可中断可续；漫画顺带把每话的图抓进图片缓存 |
| 进度 | `PUT /api/reading-progress` | 前端 `saveProgress` + 离线队列 | 断网时写入本地队列，`online` 后静默补发；导入备份带防回退守卫 |
| 朗读 | `POST /api/tts/session` → `/chunks` → `/audio` 与 `/events` | `TtsSessionService` | 首帧垫静音、`X-Accel-Buffering: no` 穿反代缓冲；单句时长随事件下发 |

## 5. 前端模块

入口是 `web/src/main.tsx`（0.8.2 结构重排后只剩应用状态与外壳；P2 起页面路由与渲染也搬了出去）。

- **外壳与导航**：一级目的地只有一张表（`app/pageMeta.ts` 的 `PAGES` 同时喂顶栏、数字键、`Alt+←/→` 与 hash 解析；
  `app/pages.tsx` 只决定每页渲染什么）。加一页只改这两处，不再改 `main.tsx` 的三元链。
  规则 / 备份 / 更新日志 / 关于是悬浮层（`PageDialog` / 实验室），不占路由。
- **阅读器**：`reader/ReaderScreen.tsx` 只做编排，几何与翻页算术在 `reader/readerFlow.ts`、手势在
  `reader/readerInteractions.ts`、点击区域在 `reader/tapZones.ts` + `reader/TapZoneEditor.tsx`。
  0.8.2 结构重排又拆出四块：目录虚拟列表 `reader/VirtualChapterList.tsx`（窗口算式仍只有
  `reader/virtualSlice.ts` 一份）、朗读集群 `reader/useReaderTts.ts`（状态 + 回调 + effect）、
  图片预热 `reader/contentImages.ts`、正文切段 `reader/paragraphs.ts`；传书合同 `reader/openBook.ts`。
- **设置与本机存储**：`reader/readerSettings.ts`（唯一那份阅读偏好）、`lib/offlineStorage.ts`
  （IndexedDB：正文分片 + 书架快照 + 离线进度队列）。
- **浮层**：所有弹窗共用 `.dialog-shell` + `.overlay-backdrop` + `.overlay-close` 一档几何。
- **错误边界**：`components/ErrorBoundary.tsx` 包根与阅读器；某一块炸了不能把整棵树带走。

## 6. 验证面

| 档 | 命令 | 覆盖 | 注意 |
| :--- | :--- | :--- | :--- |
| 单测与静态判据 | `npm --prefix web test`、`./gradlew :server:test` | 纯算式、组件静态渲染、规则求值、库层 | Windows 上服务端有既有失败基线，**判回归比失败集合，不比数量** |
| 真浏览器门禁 | `node tools/verify/<name>-check.mjs` | 版面、图层、交互、端到端链路，全部现量 | 一律串行跑；判据等条件不 `sleep`；探针带本轮 STAMP 并自清 |
| 部署后 | `node tools/verify/selfcheck.mjs`、`version-check.mjs` | 搜索→详情→目录→正文→净化，以及版本号一致 | jar 必须在 `web/dist` 之后打，否则烤进旧 bundle |

## 7. 改动边界

- 后端与规则引擎：`server/`
- 内置 Web UI：`web/`
- 文档：`docs/`
- 版本号唯一来源：`server/build.gradle`

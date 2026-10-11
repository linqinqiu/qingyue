# 架构 —— 青阅是怎么搭起来的

这份文档说"东西在哪、为什么在这儿、边界在哪儿"。怎么构建与运行看 [`deploy.md`](deploy.md)，
对外接口清单看 [`API-CONTRACT.md`](API-CONTRACT.md)，前端每个模块干什么看 [`code-map-frontend.md`](code-map-frontend.md)。
更细的历史推演在 `sessions/`，决策的理由在 `decisions/`。

## 1. 一张图

```
浏览器（React 19 + Vite，构建产物打进 jar）
   │  同源 HTTP / WebSocket / SSE 音频流
   ▼
一个 JVM 进程（Ktor + Netty CIO，默认只绑 127.0.0.1）
   ├─ 规则引擎：RuleSplit → RuleValue → JsSandbox(Rhino) + Jsoup/JsoupXpath/JsonPath
   ├─ 数据：一个 SQLite 文件（WAL），14 张表，读写分离的连接池
   └─ 外呼：NetworkSecurity 闸门（拒内网/链路本地/保留段）→ 抓回来的东西才进库
```

没有账号、密码、登录页、会话（那套在能力波 v26 整条删掉了）。**绑定地址就是身份**：
默认只监听回环，所以手机连不上是设计如此；把 `LEGADO_HOST` 改成 `0.0.0.0` 等于把整个库交给局域网，
此时写操作只剩同源闸门挡着（它防的是"随便一个网页驱动你的浏览器改你的库"，不防同网段设备直连）。

## 2. 服务端模块

| 层 | 文件 | 负责什么 | 它的边界 |
| :--- | :--- | :--- | :--- |
| 入口与装配 | `Application.kt`(149)、`ServerConfig.kt`、`DesktopLauncher.kt`(247) | Ktor 特性装配、路由注册、启动后台活儿 | 端口就绪**不等**订阅同步/缓存续跑/封面回收 —— 它们挂在 `ApplicationStarted` 之后，为的是启动别拖十几秒 |
| 路由 | `Routes.kt`(2195) | 全部 `/api/*` 与 WebSocket | 响应体一律 `@Serializable data class`；`Map<String, Any>` 在 Ktor 这边直接 500 |
| 数据 | `Database.kt`(2172) | 建表、迁移、连接生命周期、清单缓存 | 两张清单（源 / 可发现源）在库层缓存，六个写路径统一失效；`close()` 也清缓存 |
| 规则引擎 | `RuleSplit.kt`(222)、`RuleValue.kt`(446)、`RuleRunner.kt`(1451)、`JsSandbox.kt`(838) | 把 Legado 的取值语法求值成值 | 沙箱**不开真实 Java 反射**：`JavaImporter` 是安全空替身；`{{}}` 模板展开后早退，不再被当选择器二次求值 |
| 内容管道 | `ContentProcessor.kt`(182)、`LooseJson.kt`(169) | 正文净化、脏 JSON 兜底 | 净化在落库**之前**执行，离线缓存与朗读因此自动拿到干净文本 |
| 缓存 | `BookCacheService.kt`(178)、`CoverCache.kt`(177)、`book_*_cache` 三张表 | 整书离线、封面代理与落盘 | 封面边读边限大小、落盘原子化；正文缓存有 SQLite 层 —— **换章节测试改动时别读已缓存的那一章** |
| 朗读 | `EdgeTtsService.kt`(468)、`TtsSessionService.kt`(407) | 微软 Edge-TTS 合成与会话级连续流 | 音频流是 `MutableSharedFlow` 广播，不是单消费者 Channel；一条连接断开不许销毁全局会话 |
| 非文本与本地书 | `LocalBookParser.kt`(602)、`TxtTocRule.kt`(415) | TXT/EPUB 解析入库、分章规则表与打分 | 本地书走虚拟书源 `loc_book` + `local://<id>`，与网络书同一套表，不另开接口；解压有上限（单条 64 MiB / 整包 512 MiB / 1 万条） |
| 备份 | `BackupImporter.kt`(306)、`LegacyBackup.kt`(268) | 手机备份包按需流式读取 | 纯内存流式，不落盘；没有原生归宿的个性化条目**原样收下**（`KEEP_NAMES`），不整包拒收 |
| 体检与登录 | `SourceHealth.kt`(132)、`WebViewProxy.kt`(811)、`ExternalBrowserLogin.kt`(223)、`SourceDebugger.kt`(165) | 分档体检、内置浏览器代理、凭据回捞 | 体检**在读到 searchUrl 为空时就定档**，一次请求都不发 —— "没发过请求"不能算"连不上" |
| 守护与日志 | `Guard.kt`、`LogService.kt`(226)、`UpdateCheck.kt`(97) | 同源闸门、日志落库、检查更新 | 闸门比的是 `ServerIdentity`（绑定 host/port/回环/私有 IP 字面量），不是 Origin 与 Host 互比（那是 DNS 重绑定洞） |

## 3. 数据模型

库文件默认 `$LEGADO_DATA_DIR/legado.sqlite`（WAL，所以同级还有 `-wal` / `-shm`）。14 张表按归属分四组：

- **书源与凭据**：`source`（整份书源 JSON 存 `payload`，`bookSourceUrl` 允许任意非空唯一串）、
  `source_login_state`、`cookie`（存库前归一化成 `k1=v1; k2=v2`，并剥掉 `Path/HttpOnly/...` 这类指令属性）。
- **书架与进度**：`book_shelf`（含 `group_id`、可空 `sort_order`、这本实际用的 `toc_rule`）、
  `book_group`、`reading_progress`（进度是百分比，不是 Android 的字符偏移）。
- **缓存**：`book_toc_cache`、`book_content_cache`、`book_cache_status`（断点续跑与失败原因在这儿）。
  封面字节走 `cover_cache` + 磁盘文件，不写进库。
- **内容与规则**：`replace_rule`（净化规则）、`source_subscription` + `rss_source`（订阅）。
- **诊断**：`log_entry`（含 `repeat_count` 合并同类、`host` 让界面说得出哪个站在失败）。

**不在库里的两类东西**值得单独记：TXT 分章规则是"随包 `assets/txtTocRule.json` 26 条 ∪ 本机覆盖文件"，
覆盖文件在数据目录下（`TxtTocRule.kt:66`）；备份包里"原样收下"的条目也只是文件（`data/backup_kept/`），不给它们建表。

## 4. 一条开书链路

```
导入书源 ─▶ 搜索 ─▶ 详情 ─▶ 目录 ─▶ 正文 ─▶ 净化 ─▶ 缓存/离线 ─▶ 翻页与进度 ─▶ 朗读
```

| 步 | 端点 | 关键实现 | 为什么长这样 |
| :--- | :--- | :--- | :--- |
| 导入 | `POST /api/sources/import` | `Routes.kt` + 前端 `bookSourceFields.ts` | 兼容 BOM、`{data｜sources｜bookSources: []}` 外层包装，以及中文自定义标识 |
| 搜索 | `webSocket /api/search/stream` | `SearchConcurrencyTest` 守着的那条：一个慢源的 30 秒超时必须算"这一个源失败"，不能把整次搜索取消成 500 | 边搜边出；前端判重表常驻（`searchStore.ts` + `mergeStreamedResults`），每条结果不再 O(N×M) |
| 详情 | `POST /api/books/details` | `RuleRunner.details` | 只请求主书源；候补源按需再取（ADR-003） |
| 目录 | `POST /api/books/chapters` | `book_toc_cache` | 命中缓存直接回，几千章不再重抓 |
| 正文 | `POST /api/books/content` | `RuleRunner.contentPage` + `ContentProcessor` | 命中本机离线分片优先直出；媒体型章节（音频/视频/文件）走 `mediaUrl` 分流 |
| 离线 | `POST /api/bookshelf/cache` | `BookCacheService` | 4 并发切片、可中断可续；漫画顺带把每话的图抓进图片缓存 |
| 进度 | `PUT /api/reading-progress` | 前端 `saveProgress` + 离线队列 | 断网时写入本地队列，`online` 后静默补发；导入备份带防回退守卫 |
| 朗读 | `POST /api/tts/session` → `POST /api/tts/session/{id}/chunks` → `GET /api/tts/session/{id}/audio` 与 `/events`（另有 `POST /api/tts/speak` 单句） | `TtsSessionService` | 首帧垫 144 字节静音、`X-Accel-Buffering: no` 穿反代缓冲；单句时长随事件下发，前端按相对时钟锚定 |

## 5. 前端模块

入口是 `web/src/main.tsx`（路由 + 页面壳 + 几个 store）。按职责分五块，细节与逐文件行数见
[`code-map-frontend.md`](code-map-frontend.md)：

- **外壳与导航**：一级目的地只有一张表（`shortcuts.ts` 的 `PRIMARY_PAGES` 同时喂顶栏、数字键、`Alt+←/→`）。
  规则 / 备份 / 更新日志 / 关于 自 0.6.27 起是**悬浮层**（`PageDialog`），不占路由。
- **阅读器**：`ReaderScreen.tsx`(2780) 只做编排，几何与翻页算术在 `readerFlow.ts`、手势在
  `readerInteractions.ts`、点击区域在 `tapZones.ts` + `TapZoneEditor.tsx`。三块都是纯算式，单测钉住；
  画面上的位移由 `tools/verify/reader-flow-check.mjs`、`paginate-flow-check.mjs` 逐帧量。
- **设置与本机存储**：`readerSettings.ts`（唯一那份阅读偏好，含皮肤叠加基档）、`offlineStorage.ts`
  （IndexedDB：正文分片 + 书架快照 + 离线进度队列）。
- **浮层一档**：所有弹窗共用 `.dialog-shell` + `.overlay-backdrop` + `.overlay-close` 一档几何
  （PROPOSAL-018 W2）。**判据按"这条规则声明了什么"数，不按类名叫什么数** —— 后者一改名就漏。
- **错误边界**：`ErrorBoundary.tsx` 包根与阅读器；某一块炸了不能把整棵树带走。

## 6. 验证面（谁在守什么）

| 档 | 命令 | 覆盖 | 注意 |
| :--- | :--- | :--- | :--- |
| 单测与静态判据 | `npm --prefix web test`（= `tsx test/run-all.ts`）、`./gradlew :server:test` | 纯算式、组件静态渲染、规则求值、库层 | `run-all.ts` 是逐个 `import` 登记的，新文件不加那一行等于没跑；Windows 上服务端有既有失败基线，**判回归比失败集合，不比数量** |
| 真浏览器门禁 | `node tools/verify/<name>-check.mjs` | 版面、图层、交互、端到端链路，全部 `getComputedStyle` / `getBoundingClientRect` 现量，不打桩 | **一律串行跑**（多个门禁会互删探针、抢同一个 profile）；判据等条件不 `sleep`；探针带本轮 STAMP 并自清 |
| 部署后 | `node tools/verify/selfcheck.mjs`、`version-check.mjs` | 搜索→详情→目录→正文→净化，以及"版本号五处同号" | jar 必须在 `web/dist` 之后打，否则烤进旧 bundle，三条判据齐红 |

## 7. 改动边界

三个 git 工作树共享一份历史：`main`（合流目标）、`ai1/backend`、`ai2/frontend`。
**谁改什么、遇到具体情况照哪一行做，只在 [`COLLABORATION.md`](COLLABORATION.md) 里**——本文件不复述规则，
复述就是下一次"同一个真相写两处"。工作树与分支的对应关系见 [`dual-ai-setup.md`](dual-ai-setup.md)。

# API 契约

> 本文件由 **AI-1** 主导维护。AI-2 只读，如需变更请在 `docs/dual-ai/COORDINATION-ai2.md` 发起 `API-REQUEST`。
>
> 本文档为初稿，于 2026-10-11 从 `server/` 代码（Ktor，`Routes.kt` / `Models.kt` / `Application.kt` / `Guard.kt`）提取。
> 标注 `TODO` 处为未逐 handler 核实、需 AI-1 补全的部分。

## 全局约定

- **根路径**：所有业务接口挂在 `route("/api")` 下（见 `Routes.kt:82`），完整路径即 `/api/...`。
  另有独立健康检查 `GET /healthz`（`Application.kt:136`，**不在** `/api` 下）。
- **序列化**：`install(ContentNegotiation)` 使用 kotlinx `Json`（`Application.kt:110-114`）：
  `ignoreUnknownKeys = true`（忽略未知字段）、`explicitNulls = false`（null 字段省略不输出）、
  `encodeDefaults = true`（取值等于默认值的字段**也会**输出——前端依赖此行为，缺字段会白屏）。
  请求体解析失败统一返回 `400 {code:"invalid_request"}`。
- **认证（无登录）**：服务**无**登录态 / token。
  但**写操作（POST / PUT / DELETE）受同源闸门保护**（`Guard.kt` `requireSameOriginWrite`）：
  浏览器跨站写请求必须带 `Origin` 头且指向服务自身绑定的 `host:port`，否则 `403 {code:"cross_origin"}`；
  无 `Origin` 头的非浏览器客户端（curl、浏览器扩展、服务间调用）放行。
  ⚠️ 免登录依赖绑定**回环地址**（`127.0.0.1`）；若改绑 `0.0.0.0` 则免登录自动失效（`runtime.mjs` 注释）。
- **错误格式**：`ApiError(code: String, message: String)`（`Models.kt:5`）。
- **端口 / 绑定**：由 `LEGADO_HOST` / `LEGADO_PORT`（默认 `127.0.0.1:1234`，裸 jar 默认 `8080`）控制，见 `docs/dual-ai/README.md`。

## 端点清单

> 列「认证」：`读`=GET（无闸门）；`写`=POST/PUT/DELETE（受同源闸门，见上）。
> 入参/出参写模型名（见「数据模型」节）；`TODO` 为未逐 handler 核实。

| 方法 | 路径 | 入参 | 出参 | 认证 | 备注 |
|---|---|---|---|---|---|
| GET | `/healthz` | — | `HealthStatus` | 读 | 健康检查，不在 `/api` 下 |
| GET | `/api/server` | — | `ServerInfo` | 读 | 当前绑定 host/port |
| PUT | `/api/server/port` | `ServerPortRequest` | `ServerPortResult` | 写 | 只写 `port.txt`，需重启生效 |
| GET | `/api/sources` | — | `List<SourceSummary>` | 读 | 书源列表 |
| GET | `/api/cookies` | — | `GlobalCookieListResponse` | 读 | 全局 cookie |
| DELETE | `/api/cookies` | — | — | 写 | 清全局 cookie |
| POST | `/api/sources/batch` | `ImportRequest` | `ImportResponse` | 写 | 批量导入书源 |
| POST | `/api/sources/health-check` | — | TODO | 写 | 书源健康巡检 |
| GET | `/api/sources/export` | — | 文件流 | 读 | 导出书源 |
| POST | `/api/sources/import` | `ImportRequest` | `ImportResponse` | 写 | 导入书源 |
| PUT | `/api/sources/order` | `SourceOrderRequest` | — | 写 | 书源自定义排序 |
| DELETE | `/api/sources/order` | — | — | 写 | 清书源排序 |
| POST | `/api/sources/{id}/validate` | `SourceValidateRequest` | `ValidateResponse` | 写 | 校验书源 JSON |
| GET | `/api/sources/{id}/debug` | `DebugRequest`? | TODO | 读 | 书源调试 |
| GET | `/api/sources/{id}/explore` | — | TODO | 读 | 发现页 |
| GET | `/api/sources/{id}/login-ui` | — | `SourceLoginUiResponse` | 读 | 登录页 UI 描述 |
| POST | `/api/sources/{id}/login-info` | `SourceLoginInfoUpdateRequest` | — | 写 | 更新登录信息 |
| DELETE | `/api/sources/{id}/login-info` | — | — | 写 | 删登录信息 |
| POST | `/api/sources/{id}/login-header` | `SourceLoginHeaderUpdateRequest` | — | 写 | 更新登录 header |
| OPTIONS | `/api/sources/{id}/login-cookie` | — | — | 读 | 预检 |
| POST | `/api/sources/{id}/login-cookie` | `SourceLoginCookieUpdateRequest` | `SourceLoginCookieResponse` | 写 | 更新登录 cookie |
| DELETE | `/api/sources/{id}/login-header` | — | — | 写 | 删登录 header |
| POST | `/api/sources/{id}/login-action` | `SourceLoginActionRequest` | `SourceLoginActionResult` | 写 | 执行登录动作 |
| GET | `/api/sources/{id}/login-check` | — | `SourceLoginCheckResult` | 读 | 登录态检查 |
| GET | `/api/sources/{id}/credential` | — | `SourceCredentialStatus` | 读 | 凭据状态 |
| POST | `/api/sources/{id}/browser/session` | `SourceBrowserSessionRequest` | `SourceBrowserSessionResponse` | 写 | 开浏览器会话 |
| DELETE | `/api/sources/{id}/browser/session` | — | — | 写 | 关浏览器会话 |
| GET | `/api/sources/{id}/browser/cookies` | — | `SourceBrowserCookieResponse` | 读 | 取浏览器 cookie |
| DELETE | `/api/sources/{id}/browser/cookies` | — | — | 写 | 清浏览器 cookie |
| POST | `/api/sources/{id}/browser/res/capture` | — | TODO | 写 | 抓取浏览器资源 |
| GET | `/api/sources/{id}/browser/res/page` | — | TODO | 读 | 取页面 |
| POST | `/api/sources/{id}/browser/res/inline` | `SourceBrowserInlineRequest` | `SourceBrowserInlineResponse` | 写 | 内联资源 |
| GET | `/api/sources/{id}/external-login/submit` | — | TODO | 读 | 外部登录提交（GET） |
| POST | `/api/sources/{id}/external-login/submit` | TODO | TODO | 写 | 外部登录提交（POST） |
| POST | `/api/search` | `SearchRequest` | 流式 `SearchResult` | 写 | 搜索（SSE/流式，配合下方 WS） |
| WS | `/api/search/stream` | — | `SearchStreamEvent` | 写 | 搜索结果流式推送（唯一 WebSocket） |
| GET | `/api/explore/sources` | — | TODO | 读 | 发现源列表 |
| POST | `/api/explore` | `ExploreRequest` | TODO | 写 | 发现 |
| GET | `/api/subscriptions` | — | `List<SourceSubscription>` | 读 | 订阅列表 |
| POST | `/api/subscriptions` | `SubscriptionWriteRequest` | `SourceSubscription` | 写 | 新增订阅 |
| DELETE | `/api/subscriptions/{id}` | — | — | 写 | 删订阅 |
| POST | `/api/subscriptions/{id}/update` | — | TODO | 写 | 更新单条订阅 |
| POST | `/api/subscriptions/update` | — | TODO | 写 | 批量更新订阅 |
| GET | `/api/logs` | — | 文本/数组 | 读 | 服务端日志 |
| DELETE | `/api/logs` | — | — | 写 | 清日志 |
| GET | `/api/about` | — | `AboutInfo` | 读 | 关于信息 |
| POST | `/api/about/update-check` | — | `UpdateCheckResult` | 写 | 检查更新 |
| GET | `/api/changelog` | — | TODO | 读 | 更新日志 |
| GET | `/api/backup/kept` | — | TODO | 读 | 保留的备份列表 |
| GET | `/api/backup/kept/{name}` | — | 文件流 | 读 | 下载某备份 |
| POST | `/api/backup/import` | 文件上传 | TODO | 写 | 导入备份 |
| GET | `/api/rss/sources` | — | `List<RssSourceSummary>` | 读 | RSS 源列表 |
| POST | `/api/rss/sources` | `RssSourceSummary` | — | 写 | 增/改 RSS 源 |
| POST | `/api/rss/sources/enabled` | `RssSourceEnabledRequest` | — | 写 | 启停 RSS 源 |
| DELETE | `/api/rss/sources` | — | — | 写 | 删 RSS 源 |
| GET | `/api/rss/tabs` | — | `List<ExploreTab>` | 读 | RSS 标签页 |
| POST | `/api/rss/articles` | `RssArticlesRequest` | TODO | 写 | RSS 文章列表 |
| POST | `/api/rss/content` | `RssContentRequest` | TODO | 写 | RSS 文章内容 |
| POST | `/api/books/details` | `BookRequest` | `BookDetails` | 写 | 书籍详情 |
| POST | `/api/books/chapters` | `BookRequest` | `List<Chapter>` | 写 | 目录 |
| POST | `/api/books/content` | `ContentRequest` | `ChapterContent` | 写 | 章节正文 |
| GET | `/api/bookshelf` | — | `List<BookshelfItem>` | 读 | 书架列表 |
| POST | `/api/bookshelf` | `BookshelfWriteRequest` | — | 写 | 加书到书架 |
| POST | `/api/bookshelf/import-local` | `multipart/form-data`（文件 part + 可选 query `tocRule`） | `LocalBookImportResponse` | 写 | 本地书导入；`tocRule` 走 query 参数；文件按「书名-作者.txt」被目录规则解析 |
| GET | `/api/books/toc-rules` | — | `TocRuleList` | 读 | 本地书分章规则列表 |
| POST | `/api/books/toc-rules/toggle` | `TocRuleToggleRequest` | `TocRuleToggleResult` | 写 | 启停规则 |
| POST | `/api/books/toc-rules/save` | `TocRuleSaveRequest` | `TocRuleSaveResult` | 写 | 增/改规则 |
| POST | `/api/books/toc-rules/delete` | — | `TocRuleDeleteResult` | 写 | 删规则 |
| POST | `/api/books/toc-rules/reset` | — | `TocRuleResetResult` | 写 | 恢复随包规则 |
| POST | `/api/books/toc-rules/apply-backup` | — | `TocRuleApplyResult` | 写 | 套用备份规则 |
| POST | `/api/books/reparse-local` | `LocalBookReparseRequest` | `LocalBookReparseResult` | 写 | 本地书重切目录 |
| GET | `/api/bookshelf/groups` | — | `List<BookGroup>` | 读 | 书架分组列表 |
| POST | `/api/bookshelf/groups` | `BookGroupCreateRequest` | — | 写 | 新建分组 |
| DELETE | `/api/bookshelf/groups/{id}` | — | — | 写 | 删分组 |
| PUT | `/api/bookshelf/group` | `BookGroupAssignRequest` | — | 写 | 设书所属分组 |
| PUT | `/api/bookshelf/order` | `ShelfOrderRequest` | `ShelfOrderResult` | 写 | 书架自定义排序 |
| DELETE | `/api/bookshelf/order` | — | — | 写 | 清排序 |
| DELETE | `/api/bookshelf` | `?sourceId=...&bookUrl=...` | `204 No Content` | 写 | **按 query 移除单本**（非清空）；清空请用 `POST /api/bookshelf/batch-delete` |
| POST | `/api/bookshelf/cache` | `BookCacheRangeRequest` | `CachedChaptersResponse` | 写 | 离线缓存章节范围 |
| GET | `/api/bookshelf/cached-chapters` | — | `CachedChaptersResponse` | 读 | 已缓存章节 |
| DELETE | `/api/bookshelf/cache` | — | — | 写 | 清缓存 |
| PUT | `/api/bookshelf/status` | `BookshelfStatusRequest` | — | 写 | 标记读完/未完 |
| PUT | `/api/bookshelf/info` | `BookshelfInfoUpdateRequest` | — | 写 | 改书名/作者/封面 |
| POST | `/api/bookshelf/switch-source` | `BookshelfSourceSwitchRequest` | — | 写 | 换源 |
| POST | `/api/bookshelf/batch-delete` | `BatchDeleteRequest` | — | 写 | 批量删 |
| POST | `/api/bookshelf/batch-move-group` | `BatchMoveGroupRequest` | — | 写 | 批量移组 |
| POST | `/api/bookshelf/batch-mark-read` | `BatchMarkReadRequest` | — | 写 | 批量标记已读 |
| GET | `/api/covers/{key}` | — | 图片流 | 读 | 封面 |
| GET | `/api/covers/proxy` | — | 图片流 | 读 | 封面代理 |
| GET | `/api/books/local/asset` | — | 文件流 | 读 | 本地书内嵌资源 |
| GET | `/api/book/image` | — | 图片流 | 读 | 书籍图片 |
| GET | `/api/book/media` | — | 文件流 | 读 | 书籍媒体（音频/EPUB 直链等） |
| GET | `/api/reading-progress` | — | `ReadingProgress` | 读 | 阅读进度 |
| PUT | `/api/reading-progress` | `ReadingProgress` | — | 写 | 保存阅读进度 |
| GET | `/api/tts/voices` | — | `List<TtsVoice>` | 读 | TTS 音色列表 |
| POST | `/api/tts/session` | TODO | `TtsSessionInfo` | 写 | 开 TTS 会话 |
| POST | `/api/tts/session/{id}/chunks` | `TtsSessionChunkRequest` | `TtsSessionAck` | 写 | 喂文本分块 |
| POST | `/api/tts/session/{id}/control` | `TtsSessionControlRequest` | — | 写 | 控制（播放/暂停/停止） |
| DELETE | `/api/tts/session/{id}` | — | — | 写 | 关会话 |
| GET | `/api/tts/session/{id}/audio` | — | 音频流 | 读 | 音频 |
| GET | `/api/tts/session/{id}/events` | — | `TtsSessionEvent` 流（SSE） | 读 | TTS 事件流 |
| POST | `/api/tts/speak` | `TtsSpeakRequest` | TODO | 写 | 直接朗读 |
| GET | `/api/tts/speak` | — | TODO | 读 | 朗读状态（待核实） |
| GET | `/api/book/export/txt` | `?sourceId=&bookUrl=` | `text/plain` 文件流（Content-Disposition RFC5987 文件名） | 读 | ⚠️ **WIP**：TXT 导出功能在 stash（未上 main），恢复并 review 后定稿 |
| POST | `/api/book/export/txt-batch` | TODO（待恢复 stash 确认） | 文件流/zip | 写 | ⚠️ **WIP**：同上 |

## WebSocket

| 路径 | 消息格式 | 方向 | 备注 |
|---|---|---|---|
| `/api/search/stream` | `SearchStreamEvent`（`Models.kt:278`） | 服务端 → 客户端 | 搜索结果流式推送。字段：`type` / `sourceId` / `result: SearchResult?` / `done` / `error` — **TODO：逐字段核实** |

> 注：`/api/tts/session/{id}/events` 为 **SSE（Server-Sent Events）** 流而非 WebSocket（据 `Routes.kt:1777` 为 `get`）。**TODO：确认 TTS 事件传输方式。**

## 数据模型

> 全部 `@Serializable`（kotlinx）。字段签名取自 `Models.kt`，已核对。

| 模型 | 字段 | 类型 | 备注 |
|---|---|---|---|
| `ApiError` | `code: String, message: String` | 响应 | 统一错误 |
| `HealthStatus` | `title: String, version: String, status: String` | 响应 | `/healthz` |
| `SourceSummary` | `id, name, ...` | 响应 | **TODO：补全字段** |
| `ImportRequest` | `sources: List<String>, overwrite: Boolean = true` | 请求 | |
| `ImportResponse` | `imported: Int, updated: Int = 0, skipped: Int, errors: List<String>` | 响应 | |
| `SourceValidateRequest` | `json: String? = null` | 请求 | |
| `ValidateResponse` | `valid: Boolean, errors: List<String>, warnings: List<String>` | 响应 | |
| `SourceLoginUiResponse` | `items: List<SourceLoginUiItem>, ...` | 响应 | `Models.kt:52` |
| `SourceLoginInfoUpdateRequest` | `json: String, version: Long? = null` | 请求 | `Models.kt:68` |
| `SourceLoginHeaderUpdateRequest` | TODO | 请求 | |
| `SourceLoginCookieUpdateRequest` | TODO | 请求 | |
| `SourceLoginCookieResponse` | TODO | 响应 | |
| `SourceLoginActionRequest` | `action: String, ...` | 请求 | `Models.kt:75` |
| `SourceLoginActionResult` | TODO | 响应 | |
| `SourceLoginCheckResult` | TODO | 响应 | |
| `SourceCredentialStatus` | TODO | 响应 | |
| `SourceBrowserSessionRequest` | TODO | 请求 | |
| `SourceBrowserSessionResponse` | `sessionId: String, ...` | 响应 | |
| `SourceBrowserCookieResponse` | TODO | 响应 | |
| `SourceBrowserInlineRequest` | `url: String, ...` | 请求 | `Models.kt:148` |
| `SourceBrowserInlineResponse` | TODO | 响应 | |
| `SearchRequest` | `keyword: String, sourceIds: List<String>? = null` | 请求 | `Models.kt:249` |
| `SearchResult` | `sourceId, name, author?, bookUrl, coverUrl?, intro?, kind?, wordCount?, lastChapter?, sourceType: Int = 0` | 响应 | `Models.kt:289` |
| `SearchStreamEvent` | `type, totalSources, completedSources, matchedSources, emptySources, failedSources, resultCount, results: List<SearchResult>, message?`（`type`: `start\|results\|progress\|done\|error`） | SSE（WS `/api/search/stream` 下发） | 由 AI-2 核对补全（2026-10-11） |
| `ExploreTab` | `title: String, url: String` | 响应 | `Models.kt:250` |
| `ExploreRequest` | `sourceId: String, url: String, page: Int = 1` | 请求 | `Models.kt:251` |
| `SubscriptionWriteRequest` | `url: String, enabled: Boolean = true` | 请求 | `Models.kt:234` |
| `SourceSubscription` | `url: String, enabled: Boolean, ...` | 响应 | `Models.kt:235` |
| `RssSourceSummary` | `url: String, ...` | 请求/响应 | `Models.kt:257` |
| `RssArticlesRequest` | `sourceUrl: String, url: String, page: Int = 1` | 请求 | `Models.kt:275` |
| `RssContentRequest` | `sourceUrl: String, link: String` | 请求 | `Models.kt:276` |
| `BookRequest` | `sourceId: String, bookUrl: String` | 请求 | `Models.kt:302` |
| `BookDetails` | `sourceId, name, author?, intro?, coverUrl?, tocUrl, kind?, wordCount?, lastChapter?, sourceType: Int = 0` | 响应 | `Models.kt:303` |
| `Chapter` | `index: Int, title: String, url: String, isVolume: Boolean = false` | 响应 | `Models.kt:316` |
| `ContentRequest` | `sourceId: String, chapterUrl: String = "", bookUrl: String? = null` | 请求 | `Models.kt:317` |
| `ChapterContent` | `title?: String, content: String, mediaUrl?: String` | 响应 | `Models.kt:318`；`mediaUrl` 用于音频/EPUB 直链 |
| `ReadingProgress` | `sourceId, bookUrl, chapterUrl, chapterIndex: Int, scrollPosition: Double = 0.0, updatedAt: Long = 0` | 请求/响应 | `Models.kt:327` |
| `BookshelfWriteRequest` | `sourceId, bookUrl, name, author?, tocUrl, coverUrl?, alternateSources?: List<SearchResult>` | 请求 | `Models.kt:335` |
| `BookshelfSourceSwitchRequest` | `oldSourceId, oldBookUrl, book: BookshelfWriteRequest, alternateSources?` | 请求 | `Models.kt:344` |
| `BookshelfStatusRequest` | `sourceId, bookUrl, completed: Boolean` | 请求 | `Models.kt:350` |
| `BookshelfInfoUpdateRequest` | `sourceId, bookUrl, name, author?, coverUrl?` | 请求 | `Models.kt:351` |
| `BookshelfItem` | `sourceId, bookUrl, name, author?, tocUrl, coverKey?, chapterIndex?, scrollPosition?, lastReadAt: Long, tocUpdatedAt: Long = 0, cachedChapters: Int = 0, totalChapters: Int = 0, cacheState: String = "idle", cacheError?, completed: Boolean = false, alternateSources: List<SearchResult> = [], groupId: Long = 0, tocRule?: String, sortOrder?: Int, sourceType: Int = 0` | 响应 | `Models.kt:380` |
| `BookGroup` | `id: Long, name: String, bookCount: Int = 0` | 响应 | `Models.kt:413` |
| `BookGroupCreateRequest` | `name: String` | 请求 | |
| `BookGroupAssignRequest` | `sourceId, bookUrl, groupId: Long` | 请求 | |
| `BookCacheRangeRequest` | `sourceId, bookUrl, startIndex?, endIndex?, count?` | 请求 | `Models.kt:366` |
| `CachedChaptersResponse` | `sourceId, bookUrl, cachedChapterUrls: List<String>, cachedCount: Int, totalChapters: Int = 0` | 响应 | `Models.kt:373` |
| `BatchDeleteRequest` | `books: List<BookIdentifier>` | 请求 | `Models.kt:490` |
| `BatchMoveGroupRequest` | `books: List<BookIdentifier>, groupId: Long?` | 请求 | |
| `BatchMarkReadRequest` | `books: List<BookIdentifier>, isRead: Boolean` | 请求 | |
| `BookIdentifier` | `sourceId: String, bookUrl: String` | 请求 | `Models.kt:493` |
| `ShelfOrderRequest` | `books: List<BookIdentifier>` | 请求 | `Models.kt:495` |
| `ShelfOrderResult` | `updated: Int` | 响应 | |
| `TocRuleList` | `options: List<TocRuleOption>, enabled: Int = 0, total: Int = 0, fromBackup: Int = 0, overridden: Boolean = false` | 响应 | `Models.kt:441` |
| `TocRuleOption` | `key, label, example: String = "", builtIn: Boolean = false, rule: String = "", enable: Boolean = true, broken: Boolean = false, removable: Boolean = false` | 响应 | `Models.kt:427` |
| `TocRuleToggleRequest` | `key: String, enable: Boolean` | 请求 | `Models.kt:450` |
| `TocRuleToggleResult` | `id: Int, name: String, enable: Boolean` | 响应 | |
| `TocRuleSaveRequest` | `key?: String, name: String, rule: String, example?, enable: Boolean = true` | 请求 | `Models.kt:454` |
| `TocRuleSaveResult` | `id: Int, name, rule, enable: Boolean, total: Int` | 响应 | |
| `TocRuleDeleteResult` | `removed: Boolean, total: Int` | 响应 | |
| `TocRuleResetResult` | `cleared: Boolean, total: Int` | 响应 | |
| `TocRuleApplyResult` | `matched: Int = 0, flipped: Int = 0, added: Int = 0, unusable: Int = 0, total: Int = 0` | 响应 | `Models.kt:468` |
| `LocalBookReparseRequest` | `sourceId, bookUrl, ruleKey: String` | 请求 | `Models.kt:475` |
| `LocalBookReparseResult` | `success: Boolean, name: String = "", totalChapters: Int = 0, tocRuleUsed: String = "", ruleLabel: String = "", fellBack: Boolean = false, error?` | 响应 | `Models.kt:477` |
| `ServerInfo` | `host: String, port: Int` | 响应 | `Models.kt:507` |
| `ServerPortRequest` | `port: Int` | 请求 | `Models.kt:510` |
| `ServerPortResult` | `port: Int, restartRequired: Boolean` | 响应 | `Models.kt:512` |
| `AboutInfo` | `title, version, repository: String` | 响应 | `Models.kt:501` |
| `UpdateCheckResult` | `current, latest?, url?, publishedAt?, repository, status, message?`（`status`: latest/available/not_found/unreachable） | 响应 | `Models.kt:515` |
| `TtsVoice` | `id, name, lang, gender, localeName, engine: String = "edge", description?` | 响应 | `Models.kt:526` |
| `TtsSpeakRequest` | `text, voice: String = "zh-CN-XiaoxiaoNeural", rate: Int = 0, pitch: Int = 0, engine: String = "edge", customUrl?, customHeader?, customMethod?, customBody?` | 请求 | `Models.kt:537` |
| `TtsSessionInfo` | `sessionId, audioUrl, eventsUrl` | 响应 | `Models.kt:550` |
| `TtsSessionChunkRequest` | `chunkId, text, chapterIndex: Int = -1, paragraphIndex: Int = -1, engine: String = "edge", voice, rate: Int = 0, pitch: Int = 0, custom*` | 请求 | `Models.kt:557` |
| `TtsSessionControlRequest` | `action: String` | 请求 | `Models.kt:573` |
| `TtsSessionAck` | `accepted: Boolean` | 响应 | `Models.kt:578` |
| `TtsSessionEvent` | `type: String, sessionId, chunkId?, chapterIndex: Int = -1, paragraphIndex: Int = -1, audioEndMs?, durationMs?, message?` | SSE | `Models.kt:583` |
| `ReplaceRule` | `id: String = "", name: String = "", group?, ...` | 请求/响应 | **TODO：补全字段**（`Models.kt:595`） |
| `LocalBookImportResponse` | `total: Int, imported: Int, failed: Int, results: List<LocalBookImportItem>` | 响应 | `import-local` 出参 |
| `LocalBookImportItem` | `filename: String, success: Boolean, bookUrl?, name?, author?, totalChapters?, error?` | 响应 | 导入单项结果 |
| `CookieBucket` / `GlobalCookieEntry` | TODO | — | `Models.kt:166/172` |

## 变更历史

| 日期 | 变更 | 影响 | 提交 |
|---|---|---|---|
| 2026-10-11 | 初稿：从 `server/` 代码提取全部 `/api` 端点、WebSocket、数据模型 | AI-2 可读此契约对齐前端 | 4336cdf |
| 2026-10-11 | API-CHANGE：按 AI-2 的 `API-REQUEST` 修正 4 处——`import-local` 改 multipart、`DELETE /bookshelf` 改单本按 query、`SearchStreamEvent` 补全字段、标注 `export/txt` 为 WIP | AI-2 前端可按新契约对齐 | 待提交 |

> TODO（待 AI-1 补全）：
> 1. 各端点的精确入参/出参模型（尤其 `Source*` 登录链路、`Rss*`、`ReplaceRule*`、`/backup/*`、`/logs`）。
> 2. `SearchStreamEvent` 与 `TtsSessionEvent` 的完整字段。
> 3. 流式接口（`/api/search`、`/api/tts/session/{id}/events`）的传输格式（SSE vs 分块 JSON）。
> 4. 分页 / 查询参数约定（如书架、订阅、RSS 文章是否分页）。
> 5. 文件上传接口（`/api/backup/import`、`/api/bookshelf/import-local`）的请求格式（multipart？）。

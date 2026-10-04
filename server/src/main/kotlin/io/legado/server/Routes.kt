package io.legado.server

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.http.content.LocalFileContent
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import io.ktor.http.content.PartData
import io.ktor.http.content.forEachPart
import io.ktor.http.content.streamProvider
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID
import java.net.URI
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicInteger

/** 外部浏览器登录的统一回包：开着没有、是哪个浏览器、目标域、以及哪些域已经见到 Cookie。 */
private fun externalLoginStatus(
    externalLogin: ExternalBrowserLogin,
    hosts: List<String>,
    seen: List<String>?,
) = ExternalLoginStatus(
    opened = externalLogin.status() != null,
    browser = externalLogin.status()?.browser ?: "",
    port = externalLogin.status()?.port ?: 0,
    pid = externalLogin.status()?.pid ?: 0,
    hosts = hosts,
    seen = seen ?: emptyList(),
)

/** 不设身份后，朗读会话的"归属者"就是这台机器上的唯一用户。 */
internal const val LOCAL_TTS_OWNER = "local"

fun Route.apiRoutes(
    database: Database,
    runner: RuleRunner,
    coverCache: CoverCache,
    subscriptions: SubscriptionService,
    bookCache: BookCacheService,
    edgeTts: EdgeTtsService = EdgeTtsService(),
    ttsSessions: TtsSessionService = TtsSessionService(edgeTts),
    localBooksDirectory: Path = Path.of(".data/local_books"),
) {
    val webView = WebViewProxy(database)
    // 备份包里没有原生归宿的个性化条目，原样收在数据目录下的一个文件夹里（见 BackupStore 的取舍说明）。
    val backupKeep = BackupStore(localBooksDirectory.resolveSibling("backup_kept"))
    // 规则表的本机改动（手机备份套进来的启用选择与自定义规则）落在 data 下一个文件里，不建表：
    // 这张表只在切目录时被读一次，建表反而让"改了没生效"变成要查数据库的事。
    TocRules.useStore(localBooksDirectory.resolveSibling("txt_toc_rules.json"))
    // 真浏览器登录：profile 放在数据目录下（与 local_books 同级），登录态跨次启动保留。
    val externalLogin = ExternalBrowserLogin(database, localBooksDirectory.resolveSibling("external-browser-profile"))
    val debugger = SourceDebugger(runner)
    route("/api") {
        get("/sources") {
            call.respond(database.listSources(call.request.queryParameters["q"]))
        }
        // 全局登录凭据表：删书源不再连带清桶（凭据按注册域共享），所以必须有个地方
        // 能看见全部、能逐个撤掉 —— 否则就成了"看不见又删不掉"。
        get("/cookies") {
            val rows = withContext(Dispatchers.IO) {
                // 一次扫描拿到全部桶的计数：逐桶查以前把这个接口拖到 2 分半
                val mentions = database.cookieBucketMentions()
                database.listCookieBuckets().map { bucket ->
                    GlobalCookieEntry(
                        domain = bucket.domain,
                        keys = bucket.keys,
                        mentionedBy = mentions[bucket.domain] ?: 0,
                    )
                }
            }
            call.respond(GlobalCookieListResponse(count = rows.size, cookies = rows))
        }
        delete("/cookies") {
            if (!call.requireSameOriginWrite()) return@delete
            val target = call.request.queryParameters["u"]?.trim()
            if (target.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 u 参数（要删除哪个域的凭据）"))
                return@delete
            }
            val removed = withContext(Dispatchers.IO) { database.removeCookieBucket(target) }
            call.respond(mapOf("ok" to true, "removed" to removed))
        }
        post("/sources/batch") {
            if (!call.requireSameOriginWrite()) return@post
            val req = call.receive<BatchSourceRequest>()
            if (req.ids.isEmpty()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("empty_selection", "请先选择需要操作的书源"))
                return@post
            }
            try {
                val count = database.batchUpdateSources(req.ids, req.action, req.group)
                val msg = when (req.action) {
                    "enable" -> "已成功启用 $count 个书源"
                    "disable" -> "已成功停用 $count 个书源"
                    "delete" -> "已成功删除 $count 个书源"
                    "set_group" -> if (req.group.isNullOrBlank()) "已清空 $count 个书源的分组" else "已将 $count 个书源移至分组“${req.group}”"
                    "tag_group" -> "已为 $count 个书源加上标签“${req.group}”"
                    "untag_group" -> "已摘掉 $count 个书源的标签“${req.group}”"
                    else -> "已处理 $count 个书源"
                }
                call.application.log.info("source batch operation: action={}, count={}", req.action, count)
                call.respond(BatchSourceResponse(ok = true, affected = count, action = req.action, message = msg))
            } catch (error: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_action", error.message ?: "无效的批量操作"))
            } catch (error: Throwable) {
                call.application.log.error("source batch operation failed", error)
                call.respond(HttpStatusCode.InternalServerError, ApiError("batch_failed", error.message ?: "批量操作失败"))
            }
        }
        post("/sources/health-check") {
            // 这个接口会让服务端对全部启用书源发起外呼，属于「能被跨站触发的资源消耗」，
            // 因此和其余写接口一样要 CSRF；原来还把请求体解析失败吞成默认值，等于允许空体跨站触发。
            if (!call.requireSameOriginWrite()) return@post
            val req = runCatching { call.receive<SourceHealthCheckRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@post
            }
            val timeoutMs = req.timeoutMs.coerceIn(1000L, 10000L)
            val allSources = database.listSources(null)
            // 没点名 ids 时只体检**启用中**的源。整库 5,574 个里被用户停用的那批他根本不读，
            // 探它们既慢（并发 16、单个 5 秒超时，一轮就是几十分钟）又会在结果里堆一大片
            // 「连不上」，把真正要看的那几十个淹掉 —— 这正是「体检过慢、管理功能异常」的实测成因。
            // 停用的那批仍可显式点名（ids）或在界面上勾「连停用的一起体检」来覆盖。
            val targetSources = if (!req.ids.isNullOrEmpty()) {
                val idSet = req.ids.toSet()
                allSources.filter { it.id in idSet }
            } else {
                allSources.filter { it.enabled }
            }

            val startTotalNs = System.nanoTime()
            val health = SourceHealth(runner)
            val semaphore = Semaphore(16)

            val results = coroutineScope {
                targetSources.map { summary ->
                    async(Dispatchers.IO) {
                        semaphore.withPermit {
                            val record = database.getSource(summary.id)
                            if (record == null) {
                                SourceHealthCheckItem(
                                    id = summary.id,
                                    name = summary.name,
                                    ok = false,
                                    latencyMs = 0L,
                                    statusCode = 0,
                                    statusCategory = "invalid",
                                    error = "书源记录不存在",
                                )
                            } else {
                                health.probe(summary.id, summary.name, record.json, req.keyword ?: "都市", timeoutMs)
                            }
                        }
                    }
                }.awaitAll()
            }
            val totalDurationMs = (System.nanoTime() - startTotalNs) / 1_000_000
            val successCount = results.count { it.statusCategory == "valid" }
            val slowCount = results.count { it.statusCategory == "slow" }
            val failedCount = results.count { !it.ok }

            call.respond(
                SourceHealthCheckResponse(
                    total = results.size,
                    successCount = successCount,
                    slowCount = slowCount,
                    failedCount = failedCount,
                    durationMs = totalDurationMs,
                    results = results,
                )
            )
        }
        get("/sources/export") {
            call.respondText(
                text = Json.encodeToString(database.exportSources(call.request.queryParameters.getAll("id"))),
                contentType = ContentType.Application.Json.withCharset(Charsets.UTF_8),
            )
        }
        post("/sources/import") {
            if (!call.requireSameOriginWrite()) return@post
            val response = database.importSources(call.receive<ImportRequest>().sources)
            call.application.log.info("source import completed: imported={}, updated={}, skipped={}", response.imported, response.updated, response.skipped)
            call.respond(response)
        }
        // 注册在 `/sources/{id}` 之前：字面段本来就优先于参数段，但顺序摆在这儿，
        // 读代码的人不用去查路由树的优先级就能确定 `PUT /sources/order` 打的是哪一个。
        put("/sources/order") {
            if (!call.requireSameOriginWrite()) return@put
            val request = runCatching { call.receive<SourceOrderRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@put
            }
            if (request.ids.isEmpty()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("empty_order", "没有要排序的书源")); return@put
            }
            call.respond(ShelfOrderResult(database.reorderSources(request.ids)))
        }
        delete("/sources/order") {
            if (!call.requireSameOriginWrite()) return@delete
            call.respond(ShelfOrderResult(database.clearSourceOrder()))
        }
        route("/sources/{id}") {
            get {
                val source = database.getSource(call.parameters["id"]!!)
                if (source == null) call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")) else call.respond(source)
            }
            put {
                if (!call.requireSameOriginWrite()) return@put
                val request = call.receive<SourceWriteRequest>()
                try { call.respond(database.saveSource(SourceCodec.parse(request.json), request.version)); call.application.log.info("source updated: {}", call.parameters["id"]) }
                catch (_: VersionConflict) { call.respond(HttpStatusCode.Conflict, ApiError("version_conflict", "书源已在其他页面更新，请刷新后重试")) }
                catch (error: IllegalArgumentException) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_source", error.message ?: "书源无效")) }
            }
            delete {
                if (!call.requireSameOriginWrite()) return@delete
                if (database.deleteSource(call.parameters["id"]!!)) { call.application.log.info("source deleted: {}", call.parameters["id"]); call.respond(HttpStatusCode.NoContent) } else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在"))
            }
            post("/validate") {
                if (!call.requireSameOriginWrite()) return@post
                // 带草稿时校验编辑器里的未保存内容：否则「校验」永远在检查上一次落库的旧版本。
                val draft = runCatching { call.receive<SourceValidateRequest>().json }.getOrNull()?.takeIf { it.isNotBlank() }
                val text = draft ?: database.getSource(call.parameters["id"]!!)?.json
                    ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@post }
                call.respond(SourceCodec.validate(text))
            }
            get("/debug") {
                val source = database.getSource(call.parameters["id"]!!) ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@get }
                val keyword = call.request.queryParameters["keyword"]?.takeIf { it.isNotBlank() } ?: "测试"
                val targetBookUrl = call.request.queryParameters["bookUrl"]
                val chapterIndex = call.request.queryParameters["chapterIndex"]?.toIntOrNull() ?: 0
                call.response.cacheControl(CacheControl.NoStore(null))
                call.respondTextWriter(ContentType.Text.EventStream) {
                    write("event: start\ndata: ${jsonEvent("开始调试 ${source.id}｜关键词「$keyword」")}\n\n"); flush()
                    // 各阶段最坏要等满引擎超时，所以边跑边发：驱动器在 IO 线程里往 channel 塞，
                    // 这里逐条写回前端。客户端断开时 `write` 抛取消，IO 侧的发送只是 trySend 失败，不会挂住。
                    val steps = Channel<DebugStep>(Channel.UNLIMITED)
                    coroutineScope {
                        launch(Dispatchers.IO) {
                            runCatching { debugger.flow(source.json, keyword, targetBookUrl, chapterIndex) { steps.trySend(it) } }
                                .onFailure { steps.trySend(DebugStep("调试", "驱动器异常", it.message ?: it.javaClass.simpleName, false)) }
                            steps.close()
                        }
                        for (step in steps) {
                            write("event: step\ndata: ${debugJson.encodeToString(DebugStep.serializer(), step)}\n\n"); flush()
                        }
                    }
                    write("event: done\ndata: ${jsonEvent("调试结束")}\n\n"); flush()
                }
            }
            get("/explore") {
                val source = database.getSource(call.parameters["id"]!!) ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@get }
                call.respond(runCatching { runner.exploreTabs(source.json) }.getOrElse { error ->
                    call.respond(HttpStatusCode.BadGateway, ApiError("explore_failed", error.message ?: "发现页解析失败")); return@get
                })
            }
            get("/login-ui") {
                val source = database.getSource(call.parameters["id"]!!) ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@get }
                val items = runner.parseLoginUi(source.json)
                val state = database.getSourceLoginState(source.id)
                val sourceObj = runCatching { Json.parseToJsonElement(source.json).jsonObject }.getOrNull()
                val sourceName = (sourceObj?.get("bookSourceName") as? JsonPrimitive)?.contentOrNull ?: source.id
                val loginUrl = (sourceObj?.get("loginUrl") as? JsonPrimitive)?.contentOrNull
                call.respond(
                    SourceLoginUiResponse(
                        sourceId = source.id,
                        sourceName = sourceName,
                        hasLogin = items.isNotEmpty() || !loginUrl.isNullOrBlank() || sourceObj?.get("loginCheckJs") != null,
                        loginUi = items,
                        loginUrl = loginUrl,
                        loginInfo = state?.loginInfo ?: emptyMap(),
                        loginHeader = state?.loginHeader,
                        sourceVariable = state?.sourceVariable,
                        loginIsScript = runner.loginIsScript(source.json),
                        cookieDomains = WebViewProxy.credentialDomains(source.json),
                    )
                )
            }
            post("/login-info") {
                if (!call.requireSameOriginWrite()) return@post
                val sourceId = call.parameters["id"]!!
                val req = call.receive<SourceLoginInfoUpdateRequest>()
                database.saveSourceLoginInfo(sourceId, req.loginInfo)
                call.respond(mapOf("ok" to true))
            }
            delete("/login-info") {
                if (!call.requireSameOriginWrite()) return@delete
                val sourceId = call.parameters["id"]!!
                database.removeSourceLoginInfo(sourceId)
                call.respond(mapOf("ok" to true))
            }
            post("/login-header") {
                if (!call.requireSameOriginWrite()) return@post
                val sourceId = call.parameters["id"]!!
                val req = call.receive<SourceLoginHeaderUpdateRequest>()
                database.saveSourceLoginHeader(sourceId, req.loginHeader)
                call.respond(mapOf("ok" to true))
            }
            options("/login-cookie") {
                if (!allowCookieSyncOrigin(call, database)) { call.respond(HttpStatusCode.Forbidden); return@options }
                call.response.headers.append(HttpHeaders.AccessControlAllowMethods, "POST, OPTIONS")
                call.response.headers.append(HttpHeaders.AccessControlAllowHeaders, "Content-Type")
                call.respond(HttpStatusCode.OK)
            }
            post("/login-cookie") {
                val sourceId = call.parameters["id"]!!
                val targetSource = database.getSource(sourceId)
                    ?: database.listSources(null).firstOrNull {
                        it.id.contains(sourceId) || sourceId.contains(it.id) || (it.url.isNotBlank() && (sourceId.contains(it.url) || it.url.contains(sourceId)))
                    }?.let { database.getSource(it.id) }

                // 这个接口是给「在目标站点页面上运行的书签 / Chrome 扩展」用的，跨站、拿不到会话，
                // 所以原来写成 Access-Control-Allow-Origin: *。那等于任何网页都能往用户书源的 Cookie 罐里注入。
                // 改成只放行确实属于该书源站点的 Origin。
                //
                // 但界面自己的「粘贴 Cookie」也是 POST，Chrome 必然带上 Origin=本站，
                // 按域名规则永远不匹配 —— 那个页签一点就是 403，等于功能被安全加固顺手打死。
                // 同源这一支单独放行，条件是必须带有效会话 + CSRF 头；跨站仍然只认书源自己的域名。
                val sameOrigin = sameOriginCall(call)
                if (!sameOrigin && !allowCookieSyncOrigin(call, database, targetSource?.json)) {
                    call.respond(HttpStatusCode.Forbidden, ApiError("origin_not_allowed", "该页面不属于此书源的站点，已拒绝同步 Cookie"))
                    return@post
                }
                // 上面已经按 Origin 判过（同源或命中该书源自己的域），这里不再要会话
                val resolvedSourceId = targetSource?.id ?: sourceId
                val req = call.receive<SourceLoginCookieUpdateRequest>()
                val rawCookie = req.cookie.trim()
                var savedCount = 0
                if (rawCookie.isNotEmpty()) {
                    val cookieMap = database.parseCookieString(rawCookie)
                    savedCount = cookieMap.size
                    database.setCookieForUrl(req.url ?: resolvedSourceId, rawCookie)
                    val cookieStr = cookieMap.entries.joinToString("; ") { "${it.key}=${it.value}" }
                    val state = database.getSourceLoginState(resolvedSourceId)
                    if (state?.loginHeader.isNullOrBlank() && cookieStr.isNotBlank()) {
                        val headerMap = mapOf("Cookie" to cookieStr)
                        database.saveSourceLoginHeader(resolvedSourceId, Json.encodeToString(headerMap))
                    }
                    call.application.log.info("cookie synchronized for source: {}, count: {}, url: {}", resolvedSourceId, savedCount, req.url)
                }
                call.respond(SourceLoginCookieResponse(ok = true, message = "Cookie 同步成功", count = savedCount))
            }
            delete("/login-header") {
                if (!call.requireSameOriginWrite()) return@delete
                val sourceId = call.parameters["id"]!!
                database.removeSourceLoginHeader(sourceId)
                call.respond(mapOf("ok" to true))
            }
            post("/login-action") {
                if (!call.requireSameOriginWrite()) return@post
                val source = database.getSource(call.parameters["id"]!!) ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@post }
                val req = call.receive<SourceLoginActionRequest>()
                val outcome = runner.executeLoginAction(source.json, req.action, req.loginData, req.isLongClick, req.browserCompleted)
                call.respond(outcome)
            }
            get("/login-check") {
                val source = database.getSource(call.parameters["id"]!!) ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@get }
                val check = runner.checkLoginStatus(source.json)
                call.respond(check)
            }
            // 某个地址的注册域上到底有没有凭据 —— 发现页用它把"这一栏要登录"和"站点确实返回空"分开。
            // 只回答有/无，不假装能判定登录态（上游没有这个机制，loginCheckJs 只是响应改写器）。
            get("/credential") {
                val url = call.request.queryParameters["u"]?.trim()
                if (url.isNullOrBlank()) {
                    call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 u 参数（要查哪个地址所在域）"))
                    return@get
                }
                val domain = database.cookieBucket(url)
                call.respond(SourceCredentialStatus(domain = domain, has = database.getCookieForUrl(url) != null))
            }
            route("/browser") {
                post("/session") {
                    if (!call.requireSameOriginWrite()) return@post
                    val source = database.getSource(call.parameters["id"]!!) ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@post }
                    val sourceObj = runCatching { Json.parseToJsonElement(source.json).jsonObject }.getOrNull()
                    val loginUrl = (sourceObj?.get("loginUrl") as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf { it.startsWith("http") }
                    val sourceUrl = (sourceObj?.get("bookSourceUrl") as? JsonPrimitive)?.contentOrNull?.trim()
                    val homeUrl = sourceUrl?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
                    // 书源 JS 里的 java.startBrowserAwait(url) 会给出真实入口，优先级最高
                    val requestedRaw = runCatching { call.receive<SourceBrowserSessionRequest>() }.getOrNull()?.url?.trim()
                    val requestedHttp = requestedRaw?.takeIf { it.startsWith("http://") || it.startsWith("https://") }
                    val inlineOnly = requestedRaw != null && requestedHttp == null && webView.isInlineDataUrl(requestedRaw)
                    if (requestedRaw != null && requestedHttp == null && !inlineOnly) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("unsupported_url", "内置浏览器仅支持 HTTP(S) 地址或书源脚本生成的内置页面"))
                        return@post
                    }
                    val startUrl = requestedHttp
                        // loginUrl 是整段登录 JS 时，真正的登录地址只有脚本知道（`java.startBrowserAwait(...)`）
                        ?: runner.loginBrowserStartUrl(source.json)
                        ?: loginUrl
                        ?: homeUrl
                        ?: WebViewProxy.defaultStartUrl(source.json)
                    if (startUrl == null && !inlineOnly) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("no_login_url", "该书源未配置 loginUrl，且书源内容中没有任何网址，无法打开内置浏览器"))
                        return@post
                    }
                    val token = webView.issueTicket(source.id, source.json, startUrl)
                    call.application.log.info("webview session opened for source: {}, start: {}, inline: {}", source.id, startUrl ?: "(内置页面)", inlineOnly)
                    call.respond(
                        SourceBrowserSessionResponse(
                            token = token,
                            startUrl = startUrl ?: "",
                            expiresInSeconds = 1800,
                            inlineOnly = inlineOnly,
                        )
                    )
                }
                delete("/session") {
                    if (!call.requireSameOriginWrite()) return@delete
                    call.request.queryParameters["t"]?.let { webView.revokeTicket(it) }
                    call.respond(HttpStatusCode.NoContent)
                }
                get("/cookies") {
                    val sourceId = call.parameters["id"]!!
                    val json = database.getSource(sourceId)?.json ?: "{}"
                    val jar = withContext(Dispatchers.IO) { webView.jarSnapshot(json) }
                    call.respond(SourceBrowserCookieResponse(count = jar.size, domains = jar.keys.toList(), cookies = jar))
                }
                // 删掉某个注册域的凭据（界面要能单独撤掉误抓来的统计域，比如 hm.baidu.com）。
                // 域是全局共享的：这一删对所有会访问该域的书源同时生效，界面必须把这点说清楚。
                delete("/cookies") {
                    if (!call.requireSameOriginWrite()) return@delete
                    val sourceId = call.parameters["id"]!!
                    val json = database.getSource(sourceId)?.json ?: "{}"
                    val target = call.request.queryParameters["u"]?.trim()
                    if (target.isNullOrBlank()) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 u 参数（要删除哪个域名的 Cookie）"))
                        return@delete
                    }
                    val removed = withContext(Dispatchers.IO) { database.removeCookieBucket(target) }
                    val jar = withContext(Dispatchers.IO) { webView.jarSnapshot(json) }
                    call.respond(SourceCookieRemoveResponse(ok = true, removed = removed, count = jar.size, domains = jar.keys.toList()))
                }
                // 真浏览器登录（外部 Chromium + CDP 回读），与内置代理浏览器并列的另一条路：
                // 内嵌 iframe 过不了站点风控，这里交给真引擎，登录完自动按域读回 HttpOnly 凭据。
                route("/external-login") {
                    suspend fun targetHosts(id: String): Pair<String, List<String>> {
                        val source = database.getSource(id) ?: return id to emptyList()
                        return source.id to WebViewProxy.credentialDomains(source.json)
                    }
                    post {
                        if (!call.requireSameOriginWrite()) return@post
                        val sourceId = call.parameters["id"]!!
                        val source = database.getSource(sourceId)
                            ?: return@post call.respond(HttpStatusCode.NotFound, ApiError("source_not_found", "书源不存在"))
                        val startUrl = runCatching {
                            Json.parseToJsonElement(call.receiveText().ifBlank { "{}" }).jsonObject["url"]
                                ?.jsonPrimitive?.contentOrNull?.takeIf { it.startsWith("http") }
                        }.getOrNull()
                            ?: runner.loginBrowserStartUrl(source.json)
                            ?: WebViewProxy.defaultStartUrl(source.json)
                            ?: source.id
                        val (resolvedId, _) = targetHosts(sourceId)
                        val outcome = runCatching { withContext(Dispatchers.IO) { externalLogin.start(startUrl) } }
                        outcome.getOrElse { error ->
                            call.respond(HttpStatusCode.ServiceUnavailable, ApiError("browser_unavailable", error.message ?: "启动浏览器失败"))
                            return@post
                        }
                        call.application.log.info("external browser opened for source: {}, pid: {}", resolvedId, outcome.getOrThrow().pid)
                        call.respond(externalLoginStatus(externalLogin, targetHosts(sourceId).second, null))
                    }
                    get {
                        val sourceId = call.parameters["id"]!!
                        val (resolvedId, hosts) = targetHosts(sourceId)
                        val seen = withContext(Dispatchers.IO) { externalLogin.peekDomains(hosts) }
                        call.respond(externalLoginStatus(externalLogin, hosts, seen))
                    }
                    post("/capture") {
                        if (!call.requireSameOriginWrite()) return@post
                        val sourceId = call.parameters["id"]!!
                        val (resolvedId, hosts) = targetHosts(sourceId)
                        val stored = withContext(Dispatchers.IO) { externalLogin.capture(hosts) }
                        val json = database.getSource(sourceId)?.json ?: "{}"
                        val jar = withContext(Dispatchers.IO) { webView.jarSnapshot(json) }
                        call.application.log.info(
                            "external login captured cookies for {}: {} domains",
                            resolvedId,
                            stored.size,
                        )
                        call.respond(externalLoginStatus(externalLogin, hosts, stored).copy(stored = stored, count = jar.size))
                    }
                    delete {
                        if (!call.requireSameOriginWrite()) return@delete
                        withContext(Dispatchers.IO) { externalLogin.stop() }
                        call.respond(HttpStatusCode.NoContent)
                    }
                }
                get("/page") {
                    val sourceId = call.parameters["id"]!!
                    val token = call.request.queryParameters["t"]
                    if (token.isNullOrBlank()) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 token 参数"))
                        return@get
                    }
                    // i = 服务端托管的内置页面（书源 JS 生成的数据地址，直接进 URL 会超出请求行上限）
                    val inlineKey = call.request.queryParameters["i"]
                    if (!inlineKey.isNullOrBlank()) {
                        call.respondProxied { webView.openInlinePage(sourceId, token, inlineKey) }
                        return@get
                    }
                    val target = call.request.queryParameters["u"]
                    if (target.isNullOrBlank()) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 u 参数"))
                        return@get
                    }
                    call.respondProxied { webView.openPage(sourceId, token, target) }
                }
                post("/inline") {
                    if (!call.requireSameOriginWrite()) return@post
                    val sourceId = call.parameters["id"]!!
                    val req = call.receive<SourceBrowserInlineRequest>()
                    try {
                        val key = webView.registerInlinePage(sourceId, req.token, req.url)
                        call.respond(SourceBrowserInlineResponse(key = key))
                    } catch (error: WebViewException) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("inline_page_failed", error.message ?: "内置页面无法打开"))
                    }
                }
                /*
                  子资源与站点自己发的请求走这一个口。原来只注册了 GET，而注入脚本把**所有方法**的
                  fetch/XHR 都改写到 `/res` —— 于是"登录 = fetch POST /login"的站点，POST 落在 405 上
                  根本没发出去，那条 Set-Cookie 也就永远吸不到（用户：「登录抓取 cookie 还是失败」）。
                  表单那条路（/submit）一直有 POST，所以只有走 XHR 的源中招。
                */
                route("/res") {
                    // Ktor 的 `method` 不收变长参数，逐个注册；处理体只有一份，免得五份里改一份忘四份
                    for (verb in listOf(HttpMethod.Get, HttpMethod.Post, HttpMethod.Put, HttpMethod.Patch, HttpMethod.Delete)) {
                        method(verb) {
                            handle {
                                val sourceId = call.parameters["id"]!!
                                val token = call.request.queryParameters["t"]
                                val target = call.request.queryParameters["u"]
                                if (token.isNullOrBlank() || target.isNullOrBlank()) {
                                    call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 token 或 u 参数"))
                                    return@handle
                                }
                                val requestMethod = call.request.httpMethod.value
                                val body = if (requestMethod == "GET") ByteArray(0) else call.receiveStream().readBytes()
                                val contentType = call.request.headers[HttpHeaders.ContentType]
                                call.respondProxied { webView.openResource(sourceId, token, target, requestMethod, contentType, body) }
                            }
                        }
                    }
                }
                get("/submit") {
                    val sourceId = call.parameters["id"]!!
                    val token = call.request.queryParameters["t"]
                    val base = call.request.queryParameters["u"]
                    if (token.isNullOrBlank() || base.isNullOrBlank()) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 token 或 u 参数"))
                        return@get
                    }
                    val extras = call.request.queryParameters.entries()
                        .filter { it.key != "t" && it.key != "u" }
                        .flatMap { entry -> entry.value.map { "${URLEncoder.encode(entry.key, Charsets.UTF_8)}=${URLEncoder.encode(it, Charsets.UTF_8)}" } }
                    val target = if (extras.isEmpty()) base else base + (if (base.contains('?')) "&" else "?") + extras.joinToString("&")
                    call.respondProxied { webView.submitForm(sourceId, token, target, "GET", null, ByteArray(0)) }
                }
                post("/submit") {
                    val sourceId = call.parameters["id"]!!
                    val token = call.request.queryParameters["t"]
                    val target = call.request.queryParameters["u"]
                    if (token.isNullOrBlank() || target.isNullOrBlank()) {
                        call.respond(HttpStatusCode.BadRequest, ApiError("missing_parameter", "缺少 token 或 u 参数"))
                        return@post
                    }
                    val body = call.receiveStream().readBytes()
                    val contentType = call.request.headers[HttpHeaders.ContentType]
                    call.respondProxied { webView.submitForm(sourceId, token, target, "POST", contentType, body) }
                }
            }
        }
        post("/search") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<SearchRequest>()
            if (request.keyword.isBlank()) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_keyword", "请输入搜索关键词")); return@post }
            val sourceRecords = database.listSearchSourceRecords(request.sourceIds)
            val results = boundedConcurrentMap(sourceRecords, sourceSearchConcurrency()) { source -> readableSearchResults(runner, source.json, request.keyword) }.flatten()
            call.respond(results)
        }
        webSocket("/search/stream") {
            // 没有凭据可校验了：流式搜索同样只认"这个连接是不是本机页面发起的"
            if (!originMatchesHost(call)) {
                close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "跨站页面不能驱动本机搜索"))
                return@webSocket
            }
            val request = (incoming.receive() as? Frame.Text)?.readText()?.let { text -> runCatching { Json.decodeFromString<SearchRequest>(text) }.getOrNull() }
            if (request?.keyword.isNullOrBlank()) {
                send(Frame.Text(Json.encodeToString(SearchStreamEvent("error", message = "请输入搜索关键词"))))
                close(CloseReason(CloseReason.Codes.CANNOT_ACCEPT, "搜索条件无效"))
                return@webSocket
            }
            val sourceRecords = database.listSearchSourceRecords(request!!.sourceIds)
            send(Frame.Text(Json.encodeToString(SearchStreamEvent("start", totalSources = sourceRecords.size))))
            coroutineScope {
                val events = Channel<SearchStreamEvent>(Channel.BUFFERED)
                val counters = SearchStreamCounters(sourceRecords.size)
                val semaphore = Semaphore(sourceSearchConcurrency())
                val workers = sourceRecords.map { source -> async {
                    semaphore.withPermit {
                        if (!isActive) return@async
                        val outcome = searchSourceOutcome(runner, source.json, request.keyword)
                        if (!isActive) return@async
                        runCatching {
                            if (outcome.results.isNotEmpty()) events.send(SearchStreamEvent("results", results = outcome.results))
                            events.send(counters.complete(outcome))
                        }
                    }
                } }
                val completionJob = launch {
                    try {
                        workers.awaitAll()
                        runCatching { events.send(counters.snapshot("done")) }
                    } catch (_: CancellationException) {
                        // Workers were cancelled
                    } finally {
                        events.close()
                    }
                }
                val cancellationMonitor = launch {
                    try {
                        for (frame in incoming) {
                            if (frame is Frame.Text && frame.readText().contains("\"cancel\"")) break
                        }
                    } catch (_: Throwable) {
                        // Incoming channel closed
                    } finally {
                        workers.forEach { it.cancel() }
                        completionJob.cancel()
                        events.close()
                    }
                }
                try {
                    for (event in events) send(Frame.Text(Json.encodeToString(event)))
                } catch (_: Throwable) {
                    // Socket closed or disconnected
                } finally {
                    cancellationMonitor.cancel()
                    completionJob.cancel()
                    workers.forEach { it.cancel() }
                    events.close()
                }
            }
        }
        get("/explore/sources") {
            call.respond(database.listExploreSources())
        }
        post("/explore") {
            val request = call.receive<ExploreRequest>()
            val source = database.getSource(request.sourceId) ?: run {
                call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在"))
                return@post
            }
            try {
                call.respond(runner.explore(source.json, request.url, request.page.coerceAtLeast(1)))
            } catch (error: Throwable) {
                if (error is CancellationException) throw error
                call.respond(HttpStatusCode.BadGateway, ApiError("explore_failed", error.message ?: "发现页取书失败"))
            }
        }
        get("/subscriptions") {
            call.respond(database.listSubscriptions())
        }
        post("/subscriptions") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<SubscriptionWriteRequest>()
            try {
                validateSubscriptionUrl(request.url)
                call.respond(database.saveSubscription(request))
            } catch (error: IllegalArgumentException) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_subscription", error.message ?: "订阅地址无效"))
            }
        }
        delete("/subscriptions/{id}") {
            if (!call.requireSameOriginWrite()) return@delete
            val id = call.parameters["id"]?.toLongOrNull() ?: return@delete call.respond(HttpStatusCode.BadRequest, ApiError("invalid_subscription", "订阅标识无效"))
            if (database.deleteSubscription(id)) call.respond(HttpStatusCode.NoContent) else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "订阅不存在"))
        }
        post("/subscriptions/{id}/update") {
            if (!call.requireSameOriginWrite()) return@post
            val id = call.parameters["id"]?.toLongOrNull() ?: return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_subscription", "订阅标识无效"))
            try { call.respond(subscriptions.updateOne(id)) }
            catch (_: NoSuchElementException) { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "订阅不存在")) }
            catch (error: Throwable) { call.respond(HttpStatusCode.BadGateway, ApiError("subscription_update_failed", error.message ?: "订阅更新失败")) }
        }
        post("/subscriptions/update") {
            if (!call.requireSameOriginWrite()) return@post
            val results = subscriptions.updateAll()
            call.respond(mapOf("updated" to results.count { it.second.isSuccess }, "failed" to results.count { it.second.isFailure }))
        }
        // 运行日志：前端「运行日志」弹窗读这里。category/level 用枚举名过滤，limit 夹在 1~1000。
        get("/logs") {
            val params = call.request.queryParameters
            val category = params["category"]?.takeIf { it.isNotBlank() }?.let { runCatching { LogCategory.valueOf(it) }.getOrNull() }
            val level = params["level"]?.takeIf { it.isNotBlank() }?.let { runCatching { LogLevel.valueOf(it) }.getOrNull() }
            val limit = params["limit"]?.toIntOrNull()?.coerceIn(1, 1000) ?: 200
            call.respond(LogService.queryLogs(category, level, limit))
        }
        delete("/logs") {
            if (!call.requireSameOriginWrite()) return@delete
            LogService.clearLogs()
            call.respond(HttpStatusCode.NoContent)
        }
        /**
         * 更新日志：随包发出的 `CHANGELOG.md`（`server/build.gradle` 的 processResources 拷成
         * `meta/changelog.md`）。界面上那张「更新日志」页读这里。
         *
         * 两个刻意的选择：
         * ① **读 classpath，不读磁盘路径** —— jar 被单独拷到别的机器、或跑在 Docker 里时，
         *    "仓库根有个 CHANGELOG.md"这件事不成立；
         * ② 拿不到就 404 + 说明，**不返回 200 空串** —— 空串会被界面渲染成"这个版本没有任何改动"，
         *    那是把打包环节的问题说成产品事实。
         */
        get("/about") {
            call.respond(AboutInfo(BuildInfo.title, BuildInfo.version, UpdateCheck.repository))
        }
        post("/about/update-check") {
            if (!call.requireSameOriginWrite()) return@post
            call.respond(UpdateCheck.check(BuildInfo.version))
        }
        get("/changelog") {
            val text = runCatching {
                BuildInfo::class.java.classLoader.getResourceAsStream("meta/changelog.md")
                    ?.use { it.readBytes().toString(Charsets.UTF_8) }
            }.getOrNull()
            if (text.isNullOrBlank()) {
                call.respond(HttpStatusCode.NotFound, ApiError("changelog_missing", "这个构建产物里没有随包的更新日志"))
            } else {
                call.respondText(text, ContentType("text", "markdown").withCharset(Charsets.UTF_8))
            }
        }
        /**
         * RSS 订阅（手机「订阅」页那一栏）。与上面的 `/subscriptions` 是两回事：
         * 这里是**阅读 RSS 源**（上游 `RssSource`），`/subscriptions` 是**书源订阅地址**（上游 `RuleSub`）。
         */
        /**
         * 浏览器直传备份包导入：选一个手机导出的 zip 就能恢复，不需要 WebDAV。
         *
         * 以前只能"先把 zip 放进存储区（WebDAV 或手工拷），再在文件页点导入" —— 而 WebDAV 只绑回环时
         * 手机根本推不上来，这条路对用户等于不存在。落盘走临时文件，`BackupImporter` 全程按需读条目，
         * 解包与大小上限由它自己把关（单条目 64 MiB / 整包 256 MiB），密码只在内存里用一次、绝不写日志。
         */
        /*
         * 备份包里"收下了但服务端还没有原生界面"的那些条目（书签/字典/阅读记录/阅读样式…）。
         * 列表与原文都只读：写操作发生在导入那一次，这里给的是"你包里的东西现在在哪、能不能用"。
         */
        get("/backup/kept") {
            call.respond(backupKeep.list())
        }
        get("/backup/kept/{name}") {
            val name = call.parameters["name"]
                ?: return@get call.respond(HttpStatusCode.BadRequest, ApiError("invalid_name", "缺少条目名"))
            val body = backupKeep.read(name)
                ?: return@get call.respond(HttpStatusCode.NotFound, ApiError("not_kept", "服务器上没有这个条目"))
            call.respondText(body, ContentType.Application.Json)
        }
        post("/backup/import") {
            if (!call.requireSameOriginWrite()) return@post
            val multipart = call.receiveMultipart()
            var password: String? = null
            var upload: Pair<String, ByteArray>? = null
            multipart.forEachPart { part ->
                when (part) {
                    is PartData.FormItem -> if (part.name == "password") password = part.value
                    is PartData.FileItem -> if (upload == null) upload = (part.originalFileName ?: "backup.zip") to part.streamProvider().readBytes()
                    else -> {}
                }
                part.dispose()
            }
            val (filename, bytes) = upload
                ?: return@post call.respond(HttpStatusCode.BadRequest, ApiError("no_file", "没有收到备份包"))
            if (!filename.lowercase().endsWith(".zip")) {
                return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_backup", "只支持手机导出的 .zip 备份包"))
            }
            if (bytes.isEmpty()) return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_backup", "备份包是空的"))
            val staged = Files.createTempFile("legado-backup-", ".zip")
            try {
                Files.write(staged, bytes)
                val summary = runCatching {
                    withContext(Dispatchers.IO) { BackupImporter(database, backupKeep).import(staged, password?.takeIf { it.isNotBlank() }) }
                }
                val result = summary.getOrElse { error ->
                    if (error is CancellationException) throw error
                    call.respond(HttpStatusCode.BadRequest, ApiError("invalid_backup", error.message ?: "备份包解析失败"))
                    return@post
                }
                call.application.log.info(
                    "backup uploaded and imported: {} (sources={}, rules={}, books={}, rss={}, groups={})",
                    filename,
                    result.sources + result.sourcesUpdated,
                    result.rules + result.rulesUpdated,
                    result.books + result.booksUpdated,
                    result.rssSources + result.rssSourcesUpdated,
                    result.bookGroups,
                )
                call.respond(result)
            } finally {
                runCatching { Files.deleteIfExists(staged) }
            }
        }
        route("/rss") {
            get("/sources") {
                // 这里是 queryParameters：`call.parameters["q"]` 读的是路径参数，
                // 永远为 null，等于服务端筛选从来没生效过。
                call.respond(database.listRssSources(call.request.queryParameters["q"]))
            }
            post("/sources") {
                if (!call.requireSameOriginWrite()) return@post
                val response = database.importRssSources(call.receive<ImportRequest>().sources)
                call.application.log.info("rss source import completed: imported={}, updated={}", response.imported, response.updated)
                call.respond(response)
            }
            post("/sources/enabled") {
                if (!call.requireSameOriginWrite()) return@post
                val request = call.receive<RssSourceEnabledRequest>()
                if (database.setRssSourceEnabled(request.sourceUrl, request.enabled)) call.respond(HttpStatusCode.NoContent)
                else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "订阅源不存在"))
            }
            delete("/sources") {
                if (!call.requireSameOriginWrite()) return@delete
                val sourceUrl = call.parameters["sourceUrl"]
                    ?: return@delete call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "缺少 sourceUrl"))
                if (database.deleteRssSource(sourceUrl)) call.respond(HttpStatusCode.NoContent)
                else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "订阅源不存在"))
            }
            get("/tabs") {
                val sourceUrl = call.parameters["sourceUrl"]
                    ?: return@get call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "缺少 sourceUrl"))
                val payload = database.getRssSource(sourceUrl)
                    ?: return@get call.respond(HttpStatusCode.NotFound, ApiError("not_found", "订阅源不存在"))
                if (!database.rssSourceIsEnabled(sourceUrl)) {
                    call.respond(HttpStatusCode.Conflict, ApiError("rss_source_disabled", "该订阅源已停用，先在列表里点「已停用」把它启用"))
                    return@get
                }
                call.respondCatching { runner.rssTabs(payload) }
            }
            post("/articles") {
                val request = call.receive<RssArticlesRequest>()
                val payload = database.getRssSource(request.sourceUrl)
                    ?: return@post call.respond(HttpStatusCode.NotFound, ApiError("not_found", "订阅源不存在"))
                if (!database.rssSourceIsEnabled(request.sourceUrl)) {
                    call.respond(HttpStatusCode.Conflict, ApiError("rss_source_disabled", "该订阅源已停用，先在列表里点「已停用」把它启用"))
                    return@post
                }
                try {
                    call.respond(runner.rssArticles(payload, request.url, request.page.coerceAtLeast(1)))
                } catch (error: Throwable) {
                    if (error is CancellationException) throw error
                    call.respond(HttpStatusCode.BadGateway, ApiError("rss_articles_failed", error.message ?: "订阅列表解析失败"))
                }
            }
            post("/content") {
                val request = call.receive<RssContentRequest>()
                val payload = database.getRssSource(request.sourceUrl)
                    ?: return@post call.respond(HttpStatusCode.NotFound, ApiError("not_found", "订阅源不存在"))
                call.respondCatching { runner.rssContent(payload, request.link) }
            }
        }
        post("/books/details") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BookRequest>()
            if (request.sourceId == LocalBookParser.LOC_BOOK_SOURCE_ID) {
                val shelf = database.listBookshelf().firstOrNull { it.sourceId == request.sourceId && it.bookUrl == request.bookUrl }
                    ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "本地书籍不存在")); return@post }
                val cover = shelf.coverKey?.let { "/api/covers/$it" }
                call.respond(BookDetails(
                    sourceId = LocalBookParser.LOC_BOOK_SOURCE_ID,
                    name = shelf.name,
                    author = shelf.author,
                    intro = null,
                    coverUrl = cover,
                    tocUrl = shelf.tocUrl,
                ))
                return@post
            }
            val source = database.getSource(request.sourceId) ?: run { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在")); return@post }
            call.respondCatching { runner.details(source.json, request.bookUrl) }
        }
        post("/books/chapters") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BookRequest>()
            val cachedToc = database.getTocCache(request.sourceId, request.bookUrl)
                ?: database.getTocCache(request.sourceId, request.bookUrl.removeSuffix("/toc") + "/toc")
            if (cachedToc != null && cachedToc.isNotEmpty()) {
                call.respond(cachedToc)
                return@post
            }
            val fallbackFromContent = database.getCachedChaptersFallback(request.sourceId, request.bookUrl)
            if (request.sourceId == LocalBookParser.LOC_BOOK_SOURCE_ID) {
                if (fallbackFromContent.isNotEmpty()) {
                    call.respond(fallbackFromContent)
                } else {
                    call.respond(HttpStatusCode.NotFound, ApiError("not_found", "本地书籍目录不存在"))
                }
                return@post
            }
            val source = database.getSource(request.sourceId) ?: run {
                call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在"))
                return@post
            }
            call.respondCatching {
                try {
                    withTimeout(4000) {
                        val direct = runCatching { runner.chapters(source.json, request.bookUrl) }.getOrNull()
                        // 目录地址常常不等于书页地址（`tocUrl` 要从详情里再取一次），
                        // 按书页取目录会**安静地返回空列表**而不是报错，所以空结果同样要回落到详情。
                        val chapters = if (!direct.isNullOrEmpty()) direct else {
                            val details = runner.details(source.json, request.bookUrl)
                            runner.chapters(source.json, details.tocUrl).also { database.saveTocCache(request.sourceId, details.tocUrl, it) }
                        }
                        if (chapters.isNotEmpty()) {
                            database.saveTocCache(request.sourceId, request.bookUrl, chapters)
                        }
                        chapters
                    }
                } catch (error: Throwable) {
                    // 客户端真取消（JobCancellationException）要原样上抛，别兜底后对着已断的连接 respond；
                    // 本地 withTimeout 抛的 TimeoutCancellationException 才是「这次超时」，继续走回落。
                    if (error is CancellationException && error !is TimeoutCancellationException) throw error
                    if (fallbackFromContent.isNotEmpty()) {
                        fallbackFromContent
                    } else {
                        throw (error as? RuleExecutionException ?: RuleExecutionException(error.message ?: "获取章节列表失败"))
                    }
                }
            }
        }
        route("/replace-rules") {
            get {
                val q = call.request.queryParameters["q"]
                val group = call.request.queryParameters["group"]
                val scope = call.request.queryParameters["scope"] ?: call.request.queryParameters["bookName"]
                call.respond(database.listReplaceRules(q, group, scope))
            }
            get("/{id}") {
                val id = call.parameters["id"] ?: return@get call.respond(HttpStatusCode.BadRequest, ApiError("invalid_id", "缺少规则 ID"))
                database.getReplaceRule(id)?.let { call.respond(it) } ?: call.respond(HttpStatusCode.NotFound, ApiError("not_found", "规则不存在"))
            }
            post {
                if (!call.requireSameOriginWrite()) return@post
                val rule = call.receive<ReplaceRule>()
                if (rule.pattern.isBlank()) {
                    call.respond(HttpStatusCode.BadRequest, ApiError("invalid_rule", "匹配模式不能为空"))
                    return@post
                }
                call.respond(database.saveReplaceRule(rule))
            }
            put("/{id}") {
                if (!call.requireSameOriginWrite()) return@put
                val id = call.parameters["id"] ?: return@put call.respond(HttpStatusCode.BadRequest, ApiError("invalid_id", "缺少规则 ID"))
                val rule = call.receive<ReplaceRule>().copy(id = id)
                if (rule.pattern.isBlank()) {
                    call.respond(HttpStatusCode.BadRequest, ApiError("invalid_rule", "匹配模式不能为空"))
                    return@put
                }
                call.respond(database.saveReplaceRule(rule))
            }
            delete("/{id}") {
                if (!call.requireSameOriginWrite()) return@delete
                val id = call.parameters["id"] ?: return@delete call.respond(HttpStatusCode.BadRequest, ApiError("invalid_id", "缺少规则 ID"))
                if (database.deleteReplaceRule(id)) call.respond(HttpStatusCode.NoContent)
                else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "规则不存在"))
            }
            post("/delete-batch") {
                if (!call.requireSameOriginWrite()) return@post
                val ids = call.receive<List<String>>()
                val count = database.deleteReplaceRules(ids)
                call.respond(mapOf("deleted" to count))
            }
            post("/toggle") {
                if (!call.requireSameOriginWrite()) return@post
                val req = call.receive<ReplaceRuleToggleRequest>()
                val count = database.toggleReplaceRules(req.ids, req.enabled)
                call.respond(mapOf("updated" to count))
            }
            get("/export") {
                val ids = call.request.queryParameters.getAll("id")
                call.respondText(
                    text = Json.encodeToString(database.exportReplaceRules(ids)),
                    contentType = ContentType.Application.Json.withCharset(Charsets.UTF_8),
                )
            }
            post("/import") {
                if (!call.requireSameOriginWrite()) return@post
                val bodyText = call.receiveText()
                val parsedRules = parseImportedReplaceRules(bodyText)
                val response = database.importReplaceRules(parsedRules)
                call.respond(response)
            }
            post("/preview") {
                val req = call.receive<ReplaceRulePreviewRequest>()
                val rules = if (req.rule != null) listOf(req.rule) else database.getEnabledReplaceRulesForScope(req.bookName, req.sourceUrl)
                val jsSandbox = JsSandbox(runner)
                val cleaned = ContentProcessor.processContent(req.text, rules, jsSandbox = jsSandbox, bookName = req.bookName)
                val appliedNames = rules.filter { ContentProcessor.applyRule(req.text, it, jsSandbox = jsSandbox, bookName = req.bookName) != req.text }.map { it.name.ifBlank { it.pattern } }
                call.respond(ReplaceRulePreviewResponse(
                    originalText = req.text,
                    cleanedText = cleaned,
                    changed = cleaned != req.text,
                    appliedRules = appliedNames,
                ))
            }
        }
        post("/books/content") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<ContentRequest>()
            if (request.sourceId.isBlank() || request.chapterUrl.isBlank()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_content", "缺少书源或章节地址"))
                return@post
            }
            val bookUrl = request.bookUrl ?: if (request.chapterUrl.startsWith("local://")) {
                request.chapterUrl.substringBeforeLast('/')
            } else null
            val bookName = bookUrl?.let { url ->
                database.listBookshelf().firstOrNull { it.sourceId == request.sourceId && it.bookUrl == url }?.name
            }
            val cached = bookUrl?.let { database.cachedContent(request.sourceId, it, request.chapterUrl) }

            if (request.sourceId == LocalBookParser.LOC_BOOK_SOURCE_ID) {
                if (cached != null) {
                    val rules = database.getEnabledReplaceRulesForScope(bookName, "local://")
                    val jsSandbox = JsSandbox(runner)
                    val cleaned = ContentProcessor.processContent(cached.content, rules, jsSandbox = jsSandbox, bookName = bookName, chapterTitle = cached.title)
                    val cleanedTitle = cached.title?.let { ContentProcessor.processTitle(it, rules, jsSandbox = jsSandbox, bookName = bookName) }
                    call.respond(ChapterContent(title = cleanedTitle ?: cached.title, content = cleaned))
                } else {
                    call.respond(HttpStatusCode.NotFound, ApiError("not_found", "本地章节内容不存在"))
                }
                return@post
            }

            val source = database.getSource(request.sourceId) ?: run {
                call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在"))
                return@post
            }
            if (cached != null && cached.content.isNotBlank()) {
                call.respond(cached)
            } else call.respondCatching {
                try {
                    runner.content(source.json, request.chapterUrl, bookName, bookUrl).also { content ->
                        bookUrl?.let { database.cacheBookContent(request.sourceId, it, request.chapterUrl, content) }
                    }
                } catch (error: Throwable) {
                    if (cached != null && cached.content.isNotBlank()) cached
                    else throw error
                }
            }
        }
        get("/bookshelf") {
            call.respond(database.listBookshelf())
        }
        post("/bookshelf") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BookshelfWriteRequest>()
            if (request.sourceId.isBlank() || request.bookUrl.isBlank() || request.name.isBlank() || request.tocUrl.isBlank()) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "书架数据无效")); return@post }
            val immediateCover = tryFindCachedCover(coverCache, request.coverUrl, request.alternateSources)
            val item = database.saveBookshelf(request, immediateCover)
            bookCache.enqueue(CachedBookRequest(request.sourceId, request.bookUrl, request.tocUrl))
            if (immediateCover == null && (!request.coverUrl.isNullOrBlank() || !request.alternateSources.isNullOrEmpty())) {
                application.launch(Dispatchers.IO) {
                    val cached = tryCacheCover(coverCache, request.coverUrl, request.alternateSources)
                    if (cached != null) {
                        database.updateBookshelfCover(request.sourceId, request.bookUrl, cached.key, cached.contentType)
                    }
                }
            }
            call.respond(item)
        }
        post("/bookshelf/import-local") {
            if (!call.requireSameOriginWrite()) return@post
            // 规则走查询参数而不是 multipart 字段：字段在流里的顺序由前端拼接顺序决定，
            // 而解析发生在读到文件的那一刻 —— 依赖"对方先把规则放前面"是脆的。
            val tocRule = call.request.queryParameters["tocRule"]?.takeIf { it.isNotBlank() }
            val multipart = call.receiveMultipart()
            val items = mutableListOf<LocalBookImportItem>()
            var importedCount = 0
            var failedCount = 0
            // 本地书统一归到「本地」这一组：一次导入十几本，混在线书里就再也找不着了。
            // createBookGroup 是按名字找、没有才建，所以重复导入不会堆出第二个「本地」。
            val localGroupId = database.createBookGroup("本地").id
            multipart.forEachPart { part ->
                if (part is PartData.FileItem) {
                    val originalFilename = part.originalFileName ?: "book.txt"
                    val bytes = part.streamProvider().readBytes()
                    if (bytes.isNotEmpty()) {
                        try {
                            // 先生成 bookId 再解析：EPUB 里的内嵌插图要按 `/api/books/local/asset?bookId=…`
                            // 取，解析时不知道 id 就只能把图丢掉。
                            val bookId = UUID.randomUUID().toString().replace("-", "")
                            val parsed = LocalBookParser.parse(originalFilename, bytes, tocRule, bookId)
                            val ext = if (originalFilename.contains('.')) "." + originalFilename.substringAfterLast('.') else ".txt"
                            runCatching {
                                Files.createDirectories(localBooksDirectory)
                                Files.write(localBooksDirectory.resolve("$bookId$ext"), bytes)
                            }

                            val coverKey = if (parsed.coverBytes != null && parsed.coverBytes.isNotEmpty()) {
                                coverCache.saveCoverBytes(parsed.coverBytes, parsed.coverContentType ?: "image/jpeg")
                            } else null

                            val item = database.importLocalBook(bookId, parsed, coverKey, localGroupId)
                            importedCount++
                            items.add(LocalBookImportItem(
                                filename = originalFilename,
                                success = true,
                                bookUrl = item.bookUrl,
                                name = item.name,
                                author = item.author,
                                totalChapters = item.totalChapters,
                            ))
                        } catch (error: Throwable) {
                            failedCount++
                            items.add(LocalBookImportItem(
                                filename = originalFilename,
                                success = false,
                                error = error.message ?: "解析失败"
                            ))
                        }
                    }
                }
                part.dispose()
            }
            call.respond(LocalBookImportResponse(
                total = items.size,
                imported = importedCount,
                failed = failedCount,
                results = items,
            ))
        }
        /**
         * 「阅读设置 → 本地书目录」的可选规则清单：`auto` + `builtin` + 随包那 26 条里编译得出来的。
         * 坏正则在这里就已经被滤掉了（`TocRules.candidates`），界面上不会摆一个用了就报错的选项。
         */
        get("/books/toc-rules") {
            // 清单发**全部能编译的规则**，不是只发启用的那几条：手动选与参与自动打分是两件事
            call.respond(TocRuleList(
                options = listOf(
                    TocRuleOption(TocRules.AUTO, TocRules.label(TocRules.AUTO)),
                    TocRuleOption(TocRules.BUILTIN, TocRules.label(TocRules.BUILTIN), builtIn = true),
                ) + TocRules.all.map { rule ->
                    TocRuleOption(
                        key = rule.id.toString(),
                        label = rule.name,
                        example = rule.example.orEmpty(),
                        rule = rule.rule,
                        enable = rule.enable,
                        // 随包那张表里 id -100 就是"内置逐行匹配"：没有正则不等于坏，别标成编译失败
                        builtIn = rule.id == TocRules.PACKAGED_BUILTIN_ID,
                        broken = !TocRules.compiles(rule.id),
                        removable = TocRules.removable(rule.id),
                    )
                },
                enabled = TocRules.all.count { it.enable },
                total = TocRules.all.size,
                fromBackup = TocRules.customCount,
                overridden = TocRules.hasOverrides,
            ))
        }
        post("/books/toc-rules/toggle") {
            if (!call.requireSameOriginWrite()) return@post
            val request = runCatching { call.receive<TocRuleToggleRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@post
            }
            val id = request.key.toIntOrNull()
                ?: return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_rule", "只有具体规则能开关，auto 与内置不行"))
            val updated = TocRules.setEnable(id, request.enable)
                ?: return@post call.respond(HttpStatusCode.NotFound, ApiError("rule_missing", "没有这条规则"))
            call.respond(TocRuleToggleResult(updated.id, updated.name, updated.enable))
        }
        /*
         * 新建 / 修改一条分章规则（用户 2026-10-03：「txt目录规则可新建可编辑」）。
         * 正则编不出来时回的是这条规则自己的错，不是 500 —— 界面上要能就地说明"哪一列不行"。
         */
        post("/books/toc-rules/save") {
            if (!call.requireSameOriginWrite()) return@post
            val request = runCatching { call.receive<TocRuleSaveRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@post
            }
            if (request.name.isBlank() || request.rule.isBlank()) {
                return@post call.respond(HttpStatusCode.BadRequest, ApiError("rule_incomplete", "名字与正则都得填"))
            }
            if (!TocRules.patternUsable(request.rule.trim())) {
                return@post call.respond(
                    HttpStatusCode.BadRequest,
                    ApiError("rule_uncompilable", "这条正则在本机编译不出来，存进去会切不出章；先改到能编译"),
                )
            }
            // 不填 key = 新建；填了但不是数字要顶回去 —— 当成新建会把"改一条"变成"多一条"
            val id = when {
                request.key.isNullOrBlank() -> null
                else -> request.key.trim().toIntOrNull()
                    ?: return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_rule", "key 要么不填（新建），要么是规则 id"))
            }
            val saved = TocRules.save(id, request.name, request.rule, request.example, request.enable)
                ?: return@post call.respond(HttpStatusCode.NotFound, ApiError("rule_missing", "没有这条规则（或它不属于本机规则表）"))
            call.respond(TocRuleSaveResult(saved.id, saved.name, saved.rule, saved.enable, TocRules.all.size))
        }
        post("/books/toc-rules/delete") {
            if (!call.requireSameOriginWrite()) return@post
            val request = runCatching { call.receive<TocRuleToggleRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@post
            }
            val id = request.key.toIntOrNull()
                ?: return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_rule", "只有具体规则能删"))
            if (TocRules.packaged.any { it.id == id }) {
                return@post call.respond(
                    HttpStatusCode.BadRequest,
                    ApiError("packaged_rule", "随包那条规则不能删，可以取消它的「自动」勾选；要整张还原用「恢复随包那份」"),
                )
            }
            val removed = TocRules.remove(id)
            call.respond(TocRuleDeleteResult(removed, TocRules.all.size))
        }
        /*
         * 撤掉本机改动，回到随包那 26 条（套用过之后要能反悔，门禁也要能还原用户的规则表）。
         */
        post("/books/toc-rules/reset") {
            if (!call.requireSameOriginWrite()) return@post
            call.respond(TocRuleResetResult(cleared = TocRules.clearOverrides(), total = TocRules.all.size))
        }
        /*
         * 套用「手机备份里那份 txtTocRule.json」（用户 2026-10-02：「手机导入的备份里面会有这个相关的」）。
         * 只读服务器上已经收下的那条，不接受请求体里现编的表 —— 否则这条写接口就成了"任意改规则表"。
         */
        post("/books/toc-rules/apply-backup") {
            if (!call.requireSameOriginWrite()) return@post
            val text = backupKeep.read("txtTocRule.json")
                ?: return@post call.respond(
                    HttpStatusCode.NotFound,
                    ApiError("no_backup_entry", "服务器上还没有手机备份里的 TXT 分章规则；先在「备份包」导入一个带这条目的包"),
                )
            val report = TocRules.applyBackup(text)
            call.respond(TocRuleApplyResult(
                matched = report["matched"] ?: 0,
                flipped = report["flipped"] ?: 0,
                added = report["added"] ?: 0,
                unusable = report["unusable"] ?: 0,
                total = report["total"] ?: 0,
            ))
        }
        /**
         * 换一条目录规则，把这本本地书重切一遍（用户 2026-10-02：「txt目录规则，这个可以放到阅读设置里」）。
         *
         * 原始文件在导入时就整本留在 `local_books/` 里，所以换规则不必让用户重新上传。
         * 重切会覆盖目录并清掉正文缓存 —— 章节编号整体错位之后留着旧正文等于让读者读到错章。
         * 两种情况**拒绝并保留原目录**：一条规则切不出第二个章节、原文件已经不在本机。
         */
        post("/books/reparse-local") {
            if (!call.requireSameOriginWrite()) return@post
            val request = runCatching { call.receive<LocalBookReparseRequest>() }.getOrElse {
                return@post call.respond(HttpStatusCode.BadRequest, ApiError("invalid_body", "缺少 sourceId / bookUrl / ruleKey"))
            }
            val bookId = request.bookUrl.removePrefix("local://").substringBefore('/').trim()
            if (request.sourceId != LocalBookParser.LOC_BOOK_SOURCE_ID || bookId.isEmpty()) {
                return@post call.respond(HttpStatusCode.BadRequest, ApiError("not_local_book", "只有导入到本机的书才有目录规则可换"))
            }
            val existing = database.shelfBook(request.sourceId, request.bookUrl)
                ?: return@post call.respond(HttpStatusCode.NotFound, ApiError("book_missing", "书架上没有这本书"))
            val file = runCatching {
                localBooksDirectory.toFile().listFiles()?.firstOrNull { it.isFile && it.name.startsWith("$bookId.") }
            }.getOrNull()
                ?: return@post call.respond(
                    HttpStatusCode.NotFound,
                    ApiError("local_file_missing", "本机找不到这本书的原始文件（可能被清理过），重新导入一次才能换规则"),
                )
            val parsed = try {
                LocalBookParser.parse(file.name, file.readBytes(), request.ruleKey, bookId)
            } catch (error: Throwable) {
                Unit.logParsing("本地书重切目录失败", mapOf("书名" to existing.name, "规则" to request.ruleKey, "原因" to (error.message ?: "")), error)
                return@post call.respond(HttpStatusCode.BadGateway, ApiError("reparse_failed", error.message ?: "重切目录失败"))
            }
            val askedForSpecific = request.ruleKey != TocRules.AUTO && request.ruleKey != TocRules.BUILTIN
            if (askedForSpecific && parsed.tocRuleUsed == TocRules.BUILTIN) {
                // 回落意味着这条规则在这本书上切不出第二个章节：直接把整本书变成一章是破坏，
                // 所以这里不写库，把原因说清楚让用户换一条。
                return@post call.respond(
                    HttpStatusCode.BadGateway,
                    ApiError("rule_carved_nothing", "这条规则在这本书上切不出第二个章节，已保留原目录；换一条或改用自动"),
                )
            }
            database.importLocalBook(bookId, parsed, null, existing.groupId)
            database.clampShelfProgress(request.sourceId, request.bookUrl, parsed.chapters.size)
            val used = parsed.tocRuleUsed ?: TocRules.BUILTIN
            call.respond(
                LocalBookReparseResult(
                    success = true,
                    name = parsed.title,
                    totalChapters = parsed.chapters.size,
                    tocRuleUsed = used,
                    ruleLabel = TocRules.label(used),
                    fellBack = used == TocRules.BUILTIN && request.ruleKey == TocRules.AUTO,
                ),
            )
        }
        get("/bookshelf/groups") {
            call.respond(database.listBookGroups())
        }
        post("/bookshelf/groups") {
            if (!call.requireSameOriginWrite()) return@post
            val request = runCatching { call.receive<BookGroupCreateRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@post
            }
            try { call.respond(database.createBookGroup(request.name)) }
            catch (error: IllegalArgumentException) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_group", error.message ?: "分组无效")) }
        }
        delete("/bookshelf/groups/{id}") {
            if (!call.requireSameOriginWrite()) return@delete
            val id = call.parameters["id"]?.toLongOrNull()
                ?: return@delete call.respond(HttpStatusCode.BadRequest, ApiError("invalid_group", "分组标识无效"))
            if (database.deleteBookGroup(id)) call.respond(HttpStatusCode.NoContent)
            else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "分组不存在"))
        }
        put("/bookshelf/group") {
            if (!call.requireSameOriginWrite()) return@put
            val request = call.receive<BookGroupAssignRequest>()
            val updated = database.assignBookGroup(request.sourceId, request.bookUrl, request.groupId)
                ?: return@put call.respond(HttpStatusCode.NotFound, ApiError("not_found", "分组不存在或这本书不在书架上"))
            call.respond(updated)
        }
        put("/bookshelf/order") {
            if (!call.requireSameOriginWrite()) return@put
            val request = runCatching { call.receive<ShelfOrderRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@put
            }
            if (request.books.isEmpty()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("empty_order", "没有要排序的书")); return@put
            }
            call.respond(ShelfOrderResult(database.reorderBookshelf(request.books)))
        }
        delete("/bookshelf/order") {
            if (!call.requireSameOriginWrite()) return@delete
            call.respond(ShelfOrderResult(database.clearBookshelfOrder()))
        }
        get("/marks") {
            val name = call.request.queryParameters["name"]
            val marks = if (name.isNullOrBlank()) {
                database.listMarks()
            } else {
                database.listMarks(database.bookKeyOf(name, call.request.queryParameters["author"] ?: ""))
            }
            call.respond(marks)
        }
        post("/marks") {
            if (!call.requireSameOriginWrite()) return@post
            val request = runCatching { call.receive<BookMarkCreateRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@post
            }
            // 整章书签天生没有原文（它标的就是"这一章"），所以只有段落书签才要求至少有一句原文或批注
            if (request.paragraphFrom >= 0 && request.quote.isBlank() && request.note.isBlank()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("empty_mark", "书签至少要有一句原文或一条批注")); return@post
            }
            call.respond(database.createMark(request))
        }
        put("/marks/{id}/note") {
            if (!call.requireSameOriginWrite()) return@put
            val id = call.parameters["id"]?.toLongOrNull()
                ?: return@put call.respond(HttpStatusCode.BadRequest, ApiError("invalid_mark", "书签标识无效"))
            val request = runCatching { call.receive<BookMarkNoteRequest>() }.getOrElse {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 JSON")); return@put
            }
            val updated = database.updateMarkNote(id, request.note)
                ?: return@put call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书签不存在"))
            call.respond(updated)
        }
        delete("/marks/{id}") {
            if (!call.requireSameOriginWrite()) return@delete
            val id = call.parameters["id"]?.toLongOrNull()
                ?: return@delete call.respond(HttpStatusCode.BadRequest, ApiError("invalid_mark", "书签标识无效"))
            if (database.deleteMark(id)) call.respond(HttpStatusCode.NoContent)
            else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书签不存在"))
        }
        delete("/bookshelf") {
            if (!call.requireSameOriginWrite()) return@delete
            val sourceId = call.request.queryParameters["sourceId"]; val bookUrl = call.request.queryParameters["bookUrl"]
            if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank()) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "缺少书籍标识")); return@delete }
            bookCache.cancel(sourceId, bookUrl)
            if (sourceId == LocalBookParser.LOC_BOOK_SOURCE_ID) {
                val bookId = bookUrl.removePrefix("local://").substringBefore('/')
                if (bookId.isNotBlank()) {
                    runCatching {
                        if (Files.exists(localBooksDirectory)) {
                            Files.list(localBooksDirectory).use { stream ->
                                stream.filter { it.fileName.toString().startsWith(bookId) }.forEach { Files.deleteIfExists(it) }
                            }
                        }
                    }
                }
            }
            database.removeBookshelf(sourceId, bookUrl)?.let(coverCache::delete)
            call.respond(HttpStatusCode.NoContent)
        }
        post("/bookshelf/cache") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BookCacheRangeRequest>()
            val item = database.listBookshelf().firstOrNull { it.sourceId == request.sourceId && it.bookUrl == request.bookUrl }
                ?: return@post call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书籍不在书架中"))
            bookCache.enqueue(CachedBookRequest(
                item.sourceId,
                item.bookUrl,
                item.tocUrl,
                request.startIndex,
                request.endIndex,
                request.count
            ))
            call.respond(HttpStatusCode.Accepted, mapOf("status" to "queued"))
        }
        get("/bookshelf/cached-chapters") {
            if (!call.requireSameOriginWrite()) return@get
            val sourceId = call.request.queryParameters["sourceId"]
            val bookUrl = call.request.queryParameters["bookUrl"]
            if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "缺少书籍标识"))
                return@get
            }
            val cachedUrls = database.cachedChapterUrls(sourceId, bookUrl).toList()
            val total = database.getTocCache(sourceId, bookUrl)?.size ?: 0
            call.respond(CachedChaptersResponse(sourceId, bookUrl, cachedUrls, cachedUrls.size, total))
        }
        delete("/bookshelf/cache") {
            if (!call.requireSameOriginWrite()) return@delete
            val sourceId = call.request.queryParameters["sourceId"]
            val bookUrl = call.request.queryParameters["bookUrl"]
            val clearData = call.request.queryParameters["clearData"]?.toBooleanStrictOrNull() ?: false
            if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "缺少书籍标识"))
                return@delete
            }
            bookCache.cancel(sourceId, bookUrl)
            if (clearData) {
                database.clearBookCacheContent(sourceId, bookUrl)
            }
            call.respond(HttpStatusCode.NoContent)
        }
        put("/bookshelf/status") {
            if (!call.requireSameOriginWrite()) return@put
            val request = call.receive<BookshelfStatusRequest>()
            if (request.sourceId.isBlank() || request.bookUrl.isBlank()) return@put call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "缺少书籍标识"))
            database.setBookshelfCompleted(request.sourceId, request.bookUrl, request.completed)?.let { call.respond(it) }
                ?: call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书籍不在书架中"))
        }
        put("/bookshelf/info") {
            if (!call.requireSameOriginWrite()) return@put
            val request = call.receive<BookshelfInfoUpdateRequest>()
            if (request.sourceId.isBlank() || request.bookUrl.isBlank() || request.name.isBlank()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "书名不能为空"))
                return@put
            }
            val cover = request.coverUrl?.takeIf { it.isNotBlank() }?.let { url ->
                runCatching { coverCache.cache(url) }.getOrNull()
            }
            database.updateBookshelfInfo(request, cover)?.let { call.respond(it) }
                ?: call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书籍不在书架中"))
        }
        post("/bookshelf/switch-source") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BookshelfSourceSwitchRequest>()
            val book = request.book
            if (request.oldSourceId.isBlank() || request.oldBookUrl.isBlank() || book.sourceId.isBlank() || book.bookUrl.isBlank() || book.name.isBlank() || book.tocUrl.isBlank()) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_bookshelf", "书架数据无效")); return@post }
            val altList = (request.alternateSources ?: emptyList()) + (book.alternateSources ?: emptyList())
            val cover = tryCacheCover(coverCache, book.coverUrl, altList)
            bookCache.cancel(request.oldSourceId, request.oldBookUrl)
            val (item, orphan) = database.switchBookshelf(request.oldSourceId, request.oldBookUrl, book, cover, request.alternateSources)
            orphan?.let(coverCache::delete)
            bookCache.enqueue(CachedBookRequest(book.sourceId, book.bookUrl, book.tocUrl))
            call.respond(item)
        }
        
        // 批量操作：删除多本书籍
        post("/bookshelf/batch-delete") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BatchDeleteRequest>()
            if (request.books.isEmpty()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "书籍列表不能为空"))
                return@post
            }
            var deletedCount = 0
            for (book in request.books) {
                if (book.sourceId.isNotBlank() && book.bookUrl.isNotBlank()) {
                    bookCache.cancel(book.sourceId, book.bookUrl)
                    if (book.sourceId == LocalBookParser.LOC_BOOK_SOURCE_ID) {
                        val bookId = book.bookUrl.removePrefix("local://").substringBefore('/')
                        if (bookId.isNotBlank()) {
                            runCatching {
                                if (Files.exists(localBooksDirectory)) {
                                    Files.list(localBooksDirectory).use { stream ->
                                        stream.filter { it.fileName.toString().startsWith(bookId) }.forEach { Files.deleteIfExists(it) }
                                    }
                                }
                            }
                        }
                    }
                    database.removeBookshelf(book.sourceId, book.bookUrl)?.let(coverCache::delete)
                    deletedCount++
                }
            }
            call.respond(mapOf("deleted" to deletedCount, "total" to request.books.size))
        }
        
        // 批量操作：移动多本书籍到指定分组
        post("/bookshelf/batch-move-group") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BatchMoveGroupRequest>()
            if (request.books.isEmpty()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "书籍列表不能为空"))
                return@post
            }
            val movedCount = database.batchUpdateBookshelfGroup(request.books, request.groupId)
            call.respond(mapOf("moved" to movedCount, "total" to request.books.size))
        }
        
        // 批量操作：把多本书标成「已读完 / 正在阅读」。
        // 必须走与单本右键**同一个**写入口（书架的 completed 标记）：这里原来改的是阅读进度
        // （已读=把进度推到最后一章、未读=直接删掉 reading_progress），于是界面上什么都不变
        // （用户 2026-10-02：「批量管理中标注已读完没有任何显示，右击标注已读完正常」），
        // 而"未读"那一支还会把用户读到哪儿抹掉 —— 那是比不显示更糟的后果。
        post("/bookshelf/batch-mark-read") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<BatchMarkReadRequest>()
            if (request.books.isEmpty()) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "书籍列表不能为空"))
                return@post
            }
            var markedCount = 0
            for (book in request.books) {
                if (book.sourceId.isNotBlank() && book.bookUrl.isNotBlank()
                    && database.setBookshelfCompleted(book.sourceId, book.bookUrl, request.isRead) != null) markedCount++
            }
            call.respond(mapOf("marked" to markedCount, "total" to request.books.size))
        }
        
        get("/covers/{key}") {
            val key = call.parameters["key"] ?: return@get call.respond(HttpStatusCode.NotFound)
            val file = coverCache.file(key) ?: return@get call.respond(HttpStatusCode.NotFound)
            val type = database.coverContentType(key)?.let(ContentType::parse) ?: ContentType.Application.OctetStream
            call.response.cacheControl(CacheControl.MaxAge(maxAgeSeconds = 7 * 24 * 60 * 60, visibility = CacheControl.Visibility.Private))
            call.respond(LocalFileContent(file.toFile(), type))
        }
        /**
         * 本地 EPUB 的内嵌插图（用户 2026-10-02：本地阅读器要「支持图片」）。
         *
         * 包里的图不会自己出现在网上，只能从原始文件里按 zip entry 取字节。三条边界写死在这里：
         * ① `bookId` 必须是导入时生成的那串十六进制 —— 它同时是磁盘上的文件名，
         *    放开形状等于"用文件名读盘上任意文件"；
         * ② entry 路径拒绝 `..`，且只接受包里真实存在、归一化后完全相等的那个名字（不做前缀匹配）；
         * ③ 只回真正的图片（按魔数判，扩展名只作兜底），svg 一律不回 —— 同源 SVG 能带脚本。
         */
        get("/books/local/asset") {
            val bookId = call.request.queryParameters["bookId"].orEmpty()
            val wanted = call.request.queryParameters["path"].orEmpty().replace('\\', '/').trimStart('/')
            if (!LOCAL_BOOK_ID.matches(bookId) || wanted.isBlank() || wanted.contains("..")) {
                return@get call.respond(HttpStatusCode.NotFound)
            }
            val archive = runCatching {
                localBooksDirectory.toFile().listFiles()?.firstOrNull {
                    it.isFile && it.name.startsWith("$bookId.") && it.name.endsWith(".epub", ignoreCase = true)
                }
            }.getOrNull() ?: return@get call.respond(HttpStatusCode.NotFound)
            val asset = runCatching {
                java.util.zip.ZipFile(archive).use { zip ->
                    val entry = zip.entries().asSequence().firstOrNull { candidate ->
                        !candidate.isDirectory &&
                            candidate.name.replace('\\', '/').removePrefix("./") == wanted
                    } ?: return@use null
                    if (entry.size > 5L * 1024 * 1024 || entry.size < 0) return@use null
                    val bytes = zip.getInputStream(entry).readBytes()
                    localAssetType(wanted, bytes)?.let { Triple(bytes, it, entry.time) }
                }
            }.getOrNull() ?: return@get call.respond(HttpStatusCode.NotFound)
            call.response.cacheControl(CacheControl.MaxAge(maxAgeSeconds = 30 * 24 * 60 * 60, visibility = CacheControl.Visibility.Private))
            call.response.header("X-Content-Type-Options", "nosniff")
            call.respondBytes(asset.first, ContentType.parse(asset.second))
        }
        get("/book/image") {
            val url = call.request.queryParameters["url"].orEmpty()
            if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_image", "图片地址无效")); return@get
            }
            // `page` 是图片所在的那一页，拿来当 Referer —— 图站按防盗链判来源，不带就回 403 占位图。
            val referer = call.request.queryParameters["page"]?.takeIf { it.startsWith("http", ignoreCase = true) }
            try {
                val cached = coverCache.cacheContentImage(url, referer)
                val file = coverCache.file(cached.key) ?: return@get call.respond(HttpStatusCode.NotFound)
                call.response.cacheControl(CacheControl.MaxAge(maxAgeSeconds = 7 * 24 * 60 * 60, visibility = CacheControl.Visibility.Private))
                call.respond(LocalFileContent(file.toFile(), ContentType.parse(cached.contentType)))
            } catch (error: Exception) {
                // 走 LogService，不走 Ktor 的 debug 档：图挂了就只在控制台留一行 debug，
                // 「运行日志」里什么都没有 —— 与这一轮修掉的"收集了却看不见"是同一个病。
                // 级别是警告不是错误：一张图取不到，阅读器会退化成占位图，不算事故。
                Unit.logNetwork(
                    "正文图片代理失败",
                    mapOf(
                        "host" to (runCatching { java.net.URI(url.trim()).host }.getOrNull() ?: "未知"),
                        "原因" to (error.message ?: error.javaClass.simpleName),
                        "url" to url.take(120),
                    ),
                )
                call.respond(HttpStatusCode.BadGateway, ApiError("image_failed", error.message ?: "图片抓取失败"))
            }
        }
        get("/reading-progress") {
            val sourceId = call.request.queryParameters["sourceId"]
            val bookUrl = call.request.queryParameters["bookUrl"]
            if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank()) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_progress", "缺少 sourceId 或 bookUrl")); return@get }
            database.getProgress(sourceId, bookUrl)?.let { call.respond(it) } ?: call.respond(HttpStatusCode.NoContent)
        }
        put("/reading-progress") {
            if (!call.requireSameOriginWrite()) return@put
            val progress = call.receive<ReadingProgress>()
            if (progress.sourceId.isBlank() || progress.bookUrl.isBlank() || progress.chapterUrl.isBlank() || progress.chapterIndex < 0 || !progress.scrollPosition.isFinite() || progress.scrollPosition !in 0.0..1.0) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_progress", "阅读进度无效")); return@put }
            call.respond(database.saveProgress(progress))
        }
        route("/tts") {
            get("/voices") {
                call.respond(edgeTts.listVoices())
            }
            post("/session") {
                call.respond(ttsSessions.create(LOCAL_TTS_OWNER))
            }
            post("/session/{id}/chunks") {
                val session = ttsSessions.get(call.parameters["id"] ?: "", LOCAL_TTS_OWNER)
                    ?: run {
                        call.respond(HttpStatusCode.NotFound, ApiError("tts_session_not_found", "朗读会话不存在"))
                        return@post
                    }
                try {
                    val accepted = session.append(call.receive<TtsSessionChunkRequest>())
                    if (!accepted) {
                        call.respond(HttpStatusCode.Conflict, ApiError("tts_session_busy", "朗读队列已满"))
                    } else {
                        call.respond(TtsSessionAck(accepted = true))
                    }
                } catch (error: IllegalArgumentException) {
                    call.respond(HttpStatusCode.BadRequest, ApiError("invalid_tts_chunk", error.message ?: "朗读分片无效"))
                }
            }
            post("/session/{id}/control") {
                val session = ttsSessions.get(call.parameters["id"] ?: "", LOCAL_TTS_OWNER)
                    ?: run {
                        call.respond(HttpStatusCode.NotFound, ApiError("tts_session_not_found", "朗读会话不存在"))
                        return@post
                    }
                val request = call.receive<TtsSessionControlRequest>()
                when (request.action) {
                    "pause" -> session.pause()
                    "resume" -> session.resume()
                    "stop" -> ttsSessions.remove(session)
                    else -> {
                        call.respond(HttpStatusCode.BadRequest, ApiError("invalid_tts_action", "不支持的朗读操作"))
                        return@post
                    }
                }
                call.respond(TtsSessionAck(accepted = true))
            }
            delete("/session/{id}") {
                val session = ttsSessions.get(call.parameters["id"] ?: "", LOCAL_TTS_OWNER)
                    ?: run {
                        call.respond(HttpStatusCode.NotFound, ApiError("tts_session_not_found", "朗读会话不存在"))
                        return@delete
                    }
                ttsSessions.remove(session)
                call.respond(HttpStatusCode.NoContent)
            }
            get("/session/{id}/audio") {
                val session = ttsSessions.get(call.parameters["id"] ?: "", LOCAL_TTS_OWNER)
                    ?: run {
                        call.respond(HttpStatusCode.NotFound, ApiError("tts_session_not_found", "朗读会话不存在"))
                        return@get
                    }
                call.response.cacheControl(CacheControl.NoStore(null))
                call.response.header("X-Accel-Buffering", "no")
                call.response.header("Cache-Control", "no-cache, no-transform")
                call.response.header("Connection", "keep-alive")
                call.respondBytesWriter(ContentType.Audio.MPEG, status = HttpStatusCode.OK) {
                    session.streamAudio(this)
                }
            }
            get("/session/{id}/events") {
                val session = ttsSessions.get(call.parameters["id"] ?: "", LOCAL_TTS_OWNER)
                    ?: run {
                        call.respond(HttpStatusCode.NotFound, ApiError("tts_session_not_found", "朗读会话不存在"))
                        return@get
                    }
                call.response.cacheControl(CacheControl.NoStore(null))
                call.response.header("X-Accel-Buffering", "no")
                call.response.header("Cache-Control", "no-cache, no-transform")
                call.response.header("Connection", "keep-alive")
                call.respondTextWriter(ContentType.Text.EventStream) {
                    session.streamEvents(this)
                }
            }
            post("/speak") {
                // customUrl 由请求体决定，等于让调用方指定服务端要抓哪个地址；
                // 之前只验会话不验 CSRF，任何网页发个简单跨站请求就能借这台机器去打内网。
                if (!call.requireSameOriginWrite()) return@post
                val req = call.receive<TtsSpeakRequest>()
                val text = req.text.trim()
                if (text.isEmpty()) {
                    call.respond(HttpStatusCode.BadRequest, ApiError("invalid_text", "朗读文本不能为空"))
                    return@post
                }
                try {
                    if (req.engine == "custom" && !req.customUrl.isNullOrBlank()) {
                        val (contentType, audioBytes) = edgeTts.synthesizeCustom(req)
                        call.respondBytes(
                            bytes = audioBytes,
                            contentType = ContentType.parse(contentType),
                            status = HttpStatusCode.OK,
                        )
                    } else {
                        val audioBytes = edgeTts.synthesize(
                            text = text,
                            voice = req.voice.ifBlank { "zh-CN-XiaoxiaoNeural" },
                            rate = req.rate,
                            pitch = req.pitch,
                        )
                        call.respondBytes(
                            bytes = audioBytes,
                            contentType = ContentType.Audio.MPEG,
                            status = HttpStatusCode.OK,
                        )
                    }
                } catch (e: Exception) {
                    call.application.log.warn("TTS synthesis failed for voice={}: {}", req.voice, e.message)
                    call.respond(HttpStatusCode.InternalServerError, ApiError("tts_failed", e.message ?: "语音合成失败"))
                }
            }
            get("/speak") {
                val text = call.request.queryParameters["text"]?.trim() ?: ""
                if (text.isEmpty()) {
                    call.respond(HttpStatusCode.BadRequest, ApiError("invalid_text", "朗读文本不能为空"))
                    return@get
                }
                val voice = call.request.queryParameters["voice"] ?: "zh-CN-XiaoxiaoNeural"
                val rate = call.request.queryParameters["rate"]?.toIntOrNull() ?: 0
                val pitch = call.request.queryParameters["pitch"]?.toIntOrNull() ?: 0
                try {
                    val audioBytes = edgeTts.synthesize(text = text, voice = voice, rate = rate, pitch = pitch)
                    call.respondBytes(
                        bytes = audioBytes,
                        contentType = ContentType.Audio.MPEG,
                        status = HttpStatusCode.OK,
                    )
                } catch (e: Exception) {
                    call.application.log.warn("TTS get speak failed: {}", e.message)
                    call.respond(HttpStatusCode.InternalServerError, ApiError("tts_failed", e.message ?: "语音合成失败"))
                }
            }
        }
    }
}

private fun validateSubscriptionUrl(value: String) {
    val uri = runCatching { java.net.URI(value) }.getOrNull()
    require(uri?.scheme in setOf("http", "https") && !uri?.host.isNullOrBlank()) { "仅允许 HTTP(S) 订阅地址" }
    // 保存期就用与抓取期同一道 SSRF 闸门：内网/元数据地址当场拒掉，别等定时更新才失败
    NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "订阅")
}

private val SEARCH_TIMEOUT_MS = AppConfig.searchTimeoutMs

private suspend fun readableSearchResults(runner: RuleRunner, sourceJson: String, keyword: String): List<SearchResult> =
    searchSourceOutcome(runner, sourceJson, keyword).results

internal data class SearchSourceOutcome(val results: List<SearchResult>, val failed: Boolean)

internal class SearchStreamCounters(private val totalSources: Int) {
    private val completed = AtomicInteger()
    private val matched = AtomicInteger()
    private val empty = AtomicInteger()
    private val failed = AtomicInteger()
    private val resultCount = AtomicInteger()

    fun complete(outcome: SearchSourceOutcome): SearchStreamEvent {
        when {
            outcome.results.isNotEmpty() -> {
                matched.incrementAndGet()
                resultCount.addAndGet(outcome.results.size)
            }
            outcome.failed -> failed.incrementAndGet()
            else -> empty.incrementAndGet()
        }
        completed.incrementAndGet()
        return snapshot()
    }

    fun snapshot(type: String = "progress") = SearchStreamEvent(
        type = type,
        totalSources = totalSources,
        completedSources = completed.get(),
        matchedSources = matched.get(),
        emptySources = empty.get(),
        failedSources = failed.get(),
        resultCount = resultCount.get(),
    )
}

internal suspend fun searchSourceOutcome(
    runner: RuleRunner,
    sourceJson: String,
    keyword: String,
    timeoutMs: Long = SEARCH_TIMEOUT_MS,
): SearchSourceOutcome {
    /*
     * 到点的是**这一个源**，不是整次搜索。
     * `TimeoutCancellationException` 是 `CancellationException` 的子类，而这里原来只有一句
     * `if (error is CancellationException) throw error` —— 于是库里某一个源拖过 30 秒，取消就顺着
     * `coroutineScope` 传到整棵搜索树上：别的源已经搜到的那几十本一起作废，界面收到 500
     * （selfcheck「多源并发搜索返回的是数组」红过一次就是它，`server.log` 里留的是
     * `Unhandled request failure: TimeoutCancellationException`）。
     * 真正该往上传的只有"调用方自己取消了"（客户端停读、页面关了）—— 那种情况回答也没人看。
     */
    val results = try {
        withTimeout(timeoutMs) { withContext(Dispatchers.IO) { runner.search(sourceJson, keyword) } }
    } catch (error: TimeoutCancellationException) {
        return SearchSourceOutcome(emptyList(), failed = true)
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        return SearchSourceOutcome(emptyList(), failed = true)
    }
    return SearchSourceOutcome(results, failed = false)
}

internal fun sourceSearchConcurrency(processors: Int = Runtime.getRuntime().availableProcessors()): Int =
    processors.coerceIn(AppConfig.searchConcurrencyMin, AppConfig.searchConcurrencyMax)

internal suspend fun <T, R> boundedConcurrentMap(values: List<T>, limit: Int, action: suspend (T) -> R): List<R> = coroutineScope {
    val semaphore = Semaphore(limit.coerceAtLeast(1))
    values.map { value -> async { semaphore.withPermit { action(value) } } }.awaitAll()
}

private suspend fun ApplicationCall.respondCatching(block: suspend () -> Any) {
    try { respond(block()) }
    catch (error: RuleExecutionException) { respond(HttpStatusCode.BadGateway, ApiError("source_execution_failed", error.message ?: "书源执行失败")) }
    catch (error: Exception) { respond(HttpStatusCode.BadGateway, ApiError("source_execution_failed", error.message ?: "书源执行失败")) }
}

internal fun tryFindCachedCover(coverCache: CoverCache, primaryUrl: String?, alternateSources: List<SearchResult>?): CachedCover? {
    val candidates = buildList {
        primaryUrl?.takeIf { it.isNotBlank() }?.let { add(it) }
        alternateSources?.forEach { s ->
            s.coverUrl?.takeIf { it.isNotBlank() && it !in this }?.let { add(it) }
        }
    }
    for (url in candidates) {
        val cached = coverCache.getIfCached(url)
        if (cached != null) return cached
    }
    return null
}

internal fun tryCacheCover(coverCache: CoverCache, primaryUrl: String?, alternateSources: List<SearchResult>?): CachedCover? {
    val candidates = buildList {
        primaryUrl?.takeIf { it.isNotBlank() }?.let { add(it) }
        alternateSources?.forEach { s ->
            s.coverUrl?.takeIf { it.isNotBlank() && it !in this }?.let { add(it) }
        }
    }
    for (url in candidates) {
        val cached = runCatching { coverCache.cache(url) }.getOrNull()
        if (cached != null) return cached
    }
    return null
}

private fun jsonEvent(message: String): String = Json.encodeToString(message)

/** 调试事件的序列化器：`encodeDefaults` 必须开着，否则前端拿到的 JSON 会缺掉空字段。 */
/**
 * 本地书 id 的形状：导入时 `UUID.randomUUID().toString().replace("-", "")` 生成，32 位小写十六进制。
 * 取包内图片时拿它当文件名用，所以宁可窄：不匹配就直接 404，不去猜。
 */
private val LOCAL_BOOK_ID = Regex("^[0-9a-f]{16,64}$")

/**
 * 包内资源的媒体类型。**先按魔数判，扩展名只作兜底**：zip 里的名字是作者起的，
 * 内容与扩展名不符时按扩展名回会让浏览器拿错的类型渲染（而这里回的是同源地址）。
 * 认不出来的一律不回（null → 404），svg 显式排除 —— 同源 SVG 可以带脚本。
 * `internal` 而不是 `private`：这是路由的安全边界，判据要能直接打到它，不该靠反射。
 */
internal fun localAssetType(path: String, bytes: ByteArray): String? {
    // 小于这个尺寸不可能是能显示的图片（1x1 的 gif 也有三十几字节）。
    // 有了这一档，"扩展名叫 cover.png 但内容只有几个字节"也不会被当图片同源回出去。
    if (bytes.size < 32) return null
    fun isPrefix(offset: Int, text: String) = bytes.size > offset + text.length &&
        (0 until text.length).all { bytes[offset + it] == text[it].code.toByte() }
    val magic = when {
        bytes.size > 8 && bytes[0] == 0x89.toByte() && isPrefix(1, "PNG") -> "image/png"
        bytes.size > 3 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() -> "image/jpeg"
        isPrefix(0, "GIF8") -> "image/gif"
        isPrefix(0, "RIFF") && isPrefix(8, "WEBP") -> "image/webp"
        isPrefix(0, "BM") -> "image/bmp"
        else -> null
    }
    if (magic != null) return magic
    val ext = path.substringAfterLast('.', "").lowercase()
    return when (ext) {
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "bmp" -> "image/bmp"
        // svg / xml / html / 未知：同源回出去就是 XSS 面，宁可不显示
        else -> null
    }
}

private val debugJson = Json { encodeDefaults = true }

/**
 * Cookie 同步接口只接受「该书源自己的站点」发来的跨站请求：没有 Origin 头视为本机工具或同源页面，放行；
 * 有 Origin 则必须命中书源 `bookSourceUrl` / `loginUrl` 的注册域（或该主机名确实出现在这份书源配置里，
 * 兼容用自定义标识当 URL 的聚合源）。命中时回显该 Origin 并带 `Vary: Origin`，不再使用 `*`。
 */
/** Origin 的主机与端口都和请求的 Host 一致才算同源（Origin 由浏览器写，页面改不了）。 */
private fun sameOriginCall(call: ApplicationCall): Boolean {
    val origin = call.request.headers[HttpHeaders.Origin]?.trim()?.takeIf { it.isNotEmpty() } ?: return false
    val uri = runCatching { URI(origin) }.getOrNull() ?: return false
    val originHost = uri.host?.lowercase()?.trim('[', ']')?.takeIf { it.isNotEmpty() } ?: return false
    val requestHost = call.request.host().lowercase().substringBefore(':').trim('[', ']')
    if (originHost != requestHost) return false
    val originPort = if (uri.port > 0) uri.port else if (uri.scheme == "https") 443 else 80
    return originPort == call.request.port()
}

private fun allowCookieSyncOrigin(call: ApplicationCall, database: Database, sourceJson: String? = null): Boolean {
    val origin = call.request.headers[HttpHeaders.Origin]?.trim()?.takeIf { it.isNotEmpty() } ?: return true
    val host = runCatching { URI(origin).host?.lowercase() }.getOrNull()?.takeIf { it.isNotEmpty() }
        ?: return false
    val json = sourceJson ?: call.parameters["id"]?.let { database.getSource(it)?.json }
    val domains = json?.let { runCatching { WebViewProxy.allowedDomains(it) }.getOrNull() }.orEmpty()
    val registrable = runCatching { WebViewProxy.registrableDomain(host) }.getOrDefault(host)
    val matchesDomain = domains.any { registrable == it || host == it || host.endsWith(".$it") }
    if (!matchesDomain && json?.contains(host) != true) return false
    call.response.headers.append(HttpHeaders.AccessControlAllowOrigin, origin)
    call.response.headers.append(HttpHeaders.Vary, "Origin")
    return true
}

/**
 * 把代理结果写回响应；失败时返回一张可读的 HTML 错误页（因为它会被渲染进内置浏览器 iframe）。
 */
private suspend fun ApplicationCall.respondProxied(block: () -> ProxiedPayload) {
    // iframe 处于 sandbox 不透明源下，页面内 JS 发起的请求需要 CORS 放行；
    // 这些端点本身由一次性令牌鉴权，不依赖管理会话，因此放开 * 不会泄露权限。
    response.headers.append(HttpHeaders.AccessControlAllowOrigin, "*")
    try {
        val payload = withContext(Dispatchers.IO) { block() }
        respondBytes(
            bytes = payload.body,
            contentType = runCatching { ContentType.parse(payload.contentType) }.getOrNull(),
            status = HttpStatusCode.fromValue(payload.status),
        )
    } catch (error: WebViewException) {
        application.log.warn("webview proxy failed: {}", error.message)
        respondText(
            text = webViewErrorPage(error.message ?: "内置浏览器请求失败"),
            contentType = ContentType.Text.Html.withCharset(Charsets.UTF_8),
            status = HttpStatusCode.BadGateway,
        )
    }
}

private fun webViewErrorPage(message: String): String {
    val escaped = message
        .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return """
        <!doctype html>
        <html lang="zh-CN"><head><meta charset="utf-8"><title>内置浏览器无法打开页面</title>
        <style>
          body{margin:0;padding:32px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
               background:#0f1115;color:#e6e8eb;display:flex;align-items:center;justify-content:center;min-height:100vh}
          .card{max-width:520px;background:#171a21;border:1px solid #262b36;border-radius:12px;padding:24px}
          h1{margin:0 0 12px;font-size:16px;color:#f87171}
          p{margin:0;font-size:13px;line-height:1.7;color:#9aa4b2;word-break:break-all}
        </style></head>
        <body><div class="card"><h1>无法打开该页面</h1><p>$escaped</p></div></body></html>
    """.trimIndent()
}

private suspend fun parseImportedReplaceRules(bodyText: String): List<ReplaceRule> {
    val cleanText = bodyText.trim().removePrefix("\uFEFF")
    if (cleanText.isBlank()) return emptyList()

    val json = Json { ignoreUnknownKeys = true; isLenient = true }
    val jsonElement = runCatching { json.parseToJsonElement(cleanText) }.getOrNull() ?: return emptyList()

    // Check if it's an object with "url"
    if (jsonElement is kotlinx.serialization.json.JsonObject) {
        val url = jsonElement["url"]?.let { if (it is JsonPrimitive) it.contentOrNull else null }
        if (!url.isNullOrBlank()) {
            validateSubscriptionUrl(url)
            val client = java.net.http.HttpClient.newBuilder().connectTimeout(java.time.Duration.ofSeconds(10)).build()
            val req = java.net.http.HttpRequest.newBuilder().uri(java.net.URI(url)).GET().build()
            val resp = withContext(Dispatchers.IO) { client.send(req, java.net.http.HttpResponse.BodyHandlers.ofString(Charsets.UTF_8)) }
            return parseImportedReplaceRules(resp.body())
        }
    }

    val array = when (jsonElement) {
        is kotlinx.serialization.json.JsonArray -> jsonElement
        is kotlinx.serialization.json.JsonObject -> {
            (jsonElement["rules"] ?: jsonElement["data"] ?: jsonElement["replaceRules"] ?: jsonElement["items"]) as? kotlinx.serialization.json.JsonArray
        }
        else -> null
    } ?: return emptyList()

    return array.mapNotNull { item ->
        if (item !is kotlinx.serialization.json.JsonObject) return@mapNotNull null
        val pattern = item["pattern"]?.let { if (it is JsonPrimitive) it.contentOrNull else null } ?: return@mapNotNull null
        if (pattern.isBlank()) return@mapNotNull null
        val id = item["id"]?.let { if (it is JsonPrimitive) it.contentOrNull else null } ?: ""
        val name = item["name"]?.let { if (it is JsonPrimitive) it.contentOrNull else null } ?: pattern
        val group = item["group"]?.let { if (it is JsonPrimitive) it.contentOrNull else null } ?: item["groupName"]?.let { if (it is JsonPrimitive) it.contentOrNull else null }
        val replacement = item["replacement"]?.let { if (it is JsonPrimitive) it.contentOrNull else null } ?: ""
        val isRegex = item["isRegex"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toBooleanStrictOrNull() ?: (it.contentOrNull?.toIntOrNull() != 0) else null } ?: true
        val scope = item["scope"]?.let { if (it is JsonPrimitive) it.contentOrNull else null }
        val excludeScope = item["excludeScope"]?.let { if (it is JsonPrimitive) it.contentOrNull else null }
        val scopeTitle = item["scopeTitle"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toBooleanStrictOrNull() ?: (it.contentOrNull?.toIntOrNull() == 1) else null } ?: false
        val scopeContent = item["scopeContent"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toBooleanStrictOrNull() ?: (it.contentOrNull?.toIntOrNull() != 0) else null } ?: true
        val isEnabled = item["isEnabled"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toBooleanStrictOrNull() ?: (it.contentOrNull?.toIntOrNull() != 0) else null } ?: true
        val order = item["order"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toIntOrNull() else null } ?: item["sortOrder"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toIntOrNull() else null } ?: 0
        val timeoutMs = item["timeoutMillisecond"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toLongOrNull() else null } ?: item["timeout_ms"]?.let { if (it is JsonPrimitive) it.contentOrNull?.toLongOrNull() else null } ?: 3000L

        ReplaceRule(
            id = id,
            name = name,
            group = group,
            pattern = pattern,
            replacement = replacement,
            isRegex = isRegex,
            scope = scope,
            excludeScope = excludeScope,
            scopeTitle = scopeTitle,
            scopeContent = scopeContent,
            isEnabled = isEnabled,
            order = order,
            timeoutMillisecond = timeoutMs,
        )
    }
}



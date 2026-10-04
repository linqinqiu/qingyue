package io.legado.server

import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.cio.*
import io.ktor.server.engine.*
import io.ktor.server.plugins.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.plugins.statuspages.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.sessions.*
import io.ktor.server.websocket.*
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import java.nio.file.Files

fun main() {
    val config = ServerConfig.fromEnvironment()
    /*
     * 停读的客户端会把一个线程整篇压在 socket 的阻塞写上（不是挂起）：实测 24 个"读了 8KB
     * 就不再往下读"的连接，就能让一个无关的 `/healthz` 等 15 秒 —— 表现就是"端口还在听，
     * 服务像死了"。这条现在做成了可重跑的门禁：`tools/verify/stalled-client-check.mjs`。
     *
     * 能调的旋钮是引擎的分组线程数：`callGroupSize` 决定"跑请求处理与写响应"那一组有多大，
     * 默认等于 CPU 核数 —— 也就是说几台停读的浏览器就能把整组占满，连搜索要的算力一起拖死。
     * 给到 64 之后，阻塞写占的是这一组（本来就是为"可能在等"而存在的组），
     * 而 DefaultDispatcher 那批线程留给规则引擎与搜索。
     *
     * 形状上的坑记一笔：`embeddedServer(CIO, host, port) { … }` 那条重载**没有** configure 参数，
     * 尾随 lambda 是 module 而不是引擎配置 —— 要调引擎就得走 environment + configure 这条，
     * 主机端口改由 `connector { }` 给。
     */
    embeddedServer(
        CIO,
        environment = applicationEnvironment(),
        configure = {
            connector { host = config.host; port = config.port }
            callGroupSize = AppConfig.callGroupSize
        },
    ) {
        legadoApplication(config)
    }.start(wait = true)
}

fun Application.legadoApplication(config: ServerConfig = ServerConfig.fromEnvironment()) {
    // 初始化结构化日志系统
    LogService.initialize(config.databasePath)
    logSystem("青阅服务器启动", mapOf("version" to BuildInfo.version, "host" to config.host, "port" to config.port.toString()))
    
    val database = Database(config.databasePath)
    database.initialize()
    val subscriptions = SubscriptionService(database) { message -> log.info(message) }
    val runner = RuleRunner(database = database)
    val bookCache = BookCacheService(database, runner) { message -> log.info(message) }
    val edgeTts = EdgeTtsService()
    val ttsSessions = TtsSessionService(edgeTts)
    val coverCache = CoverCache(config.coverCacheDirectory)
    // 早期版本给没有封面的本地书画过一张按书名哈希的彩色 SVG，整架看下去就是彩虹；
    // 生成逻辑已删，这里把已经落库的那批回收掉，界面才会回落到主题化的文字占位。
    val purgedCovers = coverCache.purgeGeneratedLocalCovers(database)
    if (purgedCovers > 0) log.info("已回收 {} 张自动生成的本地书封面", purgedCovers)
    subscriptions.start()
    bookCache.start()
    environment.monitor.subscribe(ApplicationStopping) { 
        logSystem("服务器正在停止")
        subscriptions.stop(); bookCache.stop(); ttsSessions.close(); database.close() 
    }
    environment.monitor.subscribe(ApplicationStopped) { 
        logSystem("服务器已停止")
        subscriptions.stop(); bookCache.stop(); ttsSessions.close(); database.close() 
    }

    install(ContentNegotiation) {
        // encodeDefaults 必须开：kotlinx 默认 false 会把「取值等于默认值」的字段整个省掉，
        // 于是 replacement/isRegex/isEnabled 在响应里消失，前端按非空类型直接用就会白屏。
        json(Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true })
    }
    install(WebSockets)
    install(StatusPages) {
        // 请求体解析失败是客户端错误。没有这几条时它落进下面的 Throwable 分支 → 500 + 整段堆栈刷日志。
        exception<BadRequestException> { call, cause ->
            this@legadoApplication.log.warn("bad request: {}", cause.message)
            call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", cause.message ?: "请求内容无法解析"))
        }
        exception<ContentTransformationException> { call, cause ->
            this@legadoApplication.log.warn("request transform failed: {}", cause.message)
            call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", cause.message ?: "请求内容格式错误"))
        }
        exception<SerializationException> { call, cause ->
            this@legadoApplication.log.warn("request serialization failed: {}", cause.message)
            call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求内容不符合接口字段要求"))
        }
        exception<Throwable> { call, cause ->
            this@legadoApplication.log.error("Unhandled request failure", cause)
            call.respond(HttpStatusCode.InternalServerError, ApiError("internal_error", "服务器内部错误"))
        }
    }
    routing {
        get("/healthz") { call.respond(HealthStatus(title = BuildInfo.title, version = BuildInfo.version, status = "ok")) }
        apiRoutes(database, runner, coverCache, subscriptions, bookCache, edgeTts, ttsSessions, config.localBooksDirectory)
        // 注册在 staticWeb 之前：根路由是 `staticResources("/")`，先摆 /next 才不必去猜路由树的优先级
        staticNext(config.nextDirectory)
        staticWeb()
    }
    logSystem(
        if (Files.isRegularFile(config.nextDirectory.resolve("index.html"))) "新骨架界面已挂载 /next" else "新骨架界面未挂载（没有 next/index.html）",
        mapOf("path" to config.nextDirectory.toAbsolutePath().toString()),
    )
}

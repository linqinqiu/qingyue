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

fun main(args: Array<String>) {
    if (args.firstOrNull() == "reset-password") {
        resetPasswordMain(args.drop(1).toTypedArray())
        return
    }
    val config = ServerConfig.fromEnvironment()
    embeddedServer(CIO, host = config.host, port = config.port) {
        legadoApplication(config)
    }.start(wait = true)
}

fun Application.legadoApplication(config: ServerConfig = ServerConfig.fromEnvironment()) {
    val database = Database(config.databasePath)
    database.initialize(config.initialAdminPassword)
    val auth = AuthService(database, config.secureCookies, config.loopbackNoAuth)
    val subscriptions = SubscriptionService(database) { message -> log.info(message) }
    val runner = RuleRunner(database = database)
    val bookCache = BookCacheService(database, runner) { message -> log.info(message) }
    val edgeTts = EdgeTtsService()
    val ttsSessions = TtsSessionService(edgeTts)
    subscriptions.start()
    bookCache.start()
    environment.monitor.subscribe(ApplicationStopping) { subscriptions.stop(); bookCache.stop(); ttsSessions.close(); database.close() }
    environment.monitor.subscribe(ApplicationStopped) { subscriptions.stop(); bookCache.stop(); ttsSessions.close(); database.close() }

    install(ContentNegotiation) {
        // encodeDefaults 必须开：kotlinx 默认 false 会把「取值等于默认值」的字段整个省掉，
        // 于是 replacement/isRegex/isEnabled 在响应里消失，前端按非空类型直接用就会白屏。
        json(Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true })
    }
    install(Sessions) {
        cookie<UserSession>(AuthService.COOKIE_NAME) {
            cookie.path = "/"
            cookie.httpOnly = true
            cookie.secure = config.secureCookies
            cookie.extensions["SameSite"] = "Strict"
        }
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
        get("/healthz") { call.respond(mapOf("status" to "ok")) }
        authRoutes(auth)
        apiRoutes(database, auth, runner, CoverCache(config.coverCacheDirectory), subscriptions, bookCache, edgeTts, ttsSessions, config.localBooksDirectory)
        webDavRoutes(auth, WebDavStorage(config.webDavDirectory), database)
        staticWeb()
    }
}

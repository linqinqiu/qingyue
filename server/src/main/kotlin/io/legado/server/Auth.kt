package io.legado.server

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.plugins.origin
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.sessions.*
import java.net.URI
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

class AuthService(val database: Database, private val secureCookies: Boolean, val loopbackNoAuth: Boolean = false) {
    private val attempts = ConcurrentHashMap<String, Attempt>()
    private val basicAuthorizations = ConcurrentHashMap<String, Long>()
    private val loopbackLock = Any()

    @Volatile
    private var loopbackSession: UserSession? = null

    /**
     * 回环免登录：给来自 127.0.0.1 的匿名请求就地铸造一个会话。
     * 条件不满足（未开开关、或请求不是本机）时返回 null，行为与原版一致。
     * 整个进程复用同一条 session 记录：过期表没有清理任务，逐请求铸造会让 session 表无上限增长。
     */
    suspend fun attachLoopbackSession(call: ApplicationCall): UserSession? {
        if (!loopbackNoAuth || !ServerConfig.isLoopbackRemote(call.request.origin.remoteHost)) return null
        val cached = loopbackSession
        val session = if (cached != null && database.csrfFor(cached) != null) cached
        else synchronized(loopbackLock) { loopbackSession?.takeIf { database.csrfFor(it) != null } ?: database.createSession().also { loopbackSession = it } }
        call.sessions.set(session)
        return session
    }

    suspend fun requireSession(call: ApplicationCall, csrfRequired: Boolean = false): UserSession? {
        var session = call.sessions.get<UserSession>()
        var csrf = session?.let(database::csrfFor)
        if (session == null || csrf == null) {
            session = attachLoopbackSession(call)
            csrf = session?.let(database::csrfFor)
        }
        if (session == null || csrf == null) {
            call.sessions.clear<UserSession>(); call.respond(HttpStatusCode.Unauthorized, ApiError("unauthenticated", "请先登录")); return null
        }
        if (csrfRequired && call.request.headers[CSRF_HEADER] != csrf) {
            call.respond(HttpStatusCode.Forbidden, ApiError("csrf_invalid", "请求验证失败")); return null
        }
        return session
    }

    fun csrf(session: UserSession): String? = database.csrfFor(session)
    fun hasWebSocketSession(call: ApplicationCall, csrfToken: String?): Boolean {
        if (csrfToken.isNullOrBlank()) return false
        val session = call.sessions.get<UserSession>()
        if (session != null && csrf(session) == csrfToken) return true
        return database.hasValidCsrfToken(csrfToken)
    }

    /**
     * WebDAV 等非浏览器客户端只能走 HTTP Basic：用户名任意（便于各类客户端填写），密码为管理员密码。
     * 校验通过的结果按请求头短时缓存，避免客户端每个文件操作都触发一次 PBKDF2 计算。
     */
    fun verifyBasicAuthorization(header: String?): Boolean {
        if (header == null || !header.startsWith("Basic ", ignoreCase = true)) return false
        val cachedUntil = basicAuthorizations[header]
        if (cachedUntil != null && cachedUntil > System.currentTimeMillis()) return true
        val decoded = runCatching { String(Base64.getDecoder().decode(header.substring(BASIC_PREFIX_LENGTH).trim()), Charsets.UTF_8) }.getOrNull()
        val password = decoded?.substringAfter(':', "")
        if (password.isNullOrEmpty() || !database.verifyPassword(password)) {
            basicAuthorizations.remove(header)
            return false
        }
        if (basicAuthorizations.size >= MAX_CACHED_AUTHORIZATIONS) basicAuthorizations.clear()
        basicAuthorizations[header] = System.currentTimeMillis() + BASIC_AUTHORIZATION_TTL_MS
        return true
    }

    /**
     * 回环免登录部署下 WebDAV 是否放行。三道门槛缺一不可：
     * 开关开着、请求真的来自 127.x、`Host` 本身就是回环地址（DNS 重绑会把 attacker.example 指到本机，
     * 但 Host 头会留原域名，直接拒）；带 `Origin` 的浏览器请求还必须与 `Host` 同源，
     * 否则网页就能借本机浏览器往用户目录写文件。资源管理器/curl 不发 Origin，照常放行。
     */
    fun allowsLoopbackWebDav(call: ApplicationCall): Boolean {
        if (!loopbackNoAuth) return false
        if (!ServerConfig.isLoopbackRemote(call.request.origin.remoteHost)) return false
        val hostHeader = call.request.headers[HttpHeaders.Host].orEmpty().substringBefore(':')
        if (hostHeader.isEmpty() || !ServerConfig.isLoopbackRemote(hostHeader)) return false
        val origin = call.request.headers[HttpHeaders.Origin] ?: return true
        val originHost = runCatching { URI(origin).host }.getOrNull() ?: return false
        return originHost.equals(hostHeader, ignoreCase = true)
    }

    /** 只有客户端自己带上会话 Cookie 时 CSRF 校验才有意义（服务端铸造的匿名会话无从携带伪造请求做不到的 Cookie）。 */
    fun csrfForPresentedSession(call: ApplicationCall): String? = call.sessions.get<UserSession>()?.let { csrf(it) }

    fun canAttempt(remoteHost: String): Boolean = attempts[remoteHost]?.let { it.until > System.currentTimeMillis() } != true
    fun failure(remoteHost: String) {
        attempts.compute(remoteHost) { _, old ->
            val count = (old?.count ?: 0) + 1
            Attempt(count, if (count >= 5) System.currentTimeMillis() + 60_000 else 0)
        }
    }
    fun success(remoteHost: String) { attempts.remove(remoteHost) }
    private data class Attempt(val count: Int, val until: Long)

    companion object {
        const val COOKIE_NAME = "legado_session"
        const val CSRF_HEADER = "X-CSRF-Token"
        private const val BASIC_PREFIX_LENGTH = 6
        private const val BASIC_AUTHORIZATION_TTL_MS = 5 * 60 * 1000L
        private const val MAX_CACHED_AUTHORIZATIONS = 32
    }
}

fun Route.authRoutes(auth: AuthService) {
    route("/api/auth") {
        get("/session") {
            val session = call.sessions.get<UserSession>() ?: auth.attachLoopbackSession(call)
            val csrf = session?.let(auth::csrf)
            call.respond(SessionResponse(csrf != null, csrf))
        }
        post("/login") {
            val remote = call.request.origin.remoteHost
            if (!auth.canAttempt(remote)) { call.respond(HttpStatusCode.TooManyRequests, ApiError("rate_limited", "请稍后再试")); return@post }
            val request = call.receive<LoginRequest>()
            if (!auth.database.verifyPassword(request.password)) {
                auth.failure(remote); call.application.log.warn("authentication failed from {}", remote); call.respond(HttpStatusCode.Unauthorized, ApiError("invalid_credentials", "密码不正确")); return@post
            }
            auth.success(remote)
            val session = auth.database.createSession()
            call.application.log.info("authentication succeeded from {}", remote)
            call.sessions.set(session)
            call.respond(LoginResponse(auth.csrf(session)!!))
        }
        post("/logout") {
            val session = auth.requireSession(call, csrfRequired = true) ?: return@post
            auth.database.deleteSession(session); call.sessions.clear<UserSession>(); call.respond(HttpStatusCode.NoContent)
            call.application.log.info("session logged out")
        }
    }
}

package io.legado.server

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.request.host
import io.ktor.server.request.port
import io.ktor.server.response.respond
import java.net.URI

/**
 * 这台服务不设身份：只绑回环、给一个人用，密码、登录页与会话在这里没有意义
 * （用户 2026-09-29：「怎么还有这个功能，删掉；咱们这个是开源的，不要那么多条条框框」）。
 *
 * 但"没有凭据"不等于"任何网页都能改这个库"。浏览器发出的跨站写请求一定带 `Origin`，
 * 所以写操作只留这一道**对本机用户完全无感**的闸门：`Origin` 的主机与端口必须就是这个服务自己。
 * 挡掉的是"用户打开的某个网页驱动他的浏览器往 127.0.0.1:1234 写数据"（含 DNS 重绑，
 * 因为 Origin 由浏览器写、页面改不了，而 Host 被改写时主机名也对不上）；
 * 放行的是本机界面（同源）、命令行与不带 Origin 的非浏览器客户端（curl、扩展、服务间调用）。
 */
private val SAFE_METHODS = setOf(HttpMethod.Get, HttpMethod.Head, HttpMethod.Options)

suspend fun ApplicationCall.requireSameOriginWrite(extraAllowed: (ApplicationCall) -> Boolean = { false }): Boolean {
    if (request.local.method in SAFE_METHODS) return true
    val origin = request.headers[HttpHeaders.Origin]?.trim()?.takeIf { it.isNotEmpty() } ?: return true
    if (extraAllowed(this)) return true
    if (originMatchesHost(this)) return true
    // 拦下来必须留痕：这道闸门是这个服务唯一的写保护，用户看得见"哪个页面试图代他改数据"才有意义。
    logGuard(
        "跨站写请求被同源闸门拒绝",
        mapOf(
            "origin" to origin,
            "method" to request.local.method.value,
            "path" to request.local.uri.substringBefore('?'),
        ),
    )
    respond(HttpStatusCode.Forbidden, ApiError("cross_origin", "这个页面不是青阅界面，已拒绝它代替你改动数据"))
    return false
}

/** Origin 的主机与端口都和请求的 Host 一致才算同源。判定与既有实现同形（去 IPv6 方括号、按实际端口比）。 */
internal fun originMatchesHost(call: ApplicationCall): Boolean {
    val origin = call.request.headers[HttpHeaders.Origin]?.trim()?.takeIf { it.isNotEmpty() } ?: return false
    val uri = runCatching { URI(origin) }.getOrNull() ?: return false
    val originHost = uri.host?.lowercase()?.trim('[', ']')?.takeIf { it.isNotEmpty() } ?: return false
    val requestHost = call.request.host().lowercase().substringBefore(':').trim('[', ']')
    if (originHost != requestHost) return false
    val originPort = if (uri.port > 0) uri.port else if (uri.scheme == "https") 443 else 80
    return originPort == call.request.port()
}

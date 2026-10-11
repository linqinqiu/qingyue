package io.legado.server.http

import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.response.respond
import java.net.URI
import io.legado.server.ops.logGuard
import io.legado.server.model.ApiError

/**
 * 这台服务不设身份：只绑回环、给一个人用，密码、登录页与会话在这里没有意义
 * （用户 2026-09-29：「怎么还有这个功能，删掉；咱们这个是开源的，不要那么多条条框框」）。
 *
 * 但"没有凭据"不等于"任何网页都能改这个库"。浏览器发出的跨站写请求一定带 `Origin`，
 * 所以写操作只留这一道**对本机用户完全无感**的闸门：`Origin` 必须指向**服务自己**。
 *
 * ★ 0.6.23 修正判定对象：原来拿 Origin 和请求自己的 `Host` 头互比 —— DNS 重绑定时两者
 * 同为攻击域名，必然相等直接放行（注释里声称的"重绑也对不上"并不成立）。现在比对的是
 * **服务端真实绑定的身份**（`ServerIdentity`）：回环/配置 host/绑 0.0.0.0 时的局域网私有 IP，
 * 公网域名一律不是这台机器 —— 重绑定域名无论解析到哪都过不了。
 * 挡掉的是"用户打开的某个网页驱动他的浏览器往 127.0.0.1:1234 写数据"；
 * 放行的是本机界面（同源）、命令行与不带 Origin 的非浏览器客户端（curl、扩展、服务间调用）。
 */

/** 服务端真实绑定身份：Application 启动时写入，闸门比对它而不是请求头。 */
object ServerIdentity {
    @Volatile var host: String = "127.0.0.1"
    @Volatile var port: Int = 1234
    fun init(host: String, port: Int) { this.host = host; this.port = port }
}

private val SAFE_METHODS = setOf(HttpMethod.Get, HttpMethod.Head, HttpMethod.Options)

suspend fun ApplicationCall.requireSameOriginWrite(extraAllowed: (ApplicationCall) -> Boolean = { false }): Boolean {
    if (request.local.method in SAFE_METHODS) return true
    val origin = request.headers[HttpHeaders.Origin]?.trim()?.takeIf { it.isNotEmpty() } ?: return true
    if (extraAllowed(this)) return true
    if (isSameOriginIdentity(origin)) return true
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

/** Origin 的主机与端口都指向服务自己的绑定身份才算同源。 */
internal fun originMatchesHost(call: ApplicationCall): Boolean =
    isSameOriginIdentity(call.request.headers[HttpHeaders.Origin]?.trim())

/** 无 Origin 头返回 false（调用方语义是"没有来源就当作跨站"），有则按绑定身份判。 */
internal fun isSameOriginIdentity(origin: String?): Boolean {
    if (origin.isNullOrEmpty()) return false
    val uri = runCatching { URI(origin) }.getOrNull() ?: return false
    val originHost = uri.host?.lowercase()?.trim('[', ']')?.takeIf { it.isNotEmpty() } ?: return false
    if (!isOwnOriginHost(originHost)) return false
    val originPort = if (uri.port > 0) uri.port else if (uri.scheme == "https") 443 else 80
    return originPort == ServerIdentity.port
}

/** 这个主机名是不是"这台服务自己"：回环 / 配置的绑定 host / 绑全部网卡时的局域网私有 IP。 */
private fun isOwnOriginHost(host: String): Boolean {
    if (host == "localhost" || host == "::1" || host.startsWith("127.")) return true
    val configured = ServerIdentity.host.lowercase()
    if (host == configured) return true
    if (configured == "0.0.0.0" || configured == "::") return isPrivateIpLiteral(host)
    return false
}

private val IPV4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")

/** RFC1918/回环/链路本地的 IPv4 字面量。公网域名（含重绑定域名）不是字面量，天然挡掉。 */
internal fun isPrivateIpLiteral(host: String): Boolean {
    val m = IPV4.find(host) ?: return false
    val o = m.groupValues.drop(1).map { it.toInt() }
    if (o.any { it > 255 }) return false
    return o[0] == 10 || o[0] == 127 || (o[0] == 172 && o[1] in 16..31) ||
        (o[0] == 192 && o[1] == 168) || (o[0] == 169 && o[1] == 254)
}

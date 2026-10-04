package io.legado.server

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * 「关于」页的「检查更新」（用户 2026-10-02）。
 *
 * 地址只有这一个来源：仓库 slug 读环境变量 `LEGADO_REPO`，没有就用默认值 ——
 * **接口不接受任何能拼进 URL 的参数**。"服务端替浏览器去访问一个网址"只要参数可控，
 * 就是一个开在 127.0.0.1 上的 SSRF 门，而这个服务本来就不设身份。
 */
object UpdateCheck {
    /**
     * 仓库 slug 只有一个来源：环境变量 `LEGADO_REPO`。
     *
     * 原来这里硬写着 `lukelzlz/legado-server` —— 那是这份代码当初 clone 来的地方，**不是本项目的归属**，
     * 于是「关于」页把别人家名字当成开发者写给用户看（用户 2026-10-05：「GitHub 上我是 linqinqiu，
     * 不要将仓库放到别人手里」+「这些内容也不对啊」）。没配就如实说没配，界面上也不给「项目主页」那条链接。
     */
    val repository: String = System.getenv("LEGADO_REPO")?.trim()?.takeIf { it.isNotBlank() } ?: ""

    private val client = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(8))
        .followRedirects(HttpClient.Redirect.NEVER)
        .build()

    /**
     * 请求头前缀，**只能是 ASCII**：JDK 的 HttpClient 在建请求时就拒掉非 ISO-8859-1 的头值。
     * 原来这里拼的是 `${BuildInfo.title}/版本`（「青阅/0.6.3」），于是「检查更新」每次抛
     * `invalid header value`，而那几行写在 runCatching 外面 → 接口 500 → 界面念成「检查请求没有发出去」。
     */
    val userAgentPrefix: String = "legado-server/"

    private val json = Json { ignoreUnknownKeys = true }

    /** 版本号比较：`v` 前缀可有可无，按点分段比数字；解析不了就只判"字面不同即算有新版"。 */
    fun isNewer(latest: String, current: String): Boolean {
        val clean = { value: String -> value.trim().removePrefix("v").removePrefix("V") }
        val left = clean(latest)
        val right = clean(current)
        if (left.isBlank()) return false
        if (left == right) return false
        val leftParts = left.split('.', '-', '+')
        val rightParts = right.split('.', '-', '+')
        val numbers = leftParts.zip(rightParts).all { (a, b) -> a.toIntOrNull() != null && b.toIntOrNull() != null }
        if (!numbers) return true
        for (index in 0 until maxOf(leftParts.size, rightParts.size)) {
            val a = leftParts.getOrNull(index)?.toIntOrNull() ?: 0
            val b = rightParts.getOrNull(index)?.toIntOrNull() ?: 0
            if (a != b) return a > b
        }
        return false
    }

    fun check(current: String): UpdateCheckResult {
        if (repository.isBlank()) {
            return UpdateCheckResult(current, repository = "", status = "not_configured",
                message = "这个构建没有配置仓库地址（环境变量 LEGADO_REPO），所以没有可查的发布记录")
        }
        return runCatching {
            // User-Agent 必须是 ASCII：JDK 的 HttpClient 在建请求时就拒掉非 ISO-8859-1 的头值，
            // 而原来 `${BuildInfo.title}/0.6.3`（「青阅/0.6.3」）正好撞上 —— 更糟的是建请求那几行
            // 写在 runCatching 外面，异常直接冲出路由，接口回 500，界面上念成「检查请求没有发出去」。
            val request = HttpRequest.newBuilder(URI.create("https://api.github.com/repos/$repository/releases/latest"))
                .timeout(Duration.ofSeconds(12))
                .header("Accept", "application/vnd.github+json")
                .header("User-Agent", userAgentPrefix + current)
                .GET()
                .build()
            val response = client.send(request, HttpResponse.BodyHandlers.ofString())
            if (response.statusCode() != 200) {
                return UpdateCheckResult(current, repository = repository, status = "not_found",
                    message = "发布页返回 ${response.statusCode()}（这个仓库可能还没有发过版本）")
            }
            val body = json.parseToJsonElement(response.body()).jsonObject
            val tag = body["tag_name"]?.jsonPrimitive?.content?.trim().orEmpty()
            UpdateCheckResult(
                current = current,
                latest = tag,
                url = body["html_url"]?.jsonPrimitive?.content,
                publishedAt = body["published_at"]?.jsonPrimitive?.content,
                repository = repository,
                status = if (isNewer(tag, current)) "available" else "latest",
            )
        }.getOrElse { error ->
            UpdateCheckResult(current, repository = repository, status = "unreachable",
                message = "检查不到发布记录：${error.javaClass.simpleName}（本机可能没有外网，或这个仓库地址不对）")
        }
    }
}

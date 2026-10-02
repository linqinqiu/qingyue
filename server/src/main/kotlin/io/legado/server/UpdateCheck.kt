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
    val repository: String = System.getenv("LEGADO_REPO")?.trim()?.takeIf { it.isNotBlank() }
        ?: "lukelzlz/legado-server"

    private val client = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(8))
        .followRedirects(HttpClient.Redirect.NEVER)
        .build()

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
        val request = HttpRequest.newBuilder(URI.create("https://api.github.com/repos/$repository/releases/latest"))
            .timeout(Duration.ofSeconds(12))
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "${BuildInfo.title}/${current}")
            .GET()
            .build()
        return runCatching {
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

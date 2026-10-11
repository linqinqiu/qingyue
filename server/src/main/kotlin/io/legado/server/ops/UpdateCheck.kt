package io.legado.server.ops

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import io.legado.server.model.UpdateCheckResult

/**
 * 「关于」页的「检查更新」（用户 2026-10-02）。
 *
 * 地址只有这一个来源：仓库 slug 读环境变量 `LEGADO_REPO`，没有就用本项目的默认归属 ——
 * **接口不接受任何能拼进 URL 的参数**。"服务端替浏览器去访问一个网址"只要参数可控，
 * 就是一个开在 127.0.0.1 上的 SSRF 门，而这个服务本来就不设身份。
 *
 * 为什么改查 `/releases` 列表而不是 `/releases/latest`（用户 2026-10-11「检查更新不当」）：
 * 本仓库的 CI 每推一次 `main` 就把一个**滚动构建**发布成标签 `latest` 的 Release
 * （`.github/workflows/build-jar.yml` 里删旧 `latest` 再新建）。`/releases/latest` 于是永远
 * 返回那个 `tag_name = "latest"`，而 `isNewer("latest", "0.6.46")` 走"比不了就判字面不同"那条，
 * 结果是**每次都说「有新版本 latest」**。所以这里把发布分成两类各报各的：
 *   ① 版本号发布（标签形如 `v0.6.26`）—— 拿来跟当前版本比，判"有没有更新"；
 *   ② 滚动构建（标签不是版本号，如 `latest`）—— 给出它的发布时间与下载链接，**不硬判新旧**
 *      （本机只知道自己的版本号，不知道自己的构建时间，硬判就会说谎）。
 */
object UpdateCheck {
    /**
     * 默认仓库：本项目自己的归属（用户 2026-10-05「GitHub 账号是我本人的」）。
     *
     * 原来这里是空的，于是「检查更新」在出厂状态就永远回 `not_configured`，界面上还念成
     * "没有配置环境变量 LEGADO_REPO" —— 那是把开发者的配置项说给使用者听。没配就用自己的，
     * 这才是"检查更新"该有的默认行为。`LEGADO_REPO` 仍然可覆盖（换成别的 fork 时用）。
     */
    const val DEFAULT_REPOSITORY = "linqinqiu/qingyue"

    val repository: String = System.getenv("LEGADO_REPO")?.trim()?.takeIf { it.isNotBlank() } ?: DEFAULT_REPOSITORY

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

    /** 版本号标签：`v0.6.26` / `0.6.26` / `0.6` 都算；CI 的滚动构建标签 `latest` 不算。 */
    private val versionTag = Regex("^[vV]?\\d+(\\.\\d+)+$")

    /** 这个标签像不像版本号 —— 像才参与"有没有更新"的比较；`latest` 这种归到滚动构建那一组。 */
    fun isVersionTag(tag: String): Boolean = versionTag.matches(tag.trim())

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
                message = "这个构建没有配置发布地址，所以没有可查的发布记录")
        }
        return runCatching {
            // User-Agent 必须是 ASCII：JDK 的 HttpClient 在建请求时就拒掉非 ISO-8859-1 的头值。
            val request = HttpRequest.newBuilder(URI.create("https://api.github.com/repos/$repository/releases?per_page=100"))
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
            val releases = json.parseToJsonElement(response.body()).jsonArray
            var bestVersioned: Map<String, String>? = null
            var rolling: Map<String, String>? = null
            for (element in releases) {
                val obj = element.jsonObject
                if (obj["draft"]?.jsonPrimitive?.content == "true") continue
                val tag = obj["tag_name"]?.jsonPrimitive?.content?.trim().orEmpty()
                if (tag.isBlank()) continue
                val info = mapOf(
                    "tag" to tag,
                    "url" to (obj["html_url"]?.jsonPrimitive?.content.orEmpty()),
                    "publishedAt" to (obj["published_at"]?.jsonPrimitive?.content.orEmpty()),
                )
                if (versionTag.matches(tag)) {
                    if (bestVersioned == null || isNewer(tag, bestVersioned["tag"].orEmpty())) bestVersioned = info
                } else {
                    // 滚动构建：按发布时间取最新的一条（通常就是 `latest`）
                    if (rolling == null || info["publishedAt"].orEmpty() > rolling["publishedAt"].orEmpty()) rolling = info
                }
            }
            if (bestVersioned == null && rolling == null) {
                return UpdateCheckResult(current, repository = repository, status = "not_found",
                    message = "这个仓库还没有发过版本")
            }
            val bestTag = bestVersioned?.get("tag").orEmpty()
            UpdateCheckResult(
                current = current,
                latest = bestTag.ifBlank { null },
                url = bestVersioned?.get("url")?.ifBlank { null },
                publishedAt = bestVersioned?.get("publishedAt")?.ifBlank { null },
                repository = repository,
                status = if (bestTag.isNotBlank() && isNewer(bestTag, current)) "available" else "latest",
                rollingTag = rolling?.get("tag")?.ifBlank { null },
                rollingUrl = rolling?.get("url")?.ifBlank { null },
                rollingPublishedAt = rolling?.get("publishedAt")?.ifBlank { null },
            )
        }.getOrElse { error ->
            UpdateCheckResult(current, repository = repository, status = "unreachable",
                message = "检查不到发布记录：${error.javaClass.simpleName}（本机可能没有外网，或这个仓库地址不对）")
        }
    }
}

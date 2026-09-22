package io.legado.server

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/**
 * 书源体检。
 *
 * 判据对齐上游 Legado 的 `model/CheckSource.kt`：**带关键词实跑一次搜索，按能否解析出条目定级**，
 * 而不是 GET 一下 `bookSourceUrl` 根域名看返回码。后者两头都错：根域名挂了但搜索主机好的源被判死，
 * 根域名 200 但规则一条取不出的源被判活（本机实测：判死的 46 个里 0 个能出条目，判活的 11 个里 8 个其实零条）。
 *
 * 超时交给 RuleRunner 自己的每请求超时（`search` 是阻塞调用，外层再套 withTimeout 也中断不了 socket 读，
 * 只会得到一个「已经返回 null 但线程还在跑」的假超时）。
 *
 * `webView` / `loginUrl` 这类落在我们能力边界外的源单独定类，不并入「失效」，
 * 免得「一键停用失效源」把还能看的源关掉。
 */
class SourceHealth(private val runner: RuleRunner) {

    /** 单个源的体检。keyword 优先用源自带的 checkKeyWord（上游就是这语义），没有才用调用方给的。 */
    suspend fun probe(id: String, name: String, rawJson: String, fallbackKeyword: String, slowMs: Long = SLOW_MS): SourceHealthCheckItem {
        val validation = SourceCodec.validate(rawJson)
        if (!validation.valid) {
            return item(id, name, ok = false, 0L, category = "invalid", error = validation.errors.firstOrNull() ?: "书源规则语法无效")
        }

        val root = rawJson.objectValue()
        val searchUrl = root.string("searchUrl").orEmpty()
        val loginUrl = root.string("loginUrl").orEmpty()
        // checkKeyWord 是 ruleSearch 的成员（库内 1,162 个声明它的源全都在这一层），不是顶层字段
        val checkKeyWord = root["ruleSearch"]?.let { (it as? JsonObject)?.string("checkKeyWord") }
        val keyword = (checkKeyWord ?: fallbackKeyword).take(24)
        // webView 由参数解析器如实给出，不再靠对原文做字符串嗅探
        val wantsWebView = runner.splitUrlOptions(searchUrl).second?.webView == true

        val started = System.nanoTime()
        val outcome = withContext(Dispatchers.IO) { runCatching { runner.search(rawJson, keyword) } }
        val elapsed = (System.nanoTime() - started) / 1_000_000

        val failure = outcome.exceptionOrNull()
        if (failure != null) {
            val message = describe(failure)
            val category = classify(message, loginUrl, wantsWebView)
            return item(id, name, ok = false, elapsed, category = category, statusCode = httpStatusOf(message), error = message.take(220))
        }

        val results = outcome.getOrThrow()
        if (results.isEmpty()) {
            // 能连通、能解析，但规则取不出条目：这是「规则/站点结构问题」，不等于「站点死了」
            val category = if (wantsWebView) "needs_webview" else if (loginUrl.isNotBlank()) "needs_login" else "empty"
            return item(
                id, name, ok = false, elapsed,
                category = category,
                statusCode = 200,
                error = when (category) {
                    "needs_webview" -> "搜索地址要求 webView（要渲染 JS 才有结果），服务端代理只能拿到静态 HTML。"
                    "needs_login" -> "请求成功但零条结果，且书源配了 loginUrl：多半要先登录。"
                    else -> "请求成功但一条都没解析出来：bookList 规则没匹配上，或站点回的是拦截页/空列表。"
                },
            )
        }
        return item(
            id, name, ok = true, elapsed,
            category = if (elapsed > slowMs) "slow" else "valid",
            statusCode = 200,
            error = "搜到 ${results.size} 条（关键词「$keyword」）",
        )
    }

    private fun item(id: String, name: String, ok: Boolean, latencyMs: Long, category: String, statusCode: Int = 0, error: String? = null) =
        SourceHealthCheckItem(id = id, name = name, ok = ok, latencyMs = latencyMs, statusCode = statusCode, statusCategory = category, error = error)

    /** 只有「确认真连不上」才判 unreachable；TLS/证书这类要单独留出来，别和死站混成一类。 */
    private fun classify(message: String, loginUrl: String, wantsWebView: Boolean): String = when {
        message.contains("UnknownHost", true) || message.contains("无法解析", true) || message.contains("没有可用的搜索地址", true) -> "unreachable"
        message.contains("SSLException", true) || message.contains("证书", true) || message.contains("handshake", true) || message.contains("PKIX", true) -> "tls"
        message.contains("Connection refused", true) || message.contains("Connection reset", true) ||
            message.contains("SocketTimeout", true) || message.contains("timed out", true) || message.contains("超时", true) -> "unreachable"
        httpStatusOf(message) == 401 || httpStatusOf(message) == 403 -> "blocked"
        wantsWebView -> "needs_webview"
        loginUrl.isNotBlank() && message.contains("登录", true) -> "needs_login"
        message.contains("URL 格式无效") || message.contains("未解析变量") || message.contains("规则", true) -> "broken"
        else -> "broken"
    }

    private fun httpStatusOf(message: String): Int =
        Regex("""\b(?:HTTP |status[= ])?(4\d\d|5\d\d)\b""").find(message)?.groupValues?.get(1)?.toIntOrNull() ?: 0

    private fun describe(error: Throwable?): String {
        if (error == null) return "未知错误"
        return generateSequence(error) { cause -> cause.cause?.takeIf { it !== cause } }
            .map { (it::class.simpleName ?: "Error") + ": " + (it.message ?: "") }
            .joinToString(" ← ")
            .take(300)
    }

    private companion object {
        const val SLOW_MS = 2_500L
    }
}

private fun String.objectValue(): JsonObject =
    runCatching { Json.parseToJsonElement(this).jsonObject }.getOrDefault(JsonObject(emptyMap()))

private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf { it.isNotBlank() }

package io.legado.server.ai

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

/**
 * OpenAI 兼容协议的实现 —— **这是内置的默认 provider，不是框架本身**。
 *
 * 它从 [Agent] 里搬出来的：那段代码原来写死在编排层，等于框架把"某一家协议"
 * 当成了"框架本身"。现在它是 [LlmProviderRegistry] 里的一个可替换实现 ——
 * 想接别家协议，注册自己的 provider，不用动这个文件、也不用动 [Agent]。
 *
 * 协议细节（保持与改造前完全一致，不改变既有行为）：
 * - URL：`<baseUrl>/v1/chat/completions`（baseUrl 已以 `/v1` 结尾时不重复拼）
 * - 请求：`{model, messages:[{role,content}], temperature:0.7}`
 * - 鉴权：`Authorization: Bearer <apiKey>`（apiKey 非空时）
 * - 超时：请求 30s、连接 10s
 * - 解析：`choices[0].message.content`，解析失败退回响应原文
 * - 非 2xx / 网络失败 → 返回 null（由调用方回退本地）
 */
class OpenAiCompatibleProvider : LlmProvider {

    override val id: String = "openai-compatible"
    override val displayName: String = "OpenAI 兼容"
    override val description: String =
        "任何实现了 /v1/chat/completions 的服务：OpenAI、各类中转、LM Studio、vLLM、Ollama 的兼容端点等。"

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }

    override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? {
        val base = profile.baseUrl?.trim()?.removeSuffix("/") ?: return null
        val url = if (base.endsWith("/v1")) base + "/chat/completions" else base + "/v1/chat/completions"
        val body = json.encodeToString(
            ChatRequest(
                model = profile.model ?: "gpt-3.5-turbo",
                messages = messages.map { ChatMessage(it.role, it.content) },
                temperature = 0.7,
            ),
        )
        val builder = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .timeout(Duration.ofSeconds(30))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
        if (!profile.apiKey.isNullOrBlank()) builder.header("Authorization", "Bearer " + profile.apiKey)
        val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
        val resp = runCatching { client.send(builder.build(), HttpResponse.BodyHandlers.ofString()) }.getOrNull() ?: return null
        if (resp.statusCode() !in 200..299) return null
        // 最小解析：取 choices[0].message.content；解析失败就返回原文。
        return runCatching {
            val root = json.parseToJsonElement(resp.body())
            val choices = (root as? JsonObject)?.get("choices") as? JsonArray
            val first = choices?.firstOrNull() as? JsonObject
            val message = first?.get("message") as? JsonObject
            val content = (message?.get("content") as? JsonPrimitive)?.content
            content ?: resp.body()
        }.getOrNull() ?: resp.body()
    }

    @Serializable
    private data class ChatMessage(val role: String, val content: String)

    @Serializable
    private data class ChatRequest(val model: String, val messages: List<ChatMessage>, val temperature: Double)
}

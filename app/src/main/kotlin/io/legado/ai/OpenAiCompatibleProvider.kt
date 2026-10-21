package io.legado.ai

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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
 * - 非 2xx / 网络失败 → 返回 null（由调用方报错）
 */
class OpenAiCompatibleProvider : LlmProvider {

    override val id: String = "openai-compatible"
    override val displayName: String = "OpenAI 兼容"
    override val description: String =
        "任何实现了 /v1/chat/completions 的服务：OpenAI、各类中转、LM Studio、vLLM、Ollama 的兼容端点等。"

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }

    override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? {
        val reply = post(profile, messages, tools = null) ?: return null
        return reply.content.ifBlank { null }
    }

    /**
     * 带工具调用。用 OpenAI 的 `tools` / `tool_calls` 协议：
     * 请求给 `tools:[{type:"function",function:{name,description,parameters}}]`，
     * 响应可能带 `tool_calls:[{id,function:{name,arguments}}]`。
     *
     * 模型不认工具（或服务端不支持）时自然退化 —— 只返回普通文本，toolCalls 为空。
     */
    override fun chatWithTools(
        profile: AgentProfileStore.Profile,
        messages: List<LlmMessage>,
        tools: List<ToolMeta>,
    ): LlmReply? {
        if (tools.isEmpty()) return chat(profile, messages)?.let { LlmReply(content = it) }
        return post(profile, messages, tools)
    }

    /** 一次 HTTP 往返。tools 为 null 时不带工具（纯对话）。 */
    private fun post(
        profile: AgentProfileStore.Profile,
        messages: List<LlmMessage>,
        tools: List<ToolMeta>?,
    ): LlmReply? {
        val url = endpointUrl(profile) ?: return null
        val body = json.encodeToString(
            ChatRequest(
                model = profile.model ?: "gpt-3.5-turbo",
                messages = messages.map { ChatMessage(it.role, it.content) },
                temperature = 0.7,
                // 思考强度：只有连接自己配了才发（老服务不认这个字段会直接 400）。
                reasoningEffort = ProfileOptions.thinking(profile.options)?.wire,
                tools = tools?.takeIf { it.isNotEmpty() }?.map { meta ->
                    ToolSpec(
                        function = ToolSpecFunction(
                            name = meta.id,
                            description = meta.description,
                            // 工具参数是扁平键值（见 ToolArgs），不强制 schema ——
                            // 模型按描述自己填，框架侧对未知键宽容。
                            parameters = buildJsonObject {
                                put("type", "object")
                                put("properties", buildJsonObject { })
                                put("additionalProperties", true)
                            },
                        ),
                    )
                },
            ),
        )
        val builder = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .timeout(Duration.ofMillis(ProfileOptions.timeoutMs(profile.options) ?: 30_000L))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body))
        if (!profile.apiKey.isNullOrBlank()) builder.header("Authorization", "Bearer " + profile.apiKey)
        // 连接自己的额外请求头（中转站/自建服务常要）。危险头已在 ProfileOptions 里挡掉。
        ProfileOptions.headers(profile.options).forEach { (name, value) -> builder.header(name, value) }
        val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
        val resp = runCatching { client.send(builder.build(), HttpResponse.BodyHandlers.ofString()) }.getOrNull() ?: return null
        if (resp.statusCode() !in 200..299) return null
        return runCatching { parseReply(resp.body()) }.getOrNull()
    }

    /**
     * 拼出 `chat/completions` 的完整地址。
     *
     * 抽成独立函数是为了可测：这段的边界（baseUrl 带不带 `/v1`、带不带尾斜杠、
     * 为 null）是最容易错的地方，埋在 `post()` 里时没法单独验。
     *
     * @return null 表示 baseUrl 缺失**或为空**（调用方据此返回 null，上层报 upstream_unreachable）
     */
    internal fun endpointUrl(profile: AgentProfileStore.Profile): String? {
        // 注意 `removeSuffix("/")` 之后还要判空：空串会一路拼成 "/v1/chat/completions"，
        // 那是个没有 host 的地址 —— URI.create 能过、HttpClient.send 才炸，
        // 表现为"AI 连不上"而不是"baseUrl 没配"，排查会绕远路。
        val base = profile.baseUrl?.trim()?.removeSuffix("/")?.takeIf { it.isNotEmpty() } ?: return null
        return if (base.endsWith("/v1")) base + "/chat/completions" else base + "/v1/chat/completions"
    }

    /** 解析 OpenAI 响应：取 content，以及 tool_calls（如果有）。 */
    internal fun parseReply(body: String): LlmReply {
        // `parseToJsonElement` 遇到非 JSON 会**抛异常**（JsonDecodingException），
        // 不是返回 null —— 原来这里直接调它，于是"非 JSON 响应退回原文"这条兜底
        // 实际上走不到：异常会一路冒到 `post()` 的 runCatching 变成 null，
        // 表现为"模型没回答"，而真相是"上游返回了非 JSON（可能是 502 页面/HTML 错误页）"。
        // 包一层 runCatching，让兜底真正生效。
        val root = runCatching { json.parseToJsonElement(body) }.getOrNull() as? JsonObject
            ?: return LlmReply(content = body)
        val choices = root["choices"] as? JsonArray
        val first = choices?.firstOrNull() as? JsonObject
        val message = first?.get("message") as? JsonObject
        val content = (message?.get("content") as? JsonPrimitive)?.content ?: ""

        val calls = mutableListOf<LlmToolCall>()
        val rawCalls = message?.get("tool_calls") as? JsonArray
        rawCalls?.forEach { item ->
            val obj = item as? JsonObject ?: return@forEach
            val fn = obj["function"] as? JsonObject ?: return@forEach
            val name = (fn["name"] as? JsonPrimitive)?.content ?: return@forEach
            val argsRaw = (fn["arguments"] as? JsonPrimitive)?.content ?: "{}"
            calls += LlmToolCall(id = name, args = parseArgs(argsRaw))
        }
        // 既没 content 也没工具调用 → 退回原文（与改造前一致，别把响应吃成空）。
        if (content.isBlank() && calls.isEmpty()) return LlmReply(content = body)
        return LlmReply(content = content, toolCalls = calls)
    }

    /** 把模型给的 arguments 字符串解析成扁平键值。解析不了就当空参，不抛。 */
    internal fun parseArgs(raw: String): Map<String, Any?> = runCatching {
        val el = json.parseToJsonElement(raw)
        (el as? JsonObject)?.entries?.associate { (k, v) ->
            k to when (v) {
                is JsonPrimitive -> v.content
                else -> v.toString()
            }
        } ?: emptyMap()
    }.getOrDefault(emptyMap())

    @Serializable
    private data class ChatMessage(val role: String, val content: String)

    @Serializable
    private data class ToolSpecFunction(
        val name: String,
        val description: String,
        /**
         * 参数 schema。用 JsonObject 而不是 `Map<String, Any?>` —— 后者没有序列化器
         * （kotlinx 需要具体类型），而这里本来就是要发一段 JSON。
         */
        val parameters: JsonObject,
    )

    @Serializable
    private data class ToolSpec(val type: String = "function", val function: ToolSpecFunction)

    @Serializable
    private data class ChatRequest(
        val model: String,
        val messages: List<ChatMessage>,
        val temperature: Double,
        val tools: List<ToolSpec>? = null,
        /**
         * 思考强度。OpenAI 的 `reasoning_effort` 字段；不设就不发（老服务不认会报错）。
         * 档位见 [ProfileOptions.Thinking]。
         */
        @SerialName("reasoning_effort")
        val reasoningEffort: String? = null,
    )
}

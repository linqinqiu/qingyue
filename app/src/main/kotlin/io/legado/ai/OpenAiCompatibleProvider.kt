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
                messages = messages.map { m ->
                    ChatMessage(
                        role = m.role,
                        content = m.content,
                        toolCallId = m.toolCallId,
                        toolCalls = m.toolCalls.takeIf { it.isNotEmpty() }?.map { call ->
                            WireToolCall(
                                // 框架里 LlmToolCall.id 存的就是工具 id（解析时取的 function.name），
                                // 而协议要求 id 与 tool_call_id 成对 —— 两者同用一个值即可闭环。
                                id = call.id,
                                function = WireToolCallFunction(
                                    name = call.id,
                                    // 协议要求字符串形式的 JSON。
                                    arguments = json.encodeToString(
                                        JsonObject.serializer(),
                                        JsonObject(call.args.mapValues { (_, v) -> JsonPrimitive(v?.toString() ?: "") }),
                                    ),
                                ),
                            )
                        },
                    )
                },
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
        // 上游无视 `stream:false` 仍回 SSE 时的兜底（实测 pipio.io 在字段缺省时就是流式）：
        // 把 `data: {...}` 分块里的 delta.content 拼起来，等同于非流式的 message.content。
        // 不做这层的话，用户看到的是整段 `data: {"choices":[...]}` 原文。
        if (root == null) {
            val streamed = concatSseDeltas(body)
            if (streamed != null) return LlmReply(content = streamed)
            return LlmReply(content = body)
        }
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

    /**
     * 把 SSE 流式响应里的 `delta.content` 拼成一段完整文本。
     *
     * 只在 [parseReply] 拿到**非 JSON** 时才试：逐行找 `data: {...}`，取
     * `choices[0].delta.content`，遇到 `[DONE]` 或非 data 行就跳过。
     * 一段 delta 都没有时返回 null，让调用方继续走「退回原文」。
     */
    internal fun concatSseDeltas(body: String): String? {
        val sb = StringBuilder()
        for (line in body.lineSequence()) {
            val trimmed = line.trim()
            if (!trimmed.startsWith("data:")) continue
            val payload = trimmed.removePrefix("data:").trim()
            if (payload == "[DONE]" || payload.isEmpty()) continue
            val obj = runCatching { json.parseToJsonElement(payload) }.getOrNull() as? JsonObject ?: continue
            val choice = (obj["choices"] as? JsonArray)?.firstOrNull() as? JsonObject ?: continue
            val delta = choice["delta"] as? JsonObject ?: continue
            val piece = (delta["content"] as? JsonPrimitive)?.content ?: continue
            sb.append(piece)
        }
        return sb.toString().takeIf { it.isNotEmpty() }
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

    /**
     * 发给上游的一条消息。
     *
     * `role == "tool"` 时必须带 `tool_call_id`（指回是哪个调用的结果），
     * `role == "assistant"` 且模型要调工具时必须带 `tool_calls`。
     * 这两个字段以前没有，于是工具轮次永远在第二跳被上游 400 掉。
     */
    @Serializable
    private data class ChatMessage(
        val role: String,
        /** 工具结果/带工具调用的 assistant 轮次，content 可以是 null（协议允许）。 */
        val content: String? = null,
        @SerialName("tool_call_id")
        val toolCallId: String? = null,
        @SerialName("tool_calls")
        val toolCalls: List<WireToolCall>? = null,
    )

    /** 回传模型上一轮要求的工具调用（OpenAI 协议要求原样带回）。 */
    @Serializable
    private data class WireToolCall(
        val id: String,
        val type: String = "function",
        val function: WireToolCallFunction,
    )

    @Serializable
    private data class WireToolCallFunction(
        val name: String,
        /** 协议要求是**字符串**形式的 JSON，不是对象。 */
        val arguments: String,
    )

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
        /**
         * **必须显式发 `stream:false`。**
         *
         * OpenAI 自己的默认值就是 false，但不少中转站/自建网关（实测 pipio.io）
         * 在**字段缺省**时按 SSE 流式回 `data: {...}` 分块。而本客户端用的是
         * `BodyHandlers.ofString()` + `parseReply` 按**普通 JSON** 解析，
         * 拿到 SSE 会解析失败、走「退回响应原文」那条兜底，用户看到的是
         * 一大串 `data: {"choices":[...]}` —— 表现为「AI 答非所问」。
         * 显式写出来，不依赖上游的缺省行为。
         */
        val stream: Boolean = false,
        val tools: List<ToolSpec>? = null,
        /**
         * 思考强度。OpenAI 的 `reasoning_effort` 字段；不设就不发（老服务不认会报错）。
         * 档位见 [ProfileOptions.Thinking]。
         */
        @SerialName("reasoning_effort")
        val reasoningEffort: String? = null,
    )
}

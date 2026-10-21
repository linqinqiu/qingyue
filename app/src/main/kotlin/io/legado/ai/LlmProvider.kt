package io.legado.ai

/**
 * LLM 提供方契约 —— 让"怎么跟模型说话"成为**可插拔的**，而不是硬编码 OpenAI 协议。
 *
 * 为什么需要它（用户原话："框架牢固，没有用的可以作为插件的功能可以暂且移除，
 * 或者给他放到插件里面，内置的 ai 接入 api 后是可以完成插件功能之类的"）：
 * 从前 `Agent.callExternalHttp` 里写死了 OpenAI 兼容协议 —— URL 拼 `/v1/chat/completions`、
 * 解析 `choices[0].message.content`。想接 Anthropic / Ollama / 自建服务，
 * 只能改框架源码。那说明框架不够牢固：它把"某一家协议"当成了"框架本身"。
 *
 * 现在协议是可注册的：框架只认 [LlmProvider] 这个形状，具体怎么发请求、怎么解响应，
 * 由实现决定。OpenAI 兼容协议只是**内置的默认实现**（[OpenAiCompatibleProvider]），
 * 不是框架的一部分 —— 想换成别的，注册自己的 provider 即可，框架一行不动。
 *
 * 三条约束（与工具框架同一纪律）：
 * 1. **id 唯一**：按 [id] 注册，重复注册默认拒绝（要覆盖必须显式）。
 * 2. **失败不抛**：provider 返回 null 表示"这次没拿到"，由调用方返回明确的错误（409/502）。
 *    抛异常会被框架兜住并同样视为失败 —— 一个连不上的模型不能把整条链路带走。
 * 3. **不碰路由**：provider 只做外呼，不注册任何 HTTP 端点。
 */
interface LlmProvider {

    /** 稳定 id，如 `openai-compatible`、`ollama`、`anthropic`。档案里的 `kind` 与它对应。 */
    val id: String

    /** 给人看的名字。 */
    val displayName: String

    /** 一句话说明这个 provider 期望什么形状的地址/模型。 */
    val description: String

    /**
     * 发一次对话请求。
     *
     * @param profile 连接档案（含 baseUrl / model / apiKey 等，由用户配置）
     * @param messages 多轮消息，role 为 system/user/assistant
     * @return 模型回复的文本；拿不到就返回 null（调用方报错），**不要抛异常**
     */
    fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String?

    /**
     * 带工具能力的一次对话。**默认实现退化为纯文本**，保证既有 provider 不用改。
     *
     * 想支持工具调用（让模型能执行插件注册的能力）的 provider 覆盖这个方法。
     * 框架拿到 [LlmReply.toolCalls] 后会执行对应工具、把结果回灌，再问一轮。
     *
     * @param tools 当前可用的工具清单（来自 ToolRegistry，含插件注册的）
     * @return 文本 + 工具调用；拿不到返回 null（调用方报错）
     */
    fun chatWithTools(
        profile: AgentProfileStore.Profile,
        messages: List<LlmMessage>,
        tools: List<ToolMeta>,
    ): LlmReply? {
        // 默认：忽略工具，退化成普通对话 —— 老 provider 零改动。
        val text = chat(profile, messages) ?: return null
        return LlmReply(content = text)
    }
}

/**
 * 一条对话消息。
 *
 * [toolCallId] 只在 `role == "tool"` 时有意义：OpenAI 协议要求工具结果必须用
 * `tool_call_id` 指回**是哪一个** `tool_calls` 条目的结果，缺了它上游直接 400
 * （实测 pipio.io 报 `invalid_tool_contract: tool result requires call_id`）。
 * 之前这里只有 role/content，所以「模型要调工具」这一半能跑、「结果回灌」那一半
 * 必然失败 —— 表现为 AI 一碰工具就 `upstream_unreachable`。
 *
 * [toolCalls] 只在 `role == "assistant"` 时有意义：模型上一轮要求调的那些工具，
 * 按 OpenAI 协议必须原样带回对话历史，否则上游会认为 tool 消息没有对应的调用。
 */
data class LlmMessage(
    val role: String,
    val content: String,
    val toolCallId: String? = null,
    val toolCalls: List<LlmToolCall> = emptyList(),
)

/**
 * 一次工具调用请求 —— 模型说"我要调这个工具、带这些参数"。
 *
 * 这是"AI 能完成插件级功能"的关键：模型不再只能聊天，它能要求执行某个已注册工具，
 * 由框架执行后把结果回灌给它，它再继续推理。工具清单来自 [ToolRegistry]，
 * 所以**插件注册的工具自动对模型可见**，不必额外登记。
 */
data class LlmToolCall(
    /** 工具 id（对应 [ToolMeta.id]）。 */
    val id: String,
    /** 参数（扁平键值，与 [ToolArgs] 同形）。 */
    val args: Map<String, Any?> = emptyMap(),
)

/**
 * 模型的一次回复：文本 + 可能要调的工具。
 *
 * 两者可以同时存在（模型先说一句再调工具），所以不是二选一的结构。
 */
data class LlmReply(
    /** 文本部分，可能为空。 */
    val content: String = "",
    /** 要调的工具，可能为空。 */
    val toolCalls: List<LlmToolCall> = emptyList(),
)

/**
 * Provider 注册表 —— 让协议可插拔。
 *
 * 用法与 [ToolRegistry] 一致：内置一个默认实现，外部可注册自己的。
 *
 * ```kotlin
 * val registry = LlmProviderRegistry()              // 默认含 openai-compatible
 * registry.register(OllamaProvider())               // 加一家
 * val agent = Agent(ctx, home, registry = registry) // 交给框架
 * ```
 */
class LlmProviderRegistry(builtin: List<LlmProvider> = listOf(OpenAiCompatibleProvider())) {

    private val providers = java.util.concurrent.ConcurrentHashMap<String, LlmProvider>()

    init {
        builtin.forEach { p ->
            require(p.id.isNotBlank()) { "内置 provider 必须带 id" }
            require(providers.putIfAbsent(p.id, p) == null) { "内置 provider id 重复：${p.id}" }
        }
    }

    /** 注册一个 provider。id 已存在时返回 false（不覆盖），除非 [replace] 为 true。 */
    fun register(provider: LlmProvider, replace: Boolean = false): Boolean {
        require(provider.id.isNotBlank()) { "provider 必须带 id" }
        if (!replace) return providers.putIfAbsent(provider.id, provider) == null
        providers[provider.id] = provider
        return true
    }

    /** 注销（内置的也可以注销 —— provider 不是安全边界，只是协议实现）。 */
    fun unregister(id: String): Boolean = providers.remove(id) != null

    /** 按 id 找；没有返回 null。 */
    fun find(id: String): LlmProvider? = providers[id]

    /** 全部 provider，按 id 排序（稳定，便于展示）。 */
    fun all(): List<LlmProvider> = providers.values.sortedBy { it.id }

    /**
     * 为某个档案挑 provider。
     *
     * 匹配规则：档案的 `kind` 先按 provider id 找；找不到就用 `openai-compatible`（默认档）。
     * 这样老档案（kind 写的是 `openai-compatible`）照常工作，新协议只要 kind 对上即可。
     */
    fun forProfile(profile: AgentProfileStore.Profile): LlmProvider? {
        val kind = profile.kind.name.lowercase().replace('_', '-')
        return providers[kind] ?: providers["openai-compatible"]
    }

    /** 当前注册数量。 */
    fun size(): Int = providers.size
}

package io.legado.server.ai

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
 * 2. **失败不抛**：provider 返回 null 表示"这次没拿到"，由调用方回退本地。
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
     * @return 模型回复的文本；拿不到就返回 null（调用方回退本地），**不要抛异常**
     */
    fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String?
}

/** 一条对话消息。与 [Agent] 内部的 ChatMessage 同形，公开出来供 provider 使用。 */
data class LlmMessage(val role: String, val content: String)

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

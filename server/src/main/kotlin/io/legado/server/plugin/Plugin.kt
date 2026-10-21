package io.legado.server.plugin

/**
 * 插件契约 —— 这是「包罗万象的框架」里唯一需要插件作者实现的东西。
 *
 * 设计红线（用户原话："我们只做框架，能够包容一切的框架，不要有任何自己的内容"）：
 * 本包**不含任何具体插件**。它只定义"插件长什么样、怎么被发现、怎么被装进进程"。
 * 装什么、做什么，完全由外部决定 —— 框架对插件内容零假设。
 *
 * 一个插件能做三件事，全部可选（默认空实现，只实现关心的那部分）：
 * 1. [tools]    —— 往工具面里加能力（AI/自动化能调的东西）
 * 2. [hooks]    —— 挂工具调用的生命周期钩子（审计、限流、改写）
 * 3. [metadata] —— 自我描述（名字、版本、作者、说明），供"介绍"页展示
 *
 * 插件**不注册 HTTP 路由**（那会让 `/api/catalog` 的端点计数漂移，破坏既有门禁）。
 * 需要对外暴露能力的插件，通过注册工具实现；工具本来就能被 `/api/agent` 下的端点调到。
 *
 * 最小插件：
 * ```kotlin
 * class HelloPlugin : Plugin {
 *     override val metadata = PluginMetadata(
 *         id = "hello", name = "问候", version = "1.0.0",
 *         description = "一个最小插件示例",
 *     )
 *     override fun tools() = listOf(
 *         Tool { ctx, _ -> AgentResult(status = "ok", message = "hello") }
 *             .also { it.meta = ToolMeta("hello.greet", "hello", "打个招呼", writes = false) }
 *     )
 * }
 * ```
 */
interface Plugin {

    /** 插件自我描述。这是"介绍"页唯一的数据来源，缺字段就展示不全。 */
    val metadata: PluginMetadata

    /** 本插件提供的工具。默认空 —— 只挂钩子的插件不用实现这个。 */
    fun tools(): List<io.legado.server.ai.Tool> = emptyList()

    /**
     * 本插件提供的 LLM 协议实现。默认空。
     *
     * 这是"内置 AI 接入也能以插件形式完成"的落点：插件可以注册自己的 [io.legado.server.ai.LlmProvider]
     * （Anthropic / Ollama / 自建服务……），不必改框架源码。`openai-compatible` 只是内置的默认实现。
     */
    fun llmProviders(): List<io.legado.server.ai.LlmProvider> = emptyList()

    /**
     * 本插件提供的连接选择策略。默认空。
     *
     * 这是"连哪个外部连接"可插拔的落点：框架默认取第一个连接（[io.legado.server.ai.FirstProfileSelector]），
     * 插件可以在这里注册自己的 [io.legado.server.ai.ConnectionSelector]（例如按健康度 failover、
     * 按地域/负载挑一个），并通过 [PluginContext.selectors] 把它装进运行中的注册表，
     * 不必改框架源码。这延续了"框架只立钩子、决定交给外部"的红线。
     */
    fun connectionSelectors(): List<io.legado.server.ai.ConnectionSelector> = emptyList()

    /**
     * 本插件要挂的钩子。默认空。
     *
     * 注意：插件**不能**通过钩子绕过 [io.legado.server.ai.Guardrails] ——
     * 钩子在工具外面，只能拒绝或改写，不能替工具跳过写前确认。
     */
    fun hooks(): PluginHooks = PluginHooks.NONE

    /**
     * 本插件想订阅的事件。默认空。
     *
     * 框架会在装载时替它订阅、卸载时**自动注销** —— 插件不必自己管理句柄
     * （自己管很容易漏，卸载后回调还在跑，指向已失效的对象）。
     *
     * 返回 `事件名 to 回调` 的列表；`"*"` 表示订阅全部（审计/日志类插件用）。
     *
     * ```kotlin
     * override fun subscriptions() = listOf(
     *     "source.saved" to EventBus.Handler { e -> println("书源变了：${e.payload["id"]}") },
     * )
     * ```
     */
    fun subscriptions(): List<Pair<String, EventBus.Handler>> = emptyList()

    /**
     * 插件装载时的初始化（可选）。抛异常 = 装载失败，框架会记录并跳过这个插件，
     * **不影响其它插件**（一个坏插件不能把整个插件系统带走）。
     */
    fun onLoad(context: PluginContext) {}

    /** 插件卸载时的清理（可选）。同样不允许把异常抛给框架。 */
    fun onUnload() {}
}

/**
 * 插件自描述。字段刻意保持最小且必需 —— 这是"框架能介绍自己"的基础，
 * 没有它，插件装进来了人也看不懂装了什么。
 */
data class PluginMetadata(
    /** 全局唯一标识，建议 `作者.名字` 或 `名字`（小写、连字符/下划线）。 */
    val id: String,
    /** 给人看的名字。 */
    val name: String,
    /** 语义化版本。 */
    val version: String,
    /** 一句话说明它做什么。 */
    val description: String,
    val author: String = "",
    /** 插件主页 / 源码地址，可空。 */
    val homepage: String = "",
    /**
     * 插件声明自己需要哪些能力，纯声明性（框架当前不做强制校验，但会展示给用户）。
     * 例如 `["tools", "hooks"]`。
     */
    val capabilities: List<String> = emptyList(),
)

/**
 * 插件能挂的钩子。与 [io.legado.server.ai.ToolHooks] 同形，但用可空字段表达"我没关心这个阶段"，
 * 由框架负责翻译成 ToolHooks 的 install 调用。
 */
data class PluginHooks(
    val before: io.legado.server.ai.ToolHooks.Before? = null,
    val after: io.legado.server.ai.ToolHooks.After? = null,
    val onError: io.legado.server.ai.ToolHooks.OnError? = null,
) {
    companion object {
        val NONE = PluginHooks()
    }
}

/**
 * 插件装载时拿到的上下文。框架给插件的东西**只有这些** —— 不给 Database、不给路由、
 * 不给进程级单例，插件要操作服务就通过注册工具（工具拿 [io.legado.server.ai.AgentContext]）。
 *
 * 这样"插件能做什么"严格等于"框架允许工具做什么"，不会因为装了插件而出现第二条写入路径。
 */
data class PluginContext(
    /** 本插件被装载进哪个注册表（插件可以在这里注册工具，也可以只返回给框架装）。 */
    val registry: io.legado.server.ai.ToolRegistry,
    /** 本插件可用的钩子容器。 */
    val hooks: io.legado.server.ai.ToolHooks,
    /** LLM 协议注册表：插件在这里注册自己的 provider（如 Ollama / Anthropic）。 */
    val providers: io.legado.server.ai.LlmProviderRegistry = io.legado.server.ai.LlmProviderRegistry(),
    /** 连接选择策略注册表：插件在这里注册自己的 [io.legado.server.ai.ConnectionSelector]。 */
    val selectors: io.legado.server.ai.ConnectionSelectorRegistry = io.legado.server.ai.ConnectionSelectorRegistry(),
    /** 事件总线：插件可以订阅系统事件（也可用 [Plugin.subscriptions] 交给框架代管）。 */
    val events: EventBus = EventBus(),
    /** 框架版本，便于插件做兼容判断。 */
    val frameworkVersion: String,
)

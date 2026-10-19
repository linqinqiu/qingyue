package io.legado.server.ai

import io.legado.server.data.Database
import io.legado.server.source.SourceDebugger
import io.legado.server.source.SourceHealth
import io.legado.server.rules.RuleRunner
import io.legado.server.cache.CoverCache
import io.legado.server.subscription.SubscriptionService

/**
 * 程序内部 AI 的"连接"本体：把它要用的服务端能力一次性装好，传给每个工具。
 *
 * 这些对象就是 130 个 HTTP 端点背后那同一批服务（[Database]、[RuleRunner]、
 * [SourceDebugger]、[SourceHealth]……），所以 AI 在进程内能改的、能看到的东西，
 * 与界面/脚本通过 HTTP 能改的、能看的东西**完全一致**——没有第二条实现路径。
 *
 * 这个结构刻意只做"能力装配"：任何会真正改库的动作都走工具（[BuiltinTools]），
 * 工具再各自落实护栏（[Guardrails]）。这样"AI 能做什么"由工具清单决定，
 * 而不是由某个 LLM 想调用哪个私有方法决定。
 */
data class AgentContext(
    val database: Database,
    val runner: RuleRunner,
    val debugger: SourceDebugger,
    val health: SourceHealth,
    val subscriptions: SubscriptionService,
    val coverCache: CoverCache,
    /** 当前进程真实绑定的身份，护栏据此拒绝"把服务搬到公网"之类意图。 */
    val boundHost: String = "127.0.0.1",
    val boundPort: Int = 1234,
) {
    /**
     * 统一错误封包：工具抛出的业务异常转成 AI 能读懂的结构。
     * 与 HTTP 层 [io.legado.server.model.ApiError] 的 `code`/`message` 字段保持一致，便于复用同一套语义。
     */
    fun error(code: String, message: String): AgentResult =
        AgentResult(status = "error", code = code, message = message)
}

/**
 * 一次工具调用的返回。`data` 是结构化结果（JSON 友好），`message` 是给人/下一段推理看的简述。
 * 不引入 1234 之外的字段语义，所有 code 都沿用现有 HTTP 错误码（invalid_request / not_found /
 * version_conflict / cross_origin / source_execution_failed 等）。
 */
data class AgentResult(
    val status: String, // "ok" | "error"
    val code: String = "ok",
    val message: String? = null,
    val data: Any? = null,
)

/**
 * 工具参数：从解析出的目标里来的扁平键值。骨架阶段只支持最基础的字符串/数字/布尔/列表，
 * 不引入 JSON Schema 校验库——保持"大体框架支持"的轻量定位。
 */
typealias ToolArgs = Map<String, Any?>

/**
 * 工具的元信息，供 [Agent] 选择、也作为进程内"能力清单"对外暴露。
 */
data class ToolMeta(
    val id: String,
    val group: String,
    val description: String,
    /** 该工具是否会写库（AI 在真正调用前要先过护栏）。 */
    val writes: Boolean,
)

/**
 * 单个可调用能力。实现里直接复用 [AgentContext] 持有的服务，与 HTTP handler 同一条路径。
 *
 * 构造形态照顾到工具的写法：用 `Tool { ctx, args -> … }` 给处理体，再用 `.also { it.meta = ToolMeta(…) }`
 * 贴上元信息。所以 [meta] 是 `var`、且有只接收处理体的次级构造器。
 */
class Tool(var meta: ToolMeta, val handler: suspend (AgentContext, ToolArgs) -> AgentResult) {
    constructor(handler: suspend (AgentContext, ToolArgs) -> AgentResult) :
        this(ToolMeta("__unset__", "unknown", "", false), handler)

    suspend fun invoke(ctx: AgentContext, args: ToolArgs): AgentResult = handler(ctx, args)
}

package io.legado.server.ai

import io.legado.server.data.VersionConflict
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Path
import java.time.Duration

/**
 * 程序内部 AI 的编排骨架，也是「自定义接入」所有能力的真正执行体。
 *
 * 设计定位（用户原话："我们要做的是提供大体框架支持"）：
 * 这一层**不绑定任何外部大模型**，只把"工具选择 + 执行 + 结果反馈"的管道立起来；
 * 真正接外部模型时，唯一入口是 [callLlm] 钩子——它现在会去 [AgentProfileStore] 里找
 * 第一个非内置（openai-compatible）连接，并真正发出 HTTP 请求；找不到或调用失败就返回 null，
 * 调用方据此走关键字路由或本地兜底。HTTP 层 `/api/agent/` 只是这个网关的收口，不再另写一份外呼。
 *
 * 关键约束（沿用现有服务的语义）：
 * - AI 能调用的只有 [BuiltinTools] 注册过的工具，工具背后是和 HTTP 端点同一批服务。
 * - 写工具受 [Guardrails] 约束（批量确认、乐观锁冲突转 version_conflict、禁改绑定地址）。
 * - 不在进程内另开一条数据写入路径。
 * - 所有外部 HTTP 调用走 JDK `java.net.http.HttpClient`（Ktor 客户端不在依赖里）。
 */
class Agent(
    private val ctx: AgentContext,
    private val homeDirectory: Path,
    private val profileStore: AgentProfileStore = AgentProfileStore,
    tools: List<Tool> = BuiltinTools.all(),
    /** 工具注册表：默认用传入的 tools 建一份；外部想运行时增删工具就自己构造一个传进来。 */
    val registry: ToolRegistry = ToolRegistry(tools),
    /** 生命周期钩子：默认没有钩子（零开销），外部挂审计/限流/改写用。 */
    val hooks: ToolHooks = ToolHooks(),
    /** LLM 协议注册表：默认含 openai-compatible；想接别家协议注册自己的 provider。 */
    val providerRegistry: LlmProviderRegistry = LlmProviderRegistry(),
) {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true }

    /** 暴露给外部（含 `/api/agent`）的能力清单，与 `/api/catalog` 的"可改范围"对齐。 */
    fun toolManifest(): List<ToolMeta> = registry.manifest()

    /** 是否注册了外部（openai-compatible）连接；供 manifest 的 `enabled` 字段使用。 */
    fun hasExternalConnection(): Boolean = firstExternalProfile() != null

    /** 直接按工具 id 执行（已解析出该调哪个工具时用）。 */
    suspend fun runTool(id: String, args: ToolArgs): AgentResult {
        val tool = registry.find(id) ?: return ctx.error("unknown_tool", "未注册的工具：$id")
        val meta = tool.meta

        // 1) before 链：任一钩子返回非 null 即拦截，工具不执行。
        val blocked = try {
            hooks.runBefore(meta, args)
        } catch (e: Throwable) {
            // 钩子自己炸了不能把整条链路带走：转成 error 结果，工具照常不执行。
            ctx.error("hook_failed", "工具前置钩子异常：${e.message ?: e::class.simpleName}")
        }
        if (blocked != null) return hooks.runAfter(meta, args, blocked)

        // 2) 执行工具本体（异常统一兜底成 error 结果）。
        val raw: AgentResult = try {
            tool.invoke(ctx, args)
        } catch (e: Guardrails.AgentVersionConflict) {
            ctx.error("version_conflict", e.message ?: "书源版本冲突，请先读取最新版本再保存")
        } catch (e: VersionConflict) {
            ctx.error("version_conflict", e.message ?: "书源版本冲突，请先读取最新版本再保存")
        } catch (e: IllegalArgumentException) {
            ctx.error("invalid_request", e.message ?: "参数非法")
        } catch (e: Throwable) {
            // 先造出结果再回调：钩子看到的必须就是最终返回的那一个，不能各造一份。
            val converted = ctx.error("internal_error", e.message ?: "工具执行异常")
            hooks.runOnError(meta, args, e, converted)
            converted
        }

        // 3) after 链：可改写结果。
        return hooks.runAfter(meta, args, raw)
    }

    /**
     * 接收一个自然语言目标，产出"下一步该调哪个工具、带什么参数"。
     *
     * 占位实现：按关键字做极简路由，仅用于把整条链路跑通与演示。
     * 接真实 LLM 时，把这里的实现换成对 [callLlm] 的调用即可，其余管道不动。
     */
    suspend fun plan(goal: String): Plan {
        val g = goal.lowercase()
        val picked = when {
            "体检" in goal || "health" in g -> "source.health"
            "调试" in goal || "debug" in g -> "source.debug"
            "校验" in goal || "验证" in goal || "validate" in g -> "source.validate"
            "删除书源" in goal || "删源" in goal -> "source.batch"
            "列书源" in goal || "看看书源" in goal || "source.list" in g -> "source.list"
            "导入" in goal || "import" in g -> "source.import"
            "净化" in goal || "replace" in g -> "replace.list"
            "书架" in goal || "shelf" in g -> "shelf.list"
            "订阅" in goal || "subscription" in g -> "subscription.list"
            "搜索" in goal || "search" in g -> "search.run"
            else -> null
        }
        return Plan(goal = goal, toolId = picked, note = if (picked == null) "未在已注册工具中找到匹配项（骨架路由仅做关键字匹配）。" else null)
    }

    /**
     * LLM 钩子：存在非内置的外部连接时，真正调用该 openai-compatible 模型；
     * 缺连接或调用失败都返回 null，调用方据此走关键字路由或本地兜底。
     * 接真实 LLM 的唯一入口就在这里——不在 HTTP 层另写一份外呼。
     */
    suspend fun callLlm(prompt: String): String? {
        val ext = firstExternalProfile() ?: return null
        return callExternalHttp(ext, listOf(LlmMessage("user", prompt)))
    }

    /**
     * 文章阅读理解：外部模型优先，失败/缺连接自动回退本地抽取，保证永远有结果。
     * 这是 `/api/agent/comprehend` 的真正执行体（经由 [io.legado.server.ai.AgentConnection] 收口到 HTTP）。
     */
    suspend fun comprehend(
        text: String,
        question: String? = null,
        summarySentences: Int = 3,
        topKeywords: Int = 8,
    ): ComprehendOutcome {
        val ext = firstExternalProfile()
        if (ext != null) {
            val prompt = buildComprehensionPrompt(text, question, summarySentences, topKeywords)
            val llm = callExternalHttp(ext, listOf(LlmMessage("user", prompt)))
            if (llm != null) {
                return ComprehendOutcome(
                    engine = "external:" + ext.id,
                    summary = llm.trim(),
                    keywords = emptyList(),
                    answer = question,
                    sentencesCount = -1,
                    fallback = false,
                )
            }
            // 外部调用失败 → 回退本地并标注 fallback，保证接口永远有结果。
            return toLocalOutcome(
                LocalComprehension.analyze(text, question, summarySentences, topKeywords),
                fallback = true,
            )
        }
        return toLocalOutcome(
            LocalComprehension.analyze(text, question, summarySentences, topKeywords),
            fallback = false,
        )
    }

    /**
     * 自由对话（多轮）：直接把 `messages` 数组交给外部 openai-compatible 模型；
     * 缺外部连接时回退到本地说明（不假装是模型），由调用方决定怎么展示。
     * 这是 `POST /api/agent/chat` 的真正执行体。
     */
    suspend fun chat(messages: List<Pair<String, String>>): ChatOutcome {
        val norm = messages
            .filter { it.second.isNotBlank() }
            .map { LlmMessage(role = it.first.takeIf { r -> r in setOf("system", "user", "assistant") } ?: "user", content = it.second) }
        if (norm.isEmpty()) {
            return ChatOutcome(engine = "error", content = "", fallback = false, error = "messages 不能为空")
        }
        val ext = firstExternalProfile()
        if (ext != null) {
            val reply = callExternalHttp(ext, norm)
            if (reply != null) {
                return ChatOutcome(engine = "external:" + ext.id, content = reply.trim(), fallback = false)
            }
            // 外部调用失败 → 回退本地说明，标注 fallback，保证永远有结果。
            return ChatOutcome(
                engine = "local-fallback",
                content = "（外部模型 ${ext.id} 暂时连不上，回答由本地兜底生成）你可以继续，但当前回复不是模型原话。",
                fallback = true,
            )
        }
        return ChatOutcome(
            engine = "local-fallback",
            content = "（尚未登记任何外部模型连接，无法真正对话；请在「AI 接入 → 连接」里登记一个 openai-compatible 地址，或在 agent-profiles.json 里配置。）",
            fallback = true,
        )
    }

    /** 当前档案里第一个非内置（openai-compatible）连接；没有就返回 null（用本地兜底）。 */
    private fun firstExternalProfile(): AgentProfileStore.Profile? =
        profileStore.list(homeDirectory).firstOrNull { it.kind != AgentProfileStore.ProfileKind.BUILTIN_STUB }

    /** 把本地抽取结果映射成对外统一的 [ComprehendOutcome]（internal 以便 HTTP 层在缺句柄时也能复用本地兜底）。 */
    internal fun toLocalOutcome(r: LocalComprehension.ComprehensionResult, fallback: Boolean): ComprehendOutcome =
        ComprehendOutcome(
            engine = "local-extractive",
            summary = r.summary,
            keywords = r.keywords,
            answer = r.answer,
            sentencesCount = r.sentencesCount,
            fallback = fallback,
        )

    // 把摘要/关键词/问答需求拼成一个给外部模型的 prompt（通用模板，不绑定某家）。
    private fun buildComprehensionPrompt(text: String, question: String?, summarySentences: Int, topKeywords: Int): String =
        buildString {
            append("你是一个文章阅读理解助手。请基于下面的文章完成三件事：\n")
            append("1. 用不超过 " + summarySentences + " 句话给出摘要；\n")
            append("2. 列出 " + topKeywords + " 个关键词；\n")
            if (!question.isNullOrBlank()) append("3. 回答问题：" + question + "\n")
            append("\n文章：\n" + text + "\n")
        }

    /**
     * 通过注册的 [LlmProvider] 外呼。具体协议由 provider 决定 —— 框架不认识任何一家。
     *
     * 这是本次"框架牢固化"的关键：从前这里写死了 OpenAI 协议（URL 拼 /v1/chat/completions、
     * 解析 choices[0]），想接别家只能改框架。现在只认 [LlmProvider] 这个形状。
     *
     * 失败语义不变：provider 返回 null 或抛异常，都视为"这次没拿到"，由调用方回退本地。
     */
    private fun callExternalHttp(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? {
        val provider = providerRegistry.forProfile(profile) ?: return null
        return runCatching { provider.chat(profile, messages) }.getOrNull()
    }

    /** 文章阅读理解的结构化结果，与 HTTP 层 ComprehendResponse 对齐。 */
    data class ComprehendOutcome(
        val engine: String,
        val summary: String,
        val keywords: List<String>,
        val answer: String?,
        val sentencesCount: Int,
        val fallback: Boolean,
        val error: String? = null,
    )

    /** 一个目标经"规划 → 执行"的极简闭环结果。 */
    data class Plan(
        val goal: String,
        val toolId: String?,
        val note: String? = null,
    )

    /** 自由对话的结构化结果，与 HTTP 层 ChatResponse 对齐。 */
    data class ChatOutcome(
        val engine: String,
        val content: String,
        val fallback: Boolean,
        val error: String? = null,
    )
}

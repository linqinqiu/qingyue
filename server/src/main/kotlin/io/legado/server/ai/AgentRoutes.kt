package io.legado.server.ai

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.ApplicationCall
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.legado.server.data.Database
import io.legado.server.data.saveSource
import io.legado.server.model.ApiError
import io.legado.server.model.SourceWriteRequest
import io.legado.server.source.SourceCodec
import kotlinx.serialization.Serializable
import java.nio.file.Path

// `/api/agent/` 这一组的真实处理体。
// 这一组就是「用户自定义接入」的承载面，但**不动基础框架**：基础框架只在这里把几个稳固的钩子点
// 立出来（清单 / 连接注册 / 书源新建 / 书源校验 / 阅读理解），真正「接什么模型、连哪个地址」完全
// 交给用户在 agent-profiles.json 里配、或运行时 POST 注册。框架本身只认内置本地 stub。
// 各路由在 Routes.kt 里仍是字面注册（供 ApiCatalog 门禁逐条核对）；这里把处理器抽成顶层扩展函数。
// 写门（requireSameOriginWrite）仍由各路由自己的第一行字面值决定，本文件不替它下结论。
// 阅读理解（comprehend）不再在此另写外呼逻辑，而是直接委派给网关 AgentConnection，
// 由网关统一决定「外部模型优先 / 失败回退本地」。

// ===== 清单 manifest =====

@Serializable
private data class ManifestTool(val id: String, val group: String, val description: String, val writes: Boolean)

@Serializable
private data class ManifestResponse(
    val enabled: Boolean,
    val tools: List<ManifestTool>,
    val builtinConnections: List<String>,
)

suspend fun ApplicationCall.agentManifest(profileStoreHome: Path, profileStore: AgentProfileStore?, agentConnection: AgentConnection?) {
    val store = profileStore ?: AgentProfileStore
    // 「是否启用」取决于真实档案里有没有非内置的外部连接——而不是那个仅在 -Dai.debug 下存在的
    // 运行时句柄（那只是骨架占位）。这样用户用 POST 注册一个 openai-compatible 连接后，清单立即变 enabled。
    val externalExists = store.list(profileStoreHome).any { it.kind != AgentProfileStore.ProfileKind.BUILTIN_STUB }
    val tools = agentConnection?.manifest().orEmpty().map {
        ManifestTool(id = it.id, group = it.group, description = it.description, writes = it.writes)
    }
    respond(
        ManifestResponse(
            enabled = externalExists,
            tools = tools,
            builtinConnections = listOf(AgentProfileStore.BUILTIN_LOCAL.id),
        ),
    )
}

// ===== 连接管理 connections =====

@Serializable
private data class ConnectionRegisterRequest(
    val id: String? = null,
    val name: String,
    val kind: String,
    val baseUrl: String? = null,
    val apiKey: String? = null,
    val model: String? = null,
    val options: Map<String, String>? = null,
)

@Serializable
private data class ConnectionResponse(
    val id: String,
    val name: String,
    val kind: String,
    val builtin: Boolean,
    val model: String? = null,
    val baseUrl: String? = null,
)

suspend fun ApplicationCall.agentListConnections(profileStoreHome: Path, profileStore: AgentProfileStore?) {
    val store = profileStore ?: AgentProfileStore
    val profiles = store.list(profileStoreHome)
    respond(profiles.map { toConnectionResponse(it) })
}

suspend fun ApplicationCall.agentCreateConnection(profileStoreHome: Path, profileStore: AgentProfileStore?) {
    val store = profileStore ?: AgentProfileStore
    val req = runCatching { receive<ConnectionRegisterRequest>() }.getOrElse {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的连接描述")); return
    }
    if (req.name.isBlank()) {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "连接名称 name 不能为空")); return
    }
    val kind = runCatching {
        when (req.kind.lowercase()) {
            "openai-compatible", "openai_compatible", "openaicompatible" ->
                AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE
            else -> throw IllegalArgumentException("unsupported kind")
        }
    }.getOrElse {
        respond(
            HttpStatusCode.BadRequest,
            ApiError("invalid_kind", "自定义接入只支持 openai-compatible 一种连接类型"),
        ); return
    }
    val id = (req.id ?: req.name).trim().ifBlank { req.name }.replace(Regex("[^\\w\\-.]"), "_")
    val profile = AgentProfileStore.Profile(
        id = id,
        name = req.name.trim(),
        kind = kind,
        baseUrl = req.baseUrl,
        apiKey = req.apiKey,
        model = req.model,
        options = req.options ?: emptyMap(),
    )
    runCatching { store.register(profileStoreHome, profile) }.onFailure { ex ->
        respond(HttpStatusCode.BadRequest, ApiError("register_failed", ex.message ?: "注册连接失败")); return
    }
    respond(toConnectionResponse(store.get(profileStoreHome, id) ?: profile))
}

suspend fun ApplicationCall.agentDeleteConnection(
    id: String,
    profileStoreHome: Path,
    profileStore: AgentProfileStore?,
) {
    val store = profileStore ?: AgentProfileStore
    if (id == AgentProfileStore.BUILTIN_LOCAL.id) {
        respond(HttpStatusCode.BadRequest, ApiError("builtin_protected", "内置连接 local 不可删除")); return
    }
    val removed = store.delete(profileStoreHome, id)
    if (!removed) {
        respond(HttpStatusCode.NotFound, ApiError("not_found", "连接 $id 不存在")); return
    }
    respond(DeleteConnectionResponse(removed = id))
}

@Serializable
private data class DeleteConnectionResponse(val ok: Boolean = true, val removed: String)

private fun toConnectionResponse(p: AgentProfileStore.Profile) = ConnectionResponse(
    id = p.id,
    name = p.name,
    kind = p.kind.name.lowercase(),
    builtin = p.id == AgentProfileStore.BUILTIN_LOCAL.id,
    model = p.model,
    baseUrl = p.baseUrl,
)

// ===== 书源新建 / 校验 =====

suspend fun ApplicationCall.agentCreateSource(database: Database) {
    val req = runCatching { receive<SourceWriteRequest>() }.getOrElse {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 {json, version?}")); return
    }
    if (req.json.isBlank()) {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "json 不能为空")); return
    }
    val parsed = runCatching { SourceCodec.parse(req.json) }.getOrElse {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_source", it.message ?: "书源解析失败")); return
    }
    val record = runCatching { database.saveSource(parsed, req.version) }.getOrElse { ex ->
        when (ex) {
            is io.legado.server.data.VersionConflict ->
                respond(HttpStatusCode.Conflict, ApiError("version_conflict", "书源已被并发修改，请先读取最新版本再保存"))
            else -> respond(HttpStatusCode.InternalServerError, ApiError("save_failed", ex.message ?: "保存失败"))
        }; return
    }
    respond(
        HttpStatusCode.Created,
        SourceCreatedResponse(id = record.id, version = record.version, updatedAt = record.updatedAt.toString()),
    )
}

@Serializable
private data class SourceCreatedResponse(
    val id: String,
    val version: Long,
    val updatedAt: String,
)

@Serializable
private data class ValidateRequest(val json: String)

@Serializable
private data class ValidateResponseDto(
    val valid: Boolean,
    val errors: List<String>,
    val warnings: List<String>,
)

suspend fun ApplicationCall.agentValidateSource() {
    val req = runCatching { receive<ValidateRequest>() }.getOrElse {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 {json}")); return
    }
    if (req.json.isBlank()) {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "json 不能为空")); return
    }
    // 只校验不落库：与 SourceCodec.validate 同一条路径；这条是只读探针。
    val res = SourceCodec.validate(req.json)
    respond(ValidateResponseDto(valid = res.valid, errors = res.errors, warnings = res.warnings))
}

// ===== 文章阅读理解 =====

@Serializable
private data class ComprehendRequest(
    val text: String,
    val question: String? = null,
    val summarySentences: Int = 3,
    val topKeywords: Int = 8,
)

@Serializable
private data class ComprehendResponse(
    val engine: String,
    val summary: String,
    val keywords: List<String>,
    val answer: String? = null,
    val sentencesCount: Int,
    val fallback: Boolean? = null,
    val error: String? = null,
)

// 把阅读理解整体收口到网关 AgentConnection：外部模型优先，失败/缺连接自动回退本地，
// 保证接口永远有结果。HTTP 层只负责解析请求、委派、映射响应，不再另写一份外呼逻辑。
suspend fun ApplicationCall.agentComprehend(agentConnection: AgentConnection?) {
    val req = runCatching { receive<ComprehendRequest>() }.getOrElse {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 {text, question?}")); return
    }
    if (req.text.isBlank()) {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "text 不能为空")); return
    }
    val outcome = if (agentConnection != null) {
        agentConnection.comprehend(req.text, req.question, req.summarySentences, req.topKeywords)
    } else {
        // 理论上 1234 启动时会无条件构造网关句柄；若缺失，降级到本地 stub，保证接口永远有结果。
        localFallbackOutcome(req)
    }
    respond(toComprehendResponse(outcome))
}

// ===== 自由对话 =====

@Serializable
private data class ChatMessageDto(val role: String = "user", val content: String)

@Serializable
private data class ChatRequestDto(val messages: List<ChatMessageDto>)

@Serializable
private data class ChatResponseDto(
    val engine: String,
    val content: String,
    val fallback: Boolean? = null,
    val error: String? = null,
    /** 本轮实际执行过的工具（`工具id:结果码`）；没调工具就不出现。 */
    val toolRounds: List<String>? = null,
)

// 自由对话（多轮）：直接把 messages 数组交给外部模型，缺连接/失败回退本地说明，
// 保证接口永远有结果。HTTP 层只负责解析请求、委派、映射响应，不另写外呼逻辑。
suspend fun ApplicationCall.agentChat(agentConnection: AgentConnection?) {
    val req = runCatching { receive<ChatRequestDto>() }.getOrElse {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 {messages:[{role,content}]}")); return
    }
    if (req.messages.isEmpty()) {
        respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "messages 不能为空")); return
    }
    val pairMessages = req.messages.map { (it.role to it.content) }
    val outcome = if (agentConnection != null) {
        agentConnection.chat(pairMessages)
    } else {
        // 理论上 1234 启动时会无条件构造网关句柄；若缺失，给一条本地说明，保证接口永远有结果。
        Agent.ChatOutcome(
            engine = "local-fallback",
            content = "（网关句柄未初始化，无法对话；请重启服务。）",
            fallback = true,
        )
    }
    respond(
        ChatResponseDto(
            engine = outcome.engine,
            content = outcome.content,
            fallback = if (outcome.fallback) true else null,
            error = outcome.error,
            toolRounds = outcome.toolRounds,
        ),
    )
}

// 网关句柄缺失时的最后兜底：直接走本地抽取（无 fallback 标注）。
private fun localFallbackOutcome(req: ComprehendRequest): Agent.ComprehendOutcome {
    val local = LocalComprehension.analyze(req.text, req.question, req.summarySentences, req.topKeywords)
    return Agent.ComprehendOutcome(
        engine = "local-extractive",
        summary = local.summary,
        keywords = local.keywords,
        answer = local.answer,
        sentencesCount = local.sentencesCount,
        fallback = false,
    )
}

private fun toComprehendResponse(o: Agent.ComprehendOutcome) = ComprehendResponse(
    engine = o.engine,
    summary = o.summary,
    keywords = o.keywords,
    answer = o.answer,
    sentencesCount = o.sentencesCount,
    fallback = if (o.fallback) true else null,
    error = o.error,
)

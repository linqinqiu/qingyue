package io.legado.server.ai

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.nio.file.Files
import java.nio.file.Path

/**
 * 自定义接入的「连接档案」持久层。
 *
 * 用户原话：「能自定义接入」「给用户更多自定义选择」。这条落地的意思是：
 * 框架本身只认「内置本地 stub」这一种默认连接（永远在、不可删、不写库）；
 * 其余连接（OpenAI 兼容、自建模型网关……）既可以由用户在配置文件里预先写死，
 * 也可以经由 `POST /api/agent/connections` 在运行时注册 —— 两者都落到同一份本地 JSON，
 * 重启后自动恢复，框架不替用户做决定。
 *
 * 设计红线：这里只是「连接描述」的存取，不做任何真实外呼；真正发请求的是
 * [io.legado.server.ai.AgentRoutes] 里那条读懂了 `kind` 的调用分支。
 */
object AgentProfileStore {

    /** 配置文件名：优先放在「安装根目录」，其次 `.data/`，与 port.txt / 其他本机个性化条目同级。 */
    private const val FILE_NAME = "agent-profiles.json"

    private val json = Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true; prettyPrint = true }

    /** 内置连接：框架自带、永远存在、不可删除、不落库。comprehend 在没有任何外部连接时退回它。 */
    val BUILTIN_LOCAL = Profile(
        id = "local",
        name = "内置本地理解（无需联网）",
        kind = ProfileKind.BUILTIN_STUB,
        model = "local-extractive",
        options = mapOf("note" to "关键词抽取式的本地摘要/关键词/简易问答，不调用任何外部模型。"),
    )

    @Serializable
    enum class ProfileKind {
        @SerialName("builtin-stub")
        BUILTIN_STUB,

        @SerialName("openai-compatible")
        OPENAI_COMPATIBLE,
    }

    @Serializable
    data class Profile(
        val id: String,
        val name: String,
        val kind: ProfileKind,
        val baseUrl: String? = null,
        val apiKey: String? = null,
        val model: String? = null,
        val options: Map<String, String> = emptyMap(),
    )

    @Serializable
    private data class Store(val profiles: List<Profile> = emptyList())

    private fun resolveFile(homeDirectory: Path): Path {
        val primary = homeDirectory.resolve(FILE_NAME)
        if (Files.isReadable(primary)) return primary
        val fallback = homeDirectory.resolve(".data").resolve(FILE_NAME)
        return if (Files.isReadable(fallback)) fallback else primary
    }

    /** 列出当前全部连接：内置的永远在，外加磁盘上那份用户档案。 */
    fun list(homeDirectory: Path): List<Profile> {
        val persisted = readPersisted(homeDirectory)
        return listOf(BUILTIN_LOCAL) + persisted.filter { it.id != BUILTIN_LOCAL.id }
    }

    /** 按 id 取一个；内置 local 直接命中，其余去磁盘找。 */
    fun get(homeDirectory: Path, id: String): Profile? {
        if (id == BUILTIN_LOCAL.id) return BUILTIN_LOCAL
        return readPersisted(homeDirectory).firstOrNull { it.id == id }
    }

    /**
     * 注册/更新一个用户连接，写回磁盘。
     * 内置 id（local）不允许被覆盖或写入磁盘 —— 它只能由框架提供。
     * 返回的 Profile 即为落库后的形态（id 被规整过）。
     */
    fun register(homeDirectory: Path, draft: Profile): Profile {
        require(draft.id.isNotBlank()) { "连接 id 不能为空" }
        require(draft.id != BUILTIN_LOCAL.id) { "id 'local' 是内置连接，不可覆盖" }
        val normalized = draft.copy(
            id = draft.id.trim(),
            kind = draft.kind,
            baseUrl = draft.baseUrl?.trim()?.takeIf { it.isNotBlank() },
        )
        val current = readPersisted(homeDirectory).filter { it.id != normalized.id }.toMutableList()
        current.add(normalized)
        writePersisted(homeDirectory, current)
        return normalized
    }

    /** 删除一个用户连接（内置不可删）。返回是否真的删掉了。 */
    fun delete(homeDirectory: Path, id: String): Boolean {
        if (id == BUILTIN_LOCAL.id) return false
        val current = readPersisted(homeDirectory).toMutableList()
        val removed = current.removeIf { it.id == id }
        if (removed) writePersisted(homeDirectory, current)
        return removed
    }

    private fun readPersisted(homeDirectory: Path): List<Profile> {
        val file = resolveFile(homeDirectory)
        if (!Files.isReadable(file)) return emptyList()
        return runCatching {
            // 容忍带 UTF-8 BOM 的配置文件（很多编辑器/脚本默认写出 BOM），否则 kotlinx 解析会静默失败。
            val raw = Files.readString(file)
            val text = if (raw.length > 0 && raw[0] == '\uFEFF') raw.substring(1) else raw
            if (text.isBlank()) return emptyList()
            val store = json.decodeFromString(Store.serializer(), text)
            store.profiles.filter { it.id != BUILTIN_LOCAL.id }
        }.getOrDefault(emptyList())
    }

    private fun writePersisted(homeDirectory: Path, profiles: List<Profile>) {
        val file = homeDirectory.resolve(FILE_NAME)
        Files.createDirectories(homeDirectory)
        // .data 兜底目录也同步一份，便于备份/迁移；主文件在安装根。
        runCatching { Files.createDirectories(homeDirectory.resolve(".data")) }
        val primary = file
        Files.writeString(primary, json.encodeToString(Store.serializer(), Store(profiles)))
        runCatching {
            val fallback = homeDirectory.resolve(".data").resolve(FILE_NAME)
            Files.writeString(fallback, json.encodeToString(Store.serializer(), Store(profiles)))
        }
    }
}

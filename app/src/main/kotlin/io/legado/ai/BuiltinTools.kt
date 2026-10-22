package io.legado.ai

import io.legado.data.addNote
import io.legado.data.addReadingLog
import io.legado.data.deleteNote
import io.legado.data.deleteReplaceRule
import io.legado.data.deleteRssSource
import io.legado.data.deleteSource
import io.legado.data.getProgress
import io.legado.data.getReplaceRule
import io.legado.data.getRssSource
import io.legado.data.getSource
import io.legado.data.importReplaceRules
import io.legado.data.importSources
import io.legado.data.listBookshelf
import io.legado.data.listNotes
import io.legado.data.listReadingLog
import io.legado.data.listReplaceRules
import io.legado.data.listRssSources
import io.legado.data.listSources
import io.legado.data.listSubscriptions
import io.legado.data.removeBookshelf
import io.legado.data.reorderSources
import io.legado.data.saveBookshelf
import io.legado.data.saveReplaceRule
import io.legado.data.saveSource
import io.legado.data.setBookshelfCompleted
import io.legado.data.setRssSourceEnabled
import io.legado.data.toggleReplaceRules
import io.legado.data.updateBookshelfInfo
import io.legado.data.updateNote

import io.legado.model.ReplaceRule
import io.legado.model.ReplaceRuleImportResponse
import io.legado.model.BookshelfWriteRequest
import io.legado.model.BookshelfInfoUpdateRequest
import io.legado.model.BookNoteWrite
import io.legado.model.ReadingLogRequest
import io.legado.source.SourceCodec
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray

/** 解析工具参数里带来的 JSON 字符串：沿用 SourceCodec 的宽松策略（忽略未知键、容忍非严格 JSON）。 */
private val json = Json { ignoreUnknownKeys = true; isLenient = true; coerceInputValues = true }

/**
 * 把 1234 真实存在的能力包成 AI 可调用工具。每个工具的 `writes` 标记决定它走不走护栏确认。
 *
 * 注意：这里**只调用已存在的服务方法**，不引入 1234 之外的新业务逻辑。工具清单本身
 * 就是"AI 在大体框架里能做什么"的边界——想加新能力，先在服务端加端点，再在这里包一层。
 *
 * 分组（group）与 `/api/catalog` 的面（sources / replace-rules / rss / bookshelf / notes /
 * subscriptions / explore / search / debug / health）一一对应，方便 AI 按面选择工具。
 */
object BuiltinTools {

    private fun string(args: ToolArgs, key: String, default: String = ""): String =
        (args[key] as? String) ?: default

    private fun listString(args: ToolArgs, key: String): List<String> {
        val v = args[key] ?: return emptyList()
        if (v is List<*>) return v.mapNotNull { it?.toString() }
        if (v is String) return v.split(",").map { it.trim() }.filter { it.isNotBlank() }
        return emptyList()
    }

    private fun boolean(args: ToolArgs, key: String, default: Boolean = false): Boolean =
        (args[key] as? Boolean) ?: default

    private fun longOf(args: ToolArgs, key: String): Long? =
        (args[key] as? Number)?.toLong() ?: (args[key] as? String)?.toLongOrNull()

    private fun strId(args: ToolArgs, key: String = "id"): Long? =
        (args[key] as? Number)?.toLong() ?: (args[key] as? String)?.toLongOrNull()

    fun all(policy: GuardrailsPolicy = DefaultGuardrailsPolicy): List<Tool> {
        // 捕获注入的确认策略，供批量写工具（如 sourceBatch）在落库前询问确认。
        val confirm: (ToolArgs, String) -> AgentResult? = policy::confirm
        return listOf(
        // —— 书源 sources ——
        sourceList, sourceGet, sourceValidate, sourceDebug, sourceHealth, sourceImport, sourceUpsert, sourceDelete, sourceBatchTool(confirm), sourceOrder,

        // —— 净化规则 replace-rules ——
        replaceList, replaceGet, replaceSave, replaceDelete, replaceToggle, replaceImport,

        // —— RSS rss ——
        rssList, rssGet, rssSetEnabled, rssDelete,

        // —— 书架 bookshelf ——
        shelfList, shelfGet, shelfAdd, shelfRemove, shelfSetCompleted, shelfInfoUpdate,

        // —— 笔记/阅读 notes ——
        noteList, noteAdd, noteUpdate, noteDelete, readingLogAdd, readingLogList,
        progressGet,

        // —— 订阅 subscriptions ——
        subList, subUpdateOne, subUpdateAll,

        // —— 发现/搜索/正文（只读探针，供 AI 探查内容）explore/search ——
        exploreTabs, explore, search, bookInfo, chapters, content,
        )
    }

    // ===== sources =====

    val sourceList = Tool { ctx, args ->
        val q = string(args, "q").takeIf { it.isNotBlank() }
        val all = ctx.database.listSources(q)
        // 列表可能上万条（本机实测 5596），全量塞给模型既超上下文又会被截断，
        // 而截断后模型会把"能看到的条数"当成总数（实测问多少书源，答了 21）。
        // 所以：默认只给**总数 + 前 limit 条的摘要**，并明确说明是部分。
        // limit=0 时只回总数（问"有多少个"这种问题用它）。
        // 默认 20：每条摘要约 80~120 字符，20 条约 2 KB，安全落在 MAX_TOOL_DATA(4000) 内。
        // 实测 50 条约 4.3 KB 会被截断，模型就只能看到「truncated=true 但 items 是空的」。
        val limit = (string(args, "limit").toIntOrNull() ?: 20).coerceIn(0, 100)
        val head = if (limit == 0) emptyList() else all.take(limit)
        AgentResult(
            "ok",
            data = mapOf(
                "total" to all.size,
                "returned" to head.size,
                "truncated" to (head.size < all.size),
                "items" to head.map { mapOf("id" to it.id, "name" to it.name, "group" to it.group, "enabled" to it.enabled) },
            ),
        )
    }.also { it.meta = ToolMeta("source.list", "sources", "列出书源（可按 q 过滤）。返回 total 总数与最多 limit 条摘要（默认 20，limit=0 只回总数）。", writes = false) }

    val sourceGet = Tool { ctx, args ->
        val id = string(args, "id")
        val rec = ctx.database.getSource(id)
        if (rec == null) ctx.error("not_found", "书源 $id 不存在") else AgentResult("ok", data = rec)
    }.also { it.meta = ToolMeta("source.get", "sources", "按 id 读取书源（含 json 与乐观锁 version）。", writes = false) }

    /** 只校验不落库：复用 SourceCodec.validate，与 POST /api/sources/{id}/validate 同一条路径。 */
    val sourceValidate = Tool { ctx, args ->
        val raw = string(args, "json")
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json")
        val res = SourceCodec.validate(raw)
        AgentResult("ok", data = res)
    }.also { it.meta = ToolMeta("source.validate", "sources", "校验书源 JSON 结构，不写入数据库。", writes = false) }

    /** 分阶段跑一遍书源：结构→搜索→详情→目录→正文。复用 SourceDebugger.flow 的同步回调收集各步。 */
    val sourceDebug = Tool { ctx, args ->
        val raw = string(args, "json")
        val keyword = string(args, "keyword", "测试")
        val bookUrl = string(args, "bookUrl").takeIf { it.isNotBlank() }
        val chapterIndex = (args["chapterIndex"] as? Number)?.toInt() ?: 0
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json")
        val steps = mutableListOf<Map<String, Any?>>()
        ctx.debugger.flow(raw, keyword, bookUrl, chapterIndex) { step ->
            steps.add(mapOf(
                "stage" to step.stage, "label" to step.label, "detail" to step.detail,
                "ok" to step.ok, "elapsedMs" to step.elapsedMs,
            ))
        }
        AgentResult("ok", data = mapOf("steps" to steps))
    }.also { it.meta = ToolMeta("source.debug", "debug", "分阶段调试书源（结构/搜索/详情/目录/正文），返回每步结果。", writes = false) }

    /** 单源实跑搜索定级（valid/slow/empty/blocked/needs_login/needs_webview/unreachable/tls/broken/invalid/no_search/explore_only）。 */
    val sourceHealth = Tool { ctx, args ->
        val id = string(args, "id")
        val name = string(args, "name", id)
        val raw = string(args, "json")
        val keyword = string(args, "keyword", "测试")
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json")
        val item = ctx.health.probe(id, name, raw, keyword)
        AgentResult("ok", data = item)
    }.also { it.meta = ToolMeta("source.health", "health", "对单个书源做体检（实跑搜索定级）。", writes = false) }

    /** 批量导入：upsert by id，复用 importSources。 */
    val sourceImport = Tool { ctx, args ->
        val sources = listString(args, "sources")
        if (sources.isEmpty()) return@Tool ctx.error("invalid_request", "sources 为空")
        val result = ctx.database.importSources(sources)
        AgentResult("ok", data = result)
    }.also { it.meta = ToolMeta("source.import", "sources", "批量导入/更新书源（按 id upsert）。", writes = true) }

    /** 保存单个书源：带 version 走乐观锁（冲突会翻译成 version_conflict），不带则新建。复用 saveSource。 */
    val sourceUpsert = Tool { ctx, args ->
        val raw = string(args, "json")
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json")
        val parsed = try { SourceCodec.parse(raw) } catch (e: IllegalArgumentException) {
            return@Tool ctx.error("invalid_request", e.message ?: "书源解析失败")
        }
        val expected = longOf(args, "version")
        val rec = Guardrails.catchVersionConflict {
            ctx.database.saveSource(parsed, expected)
        }
        AgentResult("ok", data = rec)
    }.also { it.meta = ToolMeta("source.upsert", "sources", "保存单个书源（version 可空；冲突返回 version_conflict）。", writes = true) }

    /** 删除单个书源：会连带清掉该源的登录态（与 DELETE /api/sources/{id} 一致）。 */
    val sourceDelete = Tool { ctx, args ->
        val id = string(args, "id")
        val ok = ctx.database.deleteSource(id)
        if (ok) AgentResult("ok", message = "已删除 $id") else ctx.error("not_found", "书源 $id 不存在")
    }.also { it.meta = ToolMeta("source.delete", "sources", "删除单个书源（同时清该源登录态）。", writes = true) }

    /** 批量动作：delete。delete 必须 confirm。 */
    private fun sourceBatchTool(confirm: (ToolArgs, String) -> AgentResult?) = Tool { ctx, args ->
        val ids = listString(args, "ids")
        val action = string(args, "action")
        if (ids.isEmpty()) return@Tool ctx.error("empty_selection", "ids 为空")
        confirm(args, "将影响 ${ids.size} 个书源")?.let { return@Tool it }
        when (action) {
            "delete" -> {
                var n = 0
                ids.forEach { if (ctx.database.deleteSource(it)) n++ }
                AgentResult("ok", data = mapOf("affected" to n, "action" to "delete"))
            }
            else -> ctx.error("invalid_action", "批量动作 $action 暂未在该框架内实现（仅 delete 已落地）")
        }
    }.also { it.meta = ToolMeta("source.batch", "sources", "批量书源动作（delete 需 confirm=true）。", writes = true) }

    val sourceOrder = Tool { ctx, args ->
        val ids = listString(args, "ids")
        if (ids.isEmpty()) return@Tool ctx.error("empty_selection", "ids 为空")
        val n = ctx.database.reorderSources(ids)
        AgentResult("ok", data = mapOf("affected" to n))
    }.also { it.meta = ToolMeta("source.order", "sources", "按给定 id 顺序重排书源。", writes = true) }

    // ===== replace-rules =====

    val replaceList = Tool { ctx, args ->
        val q = string(args, "q").takeIf { it.isNotBlank() }
        val group = string(args, "group").takeIf { it.isNotBlank() }
        AgentResult("ok", data = ctx.database.listReplaceRules(q, group, null))
    }.also { it.meta = ToolMeta("replace.list", "replace-rules", "列出净化规则（可按 q/group 过滤）。", writes = false) }

    val replaceGet = Tool { ctx, args ->
        val id = string(args, "id")
        val rule = ctx.database.getReplaceRule(id)
        if (rule == null) ctx.error("not_found", "净化规则 $id 不存在") else AgentResult("ok", data = rule)
    }.also { it.meta = ToolMeta("replace.get", "replace-rules", "按 id 读取净化规则。", writes = false) }

    val replaceSave = Tool { ctx, args ->
        val raw = string(args, "json")
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json")
        val rule = try { json.decodeFromString(ReplaceRule.serializer(), raw) }
        catch (e: Exception) { return@Tool ctx.error("invalid_request", "净化规则 JSON 无效：${e.message}") }
        AgentResult("ok", data = ctx.database.saveReplaceRule(rule))
    }.also { it.meta = ToolMeta("replace.save", "replace-rules", "保存单条净化规则（id 空则新建）。", writes = true) }

    val replaceDelete = Tool { ctx, args ->
        val id = string(args, "id")
        val ok = ctx.database.deleteReplaceRule(id)
        if (ok) AgentResult("ok", message = "已删除 $id") else ctx.error("not_found", "净化规则 $id 不存在")
    }.also { it.meta = ToolMeta("replace.delete", "replace-rules", "删除单条净化规则。", writes = true) }

    val replaceToggle = Tool { ctx, args ->
        val ids = listString(args, "ids")
        val enabled = boolean(args, "enabled", true)
        if (ids.isEmpty()) return@Tool ctx.error("empty_selection", "ids 为空")
        val n = ctx.database.toggleReplaceRules(ids, enabled)
        AgentResult("ok", data = mapOf("affected" to n, "enabled" to enabled))
    }.also { it.meta = ToolMeta("replace.toggle", "replace-rules", "批量启用/停用净化规则。", writes = true) }

    val replaceImport = Tool { ctx, args ->
        val raw = string(args, "json")
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json")
        val rules = try {
            json.decodeFromString(JsonArray.serializer(), raw).let { arr ->
                arr.map { json.decodeFromJsonElement(ReplaceRule.serializer(), it) }
            }
        } catch (e: Exception) { return@Tool ctx.error("invalid_request", "净化规则列表 JSON 无效：${e.message}") }
        val res: ReplaceRuleImportResponse = ctx.database.importReplaceRules(rules)
        AgentResult("ok", data = res)
    }.also { it.meta = ToolMeta("replace.import", "replace-rules", "批量导入净化规则。", writes = true) }

    // ===== rss =====

    val rssList = Tool { ctx, args ->
        val q = string(args, "q").takeIf { it.isNotBlank() }
        AgentResult("ok", data = ctx.database.listRssSources(q))
    }.also { it.meta = ToolMeta("rss.list", "rss", "列出 RSS 订阅源。", writes = false) }

    val rssGet = Tool { ctx, args ->
        val url = string(args, "sourceUrl")
        val raw = ctx.database.getRssSource(url)
        if (raw == null) ctx.error("not_found", "RSS 源 $url 不存在") else AgentResult("ok", data = mapOf("sourceUrl" to url, "json" to raw))
    }.also { it.meta = ToolMeta("rss.get", "rss", "按 sourceUrl 读取 RSS 源。", writes = false) }

    val rssSetEnabled = Tool { ctx, args ->
        val url = string(args, "sourceUrl")
        val enabled = boolean(args, "enabled", true)
        val ok = ctx.database.setRssSourceEnabled(url, enabled)
        if (ok) AgentResult("ok") else ctx.error("not_found", "RSS 源 $url 不存在")
    }.also { it.meta = ToolMeta("rss.setEnabled", "rss", "启用/停用 RSS 源。", writes = true) }

    val rssDelete = Tool { ctx, args ->
        val url = string(args, "sourceUrl")
        val ok = ctx.database.deleteRssSource(url)
        if (ok) AgentResult("ok") else ctx.error("not_found", "RSS 源 $url 不存在")
    }.also { it.meta = ToolMeta("rss.delete", "rss", "删除 RSS 源。", writes = true) }

    // ===== bookshelf =====

    val shelfList = Tool { ctx, _ -> AgentResult("ok", data = ctx.database.listBookshelf()) }
        .also { it.meta = ToolMeta("shelf.list", "bookshelf", "列出书架。", writes = false) }

    /**
     * 单本书架项（含阅读进度与当前章节）。
     *
     * 以前只有 `shelf.list`：模型想知道"用户这本书读到哪了"就得把整份书架拉回来再自己筛，
     * 书架几百本时既慢又容易挑错（同名书、同书不同源）。这个工具按 `sourceId + bookUrl`
     * 精确定位一本，并把阅读进度一起带回来 —— 那是"这本书"最常被问到的部分。
     */
    val shelfGet = Tool { ctx, args ->
        val sourceId = string(args, "sourceId")
        val bookUrl = string(args, "bookUrl")
        if (sourceId.isBlank() || bookUrl.isBlank()) {
            return@Tool ctx.error("invalid_request", "缺少 sourceId 或 bookUrl")
        }
        val item = ctx.database.listBookshelf().firstOrNull { it.sourceId == sourceId && it.bookUrl == bookUrl }
            ?: return@Tool ctx.error("not_found", "书架里没有这本书（sourceId=$sourceId, bookUrl=$bookUrl）")
        // 进度是独立一张表：一起带回来，模型不用再调一次 progress.get
        val progress = runCatching { ctx.database.getProgress(sourceId, bookUrl) }.getOrNull()
        AgentResult("ok", data = mapOf("item" to item, "progress" to progress))
    }.also {
        it.meta = ToolMeta(
            "shelf.get", "bookshelf",
            "按 sourceId + bookUrl 读取书架里的单本书（含阅读进度 progress）。不知道是哪本时先用 shelf.list 或 search.run。",
            writes = false,
        )
    }

    /**
     * 阅读进度读取。
     *
     * 用户常问"我上次读到哪了"。进度与书架项是两张表，`shelf.get` 会顺带返回，
     * 但若手上只有 sourceId/bookUrl、书又不在书架里（搜到但没加），就需要这个。
     */
    val progressGet = Tool { ctx, args ->
        val sourceId = string(args, "sourceId")
        val bookUrl = string(args, "bookUrl")
        if (sourceId.isBlank() || bookUrl.isBlank()) {
            return@Tool ctx.error("invalid_request", "缺少 sourceId 或 bookUrl")
        }
        val progress = ctx.database.getProgress(sourceId, bookUrl)
            ?: return@Tool ctx.error("not_found", "这本书还没有阅读进度")
        AgentResult("ok", data = progress)
    }.also {
        it.meta = ToolMeta("progress.get", "notes", "读取某本书的阅读进度（读到哪一章、章节地址、滚动位置）。", writes = false)
    }

    val shelfAdd = Tool { ctx, args ->
        val raw = string(args, "json")
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json")
        val req = try { json.decodeFromString(BookshelfWriteRequest.serializer(), raw) }
        catch (e: Exception) { return@Tool ctx.error("invalid_request", "书架条目 JSON 无效：${e.message}") }
        AgentResult("ok", data = ctx.database.saveBookshelf(req, null))
    }.also { it.meta = ToolMeta("shelf.add", "bookshelf", "加入书架。", writes = true) }

    val shelfRemove = Tool { ctx, args ->
        val sourceId = string(args, "sourceId")
        val bookUrl = string(args, "bookUrl")
        ctx.database.removeBookshelf(sourceId, bookUrl)
        AgentResult("ok")
    }.also { it.meta = ToolMeta("shelf.remove", "bookshelf", "从书架移除。", writes = true) }

    val shelfSetCompleted = Tool { ctx, args ->
        val sourceId = string(args, "sourceId")
        val bookUrl = string(args, "bookUrl")
        val completed = boolean(args, "completed", true)
        val item = ctx.database.setBookshelfCompleted(sourceId, bookUrl, completed)
        if (item == null) ctx.error("not_found", "书架项不存在") else AgentResult("ok", data = item)
    }.also { it.meta = ToolMeta("shelf.setCompleted", "bookshelf", "标记书架项已读完/未读完。", writes = true) }

    val shelfInfoUpdate = Tool { ctx, args ->
        val raw = string(args, "json")
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json")
        val req = try { json.decodeFromString(BookshelfInfoUpdateRequest.serializer(), raw) }
        catch (e: Exception) { return@Tool ctx.error("invalid_request", "书架信息 JSON 无效：${e.message}") }
        val item = ctx.database.updateBookshelfInfo(req, null)
        if (item == null) ctx.error("not_found", "书架项不存在") else AgentResult("ok", data = item)
    }.also { it.meta = ToolMeta("shelf.infoUpdate", "bookshelf", "更新书架项书名/作者/封面。", writes = true) }

    // ===== notes / reading =====

    val noteList = Tool { ctx, args ->
        val sourceId = string(args, "sourceId")
        val bookUrl = string(args, "bookUrl")
        AgentResult("ok", data = ctx.database.listNotes(sourceId, bookUrl))
    }.also { it.meta = ToolMeta("note.list", "notes", "列出某本书的笔记/划线。", writes = false) }

    val noteAdd = Tool { ctx, args ->
        val raw = string(args, "json")
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json")
        val req = try { json.decodeFromString(BookNoteWrite.serializer(), raw) }
        catch (e: Exception) { return@Tool ctx.error("invalid_request", "笔记 JSON 无效：${e.message}") }
        AgentResult("ok", data = ctx.database.addNote(req))
    }.also { it.meta = ToolMeta("note.add", "notes", "新增笔记/划线。", writes = true) }

    val noteUpdate = Tool { ctx, args ->
        val id = strId(args) ?: return@Tool ctx.error("invalid_request", "缺少 id")
        val note = string(args, "note")
        val ok = ctx.database.updateNote(id, note)
        if (ok) AgentResult("ok") else ctx.error("not_found", "笔记 $id 不存在")
    }.also { it.meta = ToolMeta("note.update", "notes", "修改笔记内容（仅 note 一栏）。", writes = true) }

    val noteDelete = Tool { ctx, args ->
        val id = strId(args) ?: return@Tool ctx.error("invalid_request", "缺少 id")
        val ok = ctx.database.deleteNote(id)
        if (ok) AgentResult("ok") else ctx.error("not_found", "笔记 $id 不存在")
    }.also { it.meta = ToolMeta("note.delete", "notes", "删除笔记。", writes = true) }

    val readingLogAdd = Tool { ctx, args ->
        val raw = string(args, "json")
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json")
        val req = try { json.decodeFromString(ReadingLogRequest.serializer(), raw) }
        catch (e: Exception) { return@Tool ctx.error("invalid_request", "阅读日志 JSON 无效：${e.message}") }
        AgentResult("ok", data = ctx.database.addReadingLog(req))
    }.also { it.meta = ToolMeta("readingLog.add", "notes", "上报一段阅读时长。", writes = true) }

    val readingLogList = Tool { ctx, args ->
        val days = (args["days"] as? Number)?.toInt() ?: 7
        AgentResult("ok", data = ctx.database.listReadingLog(days))
    }.also { it.meta = ToolMeta("readingLog.list", "notes", "读取最近 N 天的阅读记录。", writes = false) }

    // ===== subscriptions =====

    val subList = Tool { ctx, _ -> AgentResult("ok", data = ctx.database.listSubscriptions()) }
        .also { it.meta = ToolMeta("subscription.list", "subscriptions", "列出书源订阅。", writes = false) }

    val subUpdateOne = Tool { ctx, args ->
        val id = strId(args) ?: return@Tool ctx.error("invalid_request", "缺少 id")
        val res = runCatching { ctx.subscriptions.updateOne(id) }
            .getOrElse { return@Tool ctx.error("subscription_update_failed", it.message ?: "订阅更新失败") }
        AgentResult("ok", data = res)
    }.also { it.meta = ToolMeta("subscription.updateOne", "subscriptions", "更新单个订阅。", writes = true) }

    val subUpdateAll = Tool { ctx, _ ->
        val res = ctx.subscriptions.updateAll()
        AgentResult("ok", data = mapOf("updated" to res.count { it.second.isSuccess }, "failed" to res.count { it.second.isFailure }))
    }.also { it.meta = ToolMeta("subscription.updateAll", "subscriptions", "更新全部订阅。", writes = true) }

    // ===== explore / search / content（只读探针） =====

    val exploreTabs = Tool { ctx, args ->
        val raw = string(args, "json")
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json")
        AgentResult("ok", data = ctx.runner.exploreTabs(raw))
    }.also { it.meta = ToolMeta("explore.tabs", "explore", "读取书源发现页分类。", writes = false) }

    val explore = Tool { ctx, args ->
        val raw = string(args, "json")
        val url = string(args, "url")
        val page = (args["page"] as? Number)?.toInt() ?: 1
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json")
        AgentResult("ok", data = ctx.runner.explore(raw, url, page))
    }.also { it.meta = ToolMeta("explore.run", "explore", "按发现页地址取一页。", writes = false) }

    val search = Tool { ctx, args ->
        val raw = string(args, "json")
        val keyword = string(args, "keyword", "测试")
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json")
        runCatching { ctx.runner.search(raw, keyword) }
            .fold({ AgentResult("ok", data = it) }, { ctx.error("source_execution_failed", it.message ?: "搜索失败") })
    }.also { it.meta = ToolMeta("search.run", "search", "用某书源实跑一次关键词搜索。", writes = false) }

    /**
     * 书籍详情：按书源 JSON + bookUrl 取书名/作者/简介/封面/目录地址。
     *
     * 和 `chapters.run` 的区别：那个是"跑规则取目录"，这个是"这本书是什么"。
     * 用户问"这本书讲什么"时，模型需要的是简介与元信息，不是章节列表。
     */
    val bookInfo = Tool { ctx, args ->
        val raw = string(args, "json")
        val bookUrl = string(args, "bookUrl")
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json（书源配置）")
        if (bookUrl.isBlank()) return@Tool ctx.error("invalid_request", "缺少 bookUrl")
        runCatching { ctx.runner.details(raw, bookUrl) }
            .fold({ AgentResult("ok", data = it) }, { ctx.error("source_execution_failed", it.message ?: "取书籍详情失败") })
    }.also {
        it.meta = ToolMeta(
            "book.info", "search",
            "按书源 json + bookUrl 取书籍详情（书名/作者/简介/封面/目录地址）。问\"这本书讲什么\"时用它，不要用 chapters.run。",
            writes = false,
        )
    }

    val chapters = Tool { ctx, args ->
        val raw = string(args, "json")
        val tocUrl = string(args, "tocUrl")
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json")
        runCatching { ctx.runner.chapters(raw, tocUrl) }
            .fold({ AgentResult("ok", data = it) }, { ctx.error("source_execution_failed", it.message ?: "取目录失败") })
    }.also { it.meta = ToolMeta("chapters.run", "search", "取书源目录。", writes = false) }

    val content = Tool { ctx, args ->
        val raw = string(args, "json")
        val chapterUrl = string(args, "chapterUrl")
        if (raw.isBlank()) return@Tool ctx.error("invalid_request", "缺少 json")
        runCatching { ctx.runner.content(raw, chapterUrl) }
            .fold({ AgentResult("ok", data = it) }, { ctx.error("source_execution_failed", it.message ?: "取正文失败") })
    }.also { it.meta = ToolMeta("content.run", "search", "取单章正文。", writes = false) }
}

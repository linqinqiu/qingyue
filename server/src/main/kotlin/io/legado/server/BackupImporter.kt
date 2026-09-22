package io.legado.server

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import java.nio.charset.Charset
import java.nio.file.Path
import java.util.zip.ZipEntry
import java.util.zip.ZipFile

/**
 * Legado App 备份包导入器，跨版本兼容。
 *
 * 认的包内条目（大小写、是否带目录前缀都无所谓）：
 * - 现版本：`bookSource.json` / `replaceRule.json` / `bookshelf.json`（上游 `help/storage/Backup.kt` 写出的名字）
 * - 老版本：`myBookSource.json` / `myBookReplaceRule.json` / `myBookShelf.json`（字段是扁平的，走 [LegacyBackup] 迁移）
 * - 分叉与网页版别名：`readAppBookSource.json`、`sources.json`
 *
 * 包外形状也一并兜住：`{data:[…]}` / `{bookSources:[…]}` / 整个文件只有一个源对象、UTF-8 BOM、
 * GB18030 编码、布尔写成 `1/0`、数字写成字符串。
 *
 * 实现要点：
 * 1. 全程用 [ZipFile] 按条目名读取，绝不把条目解包到磁盘，从根本上规避 zip-slip 路径穿越；
 * 2. 声明解压体积超限直接拒绝，避免 zip 炸弹撑爆内存；
 * 3. 书架的 `origin` 经 [SourceCodec.normalizeSourceId] 归一化，才能与书源表主键（也是 sourceId）对齐；
 * 4. 承接不了的条目如实写进 `skippedSections`，不静默丢弃。
 */
class BackupImporter(private val database: Database) {

    fun import(file: Path): BackupImportSummary = ZipFile(file.toFile()).use { zip ->
        val entries = zip.entries().asSequence().filter { !it.isDirectory }.toList()
        require(entries.sumOf { it.size.coerceAtLeast(0L) } <= MAX_TOTAL_BYTES) {
            "备份包展开后超过 ${MAX_TOTAL_BYTES / 1024 / 1024} MiB，已拒绝"
        }
        val present = entries.map { it.name.substringAfterLast('/').lowercase() }.toSet()
        val sources = readSection(zip, entries, SOURCE_NAMES)?.let(::parseSources).orEmpty()
        val rules = readSection(zip, entries, RULE_NAMES)?.let(::parseRules).orEmpty()
        val shelf = readSection(zip, entries, SHELF_NAMES)?.let(::parseShelf).orEmpty()
        require(sources.isNotEmpty() || rules.isNotEmpty() || shelf.isNotEmpty()) {
            "不是可识别的 Legado 备份：找过 ${SOURCE_NAMES.joinToString()} / ${RULE_NAMES.joinToString()} / " +
                "${SHELF_NAMES.joinToString()}，包内实际有 ${present.size} 个条目"
        }

        val sourceResult = database.importSources(sources)
        val ruleResult = database.importReplaceRules(rules)
        val library = database.importLibrary(shelf)
        BackupImportSummary(
            sources = sourceResult.imported,
            sourcesUpdated = sourceResult.updated,
            rules = ruleResult.imported,
            rulesUpdated = ruleResult.updated,
            books = library.imported,
            booksUpdated = library.updated,
            progress = library.progress,
            skippedSections = KNOWN_BUT_UNSUPPORTED.filter { it in present }.sorted(),
        )
    }

    /** 取候选名里第一个命中的条目；一个都没有时返回 null，由调用方区分「缺这一节」和「不是备份包」。 */
    private fun readSection(zip: ZipFile, entries: List<ZipEntry>, candidates: List<String>): String? {
        val wanted = candidates.map { it.lowercase() }.toSet()
        val entry = entries.firstOrNull { it.name.substringAfterLast('/').lowercase() in wanted } ?: return null
        require(entry.size <= MAX_ENTRY_BYTES) { "${entry.name} 展开后超过 ${MAX_ENTRY_BYTES / 1024 / 1024} MiB，已拒绝" }
        return zip.getInputStream(entry).use { stream -> decode(stream.readBytes()) }
    }

    /** 少数老备份是 GB18030 存的：UTF-8 严格解不出来再退一档，免得整包中文变乱码。 */
    private fun decode(bytes: ByteArray): String =
        runCatching { String(bytes, Charsets.UTF_8) }.getOrElse { String(bytes, Charset.forName("GB18030")) }

    private fun parseSources(text: String): List<String> = LegacyBackup.elementsOf(text).mapNotNull { element ->
        // 老格式先按上游映射迁成现版本结构，否则导进来是取不到值的空壳源
        if (LegacyBackup.isOldSource(element)) LegacyBackup.toNewSourceJson(element) else element.toString()
    }

    private fun parseRules(text: String): List<ReplaceRule> = LegacyBackup.elementsOf(text).mapNotNull { element ->
        val normalized = LegacyBackup.normalizeReplaceRule(element) ?: return@mapNotNull null
        val rule = Json.parseToJsonElement(normalized).jsonObject
        val pattern = rule.text("pattern") ?: return@mapNotNull null
        ReplaceRule(
            id = rule.text("id").orEmpty(),
            name = rule.text("name") ?: pattern,
            group = rule.text("group"),
            pattern = pattern,
            replacement = rule.text("replacement").orEmpty(),
            isRegex = rule.flag("isRegex") ?: true,
            scope = rule.text("scope"),
            excludeScope = rule.text("excludeScope"),
            scopeTitle = rule.flag("scopeTitle") ?: false,
            scopeContent = rule.flag("scopeContent") ?: true,
            isEnabled = rule.flag("isEnabled") ?: true,
            order = rule.number("order")?.toInt() ?: 0,
            timeoutMillisecond = rule.number("timeoutMillisecond") ?: 3000L,
        )
    }

    private fun parseShelf(text: String): List<BackupShelfEntry> = LegacyBackup.elementsOf(text).mapNotNull { element ->
        val jsonText = if (LegacyBackup.isOldShelfEntry(element)) LegacyBackup.toNewShelfJson(element) else element.toString()
        val book = jsonText?.let { Json.parseToJsonElement(it).jsonObject } ?: return@mapNotNull null
        val origin = book.text("origin")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        val bookUrl = book.text("bookUrl")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        val sourceId = SourceCodec.normalizeSourceId(origin)
        if (sourceId.isBlank()) return@mapNotNull null
        BackupShelfEntry(
            sourceId = sourceId,
            bookUrl = bookUrl,
            name = book.text("name")?.takeIf { it.isNotBlank() } ?: bookUrl,
            author = book.text("author")?.takeIf { it.isNotBlank() },
            tocUrl = book.text("tocUrl")?.takeIf { it.isNotBlank() } ?: bookUrl,
            coverUrl = (book.text("coverUrl") ?: book.text("customCoverUrl"))?.takeIf { it.isNotBlank() },
            completed = book.text("kind")?.contains("完结") == true,
            chapterIndex = book.number("durChapterIndex")?.toInt() ?: 0,
            readAt = book.number("durChapterTime") ?: 0L,
        )
    }

    private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
    private fun JsonObject.flag(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull
    private fun JsonObject.number(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull

    private companion object {
        const val MAX_ENTRY_BYTES = 64L * 1024 * 1024
        const val MAX_TOTAL_BYTES = 256L * 1024 * 1024

        val SOURCE_NAMES = listOf("booksource.json", "mybooksource.json", "readappbooksource.json", "sources.json")
        val RULE_NAMES = listOf("replacerule.json", "mybookreplacerule.json", "readappreplacerule.json")
        val SHELF_NAMES = listOf("bookshelf.json", "mybookshelf.json", "readappbookshelf.json")

        /** 备份包里我们暂时承接不了的条目：导入后如实回报，不假装什么都没发生。 */
        val KNOWN_BUT_UNSUPPORTED = listOf(
            "rsssources.json", "rssstar.json", "sourcesub.json", "bookgroup.json", "bookmemo.json",
            "bookmark.json", "highlight.json", "highlightrule.json", "readrecord.json",
            "readrecorddetail.json", "searchhistory.json", "txttocrule.json", "httptts.json",
            "keyboardassists.json", "dictrule.json", "servers.json", "readconfig.json",
            "themeconfig.json", "config.xml", "videoconfig.xml", "autotask.json", "runtimesourcecache.json",
        )
    }
}

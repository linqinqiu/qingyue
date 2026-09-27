package io.legado.server

import cn.wanghaomiao.xpath.model.JXDocument
import com.jayway.jsonpath.JsonPath
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.TextNode
import org.jsoup.select.Elements
import org.mozilla.javascript.BaseFunction
import org.mozilla.javascript.ClassShutter
import org.mozilla.javascript.Context
import org.mozilla.javascript.Function
import org.mozilla.javascript.NativeJSON
import org.mozilla.javascript.NativeObject
import org.mozilla.javascript.Scriptable
import org.mozilla.javascript.ScriptableObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.Charset
import java.time.Duration
import java.util.zip.GZIPInputStream
import java.util.zip.InflaterInputStream

/**
 * A deliberately small, server-safe subset of Legado's declarative source protocol.
 * It keeps execution away from Android APIs and rejects private-network targets.
 */
class RuleRunner(private val responseFetcher: ((String) -> String)? = null, internal var database: Database? = null) {
    constructor(database: Database) : this(null, database)
    constructor(responseFetcher: (String) -> String) : this(responseFetcher, null)
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NEVER).build()
    private val json = Json { ignoreUnknownKeys = true }
    private val jsSandbox = JsSandbox(this)

    fun search(sourceJson: String, keyword: String): List<SearchResult> {
        val source = sourceJson.objectValue()
        source.string("mainJs")?.takeIf { it.isNotBlank() }?.let { return JsSourceRunner(this, source).search(keyword) }
        val rawSearchUrl = source.string("searchUrl") ?: throw RuleExecutionException("该书源未配置 searchUrl")
        val sourceUrl = source.string("bookSourceUrl") ?: throw RuleExecutionException("书源缺少 bookSourceUrl")
        // 整个搜索流程都在书源上下文内执行：规则里的 <js> 依赖 source.getVariable() 与 jsLib 工具函数
        val execContext = sourceContext(source, sourceUrl)
        return jsSandbox.withSourceContext(execContext) {
            val searchUrl = if (rawSearchUrl.trimStart().startsWith("@js:") || rawSearchUrl.trimStart().startsWith("js:") || rawSearchUrl.contains("<js>")) {
                val jsCode = if (rawSearchUrl.contains("<js>")) rawSearchUrl.substringAfter("<js>").substringBefore("</js>") else rawSearchUrl.removePrefix("@js:").removePrefix("js:")
                jsSandbox.eval(jsCode, mapOf("key" to keyword, "keyword" to keyword, "page" to 1, "baseUrl" to sourceUrl, "sourceId" to sourceUrl), execContext)
                    ?: throw RuleExecutionException("searchUrl JS 计算未返回有效地址：${execContext.lastError ?: "脚本无返回值"}")
            } else {
                rawSearchUrl
            }
            val (urlTemplate, options) = splitUrlOptions(searchUrl)
            val mergedOptions = mergeOptions(parseSourceHeaders(source, sourceUrl), options)
            val rendered = renderUrl(urlTemplate, keyword, sourceUrl).absolute(sourceUrl)
            val body = fetchUrl(rendered, mergedOptions, keyword, sourceUrl, database)
            val rule = source.objectValue("ruleSearch") ?: throw RuleExecutionException("该书源未配置 ruleSearch")
            bookItems(body, rule, sourceUrl)
        }
    }

    /** 把 `ruleSearch` / `ruleExplore` 这类「列表规则 + 字段规则」解析成书籍条目。 */
    private fun bookItems(body: String, rule: JsonObject, sourceUrl: String): List<SearchResult> {
        val listRule = rule.string("bookList") ?: throw RuleExecutionException("缺少 bookList 规则")
        // 与 chapters() 一致：`<js>…</js>` 形式的列表规则要先过沙箱预处理，直接丢给 Jsoup/json-path 会解析失败
        val items = if (isJsRule(listRule)) jsListNodes(NodeValue.document(body), listRule, body, sourceUrl) else nodes(body, listRule)
        return items.mapNotNull { item ->
            val url = item.value(rule.string("bookUrl"), jsSandbox, body, sourceUrl)?.absolute(sourceUrl) ?: return@mapNotNull null
            SearchResult(
                sourceId = sourceUrl,
                name = item.value(rule.string("name"), jsSandbox, body, sourceUrl) ?: return@mapNotNull null,
                author = item.value(rule.string("author"), jsSandbox, body, sourceUrl),
                bookUrl = url,
                coverUrl = item.value(rule.string("coverUrl"), jsSandbox, body, sourceUrl)?.absolute(sourceUrl),
                intro = item.value(rule.string("intro"), jsSandbox, body, sourceUrl),
                kind = item.value(rule.string("kind"), jsSandbox, body, sourceUrl)?.trim()?.takeIf { it.isNotBlank() },
                wordCount = item.value(rule.string("wordCount"), jsSandbox, body, sourceUrl)?.trim()?.takeIf { it.isNotBlank() },
                lastChapter = item.value(rule.string("lastChapter"), jsSandbox, body, sourceUrl)?.trim()?.takeIf { it.isNotBlank() },
            )
        }
    }

    /**
     * 解析书源的 `exploreUrl`（Legado 的「发现」页配置）：
     * 既支持 `标题::URL` 换行或 `&#` 分隔的普通写法，也支持 `@js:` 返回 `[{title,url}]` 的聚合源写法。
     */
    fun exploreTabs(sourceJson: String): List<ExploreTab> {
        val source = sourceJson.objectValue()
        val raw = source.string("exploreUrl")?.trim().orEmpty()
        if (raw.isEmpty()) return emptyList()
        val sourceUrl = source.string("bookSourceUrl")
        return jsSandbox.withSourceContext(sourceContext(source, sourceUrl)) {
            val text = if (isJsRule(raw)) evalRuleJs(raw, mapOf("baseUrl" to sourceUrl.orEmpty(), "sourceId" to sourceUrl.orEmpty())) ?: return@withSourceContext emptyList() else raw
            parseExploreTabs(text)
        }
    }

    /** 按发现页地址取书籍列表：优先 `ruleExplore`，缺省回落到 `ruleSearch`（与 Legado 一致）。 */
    fun explore(sourceJson: String, urlTemplate: String, page: Int = 1): List<SearchResult> {
        val source = sourceJson.objectValue()
        val sourceUrl = source.string("bookSourceUrl") ?: throw RuleExecutionException("书源缺少 bookSourceUrl")
        return jsSandbox.withSourceContext(sourceContext(source, sourceUrl)) {
            val resolved = if (isJsRule(urlTemplate)) evalRuleJs(urlTemplate, mapOf("baseUrl" to sourceUrl, "sourceId" to sourceUrl, "key" to "", "keyword" to "", "page" to page)) ?: urlTemplate else urlTemplate
            val (path, options) = splitUrlOptions(resolved)
            val mergedOptions = mergeOptions(parseSourceHeaders(source, sourceUrl), options)
            val body = fetchUrl(renderUrl(path, "", sourceUrl, page).absolute(sourceUrl), mergedOptions, null, sourceUrl, database)
            val rule = source.objectValue("ruleExplore") ?: source.objectValue("ruleSearch") ?: throw RuleExecutionException("该书源未配置 ruleExplore/ruleSearch")
            bookItems(body, rule, sourceUrl)
        }
    }

    private fun evalRuleJs(rule: String, bindings: Map<String, Any?>): String? {
        val trimmed = rule.trim()
        val code = if (trimmed.contains("<js>")) trimmed.substringAfter("<js>").substringBefore("</js>") else trimmed.removePrefix("@js:").removePrefix("js:")
        return jsSandbox.eval(code, bindings)
    }

    private fun parseExploreTabs(text: String): List<ExploreTab> = text.trim().let { trimmed ->
        if (trimmed.startsWith("[")) {
            val array = runCatching { Json.parseToJsonElement(trimmed) as? JsonArray }.getOrNull()
            if (array != null) {
                return array.mapNotNull { element ->
                    val tab = element as? JsonObject ?: return@mapNotNull null
                    val title = (tab.string("title") ?: tab.string("name"))?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                    val url = (tab.string("url") ?: tab.string("bookSourceUrl"))?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                    ExploreTab(title, url)
                }
            }
        }
        trimmed.lineSequence().flatMap { it.split("&#") }.mapNotNull { entry ->
            val title = entry.substringBefore("::").trim()
            val url = entry.substringAfter("::", "").trim()
            if (title.isEmpty() || url.isEmpty()) null else ExploreTab(title, url)
        }.toList()
    }

    /**
     * 构造当前书源的 JS 执行上下文（含 jsLib，规则 JS 因此可以调用书源工具函数）。
     *
     * 注意：Legado 约定里 `loginUrl` 可以不是网址，而是**整段登录用 JS**（聚合源普遍如此），
     * 其中的工具函数同样会被正文/目录规则调用，因此也要并入脚本库。
     */
    private fun sourceContext(source: JsonObject, sourceUrl: String?): JsExecutionContext {
        val library = buildString {
            source.string("jsLib")?.takeIf { it.isNotBlank() }?.let { append(it) }
            val loginScript = source.string("loginUrl")?.takeIf { it.isNotBlank() && !it.trim().startsWith("http") }
            if (loginScript != null) {
                if (isNotEmpty()) append("\n")
                append(loginScript)
            }
        }.takeIf { it.isNotBlank() }
        return JsExecutionContext(sourceId = sourceUrl, database = database, jsLib = library)
    }

    fun details(sourceJson: String, bookUrl: String): BookDetails {
        val source = sourceJson.objectValue()
        source.string("mainJs")?.takeIf { it.isNotBlank() }?.let { return JsSourceRunner(this, source).details(bookUrl) }
        return jsSandbox.withSourceContext(sourceContext(source, source.string("bookSourceUrl"))) {
            declarativeDetails(source, bookUrl)
        }
    }

    /**
     * 解析 `data:;base64,<载荷>,<类型标记>` 形式的数据地址，返回解码后的载荷；非数据地址返回 null。
     *
     * 聚合类书源用它把 book_id/来源/分栏等参数从搜索结果一路带到详情、目录和正文。
     */
    private fun dataUrlPayload(url: String): String? {
        val value = url.trim()
        if (!value.startsWith("data:", ignoreCase = true)) return null
        val comma = value.indexOf(',')
        if (comma < 0) return null
        val meta = value.substring(5, comma)
        var payload = value.substring(comma + 1)
        // 末尾可能跟一个类型标记（如 ,{"type":"qingtian2"}），取最后一个逗号之前的部分
        val typeIndex = payload.lastIndexOf(',')
        if (typeIndex > 0 && payload.substring(typeIndex + 1).trimStart().startsWith("{")) {
            payload = payload.substring(0, typeIndex)
        }
        return if (meta.contains("base64", ignoreCase = true)) {
            runCatching { String(java.util.Base64.getDecoder().decode(payload.trim()), Charsets.UTF_8) }
                .getOrElse { payload }
        } else {
            runCatching { java.net.URLDecoder.decode(payload, Charsets.UTF_8) }.getOrDefault(payload)
        }
    }

    private fun declarativeDetails(
        source: JsonObject,
        bookUrl: String,
        traces: MutableList<DebugTrace>? = null,
    ): BookDetails {
        val sourceUrl = source.string("bookSourceUrl")
        val rule = source.objectValue("ruleBookInfo") ?: throw RuleExecutionException("该书源未配置 ruleBookInfo")
        val initRule = rule.string("init")

        // 聚合源把 bookUrl 当作参数载体（data:;base64,<载荷>,{"type":"qingtian"}），
        // 这类地址无法直接 HTTP 请求，需要先取出解码后的载荷交给规则。
        val dataPayload = dataUrlPayload(bookUrl)
        val body: String
        val baseDoc: NodeValue
        if (dataPayload != null) {
            body = dataPayload
            baseDoc = NodeValue.json(dataPayload)
        } else {
            val (url, options) = splitUrlOptions(bookUrl)
            val mergedOptions = mergeOptions(parseSourceHeaders(source, sourceUrl), options)
            body = fetchUrl(url, mergedOptions, null, sourceUrl, database)
            baseDoc = NodeValue.document(body)
        }

        // init 常写成「JS + 后置取值路径」的规则链（如 <js>…</js>$.data）：必须求值，不能当路径用。
        // 纯路径（如 $.data）仍走原有 at() 语义，避免把 JSON 对象退化成字符串。
        traces?.add(DebugTrace("‹响应›", bookUrl.take(160), "${body.length} 字节", ""))
        val root = when {
            initRule.isNullOrBlank() -> baseDoc
            initRule.contains("<js>") || initRule.trimStart().startsWith("@js:") || initRule.trimStart().startsWith("js:") ->
                runCatching { baseDoc.value(initRule, jsSandbox, body, bookUrl) }.getOrNull()
                    ?.takeIf { it.isNotBlank() }?.let { NodeValue.document(it) } ?: baseDoc
            else -> baseDoc.at(initRule)
        }
        fun value(key: String): String? {
            val ruleText = rule.string(key).orEmpty()
            val outcome = runCatching { root.value(rule.string(key), jsSandbox, body, bookUrl) }
            traces?.add(
                DebugTrace(
                    field = key,
                    rule = ruleText,
                    value = outcome.getOrNull()?.take(MAX_TRACE_CHARS) ?: "",
                    failure = outcome.exceptionOrNull()?.let { it.javaClass.simpleName + "：" + (it.message ?: "") }
                        ?: outcome.getOrNull()?.let { "取到空值" }.orEmpty(),
                )
            )
            return outcome.getOrNull()
        }
        val name = (value("name") ?: "").trim()
        return BookDetails(
            sourceId = source.string("bookSourceUrl")!!,
            name = name.ifBlank { "未命名书籍" },
            author = value("author"), intro = value("intro"),
            coverUrl = value("coverUrl")?.absolute(bookUrl),
            tocUrl = value("tocUrl")?.absolute(bookUrl) ?: bookUrl,
            kind = value("kind")?.trim()?.takeIf { it.isNotBlank() },
            wordCount = value("wordCount")?.trim()?.takeIf { it.isNotBlank() },
            lastChapter = value("lastChapter")?.trim()?.takeIf { it.isNotBlank() },
        )
    }

    /**
     * 调试专用：跑一遍详情规则，同时把「字段 → 规则原文 → 取到的值/失败原因」逐条带出来。
     * 只在 `/debug` 链路上用，正常取值走的是无 trace 的那条路径，不给热路径加开销。
     */
    fun debugDetails(sourceJson: String, bookUrl: String): Pair<BookDetails, List<DebugTrace>> {
        val traces = mutableListOf<DebugTrace>()
        return declarativeDetails(sourceJson.objectValue(), bookUrl, traces) to traces
    }

    fun chapters(sourceJson: String, tocUrl: String): List<Chapter> {
        val source = sourceJson.objectValue()
        source.string("mainJs")?.takeIf { it.isNotBlank() }?.let { return JsSourceRunner(this, source).chapters(tocUrl) }
        val sourceUrl = source.string("bookSourceUrl")
        return jsSandbox.withSourceContext(sourceContext(source, sourceUrl)) {
            val rule = source.objectValue("ruleToc") ?: throw RuleExecutionException("该书源未配置 ruleToc")
            val rawListRule = rule.string("chapterList") ?: throw RuleExecutionException("缺少 ruleToc.chapterList")
            // 上游允许 `-` 前缀表示倒序目录、`+` 表示显式正序（BookChapterList.analyzeChapterList）。
            val normalized = rawListRule.trimStart()
            val reverse = normalized.startsWith("-")
            val listRule = normalized.removePrefix("-").removePrefix("+").trim()
            val nextRule = rule.string("nextTocUrl").orEmpty().trim()

            // 目录分页：`nextTocUrl` 可以返回 1 个下一页、也可以一次返回多个入口页。
            // 上游用 visited 集合做回环守卫，这里再叠一层页数上限，避免坏规则把请求打成长尾。
            val collected = LinkedHashMap<String, Triple<String, String, Boolean>>()
            val queue = ArrayDeque(listOf(tocUrl))
            val visited = mutableSetOf(tocUrl)
            var pages = 0
            while (queue.isNotEmpty() && pages < MAX_TOC_PAGES) {
                val pageUrl = queue.removeFirst()
                val (pageChapters, nextUrls) = parseTocPage(source, sourceUrl, rule, listRule, nextRule, pageUrl)
                pageChapters.forEach { (name, url, isVolume) ->
                    val key = if (url.isNotBlank()) url else "vol:$name"
                    if (!collected.containsKey(key)) collected[key] = Triple(name, url, isVolume)
                }
                nextUrls.forEach { if (visited.add(it)) queue.addLast(it) }
                pages++
            }
            val ordered = if (reverse) collected.values.reversed() else collected.values.toList()
            ordered.mapIndexed { index, (name, url, isVolume) ->
                Chapter(index, name.ifBlank { if (isVolume) "" else "第 ${index + 1} 章" }, url, isVolume)
            }
        }
    }

    /** 解析目录的**一页**，返回（本页章节 名称→URL，本页声明的下一页地址）。 */
    private fun parseTocPage(
        source: JsonObject,
        sourceUrl: String?,
        rule: JsonObject,
        listRule: String,
        nextRule: String,
        pageUrl: String,
    ): Pair<List<Triple<String, String, Boolean>>, List<String>> {
        val dataPayload = dataUrlPayload(pageUrl)
        val body: String
        val chapterNodes: List<NodeValue>
        if (dataPayload != null) {
            // 聚合源的目录地址同样是参数载体，由 chapterList 的 JS 自行取回目录
            body = dataPayload
            chapterNodes = jsListNodes(NodeValue.json(dataPayload), listRule, body, pageUrl)
        } else {
            val (url, options) = splitUrlOptions(pageUrl)
            val mergedOptions = mergeOptions(parseSourceHeaders(source, sourceUrl), options)
            body = fetchUrl(url, mergedOptions, null, sourceUrl, database)
            val baseDoc = NodeValue.document(body)
            chapterNodes = if (isJsRule(listRule)) jsListNodes(baseDoc, listRule, body, pageUrl) else nodes(body, listRule)
        }
        val isVolumeRule = rule.string("isVolume")?.trim()
        val items = chapterNodes.mapNotNull { node ->
            val isVolume = isVolumeRule?.let { node.value(it, jsSandbox, body, pageUrl) }
                ?.trim()?.let { it.isNotEmpty() && it != "0" && it != "false" } ?: false
            val chapterHref = node.value(rule.string("chapterUrl"), jsSandbox, body, pageUrl)?.absolute(pageUrl)
            val name = node.value(rule.string("chapterName"), jsSandbox, body, pageUrl).orEmpty()
            // 卷分组头可无正文地址；普通章节没有地址则丢弃（维持原行为）。
            if (chapterHref == null && !isVolume) return@mapNotNull null
            Triple(name, chapterHref ?: "", isVolume)
        }
        val nextUrls = if (nextRule.isEmpty()) emptyList() else NodeValue.document(body)
            .value(nextRule, jsSandbox, body, pageUrl)
            .orEmpty()
            .lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .map { it.absolute(pageUrl) }
            .distinct()
            .toList()
        return items to nextUrls
    }

    private fun isJsRule(rule: String): Boolean {
        val trimmed = rule.trimStart()
        return trimmed.startsWith("@js:") || trimmed.startsWith("js:") || (rule.contains("<js>") && rule.contains("</js>"))
    }

    /** `<js>` 形式的列表规则：求值得到 JSON 数组后逐项包装成可继续取值的节点。 */
    private fun jsListNodes(base: NodeValue, listRule: String, body: String, baseUrl: String): List<NodeValue> {
        val trimmed = listRule.trim()
        val postRule = if (trimmed.contains("</js>")) trimmed.substringAfter("</js>").trim() else ""
        // 有尾随规则时只把 `<js>…</js>` 段交给 value()，拿到 JS 的输出文本；
        // 若连尾随规则一起交给 value()，通配路径的结果会被序列化成 Java toString，再也解析不出条目。
        val jsOnly = if (postRule.isBlank()) trimmed else trimmed.substringBefore("</js>").trim() + "</js>"
        val produced = base.value(jsOnly, jsSandbox, body, baseUrl) ?: return emptyList()
        if (postRule.isNotBlank()) return nodes(produced, postRule)
        val parsed = runCatching { Json.parseToJsonElement(produced) }.getOrNull() as? JsonArray ?: return emptyList()
        return parsed.map { NodeValue.json(it.toPlainJava()) }
    }

    /** 把 kotlinx JsonElement 转成普通 Java 结构，使 JsonPath 取值与 JS 属性访问都能正常工作。 */
    private fun JsonElement.toPlainJava(): Any? = when (this) {
        is JsonObject -> LinkedHashMap<String, Any?>().also { map -> entries.forEach { (key, value) -> map[key] = value.toPlainJava() } }
        is JsonArray -> map { it.toPlainJava() }
        is JsonPrimitive -> if (isString) content
        else content.toBooleanStrictOrNull() ?: content.toLongOrNull() ?: content.toDoubleOrNull() ?: content
        JsonNull -> null
    }

    /**
     * 把 `book.*` / `chapter.*` 的真值喂进执行上下文。
     *
     * 上游是把 Book / BookChapter 对象直接交给 Rhino，所以书源 JS 里 `book.origin`、
     * `chapter.title` 随手就能用。我们的桥对象建好了，但除登录流程外**从来没人填值**：
     * content() 只 copy 了一个 chapterUrl，于是库里 449 个引用 book./chapter. 的源
     * 取到的是空串 —— 不报错，只是拼出来的请求地址和标题不对、脚本自己判空走进另一条分支。
     * 这里把书架与目录缓存里查得到的字段补上（查不到就维持原样，绝不编造）。
     */
    private fun readingContext(
        base: JsExecutionContext,
        sourceId: String?,
        bookUrl: String?,
        bookName: String?,
        chapterUrl: String?,
    ): JsExecutionContext {
        val withChapter = base.copy(chapterUrl = chapterUrl)
        val db = database ?: return withChapter
        if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank()) return withChapter
        val shelf = db.shelfBook(sourceId, bookUrl) ?: return withChapter
        val chapters = db.getTocCache(sourceId, shelf.tocUrl)
        val index = chapters?.indexOfFirst { it.url == chapterUrl }?.takeIf { it >= 0 }
        return withChapter.copy(
            bookUrl = bookUrl,
            bookName = bookName?.takeIf { it.isNotBlank() } ?: shelf.name,
            bookAuthor = shelf.author,
            bookTocUrl = shelf.tocUrl,
            chapterIndex = index ?: shelf.chapterIndex,
            chapterTitle = index?.let { chapters?.getOrNull(it)?.title },
        )
    }

    fun content(sourceJson: String, chapterUrl: String, bookName: String? = null, bookUrl: String? = null): ChapterContent {
        val source = sourceJson.objectValue()
        val sourceUrl = source.string("bookSourceUrl")
        val sourceName = source.string("bookSourceName")
        val replaceRules = database?.getEnabledReplaceRulesForScope(bookName, sourceUrl, sourceName).orEmpty()

        if (source.string("mainJs")?.isNotBlank() == true) {
            val result = JsSourceRunner(this, source).content(chapterUrl)
            if (replaceRules.isEmpty()) return result
            val cleanedTitle = result.title?.let { ContentProcessor.processTitle(it, replaceRules, jsSandbox, bookName) }
            val cleanedText = ContentProcessor.processContent(result.content, replaceRules, jsSandbox, bookName, result.title)
            return ChapterContent(cleanedTitle, cleanedText)
        }

        return jsSandbox.withSourceContext(
            readingContext(sourceContext(source, sourceUrl), sourceUrl, bookUrl, bookName, chapterUrl),
        ) {
            val rule = source.objectValue("ruleContent") ?: throw RuleExecutionException("该书源未配置 ruleContent")
            val contentRule = rule.string("content") ?: throw RuleExecutionException("缺少 ruleContent.content")
            val nextRule = rule.string("nextContentUrl").orEmpty().trim()
            val replaceRegex = rule.string("replaceRegex")
            // 不 trim 每条：`##正则##替换` 的替换串里前后空格是有意义的（上游也原样保留）
            val patterns = replaceRegex?.split(Regex("[\r\n]+|&&"))?.filter { it.isNotBlank() }.orEmpty()

            // 正文分页：`nextContentUrl` 非空的源实测 1,693 个，以前被整个忽略，长章只拿到第一页。
            // 与目录同一套走法：visited 回环守卫 + 页数上限，翻页文本按上游一样直接串接。
            val pageTexts = mutableListOf<String>()
            val queue = ArrayDeque(listOf(chapterUrl))
            val visited = mutableSetOf(chapterUrl)
            var firstRoot: NodeValue? = null
            var firstBody: String? = null
            while (queue.isNotEmpty() && pageTexts.size < MAX_CONTENT_PAGES) {
                val pageUrl = queue.removeFirst()
                val (root, body) = contentPage(source, sourceUrl, pageUrl)
                if (firstRoot == null) { firstRoot = root; firstBody = body }
                var pageText = root.value(contentRule, jsSandbox, body, pageUrl)?.preserveContentImages(pageUrl)?.cleanContent().orEmpty()
                if (pageText.length < 500) {
                    val paragraphs = Regex("(?i)<p[^>]*>([\\s\\S]*?)</p>").findAll(body)
                        .map { it.groupValues[1].cleanContent() }
                        .filter { it.length > 2 && !it.contains("按←键返回") && !it.contains("加入书签") && !it.contains("仅放置最近浏览") }
                        .toList()
                    if (paragraphs.size >= 5) {
                        val candidate = paragraphs.joinToString("\n\n")
                        if (candidate.length > pageText.length) pageText = candidate
                    }
                }
                for (entry in patterns) {
                    pageText = applyReplaceEntry(entry, pageText)
                }
                pageTexts += pageText
                if (nextRule.isNotEmpty()) {
                    root.value(nextRule, jsSandbox, body, pageUrl).orEmpty()
                        .lineSequence()
                        .map { it.trim() }
                        .filter { it.isNotEmpty() }
                        .map { it.absolute(pageUrl) }
                        .distinct()
                        .forEach { if (visited.add(it)) queue.addLast(it) }
                }
            }
            val root = firstRoot ?: throw RuleExecutionException("正文页取不到内容")
            var text = pageTexts.filter { it.isNotBlank() }.joinToString("\n\n")
            if (text.isBlank()) {
                val detail = jsSandbox.lastError?.let { "，脚本异常：$it" } ?: ""
                throw RuleExecutionException("正文规则未提取到内容$detail")
            }

            // subContent：原版「副文规则，拼接在正文后面」（歌词/副内容等），缺省不影响既有行为。
            val subRule = rule.string("subContent")?.trim()
            if (!subRule.isNullOrEmpty()) {
                val sub = root.value(subRule, jsSandbox, firstBody, chapterUrl)?.cleanContent().orEmpty()
                if (sub.isNotBlank()) text = if (text.isBlank()) sub else "$text\n\n$sub"
            }

            var title = root.value(rule.string("title"), jsSandbox, firstBody, chapterUrl)
            if (replaceRules.isNotEmpty()) {
                text = ContentProcessor.processContent(text, replaceRules, jsSandbox, bookName, title)
                if (title != null) {
                    title = ContentProcessor.processTitle(title, replaceRules, jsSandbox, bookName)
                }
            }
            ChapterContent(title, text)
        }
    }

    /** 取正文的一页，返回（可继续取值的根节点，原始响应体）。聚合源的 `data:` 章节地址由规则自己取回正文。 */
    private fun contentPage(source: JsonObject, sourceUrl: String?, pageUrl: String): Pair<NodeValue, String> {
        val dataPayload = dataUrlPayload(pageUrl)
        if (dataPayload != null) return NodeValue.json(dataPayload) to dataPayload
        val (url, options) = splitUrlOptions(pageUrl)
        val mergedOptions = mergeOptions(parseSourceHeaders(source, sourceUrl), options)
        val body = fetchUrl(url, mergedOptions, null, sourceUrl, database)
        return NodeValue.document(body) to body
    }

    fun parseLoginUi(sourceJson: String): List<SourceLoginUiItem> {
        val source = sourceJson.objectValue()
        val sourceUrl = source.string("bookSourceUrl") ?: ""
        val loginUiStr = source.string("loginUi")?.trim()
        val loginUrl = source.string("loginUrl")?.trim()
        val jsLib = source.string("jsLib")?.trim()

        if (loginUiStr.isNullOrBlank()) {
            if (!loginUrl.isNullOrBlank() && (loginUrl.startsWith("http://") || loginUrl.startsWith("https://"))) {
                return listOf(
                    SourceLoginUiItem(
                        name = "打开登录网页",
                        type = "button",
                        action = loginUrl,
                        style = FlexChildStyle(layout_flexBasisPercent = 1.0f),
                    ),
                )
            }
            return emptyList()
        }

        val rawJson = if (loginUiStr.startsWith("@js:") || loginUiStr.startsWith("js:") || loginUiStr.contains("<js>")) {
            val jsCode = if (loginUiStr.contains("<js>")) loginUiStr.substringAfter("<js>").substringBefore("</js>") else loginUiStr.removePrefix("@js:").removePrefix("js:")
            val execContext = sourceContext(source, sourceUrl)
                .copy(sourceName = source.string("bookSourceName") ?: sourceUrl)
            jsSandbox.eval(jsCode, mapOf("sourceId" to sourceUrl, "baseUrl" to sourceUrl), execContext) ?: "[]"
        } else {
            loginUiStr
        }

        return runCatching {
            json.decodeFromString<List<SourceLoginUiItem>>(rawJson)
        }.getOrElse { emptyList() }
    }

    fun executeLoginAction(
        sourceJson: String,
        actionCode: String,
        loginData: Map<String, String>,
        isLongClick: Boolean = false,
    ): SourceLoginActionResult {
        val source = sourceJson.objectValue()
        val sourceUrl = source.string("bookSourceUrl") ?: ""
        val sourceName = source.string("bookSourceName") ?: sourceUrl

        // 脚本库（jsLib + loginUrl 形式的 JS）由执行上下文统一注入，这里只拼动作本身
        val execContext = sourceContext(source, sourceUrl).copy(
            sourceName = sourceName,
            initialLoginInfo = loginData.toMutableMap(),
            isLongClick = isLongClick,
        )

        val trimmedAction = actionCode.trim()
        if (trimmedAction.startsWith("http://") || trimmedAction.startsWith("https://")) {
            return SourceLoginActionResult(
                success = true,
                openUrl = trimmedAction,
            )
        }

        val fullScript = if (trimmedAction.equals("login", ignoreCase = true) || trimmedAction.startsWith("login(")) {
            "if (typeof login === 'function') { login.apply(this); } else { $trimmedAction; }"
        } else {
            trimmedAction
        }

        val bindings = mapOf(
            "result" to loginData,
            "baseUrl" to sourceUrl,
            "sourceId" to sourceUrl,
            "bookSourceUrl" to sourceUrl,
            "isLongClick" to isLongClick,
        )

        jsSandbox.eval(fullScript, bindings, execContext)
        val state = database?.getSourceLoginState(sourceUrl)
        val failure = execContext.lastError

        return SourceLoginActionResult(
            success = failure == null,
            error = failure,
            toastMessages = execContext.toastMessages,
            openUrl = execContext.openUrl,
            copyText = execContext.copyText,
            updatedLoginInfo = execContext.initialLoginInfo.ifEmpty { state?.loginInfo ?: emptyMap() },
            updatedLoginHeader = state?.loginHeader,
            updatedVariable = state?.sourceVariable,
            reRenderUi = execContext.reRenderUi,
        )
    }

    fun checkLoginStatus(sourceJson: String): SourceLoginCheckResult {
        val source = sourceJson.objectValue()
        val sourceUrl = source.string("bookSourceUrl") ?: ""
        val loginCheckJs = source.string("loginCheckJs")?.trim()
        val loginUrl = source.string("loginUrl") ?: ""
        val jsLib = source.string("jsLib") ?: ""

        if (loginCheckJs.isNullOrBlank()) {
            val jar = database?.getSourceCookieJar(sourceUrl)
            val state = database?.getSourceLoginState(sourceUrl)
            val hasCookie = jar?.isNotEmpty() == true
            val hasInfo = state?.loginInfo?.isNotEmpty() == true
            val hasHeader = state?.loginHeader?.isNotEmpty() == true
            val hasCredential = hasCookie || hasInfo || hasHeader
            // 无 loginCheckJs 时只能"以有无凭据"判断，无法真正验证登录是否有效；
            // 保持 loggedIn 的既有语义（有凭据即视为可用，兼容测试），但如实标注未验证。
            return SourceLoginCheckResult(
                loggedIn = hasCredential,
                hasCredential = hasCredential,
                verified = false,
                message = if (hasCredential) "已捕获登录凭据（未能自动验证有效性）" else "未登录",
            )
        }

        val execContext = sourceContext(source, sourceUrl)
        val result = jsSandbox.eval(loginCheckJs, mapOf("sourceId" to sourceUrl, "baseUrl" to sourceUrl), execContext)?.trim()
        val isSuccess = result == "true" || (result != null && result.isNotBlank() && result != "false" && result != "0" && !result.contains("未登录"))
        val jar = database?.getSourceCookieJar(sourceUrl)
        val state = database?.getSourceLoginState(sourceUrl)
        val hasCredential = isSuccess || jar?.isNotEmpty() == true || state?.loginInfo?.isNotEmpty() == true || state?.loginHeader?.isNotEmpty() == true
        return SourceLoginCheckResult(
            loggedIn = isSuccess,
            hasCredential = hasCredential,
            verified = isSuccess,
            message = if (isSuccess) "登录态已验证" else (result ?: "未登录"),
        )
    }

    internal fun fetch(url: String, sourceId: String? = null, database: Database? = null): String {
        val (cleanUrl, options) = splitUrlOptions(url)
        val db = database ?: this.database
        val mergedOptions = if (db != null && !sourceId.isNullOrBlank()) {
            val headers = mutableMapOf<String, String>()
            val state = db.getSourceLoginState(sourceId)
            state?.loginHeader?.takeIf { it.isNotBlank() }?.let { h ->
                runCatching {
                    val elem = Json.parseToJsonElement(h)
                    if (elem is JsonObject) {
                        elem.entries.filter { it.value is JsonPrimitive }.forEach {
                            headers[it.key] = (it.value as JsonPrimitive).contentOrNull ?: ""
                        }
                    }
                }
            }
            val cookie = db.getSourceCookie(sourceId, cleanUrl)
            if (!cookie.isNullOrBlank()) {
                headers["Cookie"] = cookie
            }
            mergeOptions(headers, options)
        } else {
            options
        }
        return fetchUrl(cleanUrl, mergedOptions, null, sourceId, db)
    }

    private fun parseSourceHeaders(source: JsonObject, sourceUrl: String? = null): Map<String, String> {
        val headers = mutableMapOf<String, String>()
        val headerStr = source.string("header")?.trim()
        if (!headerStr.isNullOrBlank()) {
            runCatching {
                val elem = Json.parseToJsonElement(headerStr)
                if (elem is JsonObject) {
                    elem.entries.filter { it.value is JsonPrimitive }.forEach {
                        headers[it.key] = (it.value as JsonPrimitive).contentOrNull ?: ""
                    }
                }
            }
        }
        val sUrl = sourceUrl ?: source.string("bookSourceUrl")
        val db = database
        if (db != null && !sUrl.isNullOrBlank()) {
            val state = db.getSourceLoginState(sUrl)
            state?.loginHeader?.takeIf { it.isNotBlank() }?.let { h ->
                runCatching {
                    val elem = Json.parseToJsonElement(h)
                    if (elem is JsonObject) {
                        elem.entries.filter { it.value is JsonPrimitive }.forEach {
                            headers[it.key] = (it.value as JsonPrimitive).contentOrNull ?: ""
                        }
                    }
                }
            }
            val cookie = db.getSourceCookie(sUrl, sUrl)
            if (!cookie.isNullOrBlank()) {
                headers["Cookie"] = cookie
            }
        }
        return headers
    }

    private fun mergeOptions(sourceHeaders: Map<String, String>, options: UrlOptions?): UrlOptions {
        if (sourceHeaders.isEmpty()) return options ?: UrlOptions()
        val combined = sourceHeaders.toMutableMap()
        options?.headers?.let { combined.putAll(it) }
        return (options ?: UrlOptions()).copy(headers = combined)
    }

    internal data class UrlOptions(
        val method: String = "GET",
        val body: String? = null,
        val headers: Map<String, String> = emptyMap(),
        val charset: Charset = Charsets.UTF_8,
        /** 上游 `UrlOption.useWebView()`：非 false/空即视为要用 WebView 取渲染后的 HTML。服务端抓不到，但要如实标出来。 */
        val webView: Boolean = false,
    )

    /**
     * 切出 URL 尾巴上的 `,{options}`。
     *
     * 上游语义（`AnalyzeUrl.kt:253-259`）：先严格 JSON，失败退回宽松 JSON 并提示「格式不规范」；
     * **两种都解析不出来时，URL 仍然要用去掉尾巴的那一段**（`urlNoOption`），而不是把 `,{...}` 一起当地址发出去。
     * 我们原来只在严格解析成功时才摘尾巴，失败就整串当 URL —— 直接报「URL 格式无效或包含未解析变量」，
     * 库内实测这种写法有 1,571 处（单引号键值、裸键、全角引号、字符串里裸换行、尾随逗号）。
     */
    internal fun splitUrlOptions(value: String): Pair<String, UrlOptions?> {
        val (urlPart, tail) = LooseJson.extractTail(value)
        if (tail == null) return value to null
        val strict = jsonOption(tail)
        val options = strict ?: jsonOption(LooseJson.toStrict(tail) ?: return urlPart to null) ?: return urlPart to null
        if (strict == null) System.getLogger("RuleRunner").log(
            System.Logger.Level.INFO,
            "书源链接参数 JSON 格式不规范，已按宽松模式解析: {0}", tail.take(160)
        )

        val method = (options.string("method") ?: "GET").trim().uppercase()
        return urlPart to UrlOptions(
            method = if (method == "POST" || method == "HEAD") method else "GET",
            // body 写成对象/数组时要序列化回 JSON 文本（上游 `UrlOption.getBody()` = `GSON.toJson(it)`），
            // 原来用 string() 取，对象直接被丢掉 → POST 变成空 body。
            body = when (val raw = options["body"]) {
                null -> null
                is JsonPrimitive -> raw.contentOrNull
                else -> raw.toString()
            },
            headers = headerMapOf(options["headers"]),
            charset = runCatching { Charset.forName(options.string("charset") ?: "UTF-8") }.getOrDefault(Charsets.UTF_8),
            webView = when (val raw = options["webView"]) {
                null, JsonNull -> false
                is JsonPrimitive -> raw.contentOrNull?.trim()?.lowercase()?.let { it.isNotEmpty() && it != "false" } ?: false
                else -> true
            },
        )
    }

    private fun jsonOption(text: String): JsonObject? =
        runCatching { Json.parseToJsonElement(text.trim()) as? JsonObject }.getOrNull()

    /** `headers` 既可能是对象，也可能是一整串 JSON（甚至单引号写的），上游两种都接。 */
    private fun headerMapOf(element: JsonElement?): Map<String, String> {
        val source = when (element) {
            is JsonObject -> element
            is JsonPrimitive -> element.contentOrNull?.let { jsonOption(it) ?: jsonOption(LooseJson.toStrict(it) ?: return emptyMap()) }
            else -> null
        } ?: return emptyMap()
        return source.entries.associate { (key, value) ->
            key to when (value) {
                is JsonPrimitive -> value.content
                else -> value.toString()
            }
        }
    }

    private fun parseUri(url: String): URI {
        val trimmed = url.trim()
        if (!trimmed.startsWith("http://", ignoreCase = true) && !trimmed.startsWith("https://", ignoreCase = true)) {
            throw RuleExecutionException("URL 格式无效或包含未解析变量: $url")
        }
        // Legado 书源普遍把未转义的 JSON（含 { } " 等）直接拼进 query，Android 端 OkHttp 会自动编码，
        // 而 java.net.URI 严格按 RFC 3986 拒绝。这里先按原样解析，失败再对非法字符做百分号编码。
        runCatching { URI(trimmed) }.getOrNull()?.let { return it }
        val encoded = encodeIllegalUrlChars(trimmed)
        return runCatching { URI(encoded) }.getOrElse {
            throw RuleExecutionException("URL 解析失败: $url (${it.message})")
        }
    }

    /** 对 URL 中 RFC 不允许的字面字符做百分号编码。 */
    private fun encodeIllegalUrlChars(url: String): String {
        val builder = StringBuilder(url.length + 16)
        for (ch in url) {
            when {
                ch == ' ' -> builder.append("%20")
                ch.code > 127 || ch in "\"<>{}|\\^`" -> builder.append(URLEncoder.encode(ch.toString(), Charsets.UTF_8))
                else -> builder.append(ch)
            }
        }
        return builder.toString()
    }

    private fun fetchUrl(
        url: String,
        options: UrlOptions?,
        keyword: String?,
        sourceId: String? = null,
        database: Database? = null,
    ): String {
        responseFetcher?.let { return it(url) }
        val db = database ?: this.database
        var request = buildRequest(parseUri(url), options, keyword)
        // 首次连接偶发失败（连接复用/握手抖动）时重试一次：书源 JS 常在内部 try/catch 吞掉 ajax 异常，
        // 不重试会表现为「规则执行成功但内容为空」这类极难排查的现象。
        var transientAttempt = 0
        repeat(4) {
            val response = try {
                client.send(request, HttpResponse.BodyHandlers.ofInputStream())
            } catch (error: java.io.IOException) {
                if (transientAttempt == 0) {
                    transientAttempt++
                    client.send(request, HttpResponse.BodyHandlers.ofInputStream())
                } else {
                    throw error
                }
            }
            val setCookies = response.headers().allValues("set-cookie")
            if (setCookies.isNotEmpty() && db != null && !sourceId.isNullOrBlank()) {
                // 用「当前这一跳」的地址归档：重定向后落地的域名与入口域名可以完全不同，
                // 按入口地址存会把 A 站的 Cookie 发给 B 站。
                val cookieUrl = request.uri().toString()
                setCookies.forEach { cookieStr ->
                    db.setSourceCookieFromSetCookie(sourceId, cookieUrl, cookieStr)
                }
            }
            if (response.statusCode() !in 300..399) {
                if (response.statusCode() !in 200..299) {
                    runCatching { response.body().close() }
                    throw RuleExecutionException("上游返回 HTTP ${response.statusCode()}")
                }
                val bytes = response.body().use { readLimited(it) }
                if (bytes.size > MAX_BODY_BYTES) throw RuleExecutionException("上游响应超过 2 MiB 限制")
                val charset = (options?.charset) ?: Charsets.UTF_8
                return decodeBody(bytes, response.headers().firstValue("content-encoding").orElse(""), charset)
            }
            runCatching { response.body().close() }
            val location = response.headers().firstValue("location").orElseThrow { RuleExecutionException("重定向缺少 Location") }
            val redirect = request.uri().resolve(location); validateTarget(redirect)
            request = buildRequest(redirect, options, keyword)
        }
        throw RuleExecutionException("重定向次数超过限制")
    }

    private fun buildRequest(initial: URI, options: UrlOptions?, keyword: String?): HttpRequest {
        validateTarget(initial)
        val builder = HttpRequest.newBuilder(initial)
            .timeout(Duration.ofSeconds(20))
            .header("User-Agent", "LegadoServer/0.1")
            .header("Accept-Encoding", "gzip, deflate")
        options?.headers?.forEach { (name, value) -> builder.header(name, value) }
        val method = options?.method?.uppercase() ?: "GET"
        val body = options?.body
        if (method != "GET" && body != null) {
            val rendered = keyword?.let { renderUrl(body, it, initial.toString()) } ?: body
            builder.method(method, HttpRequest.BodyPublishers.ofString(rendered, options?.charset ?: Charsets.UTF_8))
        } else {
            builder.method(method, HttpRequest.BodyPublishers.noBody())
        }
        return builder.build()
    }

    private fun decodeBody(bytes: ByteArray, contentEncoding: String, charset: Charset): String {
        val encoding = contentEncoding.lowercase()
        val decoded = when {
            encoding.contains("gzip") -> GZIPInputStream(bytes.inputStream()).use(::readAll)
            encoding.contains("deflate") -> InflaterInputStream(bytes.inputStream()).use(::readAll)
            else -> bytes
        }
        return decoded.toString(charset)
    }

    private fun readAll(input: InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) return output.toByteArray()
            output.write(buffer, 0, count)
            // 2 MiB 上限原本只卡在压缩字节上：一个 gzip 炸弹就能在解压时无限膨胀直接把进程顶爆。
            if (output.size() > MAX_BODY_BYTES) throw RuleExecutionException("响应解压后超过 2 MiB 限制")
        }
    }

    private fun readLimited(input: InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) return output.toByteArray()
            require(output.size() + count <= MAX_BODY_BYTES) { "上游响应超过 2 MiB 限制" }
            output.write(buffer, 0, count)
        }
    }

    private fun validateTarget(uri: URI) {
        try {
            NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "书源")
        } catch (e: IllegalArgumentException) {
            throw RuleExecutionException(e.message ?: "拒绝访问内网或本机地址")
        }
    }

    private fun renderUrl(template: String, keyword: String, sourceUrl: String, page: Int = 1): String {
        val literals = template
            .replace("{{key}}", URLEncoder.encode(keyword, Charsets.UTF_8))
            .replace("{{keyword}}", URLEncoder.encode(keyword, Charsets.UTF_8))
            .replace("{{page}}", page.toString())
            .replace("<key>", URLEncoder.encode(keyword, Charsets.UTF_8))
            .replace("{{source.key}}", URLEncoder.encode(keyword, Charsets.UTF_8))
            .replace("{{source.bookSourceUrl}}", sourceUrl)
            .replace("{{cookie.removeCookie(source.key)}}", "")
        // Legado 把地址里剩下的 `{{…}}` 当 JS 表达式求值（`{{(page-1)*20}}`、`{{java.getDict(…)}}`、
        // `{{url=source.getKey();cookie.removeCookie(url)}}`）。只认固定字面量的话整串会被当成网址，
        // 这类书源就永远搜不到东西。求值失败的占位符原样保留，免得把网址悄悄改坏。
        val context = jsSandbox.threadContext.get()
        return URL_VARIABLE_PATTERN.replace(literals) { match ->
            context?.lastError = null
            val value = runCatching {
                jsSandbox.eval(match.groupValues[1], mapOf(
                    "key" to keyword,
                    "keyword" to keyword,
                    "page" to page,
                    "baseUrl" to sourceUrl,
                    "sourceId" to sourceUrl,
                ))
            }.getOrNull()
            when {
                context?.lastError != null -> match.value
                value == null || value == "undefined" || value == "null" -> ""
                else -> trimJsNumberFraction(value.trim())
            }
        }
    }

    /** Rhino 里所有数字都是 double，`{{(page-1)*20}}` 会求值成 `0.0`；网址里必须是 `0`。 */
    private fun trimJsNumberFraction(text: String): String =
        if (Regex("""-?\d+\.0+""").matches(text)) text.substringBefore('.') else text

    private fun nodes(body: String, rule: String): List<NodeValue> {
        // @xpath 方言优先：xpath 里的 `|` 并集不能被当成 Legado 的 `||` 备选来切分
        if (isXpathRule(rule)) return xpathNodes(Jsoup.parse(body), stripXpathPrefix(rule))
        // @json: 前缀（对齐原版 ruleStr.startsWith("@Json:")）：去前缀后按 JSONPath 读列表
        if (isJsonPrefixedRule(rule)) {
            val path = stripJsonPrefix(rule)
            return runCatching { (JsonPath.read<Any>(body, path) as? List<*>)?.map { NodeValue.json(it) } ?: emptyList() }.getOrDefault(emptyList())
        }
        val alternatives = splitLegadoAlternatives(rule)
        if (alternatives.size > 1) {
            return alternatives.firstNotNullOfOrNull { branch -> nodes(body, branch).ifEmpty { null } } ?: emptyList()
        }
        return when {
            rule.startsWith("$") -> (JsonPath.read<Any>(body, rule) as? List<*>)?.map { NodeValue.json(it) } ?: emptyList()
            else -> {
                val (base, ops) = splitIndexSuffix(rule)
                val selected = Jsoup.parse(body).select(base.css()).map(NodeValue::html)
                if (ops.isEmpty()) selected else applyIndexTokens(selected, ops)
            }
        }
    }

    private fun String.css(): String {
        val clean = removePrefix("@css:").trim()
        val parts = clean.split("@")
        val cssParts = mutableListOf<String>()
        for (part in parts) {
            val trimmed = part.trim()
            if (trimmed.isEmpty()) continue
            if (trimmed in setOf("text", "href", "src", "content", "html", "textNodes", "textNode")) break
            if (trimmed.startsWith("attr(") || trimmed.startsWith("text(") || trimmed.startsWith("all")) break
            if (trimmed.startsWith("class.")) {
                val cls = trimmed.removePrefix("class.")
                if ("." in cls) {
                    val (cName, idxStr) = cls.split(".", limit = 2)
                    val idx = idxStr.toIntOrNull()
                    if (idx != null) cssParts.add(".$cName:nth-of-type(${idx + 1})") else cssParts.add(".$cls")
                } else {
                    cssParts.add(".$cls")
                }
            } else if (trimmed.matches(Regex("^[a-zA-Z0-9-]+\\.\\d+$"))) {
                val (tag, idxStr) = trimmed.split(".", limit = 2)
                val idx = idxStr.toIntOrNull()
                if (idx != null) cssParts.add("$tag:nth-of-type(${idx + 1})") else cssParts.add(trimmed)
            } else {
                cssParts.add(trimmed)
            }
        }
        return if (cssParts.isEmpty()) clean else cssParts.joinToString(" ")
    }
    /**
     * `cleanContent()` 会把所有标签抹掉，正文配图因此整张消失（上游是用 ImageGetter 渲染的）。
     * 先把 `<img>` 换成 `![图片](绝对地址)` 占位行，前端按行还原成 `<img>` —— 这样在线读、
     * 离线缓存、净化管道、TTS 走的仍然是同一条字符串链路，不用为图片另开一套数据结构。
     * 懒加载源普遍写 `data-src`/`data-original`，一并认。`data:` 内联图会撑爆缓存，丢掉。
     */
    private fun String.preserveContentImages(pageUrl: String): String =
        Regex("(?i)<img[^>]*?(?:data-original|data-src|src)\\s*=\\s*[\"']?([^\"'\\s>]+)").replace(this) { match ->
            val src = match.groupValues[1]
            if (src.startsWith("data:", ignoreCase = true)) "" else "\n![图片](${src.absolute(pageUrl)})\n"
        }

    private fun String.cleanContent(): String = this        .replace(Regex("(?i)<script[\\s\\S]*?</script>"), "")
        .replace(Regex("(?i)<style[\\s\\S]*?</style>"), "")
        .replace(Regex("(?i)<div[\\s\\S]*?</div>"), "")
        .replace(Regex("(?i)<br\\s*/?>"), "\n")
        .replace(Regex("(?i)</?p[^>]*>"), "\n")
        .replace(Regex("<[^>]+>"), "")
        .let { org.jsoup.parser.Parser.unescapeEntities(it, false) }
        .lines()
        .map { it.trim() }
        .filter { it.isNotBlank() }
        .joinToString("\n\n")
    private fun String.absolute(base: String): String = try {
        val cleanBase = base.substringBefore("##").substringBefore("#").trim()
        if (cleanBase.startsWith("http://", ignoreCase = true) || cleanBase.startsWith("https://", ignoreCase = true)) {
            URI(cleanBase).resolve(this).toString()
        } else {
            this
        }
    } catch (_: Exception) { this }
    private fun String.objectValue(): JsonObject = json.parseToJsonElement(this).jsonObject
    private fun JsonObject.objectValue(key: String): JsonObject? = get(key)?.jsonObject
    private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull
    private companion object {
        const val MAX_BODY_BYTES = 2 * 1024 * 1024
        private const val MAX_TRACE_CHARS = 240
        val URL_VARIABLE_PATTERN = Regex("\\{\\{(.+?)}}")

        /**
         * 续取页数上限。上游只靠 visited 集合防回环，服务端替用户发请求，
         * 需要一层硬上限，否则一条坏规则能把开书变成一次爬站。
         */
        const val MAX_TOC_PAGES = 40
        const val MAX_CONTENT_PAGES = 30
    }
}

private class JsSourceRunner(private val runner: RuleRunner, private val source: JsonObject) {
    private val script = source.string("mainJs") ?: error("mainJs 缺失")

    fun search(keyword: String): List<SearchResult> = call("search", arrayOf(keyword, 1)).jsonArray().mapNotNull { value ->
        val book = Json.parseToJsonElement(value).jsonObject
        val url = book.string("bookUrl") ?: return@mapNotNull null
        SearchResult(source.string("bookSourceUrl")!!, book.string("name") ?: return@mapNotNull null, book.string("author"), url, book.string("coverUrl"), book.string("intro"))
    }
    fun details(bookUrl: String): BookDetails {
        val value = callOptional("getBookInfo", arrayOf(bookObject(bookUrl)))?.jsonObjectOrEmpty() ?: JsonObject(emptyMap())
        val name = value.string("name")?.trim().orEmpty()
        return BookDetails(source.string("bookSourceUrl")!!, name.ifBlank { "未命名书籍" }, value.string("author"), value.string("intro"), value.string("coverUrl"), value.string("tocUrl") ?: bookUrl)
    }
    fun chapters(tocUrl: String): List<Chapter> = call("getChapters", arrayOf(bookObject(tocUrl))).jsonArray().mapIndexedNotNull { index, value ->
        val chapter = Json.parseToJsonElement(value).jsonObject; val url = chapter.string("url") ?: return@mapIndexedNotNull null; Chapter(index, chapter.string("title") ?: "第 ${index + 1} 章", url)
    }
    fun content(chapterUrl: String): ChapterContent = ChapterContent(content = call("getContent", arrayOf(chapterObject(chapterUrl), bookObject(""), null)).trim().also { if (it.isBlank()) throw RuleExecutionException("JS书源正文为空") })

    private fun call(name: String, args: Array<Any?>): String = callOptional(name, args) ?: throw RuleExecutionException("JS书源缺少函数 $name")
    private fun callOptional(name: String, args: Array<Any?>): String? {
        val context = Context.enter()
        try {
            context.optimizationLevel = -1; context.setClassShutter(ClassShutter { false })
            val scope = context.initSafeStandardObjects()
            ScriptableObject.putProperty(scope, "java", ajaxFunction(scope))
            context.evaluateString(scope, script, "source.js", 1, null)
            val function = ScriptableObject.getProperty(scope, name) as? Function ?: return null
            val raw = function.call(context, scope, scope, args.map { toJsValue(it, scope) }.toTypedArray())
            if (raw == null || raw == Context.getUndefinedValue()) return null
            if (raw is CharSequence) return raw.toString()
            return NativeJSON.stringify(context, scope, raw, null, null).toString()
        } catch (error: RuleExecutionException) { throw error }
        catch (error: Exception) { throw RuleExecutionException("JS书源 $name 执行失败: ${error.message}") }
        finally { Context.exit() }
    }
    private fun ajaxFunction(scope: Scriptable): NativeObject = NativeObject().also { api ->
        api.parentScope = scope
        ScriptableObject.putProperty(api, "ajax", object : BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any = runner.fetch(args.firstOrNull()?.toString() ?: throw RuleExecutionException("ajax 缺少 URL"))
        })
    }
    private fun toJsValue(value: Any?, scope: Scriptable): Any? = when (value) {
        is Map<*, *> -> NativeObject().also { objectValue ->
            objectValue.parentScope = scope
            value.forEach { (key, item) -> if (key is String) ScriptableObject.putProperty(objectValue, key, toJsValue(item, scope)) }
        }
        is List<*> -> Context.getCurrentContext().newArray(scope, value.map { toJsValue(it, scope) }.toTypedArray())
        else -> Context.javaToJS(value, scope)
    }
    private fun bookObject(url: String) = mapOf("bookUrl" to url, "tocUrl" to url)
    private fun chapterObject(url: String) = mapOf("url" to url)
    private fun String.jsonArray(): List<String> = (Json.parseToJsonElement(this) as? JsonArray)?.map { it.toString() } ?: throw RuleExecutionException("JS书源返回值必须是数组")
    private fun String.jsonObjectOrEmpty(): JsonObject = runCatching { Json.parseToJsonElement(this).jsonObject }.getOrDefault(JsonObject(emptyMap()))
    private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull
}

class RuleExecutionException(message: String) : RuntimeException(message)

/** 调试链路里的一条规则追溯：字段、规则原文、取到的值，以及取不到时的原因。 */
@Serializable
data class DebugTrace(
    val field: String,
    val rule: String,
    val value: String,
    val failure: String = "",
)

// ---------------------------------------------------------------- @xpath 方言（JsoupXpath）

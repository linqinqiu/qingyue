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
            val collected = LinkedHashMap<String, String>()
            val queue = ArrayDeque(listOf(tocUrl))
            val visited = mutableSetOf(tocUrl)
            var pages = 0
            while (queue.isNotEmpty() && pages < MAX_TOC_PAGES) {
                val pageUrl = queue.removeFirst()
                val (pageChapters, nextUrls) = parseTocPage(source, sourceUrl, rule, listRule, nextRule, pageUrl)
                pageChapters.forEach { (name, url) -> collected.putIfAbsent(url, name) }
                nextUrls.forEach { if (visited.add(it)) queue.addLast(it) }
                pages++
            }
            val ordered = if (reverse) collected.entries.reversed() else collected.entries.toList()
            // collected 的键是章节地址（去重靠它）、值是标题，解构顺序别写反。
            ordered.mapIndexed { index, (url, name) -> Chapter(index, name.ifBlank { "第 ${index + 1} 章" }, url) }
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
    ): Pair<List<Pair<String, String>>, List<String>> {
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
        val items = chapterNodes.mapNotNull { node ->
            val chapterHref = node.value(rule.string("chapterUrl"), jsSandbox, body, pageUrl)?.absolute(pageUrl) ?: return@mapNotNull null
            node.value(rule.string("chapterName"), jsSandbox, body, pageUrl).orEmpty() to chapterHref
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

    fun content(sourceJson: String, chapterUrl: String, bookName: String? = null): ChapterContent {
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
            sourceContext(source, sourceUrl).let { it.copy(chapterUrl = chapterUrl) },
        ) {
            val rule = source.objectValue("ruleContent") ?: throw RuleExecutionException("该书源未配置 ruleContent")
            val contentRule = rule.string("content") ?: throw RuleExecutionException("缺少 ruleContent.content")
            val nextRule = rule.string("nextContentUrl").orEmpty().trim()
            val replaceRegex = rule.string("replaceRegex")
            val patterns = replaceRegex?.split(Regex("[\r\n]+|&&"))?.map { it.trim() }?.filter { it.isNotBlank() }.orEmpty()

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
                for (pattern in patterns) {
                    pageText = runCatching { pageText.replace(Regex(pattern), "") }.getOrDefault(pageText)
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
        val alternatives = splitLegadoAlternatives(rule)
        if (alternatives.size > 1) {
            return alternatives.firstNotNullOfOrNull { branch -> nodes(body, branch).ifEmpty { null } } ?: emptyList()
        }
        return when {
            rule.startsWith("$") -> (JsonPath.read<Any>(body, rule) as? List<*>)?.map { NodeValue.json(it) } ?: emptyList()
            else -> Jsoup.parse(body).select(rule.css()).map(NodeValue::html)
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
            if ("!" in trimmed) {
                val (tag, notIndex) = trimmed.split("!", limit = 2)
                val idx = notIndex.toIntOrNull()
                if (idx != null) {
                    cssParts.add("$tag:not(:nth-child(${idx + 1}))")
                } else {
                    cssParts.add(tag)
                }
            } else if (trimmed.startsWith("class.")) {
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

/**
 * 切分 Legado 的 `a||b||c` 备选规则，只在 `{{…}}` 之外切：
 * `{{$.book_id||$.BookID}}` 里的 `||` 属于占位符内部的路径备选，不能当外层分支。
 */
internal fun splitLegadoAlternatives(rule: String): List<String> {
    val (separator, parts) = splitLegadoBranches(rule)
    return if (separator == "||") parts else listOf(rule.trim()).filter { it.isNotEmpty() }
}

/**
 * Legado 的分支规则：`||` 取第一个有结果的分支，`&&` 把所有分支的结果拼接起来。
 * 依据上游 `RuleAnalyzer.splitRule("&&","||","%%")`：**无优先级、最左边的分隔符说了算**，
 * 并且切分要跳过 `{{…}}`、`[…]`（JSONPath 过滤谓词里本来就带 `&&`/`||`）、引号与 `##正则##` 段，
 * 否则 `$.book[?(@.price<10 && @.cat=="x")]` 会被从中间劈开。
 */
internal fun splitLegadoBranches(rule: String): Pair<String?, List<String>> {
    val separators = topLevelSeparators(rule)
    val separator = separators.firstOrNull()?.second ?: return null to listOf(rule.trim()).filter { it.isNotEmpty() }
    val parts = mutableListOf<String>()
    var start = 0
    for ((index, token) in separators.filter { it.second == separator }) {
        parts += rule.substring(start, index)
        start = index + token.length
    }
    parts += rule.substring(start)
    return separator to parts.map { it.trim() }.filter { it.isNotEmpty() }
}

private fun topLevelSeparators(rule: String): List<Pair<Int, String>> {
    val found = mutableListOf<Pair<Int, String>>()
    var depth = 0
    var quote: Char? = null
    var index = 0
    while (index < rule.length) {
        val ch = rule[index]
        when {
            quote != null -> if (ch == quote) quote = null
            ch == '\'' || ch == '"' -> quote = ch
            ch == '{' || ch == '[' -> depth++
            ch == '}' || ch == ']' -> depth = (depth - 1).coerceAtLeast(0)
            ch == '#' && rule.startsWith("##", index) -> {
                val end = rule.indexOf("##", index + 2)
                index = if (end < 0) rule.length else end + 1
            }
            depth == 0 && rule.startsWith("||", index) -> { found += index to "||"; index++ }
            depth == 0 && rule.startsWith("&&", index) -> { found += index to "&&"; index++ }
        }
        index++
    }
    return found
}

/**
 * 在 `{{…}}` 之外找内联 JS 分隔符，返回「位置 + 分隔符长度」。
 * 行首的 `@js:` 由调用方先行处理，所以只认下标 > 0 的情况。
 */
internal fun findInlineJsMarker(rule: String): Pair<Int, Int>? {
    var depth = 0
    var index = 0
    while (index < rule.length) {
        when (val ch = rule[index]) {
            '{' -> depth++
            '}' -> depth = (depth - 1).coerceAtLeast(0)
            '@' -> if (depth == 0 && rule.startsWith("@js:", index)) return index to 4
            'j' -> if (depth == 0 && rule.startsWith("js:", index) &&
                (index == 0 || rule[index - 1] == ' ' || rule[index - 1] == '\n')
            ) return index to 3
        }
        index++
    }
    return null
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

internal class NodeValue private constructor(private val html: Element?, private val json: Any?) {
    private val ruleVariables = mutableMapOf<String, String>()

    fun value(rule: String?, jsSandbox: JsSandbox? = null, rawBody: String? = null, baseUrl: String? = null): String? {
        if (rule.isNullOrBlank()) return null
        var trimmedRule = rule.trim()

        // `@put:{key:规则}` 求值后存进变量表并从规则串里剔除，`@get:{key}` 再取回。
        // 上游把这张表挂在 ruleData 上，所以同一个 `name` 里 put、`tocUrl` 里 get 是合法的，
        // 变量表必须跟着「本次解析的节点」走，而不是单次 value() 调用。
        trimmedRule = storePutVariables(trimmedRule, jsSandbox, rawBody, baseUrl)
        trimmedRule = substituteGetVariables(trimmedRule)
        if (trimmedRule.isBlank()) return null

        // Legado 的 `规则1||规则2||…` 备选语法：返回第一个取到值的分支。聚合源的字段规则几乎人人都写，
        // 不支持就等于整条记录被 mapNotNull 丢掉，表现为「搜索完成：0 项」而不是报错。
        // 只在花括号外层切，`{{$.book_id||$.BookID}}` 里的 `||` 属于内层路径的备选。
        // 有内联 `@js:` 时更要跳过：JS 里的 `a || b` 是代码，不是分支，切开会破坏整段脚本。
        val inlineJs = findInlineJsMarker(trimmedRule)
        val (branchSeparator, branches) = splitLegadoBranches(trimmedRule)
        if (branches.size > 1 && inlineJs == null &&
            !trimmedRule.contains("<js>") && !trimmedRule.startsWith("@js:") && !trimmedRule.startsWith("js:")
        ) {
            val evaluated = branches.mapNotNull { branch ->
                value(branch, jsSandbox, rawBody, baseUrl)?.takeIf { it.isNotBlank() }
            }
            // `&&` 是「并且」：每个分支都要取值再拼接；`||` 只要第一个非空。
            return if (branchSeparator == "&&") evaluated.joinToString("\n").takeIf { it.isNotBlank() } else evaluated.firstOrNull()
        }

        if (trimmedRule.contains("{{") && trimmedRule.contains("}}")) {
            trimmedRule = Regex("\\{\\{(.*?)}}").replace(trimmedRule) { match ->
                // 只去前导空白：`{{$.t##T|\+.*## }}` 的替换串就是那个空格，整串 trim 会把时间粘成 `2023-09-0100:00:33`。
                val inner = match.groupValues[1].trimStart()
                if (inner.isBlank()) return@replace ""
                // 先查 `@put:` 存下的变量（上游 `{{}}` 与 `@get:{}` 是同一条正则匹配的）
                ruleVariables[inner.trim()]?.let { return@replace it }
                // 花括号里既可能写取值路径，也可能写一整段 JS（`{{java.timeFormat(...)}}`）。
                // 只认 `$` 开头的话，实测语料里 1800 余行规则会被渲染成空白。
                if (isJsExpression(inner)) evaluateJs(jsSandbox, inner.trim(), rawBody, baseUrl) ?: ""
                else if (!inner.contains("||")) runCatching { valuePlain(inner) }.getOrNull() ?: ""
                else splitLegadoAlternatives(inner).firstNotNullOfOrNull { branch ->
                    runCatching { valuePlain(branch) }.getOrNull()?.takeIf { it.isNotBlank() }
                } ?: ""
            }
        }

        if (trimmedRule.startsWith("@js:") || trimmedRule.startsWith("js:")) {
            val jsCode = trimmedRule.removePrefix("@js:").removePrefix("js:").trim()
            return evaluateJs(jsSandbox, jsCode, rawBody, baseUrl) ?: documentText().ifBlank { rawBody ?: "" }
        }

        // Legado 允许「文字模板 + @js: 代码」：前段先求值成字符串，作为 result 交给后段 JS 收尾。
        // 番茄一类聚合源用它把 `__status__` 这类占位词替换成「连载/完结」，不认的话源码会直接漏进简介。
        val marker = if (trimmedRule.contains("<js>")) null else findInlineJsMarker(trimmedRule)
        if (marker != null) {
            val preRule = trimmedRule.substring(0, marker.first).trim()
            val jsCode = trimmedRule.substring(marker.first + marker.second).trim()
            val base = value(preRule, jsSandbox, rawBody, baseUrl) ?: ""
            if (jsCode.isBlank()) return base
            val src = rawBody ?: base
            return jsSandbox?.eval(jsCode, mapOf("result" to base, "src" to src, "baseUrl" to (baseUrl ?: ""))) ?: base
        }

        if (trimmedRule.contains("<js>") && trimmedRule.contains("</js>")) {
            val preRule = trimmedRule.substringBefore("<js>").trim()
            val jsCode = trimmedRule.substringAfter("<js>").substringBefore("</js>").trim()
            val postRule = trimmedRule.substringAfter("</js>").trim()
            // 无前缀时 result 就是当前条目本身。JSON 条目必须按**对象**传入（沙箱会把 Map 转成 JS 对象），
            // 若按 toString 传，书源里的 result.book_id 之类属性访问全部取不到值，条目会被整条丢弃。
            val intermediate: Any? = if (preRule.isNotBlank()) valuePlain(preRule) ?: ""
            else html?.html() ?: json ?: rawBody ?: ""
            val evaluated = jsSandbox?.eval(
                jsCode,
                mapOf("result" to intermediate, "src" to (rawBody ?: intermediate), "baseUrl" to (baseUrl ?: "")),
            ) ?: (intermediate as? String ?: intermediate?.toString() ?: "")
            if (postRule.isBlank()) return evaluated
            // Legado 规则链：`<js>…</js>` 之后可以再接取值路径（如 `$.data` 或 CSS 选择器），
            // 把 JS 的返回值当作新文档继续取值。聚合源大量使用这种写法。
            return NodeValue.document(evaluated).value(postRule, jsSandbox, evaluated, baseUrl)
        }

        return valuePlain(trimmedRule)
    }

    private fun documentText(): String = html?.html() ?: json?.toString() ?: ""

    /** `@put:{k:rule}`：求值存表并吃掉这段；正则形状与上游 `AnalyzeRule.putPattern` 一致。 */
    private fun storePutVariables(rule: String, jsSandbox: JsSandbox?, rawBody: String?, baseUrl: String?): String =
        PUT_VARIABLE.replace(rule) { match ->
            val body = match.groupValues[1]
            val key = body.substringBefore(':').trim().removeSurrounding("\"")
            val subRule = body.substringAfter(':', "")
            if (key.isNotEmpty() && subRule.isNotEmpty()) {
                ruleVariables[key] = value(subRule, jsSandbox, rawBody, baseUrl) ?: ""
            }
            ""
        }

    /** `@get:{k}` 与 `{{k}}` 共用一张表（上游 `evalPattern` 就是把这两种写法合并匹配的）。 */
    private fun substituteGetVariables(rule: String): String = GET_VARIABLE.replace(rule) { match ->
        ruleVariables[match.groupValues[1].trim().removeSurrounding("\"")] ?: ""
    }

    private fun evaluateJs(jsSandbox: JsSandbox?, code: String, rawBody: String?, baseUrl: String?): String? {
        val doc = documentText()
        return jsSandbox?.eval(
            code,
            mapOf("result" to doc, "src" to (rawBody ?: doc), "baseUrl" to (baseUrl ?: "")),
        )
    }

    /** `{{…}}` 里的内容是取值路径还是一段 JS：带调用括号、或从 `java.`/`cookie.`/`result` 等起手即为 JS。 */
    private fun isJsExpression(inner: String): Boolean {
        val text = inner.trim()
        return !text.startsWith("$") && !text.startsWith("..") && !BARE_JSON_KEY.matches(text) &&
            (text.contains('(') || JS_IDENT_PREFIX.matches(text))
    }

    private fun valuePlain(rule: String): String? {
        if (rule.isBlank()) return null
        return if (json != null) valueJson(rule)
        else html?.let { element ->
            if (isXpathRule(rule)) {
                val path = stripXpathPrefix(rule)
                val texts = xpathTexts(element, path.substringBefore("##"))
                if (texts.isEmpty()) return null
                return applyRegexReplace(texts.joinToString("\n"), path).takeIf { it.isNotBlank() }
            }
            val selector = rule.removePrefix("@css:")
            val segments = selector.split('@')
            val lastSegment = segments.last()
            val rawMode = lastSegment.substringBefore("##").ifBlank { "text" }
            val selectorChain = segments.subList(0, segments.size - 1).filter { it.isNotBlank() }
            
            val elements = if (selectorChain.isEmpty()) listOf(element) else {
                var currentList = listOf(element)
                for (segment in selectorChain) {
                    val nextList = mutableListOf<Element>()
                    for (curr in currentList) {
                        nextList.addAll(selectAllLegado(curr, segment))
                    }
                    currentList = nextList
                    if (currentList.isEmpty()) break
                }
                currentList
            }
            if (elements.isEmpty()) return null
            val texts = elements.mapNotNull { el ->
                when (rawMode) {
                    "html" -> el.html().takeIf { it.isNotBlank() }
                    "text" -> el.text().takeIf { it.isNotBlank() }
                    "textNodes", "textNode" -> el.ownText().takeIf { it.isNotBlank() }
                    else -> el.attr(rawMode).takeIf { it.isNotBlank() }
                }
            }
            if (texts.isEmpty()) return null
            val resultText = applyRegexReplace(texts.joinToString("\n"), lastSegment)
            resultText.takeIf { it.isNotBlank() }
        }
    }

    private fun selectAllLegado(element: Element, selector: String): List<Element> = runCatching {
        val trimmed = selector.trim()
        if (trimmed == "children") return@runCatching element.children().toList()
        val idOnly = Regex("^id\\.([a-zA-Z0-9_-]+)$").find(trimmed)
        if (idOnly != null) {
            val el = element.getElementById(idOnly.groupValues[1])
            return@runCatching if (el != null) listOf(el) else emptyList()
        }
        val tagOnly = Regex("^tag\\.([a-zA-Z0-9_-]+)$").find(trimmed)
        if (tagOnly != null) {
            return@runCatching element.getElementsByTag(tagOnly.groupValues[1]).toList()
        }
        val classOnly = Regex("^class\\.([a-zA-Z][a-zA-Z0-9_-]*)$").find(trimmed)
        if (classOnly != null) {
            return@runCatching element.select(".${classOnly.groupValues[1]}")
        }
        val indexed = Regex("^([a-zA-Z][a-zA-Z0-9-]*)\\.(\\d+)$").find(trimmed)
        if (indexed != null) {
            val tag = indexed.groupValues[1]
            val ordinal = indexed.groupValues[2].toInt().coerceAtLeast(0)
            val matches = element.getElementsByTag(tag)
            return@runCatching matches.getOrNull(ordinal)?.let { listOf(it) } ?: emptyList()
        }
        val classIndexed = Regex("^class\\.([a-zA-Z][a-zA-Z0-9_-]*)\\.(\\d+)$").find(trimmed)
            ?: Regex("^\\.([a-zA-Z][a-zA-Z0-9_-]*)\\.(\\d+)$").find(trimmed)
        if (classIndexed != null) {
            val className = classIndexed.groupValues[1]
            val ordinal = classIndexed.groupValues[2].toInt().coerceAtLeast(0)
            val matches = element.select(".$className")
            return@runCatching matches.getOrNull(ordinal)?.let { listOf(it) } ?: emptyList()
        }
        element.select(trimmed)
    }.getOrDefault(emptyList())

    fun at(rule: String?): NodeValue {
        if (json == null || rule.isNullOrBlank() || !rule.trimStart().startsWith("$")) return this
        return runCatching { NodeValue.json(readJson(rule)) }.getOrDefault(this)
    }

    private fun unwrapJsonValue(value: Any?): String? {
        return when (value) {
            null -> null
            // JSON 对象必须序列化成合法 JSON：直接用 Java 的 {k=v} 形式会让后续规则链解析失败
            is Map<*, *> -> toJsonText(value)
            is List<*> -> {
                val nonNull = value.filterNotNull()
                // 元素是对象/嵌套结构时必须保留 JSON 数组形态，否则章节列表之类的规则链会被压成文本而无法再解析；
                // 纯标量列表仍按行拼接，保持原有取值语义。
                if (nonNull.any { it is Map<*, *> || it is List<*> }) toJsonText(nonNull)
                else if (nonNull.size == 1) unwrapJsonValue(nonNull[0])
                else nonNull.joinToString(separator = "\n") { unwrapJsonValue(it) ?: "" }.ifBlank { null }
            }
            else -> value.toString().takeIf { it.isNotBlank() }
        }
    }

    /** 把 JsonPath 取出的 Java Map/List 递归序列化为合法 JSON 文本。 */
    private fun toJsonText(value: Any?): String = runCatching {
        Json.encodeToString(JsonElement.serializer(), toJsonElement(value))
    }.getOrElse { value?.toString() ?: "" }

    private fun toJsonElement(value: Any?): JsonElement = when (value) {
        null -> JsonNull
        is JsonElement -> value
        is String -> JsonPrimitive(value)
        is Number -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        is Map<*, *> -> JsonObject(value.entries.associate { (key, item) -> key.toString() to toJsonElement(item) })
        is Iterable<*> -> JsonArray(value.map { toJsonElement(it) })
        else -> JsonPrimitive(value.toString())
    }

    private fun valueJson(rule: String): String? {
        // Legado 规则语法 `路径##正则##替换`：必须先剥离 ## 部分再交给 JsonPath，
        // 否则整串会当成 JSON 路径解析失败，条目会被 mapNotNull 全部丢弃（表现为搜索 0 结果）。
        val pathPart = rule.substringBefore("##").trim()
        val template = Regex("\\{\\{(.*?)}}").replace(pathPart) { match ->
            val inner = match.groupValues[1].trim()
            unwrapJsonValue(readJson(inner)) ?: ""
        }
        // Legado 的裸键简写：JSON 规则里写 `book_name` 等价于 `$.book_name`（番茄等官方接口源大量使用）。
        // 不展开的话这里会把规则文本本身当成值返回，详情书名变成「book_name」、章节标题变成「title」。
        val path = when {
            template.startsWith("$") || template.startsWith("@") -> template
            BARE_JSON_KEY.matches(template) -> "\$.$template"
            else -> return applyRegexReplace(template, rule).takeIf { it.isNotBlank() }
        }
        val raw = unwrapJsonValue(readJson(path)) ?: return null
        return applyRegexReplace(raw, rule).takeIf { it.isNotBlank() }
    }

    /** Legado 的 `##正则##替换` 语法：成对出现，替换串缺省为空串。 */
    private fun applyRegexReplace(value: String, rule: String): String {
        if (!rule.contains("##")) return value
        val parts = rule.split("##")
        var result = value
        var index = 1
        while (index < parts.size) {
            val pattern = parts[index]
            val replacement = if (index + 1 < parts.size) parts[index + 1] else ""
            if (pattern.isNotBlank()) {
                result = runCatching { result.replace(Regex(pattern), replacement) }.getOrDefault(result)
            }
            index += 2
        }
        return result
    }

    private fun readJson(path: String): Any? = runCatching {
        val clean = path.trim()
        val normalized = if (clean.startsWith("$")) clean else if (clean.startsWith("..")) "$.$clean" else "$.$clean"
        JsonPath.read<Any>(json, normalized)
    }.getOrNull()

    companion object {
        /** Legado JSON 规则里的裸键简写（`book_name` == `$.book_name`）。 */
        private val BARE_JSON_KEY = Regex("[A-Za-z_][\\w-]*(\\.[A-Za-z_][\\w-]*)*")
        private val JS_IDENT_PREFIX = Regex("^(?:java|cookie|source|book|chapter|result|baseUrl|key|page)\\b")
        private val PUT_VARIABLE = Regex("@put:\\{([^{}]*?)\\}", RegexOption.IGNORE_CASE)
        private val GET_VARIABLE = Regex("@get:\\{([^{}]*?)\\}", RegexOption.IGNORE_CASE)

        fun html(element: Element) = NodeValue(element, null)
        fun document(body: String) = if (body.trimStart().startsWith("{") || body.trimStart().startsWith("[")) {
            NodeValue(null, JsonPath.parse(body).json<Any>())
        } else {
            NodeValue(Jsoup.parse(body), null)
        }
        fun json(value: Any?) = NodeValue(null, value)
    }
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

private val XPATH_PREFIX = Regex("""^@(?:xpath|xp)\s*:\s*""", RegexOption.IGNORE_CASE)

private fun isXpathRule(rule: String): Boolean = XPATH_PREFIX.containsMatchIn(rule.trim())

private fun stripXpathPrefix(rule: String): String = XPATH_PREFIX.replace(rule.trim(), "").trim()

/** JXDocument 2.5.1 只吃 Document / Elements / String / List，不接受裸 Node，这里按类型适配。 */
private fun jx(node: Node): JXDocument = when (node) {
    is Document -> JXDocument(node)
    is Element -> JXDocument(Elements(listOf(node)))
    else -> JXDocument(node.toString())
}

/** 列表选择：从文档/元素出发按 xpath 选出节点。元素结果包成可继续取值的 html 节点，文本/属性结果当作文本节点。 */
private fun xpathNodes(node: Node, path: String): List<NodeValue> =
    runCatching {
        jx(node).sel(path).mapNotNull { item ->
            when (item) {
                is Element -> NodeValue.html(item)
                is TextNode -> NodeValue.document(item.getWholeText())
                null -> null
                else -> NodeValue.document(item.toString())
            }
        }
    }.getOrDefault(emptyList())

/** 字段取值：按 xpath 求值后把结果统一成文本（Element 取可见文本，TextNode/属性取文本）。 */
private fun xpathTexts(node: Node, path: String): List<String> =
    runCatching {
        jx(node).sel(path).mapNotNull { item ->
            when (item) {
                is Element -> item.text().ifBlank { item.wholeText().ifBlank { null } }
                is TextNode -> item.getWholeText().ifBlank { null }
                null -> null
                else -> item.toString().ifBlank { null }
            }
        }
    }.getOrDefault(emptyList())

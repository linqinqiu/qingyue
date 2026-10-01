package io.legado.server

import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.parser.Parser
import java.io.ByteArrayInputStream
import java.io.File
import java.net.URLDecoder
import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream

data class ParsedBook(
    val title: String,
    val author: String? = null,
    val intro: String? = null,
    val coverBytes: ByteArray? = null,
    val coverContentType: String? = null,
    val chapters: List<ParsedChapter>,
)

data class ParsedChapter(
    val title: String,
    val content: String,
)

object LocalBookParser {

    const val LOC_BOOK_SOURCE_ID = "loc_book"

    // 中文小说章节识别核心正则（增强版）
    // 匹配格式包括：
    // - 第X章/回/节/卷/集/篇/部（数字、中文、混合）
    // - Chapter X / Vol. X
    // - 纯数字前缀：1. 2. 3. 或 一、二、三、
    // - 特殊章节：引子/序言/楔子/尾声/后记/番外/终章/前言/附录
    // - 卷部：上部/下部/中部/前传/后传/外传/特别篇
    // - 标题后缀：`第一章 起源`、`3. 起飞`、`第1章：归来`（分隔符可以只是空格）
    //
    // 两个坑，改的时候别碰回去：
    // ① 所有分支必须整体套在一个 `(?: … )` 里再上 `^…$`。`Regex.matches` 要整行匹配，
    //    写成顶层 `^(?:A)|(?:B)|…$` 时每条分支各自被 `^`/`$` 卡成不一样的形状
    //    （只有第一条带 `^`、只有最后一条带 `$`），"第X章 + 空格 + 标题"这类最常见写法反而匹配不上。
    // ② 上一版这里多了一个右括号，`Pattern` 编译失败 → `LocalBookParser` 的类初始化直接抛
    //    `ExceptionInInitializerError`，整个对象此后全是 `NoClassDefFoundError`：
    //    表现不是"分章不准"，而是**本地书导入整条功能是死的**。所以这一组的用例
    //    （LocalBookParserTest）必须先能跑起来再谈别的。
    private val CHAPTER_TITLE_REGEX = Regex(
        """^(?:(?:第\s*[0-9零一二三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+[章回节卷集篇部幕计])|(?:Chapter|Vol\.?)\s+[0-9]+|(?:[0-9]{1,4}[.\s、]|[零一二三四五六七八九十百千万]{1,4}[、.]\s*)|(?:引子|序(?:言|章)?|楔子|尾(?:声|章)|后记|番外|终章|前言|附(?:录|记)|跋)|(?:上部|下部|中部|前传|后传|外传|特别篇))(?:\s*[-—·:：]?\s*.+)?$""",
        RegexOption.IGNORE_CASE
    )

    fun parse(filename: String, bytes: ByteArray): ParsedBook {
        val lowerName = filename.lowercase()
        return when {
            lowerName.endsWith(".epub") -> parseEpub(filename, bytes)
            lowerName.endsWith(".txt") || lowerName.endsWith(".text") -> parseTxt(filename, bytes)
            else -> {
                // 自动探测是否为 zip/epub 结构
                if (bytes.size >= 4 && bytes[0] == 0x50.toByte() && bytes[1] == 0x4B.toByte()) {
                    runCatching { parseEpub(filename, bytes) }.getOrElse { parseTxt(filename, bytes) }
                } else {
                    parseTxt(filename, bytes)
                }
            }
        }
    }

    /**
     * TXT 文本自动探测编码与分章
     */
    fun parseTxt(filename: String, bytes: ByteArray): ParsedBook {
        val (detectedTitle, detectedAuthor) = extractTitleAndAuthorFromFilename(filename)
        val text = decodeText(bytes)

        val lines = text.lines()
        val chapters = mutableListOf<ParsedChapter>()

        var currentTitle: String? = null
        val currentContent = StringBuilder()

        for (line in lines) {
            val trimmed = line.trim()
            if (trimmed.isNotEmpty() && CHAPTER_TITLE_REGEX.matches(trimmed)) {
                if (currentTitle != null) {
                    chapters.add(ParsedChapter(currentTitle, currentContent.toString().trim()))
                    currentContent.clear()
                } else if (currentContent.isNotBlank()) {
                    // 第一章之前的内容作为前言/引子（最多保留 2000 字）
                    val prologue = currentContent.toString().trim().take(2000)
                    chapters.add(ParsedChapter("前言", prologue))
                    currentContent.clear()
                }
                currentTitle = trimmed
            } else {
                if (currentContent.isNotEmpty()) {
                    currentContent.append("\n")
                }
                currentContent.append(line)
            }
        }

        if (currentTitle != null) {
            chapters.add(ParsedChapter(currentTitle, currentContent.toString().trim()))
        } else if (currentContent.isNotBlank()) {
            val remaining = currentContent.toString().trim()
            if (chapters.isEmpty()) {
                // 全书无章节匹配，按字数智能分页切分
                chapters.addAll(paginateText(remaining))
            } else {
                chapters.add(ParsedChapter("尾声", remaining))
            }
        }

        val finalChapters = if (chapters.isEmpty()) {
            listOf(ParsedChapter("正文", text.trim()))
        } else chapters

        // TXT 没有封面可言：以前按书名哈希生成一张彩色 SVG，一书架本地书下去就是彩虹，
        // 现在留空，由界面的主题化文字占位承担（BookCover → .cover-fallback）。
        return ParsedBook(
            title = detectedTitle,
            author = detectedAuthor,
            intro = if (finalChapters.firstOrNull()?.title == "前言") finalChapters.first().content.take(300) else null,
            chapters = finalChapters,
        )
    }

    /**
     * EPUB 规范解压与元数据、目录、正文提取
     */
    fun parseEpub(filename: String, bytes: ByteArray): ParsedBook {
        val entries = mutableMapOf<String, ByteArray>()
        ZipInputStream(ByteArrayInputStream(bytes)).use { zis ->
            var entry: ZipEntry? = zis.nextEntry
            while (entry != null) {
                if (!entry.isDirectory) {
                    val name = normalizeZipPath(entry.name)
                    entries[name] = zis.readAllBytes()
                }
                entry = zis.nextEntry
            }
        }

        // 1. 定位 container.xml
        val containerXmlBytes = entries["META-INF/container.xml"]
            ?: entries.entries.firstOrNull { it.key.equals("META-INF/container.xml", ignoreCase = true) }?.value
            ?: throw IllegalArgumentException("无效的 EPUB 文件：缺少 META-INF/container.xml")

        val containerDoc = Jsoup.parse(String(containerXmlBytes, StandardCharsets.UTF_8), "", Parser.xmlParser())
        val rootfile = containerDoc.select("rootfiles > rootfile").firstOrNull()
            ?: containerDoc.select("rootfile").firstOrNull()
            ?: throw IllegalArgumentException("无效的 EPUB 文件：未找到 rootfile")

        val opfPath = normalizeZipPath(rootfile.attr("full-path"))
        val opfBytes = entries[opfPath]
            ?: entries.entries.firstOrNull { it.key.equals(opfPath, ignoreCase = true) }?.value
            ?: throw IllegalArgumentException("未找到 OPF 描述文件：$opfPath")

        val opfBaseDir = if (opfPath.contains('/')) opfPath.substringBeforeLast('/') + "/" else ""
        val opfDoc = Jsoup.parse(String(opfBytes, StandardCharsets.UTF_8), "", Parser.xmlParser())

        // 2. 提取元数据
        val (fileTitle, fileAuthor) = extractTitleAndAuthorFromFilename(filename)
        val title = opfDoc.select("metadata > dc|title, metadata > title").firstOrNull()?.text()?.trim()
            ?.ifBlank { null } ?: fileTitle
        val author = opfDoc.select("metadata > dc|creator, metadata > creator").firstOrNull()?.text()?.trim()
            ?.ifBlank { null } ?: fileAuthor
        val intro = opfDoc.select("metadata > dc|description, metadata > description").firstOrNull()?.text()?.trim()
            ?.ifBlank { null }

        // 3. Manifest 映射 (id -> href, media-type, properties)
        data class ManifestItem(val id: String, val href: String, val mediaType: String, val properties: String)
        val manifest = mutableMapOf<String, ManifestItem>()
        for (item in opfDoc.select("manifest > item")) {
            val id = item.attr("id")
            val rawHref = item.attr("href")
            val href = try { URLDecoder.decode(rawHref, "UTF-8") } catch (_: Throwable) { rawHref }
            val fullHref = normalizeZipPath(opfBaseDir + href)
            val mediaType = item.attr("media-type")
            val properties = item.attr("properties")
            manifest[id] = ManifestItem(id, fullHref, mediaType, properties)
        }

        // 4. 提取封面
        var coverBytes: ByteArray? = null
        var coverContentType: String? = null

        // 查找 meta cover 属性
        val coverMetaId = opfDoc.select("metadata > meta[name=cover]").attr("content").ifBlank { null }
        val coverItem = (coverMetaId?.let { manifest[it] })
            ?: manifest.values.firstOrNull { it.properties.contains("cover-image") }
            ?: manifest.values.firstOrNull { it.id.equals("cover", ignoreCase = true) && it.mediaType.startsWith("image/") }
            ?: manifest.values.firstOrNull { it.href.contains("cover", ignoreCase = true) && it.mediaType.startsWith("image/") }

        if (coverItem != null) {
            val imgData = findZipEntry(entries, coverItem.href)
            if (imgData != null && imgData.isNotEmpty()) {
                coverBytes = imgData
                coverContentType = coverItem.mediaType.ifBlank { "image/jpeg" }
            }
        }

        // 5. 提取目录 (NCX 或 Nav 或 Spine)
        val chapters = mutableListOf<ParsedChapter>()

        // 尝试 NCX 目录
        val spineTocId = opfDoc.select("spine").attr("toc").ifBlank { null }
        val ncxItem = (spineTocId?.let { manifest[it] })
            ?: manifest.values.firstOrNull { it.mediaType == "application/x-dtbncx+xml" || it.href.endsWith(".ncx", ignoreCase = true) }

        if (ncxItem != null) {
            val ncxBytes = findZipEntry(entries, ncxItem.href)
            if (ncxBytes != null) {
                val ncxBaseDir = if (ncxItem.href.contains('/')) ncxItem.href.substringBeforeLast('/') + "/" else ""
                val ncxDoc = Jsoup.parse(String(ncxBytes, StandardCharsets.UTF_8), "", Parser.xmlParser())
                val navPoints = ncxDoc.select("navMap > navPoint, navPoint")
                for (np in navPoints) {
                    val label = np.select("navLabel > text").firstOrNull()?.text()?.trim() ?: "章节"
                    val src = np.select("content").attr("src").substringBefore('#')
                    if (src.isNotBlank()) {
                        val fullPath = normalizeZipPath(ncxBaseDir + src)
                        val htmlBytes = findZipEntry(entries, fullPath)
                        if (htmlBytes != null) {
                            val content = extractHtmlContent(htmlBytes)
                            if (content.isNotBlank()) {
                                chapters.add(ParsedChapter(label, content))
                            }
                        }
                    }
                }
            }
        }

        // 若 NCX 解析为空，尝试 EPUB 3 Nav
        if (chapters.isEmpty()) {
            val navItem = manifest.values.firstOrNull { it.properties.contains("nav") }
            if (navItem != null) {
                val navBytes = findZipEntry(entries, navItem.href)
                if (navBytes != null) {
                    val navBaseDir = if (navItem.href.contains('/')) navItem.href.substringBeforeLast('/') + "/" else ""
                    val navDoc = Jsoup.parse(String(navBytes, StandardCharsets.UTF_8))
                    val links = navDoc.select("nav[epub|type=toc] a, nav a")
                    for (a in links) {
                        val label = a.text().trim().ifBlank { "章节" }
                        val src = a.attr("href").substringBefore('#')
                        if (src.isNotBlank()) {
                            val fullPath = normalizeZipPath(navBaseDir + src)
                            val htmlBytes = findZipEntry(entries, fullPath)
                            if (htmlBytes != null) {
                                val content = extractHtmlContent(htmlBytes)
                                if (content.isNotBlank()) {
                                    chapters.add(ParsedChapter(label, content))
                                }
                            }
                        }
                    }
                }
            }
        }

        // 若仍为空，按 Spine 线性顺序读取
        if (chapters.isEmpty()) {
            val itemrefs = opfDoc.select("spine > itemref")
            var idx = 1
            for (itemref in itemrefs) {
                val idref = itemref.attr("idref")
                val item = manifest[idref] ?: continue
                val htmlBytes = findZipEntry(entries, item.href) ?: continue
                val (extractedTitle, content) = extractHtmlTitleAndContent(htmlBytes, idx)
                if (content.isNotBlank()) {
                    chapters.add(ParsedChapter(extractedTitle, content))
                    idx++
                }
            }
        }

        val finalChapters = if (chapters.isEmpty()) {
            listOf(ParsedChapter("正文", "本书正文内容解析为空或为纯图片。"))
        } else chapters

        return ParsedBook(
            title = title,
            author = author,
            intro = intro,
            coverBytes = coverBytes,
            coverContentType = coverContentType,
            chapters = finalChapters,
        )
    }

    private fun findZipEntry(entries: Map<String, ByteArray>, path: String): ByteArray? {
        val norm = normalizeZipPath(path)
        return entries[norm] ?: entries.entries.firstOrNull { it.key.equals(norm, ignoreCase = true) }?.value
    }

    private fun extractHtmlContent(bytes: ByteArray): String {
        val html = String(bytes, StandardCharsets.UTF_8)
        val doc = Jsoup.parse(html)
        doc.select("script, style, link, meta").remove()
        // 将块级元素转换为换行
        doc.select("p, div, br, h1, h2, h3, h4, h5, h6, tr, li, blockquote").prepend("\n\n")
        val text = doc.body()?.text() ?: doc.text()
        return cleanText(text)
    }

    private fun extractHtmlTitleAndContent(bytes: ByteArray, defaultIndex: Int): Pair<String, String> {
        val html = String(bytes, StandardCharsets.UTF_8)
        val doc = Jsoup.parse(html)
        doc.select("script, style, link, meta").remove()
        val titleCandidate = doc.select("h1, h2, title").firstOrNull()?.text()?.trim()
        val title = if (!titleCandidate.isNullOrBlank() && titleCandidate.length <= 40) {
            titleCandidate
        } else {
            "第 $defaultIndex 章"
        }
        doc.select("p, div, br, h1, h2, h3, h4, h5, h6, tr, li, blockquote").prepend("\n\n")
        val text = doc.body()?.text() ?: doc.text()
        return title to cleanText(text)
    }

    private fun cleanText(text: String): String {
        return text.lines()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .joinToString("\n\n")
    }

    private fun paginateText(text: String, chunkSize: Int = 4000): List<ParsedChapter> {
        if (text.length <= chunkSize) {
            return listOf(ParsedChapter("正文", text))
        }
        val chapters = mutableListOf<ParsedChapter>()
        var start = 0
        var page = 1
        while (start < text.length) {
            var end = (start + chunkSize).coerceAtMost(text.length)
            if (end < text.length) {
                // 尝试在自然换行处切分（避免从句子中间劈开）
                val newlineIdx = text.lastIndexOf('\n', end)
                if (newlineIdx > start + chunkSize / 2) {
                    end = newlineIdx + 1
                }
            }
            val chunk = text.substring(start, end).trim()
            if (chunk.isNotEmpty()) {
                // 标题只写"第 X 节"。上一版在这里加了"（共约 Y 节）"，意图是让人知道总共分了几个，
                // 但目录里每一条都挂一遍总数只是噪声，而且"共约"是按字数估的：自然换行会让实际段数与估算不符，
                // 写进标题就是把一个不确定的数字变成看起来确定的。总数阅读器本来就显示（第 x / y 章）。
                chapters.add(ParsedChapter("第 $page 节", chunk))
                page++
            }
            start = end
        }
        return chapters
    }

    /**
     * 智能编码探测：UTF-8, UTF-8 BOM, UTF-16, GB18030/GBK
     */
    fun decodeText(bytes: ByteArray): String {
        if (bytes.isEmpty()) return ""

        // 1. 检查 BOM
        if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte()) {
            return String(bytes, 3, bytes.size - 3, StandardCharsets.UTF_8)
        }
        if (bytes.size >= 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte()) {
            return String(bytes, 2, bytes.size - 2, StandardCharsets.UTF_16BE)
        }
        if (bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte()) {
            return String(bytes, 2, bytes.size - 2, StandardCharsets.UTF_16LE)
        }

        // 2. 尝试严格 UTF-8 解码
        try {
            val decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            val charBuffer = decoder.decode(ByteBuffer.wrap(bytes))
            return charBuffer.toString()
        } catch (_: Throwable) {
            // UTF-8 严格解码失败
        }

        // 3. 尝试 GB18030 (向下兼容 GBK, GB2312)
        try {
            val gbkCharset = Charset.forName("GB18030")
            val decoder = gbkCharset.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            val charBuffer = decoder.decode(ByteBuffer.wrap(bytes))
            return charBuffer.toString()
        } catch (_: Throwable) {
            // GB18030 严格解码失败
        }

        // 4. 容错回退
        return String(bytes, StandardCharsets.UTF_8)
    }

    /**
     * 从文件名中提取书名与作者
     */
    fun extractTitleAndAuthorFromFilename(filename: String): Pair<String, String?> {
        val cleanName = filename.substringBeforeLast('.').trim()
        val authorRegexes = listOf(
            Regex("""(?:作者|著)[:：\s]+([^\s_\(\)\[\]《》【】]+)"""),
            Regex("""[《【\[](.+?)[》】\]]\s*(?:作者|著)?[:：\s]*([^\s_\(\)\[\]《》【】]+)"""),
            Regex("""^(.+?)[_—\-\s]+(?:作者|著)?[:：\s]*([^\s_\(\)\[\]《》【】]+)$"""),
            Regex("""^(.+?)\s*\(([^\(\)]+)\)$"""),
        )

        for (regex in authorRegexes) {
            val match = regex.find(cleanName)
            if (match != null) {
                val groups = match.groupValues
                if (groups.size == 3) {
                    val title = sanitizeTitle(groups[1])
                    val author = groups[2].trim()
                    if (title.isNotBlank() && author.isNotBlank()) {
                        return title to author
                    }
                } else if (groups.size == 2) {
                    val author = groups[1].trim()
                    val title = sanitizeTitle(cleanName.replace(match.value, ""))
                    if (title.isNotBlank() && author.isNotBlank()) {
                        return title to author
                    }
                }
            }
        }

        return sanitizeTitle(cleanName) to null
    }

    private fun sanitizeTitle(raw: String): String {
        return raw.replace(Regex("""^[《【\[(]+"""), "")
            .replace(Regex("""[》】\])]+$"""), "")
            .trim()
            .ifBlank { "未知书籍" }
    }

    private fun normalizeZipPath(path: String): String {
        val parts = path.replace('\\', '/').split('/')
        val stack = mutableListOf<String>()
        for (part in parts) {
            if (part == "." || part.isEmpty()) continue
            if (part == "..") {
                if (stack.isNotEmpty()) stack.removeAt(stack.size - 1)
            } else {
                stack.add(part)
            }
        }
        return stack.joinToString("/")
    }
}

package io.legado.server

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * 本地 TXT 的目录规则（用户 2026-10-02：「txt目录规则，这个可以放到阅读设置里」）。
 *
 * 字段与上游 `data/entities/TxtTocRule.kt` 对齐；内置那 26 条来自上游
 * `app/src/main/assets/defaultData/txtTocRule.json`（LegadoTeam/legado，GPL-3.0，
 * 本项目同为 GPL-3.0），**原样作为随包资源 `assets/txtTocRule.json` 装进来，不手抄**：
 * 这些正则里有 `节(?!课)`、`正文(?!完|结)`、`部(?![分赛游])` 这类负向排除，
 * 抄错一个字就会把"第一节课程"当成一章，或者反过来整本书切不出一章。
 */
@Serializable
data class TxtTocRule(
    val id: Int = 0,
    val name: String = "",
    val rule: String = "",
    /** 上游用它挂"标题净化 JS"；随包这 26 条里都是空的，接上之前不参与解析。 */
    val replacement: String = "",
    val example: String? = null,
    val serialNumber: Int = -1,
    val enable: Boolean = true,
)

/**
 * 规则表与"哪一条适合这本书"的判定。
 *
 * 打分口径照抄上游 `TextFile.getTocRule()`：对**同一份正文**逐条规则跑一遍，
 * `csNum` 是有效标题数，`numE` 是"两次命中之间不足 100 字"的伪命中（这种一般是卷/部，不是章）；
 * 只有 `csNum >= numE * 3` 且比当前最优多 [OVER_RULE_COUNT] 条以上才换规则，
 * 命中超过 [EARLY_ACCEPT] 条就提前定案（前面的规则已经够用了，不必再试后面的）。
 *
 * 为什么要有这套打分：单看一条规则"能匹配上"没有意义——越宽松的规则匹配得越多也错得越多，
 * 必须拿真实正文量出来它切出的章数与噪声比例。
 */
object TocRules {
    /** 界面与备份里用的两个特殊值；其余都是 [TxtTocRule.id] 的十进制字符串。 */
    const val AUTO = "auto"
    const val BUILTIN = "builtin"

    private const val OVER_RULE_COUNT = 2
    private const val EARLY_ACCEPT = 70

    /** 打分只看文件头这么多字符：与上游"读头 512KB 选规则"同一口径，200MB 的书不必全文扫两遍。 */
    private const val SNIFF_CHARS = 512_000

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }
    // ConcurrentHashMap 不许存 null，所以"编不出来"不能塞进同一张表里 ——
    // 第一版就是在这里 `getOrPut(id) { … ?: return@getOrPut null }`，
    // 查一个不存在的规则 id 直接 NPE。成功进 compiled，失败进 rejected。
    private val compiled = java.util.concurrent.ConcurrentHashMap<Int, Regex>()
    private val rejected = java.util.concurrent.ConcurrentHashMap.newKeySet<Int>()

    val all: List<TxtTocRule> by lazy { load() }

    /** 能参与打分/选用的：启用、规则非空、且真的编译得出来（坏正则跳过，不是崩）。 */
    val candidates: List<TxtTocRule> by lazy { all.filter { it.enable && compile(it.id) != null } }

    fun byId(id: Int): TxtTocRule? = all.firstOrNull { it.id == id }

    /** 界面上显示的名字（找不到规则时说真话，不把裸 id 甩给用户）。 */
    fun label(key: String): String = when (key) {
        AUTO -> "自动选择（按正文打分）"
        BUILTIN -> "内置规则"
        else -> byId(key.toIntOrNull() ?: Int.MIN_VALUE)?.name ?: "未知规则（$key）"
    }

    /** 上游用 `Pattern.MULTILINE` + `find()` 全文找标题，这里保持同一语义。 */
    private fun compile(id: Int): Regex? {
        compiled[id]?.let { return it }
        if (id in rejected) return null
        val rule = byId(id)
        if (rule == null || rule.rule.isBlank()) {
            rejected += id
            return null
        }
        val regex = runCatching { Regex(rule.rule, RegexOption.MULTILINE) }.getOrElse { error ->
            // 坏规则不该拖垮整条导入链，但必须看得见是哪一条坏了（本轮日志改造的口径）。
            rejected += id
            Unit.logParsing("TXT 目录规则正则编译失败，已跳过该规则", mapOf("规则" to rule.name, "原因" to (error.message ?: "")))
            return null
        }
        compiled[id] = regex
        return regex
    }

    fun regexFor(key: String?): Regex? {
        val id = key?.toIntOrNull() ?: return null
        return compile(id)
    }

    /** 这本书用的规则是不是"自动"这一档（含没存过规则的老数据）。 */
    fun isAuto(key: String?): Boolean = key.isNullOrBlank() || key == AUTO

    /**
     * 按上游口径给一条规则打分：返回（有效标题数, 伪命中数）。
     * 单独暴露出来是为了判据能直接断言"宽松规则的分不会赢过精确规则"。
     */
    fun score(text: String, id: Int): Pair<Int, Int>? {
        val regex = compile(id) ?: return null
        var start = 0
        var titles = 0
        var volumes = 0
        for (match in regex.findAll(text)) {
            val gap = match.range.first - start
            if (start == 0 || gap > 1000) {
                if (match.value.isNotBlank()) titles++
                start = match.range.last + 1
            } else if (gap < 100) {
                volumes++
            }
        }
        return titles to volumes
    }

    /** 给这本书挑一条规则；一条都不合格时返回 null，由调用方回落到内置那条。 */
    fun suggest(text: String): TxtTocRule? {
        val head = if (text.length > SNIFF_CHARS) text.substring(0, SNIFF_CHARS) else text
        var best: TxtTocRule? = null
        var maxNum = -1
        for (rule in candidates) {
            val (titles, volumes) = score(head, rule.id) ?: continue
            if (titles >= volumes * 3 && titles > maxNum + OVER_RULE_COUNT) {
                maxNum = titles
                best = rule
                if (maxNum > EARLY_ACCEPT) break
            }
        }
        return best
    }

    /**
     * 用给定规则把正文切成章。标题取命中本身（与上游一致），正文取到下一个命中之前。
     * 返回空列表表示"这条规则在这本书上切不出章"，调用方该回落而不是硬用。
     */
    fun split(text: String, regex: Regex): List<ParsedChapter> {
        val hits = regex.findAll(text)
            .map { it.range.first to it.value.trim() }
            .filter { it.second.isNotEmpty() }
            .toList()
        if (hits.isEmpty()) return emptyList()
        val chapters = mutableListOf<ParsedChapter>()
        hits.first().let { (offset, title) ->
            val prologue = text.substring(0, offset).trim()
            // 第一章之前还散着内容：与内置路径同一处理，不丢字。
            if (prologue.isNotBlank()) chapters.add(ParsedChapter("前言", prologue.take(2000)))
            chapters.add(ParsedChapter(title, ""))
        }
        for (index in 1 until hits.size) {
            val (from, title) = hits[index]
            val previous = chapters.last()
            val body = text.substring(hits[index - 1].first + hits[index - 1].second.length, from).trim()
            chapters[chapters.lastIndex] = ParsedChapter(previous.title, body)
            chapters.add(ParsedChapter(title, ""))
        }
        chapters[chapters.lastIndex] = ParsedChapter(chapters.last().title, text.substring(hits.last().first + hits.last().second.length).trim())
        return chapters.filter { it.title.isNotBlank() }
    }

    private fun load(): List<TxtTocRule> {
        val text = runCatching {
            TocRules::class.java.classLoader.getResourceAsStream("assets/txtTocRule.json")
                ?.readBytes()?.toString(Charsets.UTF_8)
        }.getOrNull()
        if (text.isNullOrBlank()) {
            // 资源没进包（打包环节出错）：只剩内置那一条规则，导入功能不该因此整个死掉。
            Unit.logSystem("没读到随包的 TXT 目录规则表，只剩内置规则可用", mapOf("资源" to "assets/txtTocRule.json"))
            return emptyList()
        }
        return runCatching { json.decodeFromString<List<TxtTocRule>>(text) }
            .onFailure { Unit.logSystem("TXT 目录规则表解析失败", mapOf("原因" to (it.message ?: ""))) }
            .getOrNull()
            ?.sortedBy { it.serialNumber }
            ?: emptyList()
    }
}

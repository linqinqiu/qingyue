package io.legado.server

import org.junit.Assert.*
import org.junit.Test
import java.nio.charset.StandardCharsets

/**
 * TXT 目录规则表（用户 2026-10-02：「txt目录规则，这个可以放到阅读设置里」）。
 *
 * 这组用例的目的不是"规则多"，而是**证明那 26 条从上游搬来的正则在 JVM 里真的能用**：
 * 它们要能在 Kotlin/Java 的 `Pattern` 下编译、能按正文打分、切完不丢字。
 * 上游用的是 Android 的 `java.util.regex`，看着同一套其实差在调用方式
 * （`MULTILINE` + `find()` 全文找标题，不是逐行 `matches`），照错语义比抄错字符更隐蔽。
 */
class TxtTocRuleTest {

    /** 一本规规矩矩的书：八个章标题，每章正文一千多字（远超打分里的 1000 字间隔线）。 */
    private fun wellMarkedBook(): String = buildString {
        append("这是一段没有章节标记的开篇散稿，用来验证前言不会被吞掉。\n")
        for (index in 1..8) {
            append("第").append(chinese(index)).append("章 第").append(index).append("回标题\n")
            repeat(30) { append("这是第${index}章的正文内容，讲一些情节推进与人物对话。\n") }
        }
        append("全书完\n")
    }

    private fun chinese(index: Int): String =
        listOf("一", "二", "三", "四", "五", "六", "七", "八", "九", "十")[index - 1]

    /** 没有章节标记的散文：任何规则都不该硬切出一堆章。 */
    private fun plainProse(): String = buildString {
        repeat(60) { append("他沿着河堤走了很久，水声一直跟着他，像一句不肯说完的话。\n") }
    }

    @Test
    fun `packaged rule table loads with the upstream shape`() {
        assertEquals("上游这份表是 26 条", 26, TocRules.all.size)
        assertEquals("默认启用 12 条", 12, TocRules.all.count { it.enable })
        assertTrue("一条都编译不出来就是资源或正则方言出了问题", TocRules.candidates.isNotEmpty())
        // 启用的规则必须全部编译得出来：编不出来会被静默跳过，用户看到的是"选了没用"
        assertEquals(
            "有启用的规则编译失败：" + TocRules.all.filter { it.enable && it.rule.isNotBlank() && TocRules.regexFor(it.id.toString()) == null }
                .joinToString { it.name },
            TocRules.all.count { it.enable && it.rule.isNotBlank() },
            TocRules.candidates.size,
        )
    }

    @Test
    fun `suggest picks a rule that actually carves the book`() {
        val text = wellMarkedBook()
        val picked = TocRules.suggest(text)
        assertNotNull("规规矩矩的「第一章 …」不该选不出规则", picked)
        val regex = TocRules.regexFor(picked!!.id.toString())!!
        val chapters = TocRules.split(text, regex)
        assertTrue("切出的章数不该少于 8（实际 ${chapters.size}，规则「${picked.name}」）", chapters.size >= 8)
        assertTrue("章名里要能看见中文数字章", chapters.any { it.title.contains("第一章") })
        // 入选条件本身就是可断言的性质：有效标题数 ≥ 伪命中数 × 3
        val (titles, volumes) = TocRules.score(text.take(512_000), picked.id)!!
        assertTrue("入选规则没满足打分条件：titles=$titles volumes=$volumes", titles >= volumes * 3)
    }

    @Test
    fun `auto selection never eats the very first chapter`() {
        val text = buildString {
            for (index in 1..8) {
                append("第").append(chinese(index)).append("章 第").append(index).append("回标题\n")
                // 正文里刻意不出现"第X章"这种字样，也不给开头的散稿 —— 这本书的第一行就是第一章
                repeat(50) { append("这是${index}号船员的正文内容，讲一些情节推进与人物对话。\n") }
            }
        }
        // 反向对照：随包里确实有条规则"开头没有换行就命不中"。它不存在的话这条用例就是空判。
        val misses = TocRules.candidates.filter { rule ->
            val regex = TocRules.regexFor(rule.id.toString()) ?: return@filter false
            (regex.findAll(text).firstOrNull()?.range?.first ?: 0) > 0
        }
        assertTrue("随包规则里没有漏掉第一条标题的样本，判据失去意义", misses.isNotEmpty())

        val picked = TocRules.suggest(text)
        assertNotNull("规规矩矩的书不该选不出规则", picked)
        val chapters = TocRules.split(text, TocRules.regexFor(picked!!.id.toString())!!)
        assertEquals("第一章整章被吞成了「前言」（选中的规则是「${picked.name}」）", "第一章 第1回标题", chapters.first().title)
        assertEquals("八章就该切出八章（实际 ${chapters.size}）", 8, chapters.size)
    }

    @Test
    fun `applying a backup table adopts enable choices by rule text and keeps unknown rules`() {
        val dir = java.nio.file.Files.createTempDirectory("toc-rule-merge")
        val json = kotlinx.serialization.json.Json
        val payloadOf = { rules: List<TxtTocRule> -> json.encodeToString(kotlinx.serialization.builtins.ListSerializer(TxtTocRule.serializer()), rules) }
        val enabled = TocRules.packaged.filter { it.enable }
        val target = enabled.first()
        val payload = payloadOf(listOf(
            // 同一条规则、手机上取消了勾选：按 `rule` 字面匹配，不看 id（手机端 id 与本机对不上）
            target.copy(id = 777, enable = false),
            // 用户在手机上自己加的一条：随包没有，收下为新规则
            TxtTocRule(id = 778, name = "我自己加的规则", rule = "^第[0-9]+[章节].*$", serialNumber = 99, enable = true),
            // 编不出来的正则不该入库（入库会让"这条切不出章"变成随机现象）
            TxtTocRule(id = 779, name = "坏正则", rule = "([unclosed", serialNumber = 98, enable = true),
        ))
        try {
            TocRules.useStore(dir.resolve("txt_toc_rules.json"))
            val report = TocRules.applyBackup(payload)
            assertEquals("匹配上的只有一条", 1, report["matched"])
            assertEquals("启用状态被改动一条", 1, report["flipped"])
            assertEquals("收下 1 条新规则（实际 ${report["added"]}）", 1, report["added"])
            assertEquals("坏正则 1 条被跳过", 1, report["unusable"])
            assertFalse("手机上取消勾选的那条在本机应变为停用", TocRules.byId(target.id)!!.enable)
            assertTrue("新规则要能被查到", TocRules.all.any { it.name == "我自己加的规则" })
            assertNull("坏正则不入库", TocRules.all.firstOrNull { it.name == "坏正则" })
            // 覆盖文件写的是**整张表**：只写"改动的那几条"时，重新装载会把停用冲掉
            // （第一版就是这里露馅的：`ArrayList(容量)` 造出来是空表，匹配到的那条根本没被改到）
            val rows = json.decodeFromString(kotlinx.serialization.builtins.ListSerializer(TxtTocRule.serializer()),
                java.nio.file.Files.readString(dir.resolve("txt_toc_rules.json")))
            assertTrue("覆盖文件里应有整张表（实际 ${rows.size} 条，随包 ${TocRules.packaged.size} 条）",
                rows.size >= TocRules.packaged.size + 1)
            assertFalse("文件里那一条也记着停用", rows.first { it.id == target.id }.enable)
            assertEquals("来自备份的条数要说得出来", 1, TocRules.customCount)
            assertTrue("随包那份不许被写坏（改动只在覆盖层）", TocRules.packaged.first { it.id == target.id }.enable)
            // 换一个 store 再读回来，等价于重启进程：改动必须落在文件里而不是只在内存
            TocRules.useStore(dir.resolve("txt_toc_rules.json"))
            assertFalse("重新装载后停用状态还在", TocRules.byId(target.id)!!.enable)
        } finally {
            // 收尾必须把全局表倒回去，否则同一 JVM 里后面的用例会读到这份测试的启用改动
            TocRules.useStore(dir.resolve("nothing-here.json"))
            java.nio.file.Files.deleteIfExists(dir.resolve("txt_toc_rules.json"))
            java.nio.file.Files.deleteIfExists(dir)
        }
        assertEquals("倒回之后随包多少条就是多少条", TocRules.packaged.size, TocRules.all.size)
        assertTrue("倒回之后那条又启用着", TocRules.byId(target.id)!!.enable)
    }

    @Test
    fun `split keeps the prologue and the tail instead of eating text`() {
        val text = wellMarkedBook()
        val picked = TocRules.suggest(text)!!
        val chapters = TocRules.split(text, TocRules.regexFor(picked.id.toString())!!)
        assertEquals("第一章之前的散稿要成节", "前言", chapters.first().title)
        assertTrue(chapters.first().content.contains("没有章节标记的开篇散稿"))
        val joined = chapters.joinToString("\n") { "${it.title}\n${it.content}" }
        assertTrue("正文不能丢", joined.contains("水声") || joined.contains("情节推进"))
        assertTrue("结尾散句要归最后一章", chapters.last().content.contains("全书完"))
        assertTrue("每章都得有正文", chapters.filter { it.title != "前言" }.all { it.content.isNotBlank() })
    }

    @Test
    fun `a book without headings falls back to the builtin path and loses nothing`() {
        val prose = plainProse()
        val parsed = LocalBookParser.parseTxt("散文集.txt", prose.toByteArray(StandardCharsets.UTF_8))
        assertEquals("切不出章就该老实说用的是内置", TocRules.BUILTIN, parsed.tocRuleUsed)
        assertTrue(parsed.chapters.isNotEmpty())
        val joined = parsed.chapters.joinToString("\n") { it.content }
        assertTrue("内置路径也不许丢正文", joined.contains("他沿着河堤走了很久"))
    }

    @Test
    fun `explicit builtin key never consults the table`() {
        val text = wellMarkedBook()
        val parsed = LocalBookParser.parseTxt("规整书.txt", text.toByteArray(StandardCharsets.UTF_8), TocRules.BUILTIN)
        assertEquals(TocRules.BUILTIN, parsed.tocRuleUsed)
        // 内置那条是逐行匹配的，八章都在
        assertTrue(parsed.chapters.count { it.title.startsWith("第") } >= 8)
    }

    @Test
    fun `unknown rule id is refused, not silently ignored`() {
        assertNull(TocRules.regexFor("999999"))
        assertNull(TocRules.regexFor(TocRules.AUTO))
        assertNull(TocRules.regexFor(null))
        assertTrue(TocRules.label("999999").contains("未知规则"))
        // 显式指定一条不存在的规则：不报错也不生效，回落内置 —— 但 tocRuleUsed 必须说实话
        val parsed = LocalBookParser.parseTxt(
            "规整书.txt", wellMarkedBook().toByteArray(StandardCharsets.UTF_8), "999999",
        )
        assertEquals(TocRules.BUILTIN, parsed.tocRuleUsed)
    }

    @Test
    fun `labels for the two special keys read as sentences`() {
        assertEquals("自动选择（按正文打分）", TocRules.label(TocRules.AUTO))
        assertEquals("内置规则", TocRules.label(TocRules.BUILTIN))
        val real = TocRules.candidates.first()
        assertEquals(real.name, TocRules.label(real.id.toString()))
        assertTrue(TocRules.isAuto(null))
        assertTrue(TocRules.isAuto(TocRules.AUTO))
        assertFalse(TocRules.isAuto(real.id.toString()))
    }
}

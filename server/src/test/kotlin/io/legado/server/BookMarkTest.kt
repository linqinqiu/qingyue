package io.legado.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

/**
 * 书签（用户 2026-10-02：「加入书签功能，可以段落（多段落），章节书签…该书签可以自定义评论，
 * 支持在同书不同书源中使用」）。
 *
 * 这一组主要钉"跨书源"那一句：书签归拢键是**书名 + 作者**，不是 `sourceId + bookUrl`。
 * 同一本书在两个源里第 37 章往往不是同一章，所以清单要合得起来、标题要留得住 ——
 * 前端跳转时先认标题，认不到才退回章节号。
 */
class BookMarkTest {
    private class Fixture(val database: Database, val directory: java.nio.file.Path) {
        fun close() {
            database.close()
            directory.toFile().deleteRecursively()
        }
    }

    private fun fixture(name: String): Fixture {
        val directory = Files.createTempDirectory(name)
        val database = Database(directory.resolve("legado.sqlite").toString())
        database.initialize()
        return Fixture(database, directory)
    }

    private fun draft(
        sourceId: String,
        name: String = "三体",
        author: String? = "刘慈欣",
        chapterIndex: Int = 3,
        chapterTitle: String = "人类舰队",
        from: Int = 7,
        to: Int = 9,
        quote: String = "给岁月以文明",
        note: String = "",
    ) = BookMarkCreateRequest(
        sourceId = sourceId,
        bookUrl = "$sourceId/book/1",
        bookName = name,
        bookAuthor = author,
        chapterIndex = chapterIndex,
        chapterTitle = chapterTitle,
        paragraphFrom = from,
        paragraphTo = to,
        quote = quote,
        note = note,
    )

    @Test
    fun `同一本书换源之后，两边打的书签在同一条清单里`() {
        val fixture = fixture("legado-mark-cross-source")
        try {
            fixture.database.createMark(draft(sourceId = "https://a.example/"))
            fixture.database.createMark(draft(sourceId = "https://b.example/", chapterTitle = "地球往事", chapterIndex = 5))
            val marks = fixture.database.listMarks(fixture.database.bookKeyOf("三体", "刘慈欣"))
            assertEquals(2, marks.size)
            assertEquals(setOf("https://a.example/", "https://b.example/"), marks.map { it.sourceId }.toSet())
            // 换源不改变"是哪一本书"，但每条要记住自己当时在哪个源、哪一章
            assertEquals(setOf("人类舰队", "地球往事"), marks.map { it.chapterTitle }.toSet())
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `归拢键忽略首尾与内部空白、忽略大小写，但不忽略作者`() {
        val fixture = fixture("legado-mark-key")
        try {
            fixture.database.createMark(draft(sourceId = "https://a.example/", name = "  三体 ", author = "  刘慈欣  "))
            fixture.database.createMark(draft(sourceId = "https://a.example/", name = "三体", author = "刘慈欣", quote = "另一句"))
            assertEquals(2, fixture.database.listMarks(fixture.database.bookKeyOf("三体", "刘慈欣")).size)
            assertEquals(0, fixture.database.listMarks(fixture.database.bookKeyOf("三体", "")).size)
            assertEquals(0, fixture.database.listMarks(fixture.database.bookKeyOf("三体", "刘欣")).size)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `段落范围反过来也会摆正，整章书签的 -1 不被夹成 0`() {
        val fixture = fixture("legado-mark-range")
        try {
            fixture.database.createMark(draft(sourceId = "https://a.example/", from = 9, to = 4))
            val flipped = fixture.database.listMarks(fixture.database.bookKeyOf("三体", "刘慈欣")).single()
            assertEquals(4, flipped.paragraphFrom)
            assertEquals(9, flipped.paragraphTo)
            fixture.database.createMark(draft(sourceId = "https://a.example/", from = -1, to = -1, quote = ""))
            val whole = fixture.database.listMarks(fixture.database.bookKeyOf("三体", "刘慈欣")).first { it.quote.isEmpty() }
            assertEquals(-1, whole.paragraphFrom)
            assertEquals(-1, whole.paragraphTo)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `批注可以后补也可以清空，删除只删那一条`() {
        val fixture = fixture("legado-mark-note")
        try {
            val first = fixture.database.createMark(draft(sourceId = "https://a.example/", quote = "第一条"))
            val second = fixture.database.createMark(draft(sourceId = "https://a.example/", quote = "第二条"))
            val updated = fixture.database.updateMarkNote(first.id, "这里要重读")
            assertEquals("这里要重读", updated?.note)
            assertEquals(first.copy(note = "这里要重读"), updated)
            assertEquals("", fixture.database.updateMarkNote(first.id, "")?.note)
            assertTrue(fixture.database.deleteMark(second.id))
            assertNull(fixture.database.updateMarkNote(987654, "x"))
            assertEquals(listOf(first.id), fixture.database.listMarks(fixture.database.bookKeyOf("三体", "刘慈欣")).map { it.id })
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `整章书签天生没有原文，不该被当成空条目拒掉`() {
        val fixture = fixture("legado-mark-chapter")
        try {
            // 段落书签原文与批注都空 = 一条没有内容的书签（路由那层拒收）；
            // 整章书签本来就只标"这一章"，两句都可以空。
            fixture.database.createMark(draft(sourceId = "https://a.example/", from = -1, to = -1, quote = "", note = ""))
            val whole = fixture.database.listMarks(fixture.database.bookKeyOf("三体", "刘慈欣")).single()
            assertEquals(-1, whole.paragraphFrom)
            assertEquals("", whole.quote)
            assertEquals("人类舰队", whole.chapterTitle)
        } finally {
            fixture.close()
        }
    }

    @Test
    fun `不带书名查就是全部书签，跨书管理那一页要用`() {
        val fixture = fixture("legado-mark-all")
        try {
            fixture.database.createMark(draft(sourceId = "https://a.example/"))
            fixture.database.createMark(draft(sourceId = "https://a.example/", name = "球状闪电", author = "刘慈欣"))
            fixture.database.createMark(draft(sourceId = "https://a.example/", name = "别源的书", author = "某人"))
            val all = fixture.database.listMarks()
            assertEquals(3, all.size)
            assertNotNull(all.firstOrNull { it.bookName == "球状闪电" })
        } finally {
            fixture.close()
        }
    }
}

package io.legado.server.data

import io.legado.server.localbook.LocalBookParser
import io.legado.server.localbook.ParsedBook
import io.legado.server.model.BookshelfItem
import io.legado.server.model.CachedBookRequest
import io.legado.server.model.Chapter
import io.legado.server.model.ChapterContent
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * `Database` 的目录缓存、本地书入库、正文缓存与缓存任务状态面（0.8.2 结构重排从 `Database.kt` 逐字拆出）。
 * 写成同包扩展函数：调用点 `database.foo()` 与成员写法逐字一致；连接、`connect`/`write`（internal）、
 * 建表与迁移留在 `Database.kt`。跨包调用这些面需 `import io.legado.server.data.<方法>`（顶层扩展不是成员）。
 */
fun Database.getTocCache(sourceId: String, tocUrl: String): List<Chapter>? = connect { db ->
    db.prepareStatement("select chapters_json from book_toc_cache where source_id = ? and toc_url = ?").use { stmt ->
        stmt.setString(1, sourceId)
        stmt.setString(2, tocUrl)
        stmt.executeQuery().use { rs ->
            if (rs.next()) {
                runCatching { Json.decodeFromString<List<Chapter>>(rs.getString(1)) }.getOrNull()
            } else null
        }
    }
}

fun Database.saveTocCache(sourceId: String, tocUrl: String, chapters: List<Chapter>) = write { db ->
    db.prepareStatement("""
        insert into book_toc_cache(source_id, toc_url, chapters_json, updated_at)
        values(?, ?, ?, ?)
        on conflict(source_id, toc_url) do update set
            chapters_json = excluded.chapters_json, updated_at = excluded.updated_at
    """.trimIndent()).use { stmt ->
        stmt.setString(1, sourceId)
        stmt.setString(2, tocUrl)
        stmt.setString(3, Json.encodeToString(chapters))
        stmt.setLong(4, System.currentTimeMillis())
        stmt.executeUpdate()
    }
}

fun Database.importLocalBook(
    bookId: String,
    parsed: ParsedBook,
    coverKey: String?,
    groupId: Long = 0,
): BookshelfItem = write { db ->
    db.autoCommit = false
    try {
        val sourceId = LocalBookParser.LOC_BOOK_SOURCE_ID
        val bookUrl = "local://$bookId"
        val tocUrl = "local://$bookId/toc"
        val now = System.currentTimeMillis()

        // 1. Insert/update book_shelf
        db.prepareStatement("""
            insert into book_shelf(source_id, book_url, name, author, toc_url, cover_url, cover_key, last_read_at, completed, alternate_sources, group_id, toc_rule)
            values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(source_id, book_url) do update set
                name = excluded.name, author = excluded.author, toc_url = excluded.toc_url,
                cover_key = coalesce(excluded.cover_key, book_shelf.cover_key),
                last_read_at = excluded.last_read_at, group_id = excluded.group_id,
                toc_rule = coalesce(excluded.toc_rule, book_shelf.toc_rule)
        """.trimIndent()).use { stmt ->
            stmt.setString(1, sourceId)
            stmt.setString(2, bookUrl)
            stmt.setString(3, parsed.title)
            stmt.setString(4, parsed.author)
            stmt.setString(5, tocUrl)
            stmt.setString(6, null)
            stmt.setString(7, coverKey)
            stmt.setLong(8, now)
            stmt.setInt(9, 0)
            stmt.setString(10, "[]")
            stmt.setLong(11, groupId)
            // 存"这次实际生效的规则"，不是"用户当时选的那条"
            stmt.setString(12, parsed.tocRuleUsed)
            stmt.executeUpdate()
        }

        // 2. Insert cover into cover_cache if present
        if (coverKey != null && parsed.coverContentType != null) {
            db.prepareStatement("insert into cover_cache(cache_key, content_type) values(?, ?) on conflict(cache_key) do update set content_type=excluded.content_type").use {
                it.setString(1, coverKey)
                it.setString(2, parsed.coverContentType)
                it.executeUpdate()
            }
        }

        // 3. Insert TOC cache
        val chapters = parsed.chapters.mapIndexed { idx, ch ->
            Chapter(
                index = idx,
                title = ch.title,
                url = "local://$bookId/chapter_${idx + 1}"
            )
        }
        db.prepareStatement("""
            insert into book_toc_cache(source_id, toc_url, chapters_json, updated_at)
            values(?, ?, ?, ?)
            on conflict(source_id, toc_url) do update set
                chapters_json = excluded.chapters_json, updated_at = excluded.updated_at
        """.trimIndent()).use { stmt ->
            stmt.setString(1, sourceId)
            stmt.setString(2, tocUrl)
            stmt.setString(3, Json.encodeToString(chapters))
            stmt.setLong(4, now)
            stmt.executeUpdate()
        }
        db.prepareStatement("""
            insert into book_toc_cache(source_id, toc_url, chapters_json, updated_at)
            values(?, ?, ?, ?)
            on conflict(source_id, toc_url) do update set
                chapters_json = excluded.chapters_json, updated_at = excluded.updated_at
        """.trimIndent()).use { stmt ->
            stmt.setString(1, sourceId)
            stmt.setString(2, bookUrl)
            stmt.setString(3, Json.encodeToString(chapters))
            stmt.setLong(4, now)
            stmt.executeUpdate()
        }

        // 4. Batch insert chapters into book_content_cache
        db.prepareStatement("delete from book_content_cache where source_id = ? and book_url = ?").use {
            it.setString(1, sourceId)
            it.setString(2, bookUrl)
            it.executeUpdate()
        }
        db.prepareStatement("""
            insert into book_content_cache(source_id, book_url, chapter_url, title, content, cached_at)
            values(?, ?, ?, ?, ?, ?)
        """.trimIndent()).use { stmt ->
            chapters.forEachIndexed { idx, ch ->
                val contentText = parsed.chapters.getOrNull(idx)?.content ?: ""
                stmt.setString(1, sourceId)
                stmt.setString(2, bookUrl)
                stmt.setString(3, ch.url)
                stmt.setString(4, ch.title)
                stmt.setString(5, contentText)
                stmt.setLong(6, now)
                stmt.addBatch()
            }
            stmt.executeBatch()
        }

        // 5. Update book_cache_status to ready
        db.prepareStatement("""
            insert into book_cache_status(source_id, book_url, total_chapters, cached_chapters, state, last_error, updated_at)
            values(?, ?, ?, ?, 'ready', null, ?)
            on conflict(source_id, book_url) do update set
                total_chapters = excluded.total_chapters, cached_chapters = excluded.cached_chapters,
                state = 'ready', last_error = null, updated_at = excluded.updated_at
        """.trimIndent()).use { stmt ->
            stmt.setString(1, sourceId)
            stmt.setString(2, bookUrl)
            stmt.setInt(3, chapters.size)
            stmt.setInt(4, chapters.size)
            stmt.setLong(5, now)
            stmt.executeUpdate()
        }

        db.commit()
        getBookshelf(db, sourceId, bookUrl)!!
    } catch (e: Throwable) {
        db.rollback()
        throw e
    } finally {
        db.autoCommit = true
    }
}

fun Database.getCachedChaptersFallback(sourceId: String, bookUrl: String): List<Chapter> = connect { db ->
    db.prepareStatement("""
        select chapter_url, title from book_content_cache
        where source_id = ? and (book_url = ? or chapter_url like ?)
        order by rowid asc
    """.trimIndent()).use { stmt ->
        stmt.setString(1, sourceId)
        stmt.setString(2, bookUrl)
        stmt.setString(3, "%$bookUrl%")
        stmt.executeQuery().use { rs ->
            buildList {
                var index = 0
                while (rs.next()) {
                    val url = rs.getString(1)
                    val title = rs.getString(2)?.ifBlank { null } ?: "第 ${index + 1} 章"
                    add(Chapter(index++, title, url))
                }
            }
        }
    }
}

fun Database.cachedContent(sourceId: String, bookUrl: String, chapterUrl: String): ChapterContent? = connect { db -> db.prepareStatement("select title,content from book_content_cache where source_id=? and book_url=? and chapter_url=?").use {
    it.setString(1, sourceId); it.setString(2, bookUrl); it.setString(3, chapterUrl); it.executeQuery().use { rs -> if (rs.next()) ChapterContent(rs.getString(1), rs.getString(2)) else null }
} }

fun Database.cachedChapterUrls(sourceId: String, bookUrl: String): Set<String> = connect { db ->
    db.prepareStatement("select chapter_url from book_content_cache where source_id = ? and book_url = ?").use { statement ->
        statement.setString(1, sourceId)
        statement.setString(2, bookUrl)
        statement.executeQuery().use { rs ->
            buildSet {
                while (rs.next()) add(rs.getString(1))
            }
        }
    }
}

fun Database.clearBookCacheContent(sourceId: String, bookUrl: String): Int = write { db ->
    val deleted = db.prepareStatement("delete from book_content_cache where source_id = ? and book_url = ?").use { statement ->
        statement.setString(1, sourceId)
        statement.setString(2, bookUrl)
        statement.executeUpdate()
    }
    db.prepareStatement("update book_cache_status set cached_chapters = 0, state = 'idle', last_error = null, updated_at = ? where source_id = ? and book_url = ?").use { statement ->
        statement.setLong(1, System.currentTimeMillis())
        statement.setString(2, sourceId)
        statement.setString(3, bookUrl)
        statement.executeUpdate()
    }
    deleted
}

fun Database.updateBookCacheProgress(sourceId: String, bookUrl: String, cachedCount: Int) = write { db ->
    db.prepareStatement("update book_cache_status set cached_chapters = ?, updated_at = ? where source_id = ? and book_url = ?").use { statement ->
        statement.setInt(1, cachedCount)
        statement.setLong(2, System.currentTimeMillis())
        statement.setString(3, sourceId)
        statement.setString(4, bookUrl)
        statement.executeUpdate()
    }
}

fun Database.cacheBookContent(sourceId: String, bookUrl: String, chapterUrl: String, content: ChapterContent): Unit = write { db ->
    db.prepareStatement("""
        insert into book_content_cache(source_id, book_url, chapter_url, title, content, cached_at)
        values(?, ?, ?, ?, ?, ?)
        on conflict(source_id, book_url, chapter_url) do update set
            title = excluded.title, content = excluded.content, cached_at = excluded.cached_at
    """.trimIndent()).use { statement ->
        statement.setString(1, sourceId)
        statement.setString(2, bookUrl)
        statement.setString(3, chapterUrl)
        statement.setString(4, content.title)
        statement.setString(5, content.content)
        statement.setLong(6, System.currentTimeMillis())
        statement.executeUpdate()
    }
}

fun Database.beginBookCache(sourceId: String, bookUrl: String, total: Int) = write { db -> db.prepareStatement("insert into book_cache_status(source_id,book_url,total_chapters,cached_chapters,state,last_error,updated_at) values(?,?,?,?,?,?,?) on conflict(source_id,book_url) do update set total_chapters=excluded.total_chapters,cached_chapters=excluded.cached_chapters,state=excluded.state,last_error=null,updated_at=excluded.updated_at").use {
    val count = db.prepareStatement("select count(*) from book_content_cache where source_id=? and book_url=?").use { query -> query.setString(1, sourceId); query.setString(2, bookUrl); query.executeQuery().use { rs -> rs.next(); rs.getInt(1) } }
    it.setString(1, sourceId); it.setString(2, bookUrl); it.setInt(3, total); it.setInt(4, count); it.setString(5, "caching"); it.setString(6, null); it.setLong(7, System.currentTimeMillis()); it.executeUpdate()
} }

fun Database.finishBookCache(sourceId: String, bookUrl: String, error: String? = null) = write { db ->
    val state = if (error == null) "ready" else "failed"
    val cachedCount = db.prepareStatement("select count(*) from book_content_cache where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeQuery().use { rs -> rs.next(); rs.getInt(1) } }
    val existingTotal = db.prepareStatement("select total_chapters from book_cache_status where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeQuery().use { rs -> if (rs.next()) rs.getInt(1) else 0 } }
    val total = if (existingTotal > 0) existingTotal else cachedCount
    db.prepareStatement("insert into book_cache_status(source_id,book_url,total_chapters,cached_chapters,state,last_error,updated_at) values(?,?,?,?,?,?,?) on conflict(source_id,book_url) do update set total_chapters=excluded.total_chapters,cached_chapters=excluded.cached_chapters,state=excluded.state,last_error=excluded.last_error,updated_at=excluded.updated_at").use {
        it.setString(1, sourceId); it.setString(2, bookUrl); it.setInt(3, total); it.setInt(4, cachedCount); it.setString(5, state); it.setString(6, error?.take(500)); it.setLong(7, System.currentTimeMillis()); it.executeUpdate()
    }
}

fun Database.cacheRequests(): List<CachedBookRequest> = connect { db -> db.prepareStatement("select source_id,book_url,toc_url from book_shelf").use { query -> query.executeQuery().use { rs -> buildList { while (rs.next()) add(CachedBookRequest(rs.getString(1), rs.getString(2), rs.getString(3))) } } } }

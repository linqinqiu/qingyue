package io.legado.server

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.sqlite.SQLiteConfig
import java.io.Closeable
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.security.SecureRandom
import java.sql.Connection
import java.util.Base64
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.locks.ReentrantLock
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import kotlin.concurrent.withLock

class Database(private val path: String) : Closeable, AutoCloseable {
    private val random = SecureRandom()
    private val writeLock = ReentrantLock()
    private val readPool = ConcurrentLinkedQueue<Connection>()
    private val maxPoolSize = AppConfig.dbPoolSize
    @Volatile private var isClosed = false
    private var _writeConnection: Connection? = null

    private val sqliteConfig = SQLiteConfig().apply {
        setJournalMode(SQLiteConfig.JournalMode.WAL)
        setSynchronous(SQLiteConfig.SynchronousMode.NORMAL)
        setBusyTimeout(10000)
        enforceForeignKeys(true)
    }

    init { Files.createDirectories(Path.of(path).toAbsolutePath().parent) }

    private fun createConnection(): Connection = sqliteConfig.createConnection("jdbc:sqlite:$path")

    private fun getWriteConnection(): Connection {
        var conn = _writeConnection
        if (conn == null || conn.isClosed) {
            conn = createConnection()
            _writeConnection = conn
        }
        return conn
    }

    private fun <T> connect(block: (Connection) -> T): T {
        check(!isClosed) { "Database is closed" }
        var connection = readPool.poll()?.takeIf { !it.isClosed } ?: createConnection()
        return try {
            val result = block(connection)
            if (!isClosed && !connection.isClosed && readPool.size < maxPoolSize) {
                readPool.offer(connection)
            } else {
                runCatching { connection.close() }
            }
            result
        } catch (error: Throwable) {
            runCatching { connection.close() }
            if (error is java.sql.SQLException && !isClosed) {
                val fresh = createConnection()
                try {
                    val result = block(fresh)
                    if (!isClosed && !fresh.isClosed && readPool.size < maxPoolSize) {
                        readPool.offer(fresh)
                    } else {
                        runCatching { fresh.close() }
                    }
                    result
                } catch (retryError: Throwable) {
                    runCatching { fresh.close() }
                    throw retryError
                }
            } else {
                throw error
            }
        }
    }

    private fun <T> write(block: (Connection) -> T): T = writeLock.withLock {
        check(!isClosed) { "Database is closed" }
        block(getWriteConnection())
    }

    override fun close() {
        if (isClosed) return
        isClosed = true
        writeLock.withLock {
            _writeConnection?.let { conn -> runCatching { conn.close() } }
            _writeConnection = null
        }
        while (true) {
            val conn = readPool.poll() ?: break
            runCatching { conn.close() }
        }
    }

    fun initialize() = write { db ->
        db.createStatement().use { statement ->
            statement.execute("pragma journal_mode = wal")
            statement.executeUpdate("""
                create table if not exists source (
                  id text primary key, name text not null, source_url text not null,
                  source_group text, enabled integer not null, is_js integer not null,
                  payload text not null, version integer not null, updated_at integer not null
                );
                create index if not exists source_name_idx on source(name);
                create index if not exists idx_source_name_nocase on source(name collate nocase);
                create table if not exists reading_progress (
                  source_id text not null, book_url text not null, chapter_url text not null,
                  chapter_index integer not null, updated_at integer not null,
                  primary key (source_id, book_url)
                );
                create table if not exists cover_cache (
                  cache_key text primary key, content_type text not null
                );
                create table if not exists book_shelf (
                  source_id text not null, book_url text not null, name text not null,
                  author text, toc_url text not null, cover_url text, cover_key text,
                  last_read_at integer not null, completed integer not null default 0,
                  alternate_sources text, group_id integer not null default 0,
                  primary key (source_id, book_url)
                );
                create index if not exists book_shelf_last_read_idx on book_shelf(last_read_at desc);
                -- 书架分组（上游 data/entities/BookGroup.kt：主键 groupId、groupName、order）。
                -- 上游另有一批负数虚拟组（IdAll=-1 全部、IdLocal=-2 本地），我们不照抄：
                -- 虚拟组在界面上和真组混在一起会分不清"能不能改名/删除"，所以只做真组 + 未分组(0)。
                create table if not exists book_group (
                  group_id integer primary key, name text not null, sort_order integer not null default 0, created_at integer not null
                );
                create table if not exists book_content_cache (
                  source_id text not null, book_url text not null, chapter_url text not null,
                  title text, content text not null, cached_at integer not null,
                  primary key (source_id, book_url, chapter_url)
                );
                create index if not exists book_content_cache_book_idx on book_content_cache(source_id, book_url);
                create table if not exists book_cache_status (
                  source_id text not null, book_url text not null, total_chapters integer not null default 0,
                  cached_chapters integer not null default 0, state text not null default 'idle',
                  last_error text, updated_at integer not null,
                  primary key (source_id, book_url)
                );
                create table if not exists source_subscription (
                  id integer primary key autoincrement, url text not null unique,
                  enabled integer not null, created_at integer not null, updated_at integer not null,
                  last_success_at integer, last_attempt_at integer, last_error text,
                  last_imported integer not null default 0, content_hash text
                );
                create index if not exists source_subscription_enabled_idx on source_subscription(enabled);
                -- 手机「订阅」页的 RSS 源（上游 data/entities/RssSource.kt，表名 rssSources，主键 sourceUrl）。
                -- 与书源同一套做法：只把列表/筛选要用的字段摊平出来，规则原文整体留在 payload 里交给引擎。
                create table if not exists rss_source (
                  source_url text primary key, name text not null, source_group text, source_icon text,
                  enabled integer not null, has_list_rule integer not null, payload text not null, updated_at integer not null
                );
                create index if not exists rss_source_group_idx on rss_source(source_group);
                create table if not exists book_toc_cache (
                  source_id text not null, toc_url text not null, chapters_json text not null, updated_at integer not null,
                  primary key (source_id, toc_url)
                );
                create table if not exists source_login_state (
                  source_id text primary key,
                  login_info text,
                  login_header text,
                  source_variable text,
                  source_kv text,
                  cookie_jar text,
                  updated_at integer not null
                );
                -- 登录凭据按**注册域**全局存一张表，与上游一致（Cookie.kt 只有 url/cookie 两列，
                -- 键是 NetworkUtils.getSubDomain(url) 的 eTLD+1）。所以「登录一次、所有访问该域
                -- 的书源都带上」是这套语义自带的结果，不需要也不存在"判定某书源是否已登录"的机制。
                -- source_login_state.cookie_jar 是改造前的旧形状，启动时一次性折叠进来后置空。
                create table if not exists cookie (
                  url text primary key,
                  cookie text not null,
                  updated_at integer not null
                );
                create table if not exists replace_rule (
                  id text primary key,
                  name text not null,
                  group_name text,
                  pattern text not null,
                  replacement text not null default '',
                  is_regex integer not null default 1,
                  scope text,
                  exclude_scope text,
                  scope_title integer not null default 0,
                  scope_content integer not null default 1,
                  is_enabled integer not null default 1,
                  sort_order integer not null default 0,
                  timeout_ms integer not null default 3000,
                  created_at integer not null,
                  updated_at integer not null
                );
                create index if not exists idx_replace_rule_enabled on replace_rule(is_enabled, sort_order asc);
                create index if not exists idx_replace_rule_group on replace_rule(group_name);
                -- 结构化日志落库（LogService 文档里承诺的 SQLite 持久化，此前只写了滚动文件）。
                -- 内存队列只有最近 1000 条、进程一退就没；入库后前端「运行日志」才能翻历史、按类别筛。
                create table if not exists log_entry (
                  id integer primary key autoincrement, ts integer not null,
                  category text not null, level text not null, message text not null,
                  context text, stack_trace text
                );
                create index if not exists idx_log_entry_ts on log_entry(ts desc);
                create index if not exists idx_log_entry_category on log_entry(category);
            """.trimIndent())
            // 不再有账号与会话：这台服务不设身份（写操作只留 Guard.kt 的同源闸门）。
            // 老库里的这两张表是死重量，启动时收掉。
            statement.executeUpdate("drop table if exists app_user")
            statement.executeUpdate("drop table if exists session")
        }
        migrateReadingProgress(db)
        migrateBookshelf(db)
        migrateSourceTable(db)
        migrateLegacyCookieJars(db)
    }







    fun listSources(query: String?): List<SourceSummary> = connect { db ->
        val sql = if (query.isNullOrBlank()) {
            "select id, name, source_url, source_group, enabled, is_js, updated_at, version, has_login from source order by name collate nocase"
        } else {
            "select id, name, source_url, source_group, enabled, is_js, updated_at, version, has_login from source where name like ? or source_url like ? order by name collate nocase"
        }
        db.prepareStatement(sql).use { statement ->
            if (!query.isNullOrBlank()) { statement.setString(1, "%$query%"); statement.setString(2, "%$query%") }
            statement.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        add(
                            SourceSummary(
                                id = rs.getString(1),
                                name = rs.getString(2),
                                url = rs.getString(3),
                                group = rs.getString(4),
                                enabled = rs.getInt(5) == 1,
                                isJsSource = rs.getInt(6) == 1,
                                hasLogin = rs.getInt(9) == 1,
                                updatedAt = rs.getLong(7),
                                version = rs.getLong(8),
                            )
                        )
                    }
                }
            }
        }
    }

    fun getSource(id: String): SourceRecord? = connect { db -> db.prepareStatement("select id, payload, version, updated_at from source where id = ?").use {
        it.setString(1, id); it.executeQuery().use { rs -> if (rs.next()) SourceRecord(rs.getString(1), rs.getString(2), rs.getLong(3), rs.getLong(4)) else null }
    } }

    /** 配了「发现」页（exploreUrl 非空）的启用书源，供发现页做书源筛选。 */
    fun listExploreSources(): List<SourceSummary> = connect { db ->
        db.prepareStatement(
            "select id, name, source_url, source_group, enabled, is_js, updated_at, version, has_login, payload from source where enabled = 1 order by name collate nocase"
        ).use { statement ->
            statement.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        val exploreUrl = runCatching {
                            Json.parseToJsonElement(rs.getString(10)).jsonObject["exploreUrl"]?.jsonPrimitive?.contentOrNull
                        }.getOrNull()
                        if (!exploreUrl.isNullOrBlank()) add(rs.toSummary())
                    }
                }
            }
        }
    }

    fun listSearchSourceRecords(sourceIds: List<String>?): List<SourceRecord> = connect { db ->
        val ids = sourceIds?.distinct()?.takeIf { it.isNotEmpty() }
        val sql = if (ids == null) {
            "select id, payload, version, updated_at from source where enabled = 1 order by name collate nocase"
        } else {
            "select id, payload, version, updated_at from source where enabled = 1 and id in (${ids.joinToString(",") { "?" }}) order by name collate nocase"
        }
        db.prepareStatement(sql).use { statement ->
            ids?.forEachIndexed { index, id -> statement.setString(index + 1, id) }
            statement.executeQuery().use { rs -> buildList { while (rs.next()) add(SourceRecord(rs.getString(1), rs.getString(2), rs.getLong(3), rs.getLong(4))) } }
        }
    }

    fun saveSource(parsed: ParsedSource, expectedVersion: Long?): SourceRecord = write { db ->
        db.autoCommit = false
        try {
            val current = db.prepareStatement("select version from source where id = ?").use { it.setString(1, parsed.id); it.executeQuery().use { rs -> if (rs.next()) rs.getLong(1) else null } }
            if (expectedVersion != null && current != expectedVersion) throw VersionConflict()
            val version = (current ?: 0) + 1; val now = System.currentTimeMillis()
            db.prepareStatement("""insert into source(id,name,source_url,source_group,enabled,is_js,payload,version,updated_at,has_login)
                values(?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set name=excluded.name,source_url=excluded.source_url,source_group=excluded.source_group,enabled=excluded.enabled,is_js=excluded.is_js,payload=excluded.payload,version=excluded.version,updated_at=excluded.updated_at,has_login=excluded.has_login""").use {
                it.setString(1, parsed.id); it.setString(2, parsed.name); it.setString(3, parsed.url); it.setString(4, parsed.group); it.setInt(5, if (parsed.enabled) 1 else 0); it.setInt(6, if (parsed.isJs) 1 else 0); it.setString(7, parsed.json); it.setLong(8, version); it.setLong(9, now); it.setInt(10, if (parsed.hasLogin) 1 else 0); it.executeUpdate()
            }
            db.commit(); SourceRecord(parsed.id, parsed.json, version, now)
        } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
    }

    /** 删书源要连它的凭据一起删：`source_login_state` 里是登录头与 Cookie 罐，
     *  留着就是一个已经不再信任的站点的有效凭据。批量删除早就这么做了，单删漏了。 */
    fun deleteSource(id: String): Boolean = write { db ->
        db.autoCommit = false
        try {
            val removed = db.prepareStatement("delete from source where id = ?").use { stmt ->
                stmt.setString(1, id)
                stmt.executeUpdate() == 1
            }
            db.prepareStatement("delete from source_login_state where source_id = ?").use { stmt ->
                stmt.setString(1, id)
                stmt.executeUpdate()
            }
            db.commit()
            removed
        } catch (error: Exception) {
            runCatching { db.rollback() }
            throw error
        } finally {
            db.autoCommit = true
        }
    }

    fun batchUpdateSources(ids: List<String>, action: String, group: String? = null): Int {
        val distinctIds = ids.filter { it.isNotBlank() }.distinct()
        if (distinctIds.isEmpty()) return 0
        val now = System.currentTimeMillis()
        var affectedTotal = 0
        write { db ->
            db.autoCommit = false
            try {
                distinctIds.chunked(200).forEach { chunk ->
                    val placeholders = chunk.joinToString(",") { "?" }
                    when (action) {
                        "enable" -> {
                            val sql = "update source set enabled = 1, updated_at = ? where id in ($placeholders)"
                            db.prepareStatement(sql).use { stmt ->
                                stmt.setLong(1, now)
                                chunk.forEachIndexed { i, id -> stmt.setString(i + 2, id) }
                                affectedTotal += stmt.executeUpdate()
                            }
                        }
                        "disable" -> {
                            val sql = "update source set enabled = 0, updated_at = ? where id in ($placeholders)"
                            db.prepareStatement(sql).use { stmt ->
                                stmt.setLong(1, now)
                                chunk.forEachIndexed { i, id -> stmt.setString(i + 2, id) }
                                affectedTotal += stmt.executeUpdate()
                            }
                        }
                        "set_group" -> {
                            val targetGroup = group?.trim()?.takeIf { it.isNotBlank() }
                            val sql = "update source set source_group = ?, updated_at = ? where id in ($placeholders)"
                            db.prepareStatement(sql).use { stmt ->
                                stmt.setString(1, targetGroup)
                                stmt.setLong(2, now)
                                chunk.forEachIndexed { i, id -> stmt.setString(i + 3, id) }
                                affectedTotal += stmt.executeUpdate()
                            }
                        }
                        // 追加一个标签，而不是覆盖整串：`bookSourceGroup` 是书源作者/用户自己写的分类，
                        // 体检结论只能"再加一档"，冲掉原标签等于用一次探测否掉整库的原始信息。
                        "tag_group" -> {
                            val tag = group?.trim()?.takeIf { it.isNotBlank() }
                                ?: throw IllegalArgumentException("tag_group 需要提供一个标签")
                            val sql = """
                                update source
                                   set source_group = case
                                        when source_group is null or trim(source_group) = '' then ?
                                        when (' ' || replace(replace(source_group, ',', ' '), '，', ' ') || ' ') like ('% ' || ? || ' %') then source_group
                                        else trim(source_group) || ' ' || ?
                                     end,
                                   updated_at = ?
                                 where id in ($placeholders)
                            """.trimIndent()
                            db.prepareStatement(sql).use { stmt ->
                                stmt.setString(1, tag)
                                stmt.setString(2, tag)
                                stmt.setString(3, tag)
                                stmt.setLong(4, now)
                                chunk.forEachIndexed { i, id -> stmt.setString(i + 5, id) }
                                affectedTotal += stmt.executeUpdate()
                            }
                        }
                        // 撤销：只摘掉我们打过的那个标签，其余标签原样留着
                        "untag_group" -> {
                            val tag = group?.trim()?.takeIf { it.isNotBlank() }
                                ?: throw IllegalArgumentException("untag_group 需要提供一个标签")
                            val sql = """
                                update source
                                   set source_group = trim(replace(replace(' ' || coalesce(source_group, '') || ' ', ' ' || ? || ' ', ' '), '  ', ' ')),
                                       updated_at = ?
                                 where id in ($placeholders)
                            """.trimIndent()
                            db.prepareStatement(sql).use { stmt ->
                                stmt.setString(1, tag)
                                stmt.setLong(2, now)
                                chunk.forEachIndexed { i, id -> stmt.setString(i + 3, id) }
                                affectedTotal += stmt.executeUpdate()
                            }
                        }
                        "delete" -> {
                            val delSql = "delete from source where id in ($placeholders)"
                            db.prepareStatement(delSql).use { stmt ->
                                chunk.forEachIndexed { i, id -> stmt.setString(i + 1, id) }
                                affectedTotal += stmt.executeUpdate()
                            }
                            val delLoginSql = "delete from source_login_state where source_id in ($placeholders)"
                            db.prepareStatement(delLoginSql).use { stmt ->
                                chunk.forEachIndexed { i, id -> stmt.setString(i + 1, id) }
                                stmt.executeUpdate()
                            }
                        }
                        else -> throw IllegalArgumentException("不支持的批量操作: $action")
                    }
                }
                db.commit()
            } catch (error: Throwable) {
                db.rollback()
                throw error
            } finally {
                db.autoCommit = true
            }
        }
        return affectedTotal
    }
    fun saveProgress(progress: ReadingProgress): ReadingProgress = write { db ->
        val now = System.currentTimeMillis()
        db.prepareStatement("""insert into reading_progress(source_id,book_url,chapter_url,chapter_index,scroll_position,updated_at) values(?,?,?,?,?,?)
            on conflict(source_id,book_url) do update set chapter_url=excluded.chapter_url,chapter_index=excluded.chapter_index,scroll_position=excluded.scroll_position,updated_at=excluded.updated_at""").use {
            it.setString(1, progress.sourceId); it.setString(2, progress.bookUrl); it.setString(3, progress.chapterUrl); it.setInt(4, progress.chapterIndex); it.setDouble(5, progress.scrollPosition); it.setLong(6, now); it.executeUpdate()
        }
        db.prepareStatement("update book_shelf set last_read_at=? where source_id=? and book_url=?").use {
            it.setLong(1, now); it.setString(2, progress.sourceId); it.setString(3, progress.bookUrl); it.executeUpdate()
        }
        progress.copy(updatedAt = now)
    }
    fun getProgress(sourceId: String, bookUrl: String): ReadingProgress? = connect { db -> db.prepareStatement("select source_id,book_url,chapter_url,chapter_index,scroll_position,updated_at from reading_progress where source_id=? and book_url=?").use {
        it.setString(1, sourceId); it.setString(2, bookUrl); it.executeQuery().use { rs -> if (rs.next()) ReadingProgress(rs.getString(1), rs.getString(2), rs.getString(3), rs.getInt(4), rs.getDouble(5), rs.getLong(6)) else null }
    } }
    fun saveBookshelf(request: BookshelfWriteRequest, cover: CachedCover?): BookshelfItem = write { db ->
        val now = System.currentTimeMillis()
        db.autoCommit = false
        try {
            cover?.let { value -> db.prepareStatement("insert into cover_cache(cache_key,content_type) values(?,?) on conflict(cache_key) do update set content_type=excluded.content_type").use { it.setString(1, value.key); it.setString(2, value.contentType); it.executeUpdate() } }
            val altJson = request.alternateSources?.let { Json.encodeToString(it) }
            db.prepareStatement("""insert into book_shelf(source_id,book_url,name,author,toc_url,cover_url,cover_key,last_read_at,alternate_sources) values(?,?,?,?,?,?,?,?,?)
                on conflict(source_id,book_url) do update set name=excluded.name,author=excluded.author,toc_url=excluded.toc_url,cover_url=excluded.cover_url,cover_key=coalesce(excluded.cover_key,book_shelf.cover_key),last_read_at=excluded.last_read_at,alternate_sources=coalesce(excluded.alternate_sources,book_shelf.alternate_sources)""").use {
                it.setString(1, request.sourceId); it.setString(2, request.bookUrl); it.setString(3, request.name); it.setString(4, request.author); it.setString(5, request.tocUrl); it.setString(6, request.coverUrl); it.setString(7, cover?.key); it.setLong(8, now); it.setString(9, altJson); it.executeUpdate()
            }
            db.commit(); getBookshelf(db, request.sourceId, request.bookUrl)!!
        } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
    }
    fun updateBookshelfCover(sourceId: String, bookUrl: String, coverKey: String, contentType: String = "image/*"): Boolean = write { db ->
        val exists = db.prepareStatement("select 1 from book_shelf where source_id=? and book_url=?").use { stmt ->
            stmt.setString(1, sourceId)
            stmt.setString(2, bookUrl)
            stmt.executeQuery().use { rs -> rs.next() }
        }
        if (!exists) return@write false

        db.prepareStatement("insert into cover_cache(cache_key,content_type) values(?,?) on conflict(cache_key) do update set content_type=excluded.content_type").use {
            it.setString(1, coverKey)
            it.setString(2, contentType)
            it.executeUpdate()
        }
        db.prepareStatement("update book_shelf set cover_key=? where source_id=? and book_url=?").use {
            it.setString(1, coverKey)
            it.setString(2, sourceId)
            it.setString(3, bookUrl)
            it.executeUpdate() > 0
        }
    }
    fun listBookshelf(): List<BookshelfItem> = connect { db -> db.prepareStatement(SHELF_SELECT + " order by s.last_read_at desc").use { query -> query.executeQuery().use { rs -> buildList { while (rs.next()) add(rs.toShelf()) } } } }

    /**
     * 单本书的书架记录。规则求值每翻一章都要读一次上下文，
     * 不能拿 listBookshelf() 的全表 JOIN 顶替 —— 离线缓存一本 5,000 章的书就是 5,000 次全表扫。
     */
    fun shelfBook(sourceId: String, bookUrl: String): BookshelfItem? = connect { db ->
        db.prepareStatement(SHELF_SELECT + " where s.source_id=? and s.book_url=? limit 1").use {
            it.setString(1, sourceId); it.setString(2, bookUrl)
            it.executeQuery().use { rs -> if (rs.next()) rs.toShelf() else null }
        }
    }
    fun setBookshelfCompleted(sourceId: String, bookUrl: String, completed: Boolean): BookshelfItem? = write { db ->
        db.prepareStatement("update book_shelf set completed=? where source_id=? and book_url=?").use {
            it.setInt(1, if (completed) 1 else 0); it.setString(2, sourceId); it.setString(3, bookUrl); it.executeUpdate()
        }
        getBookshelf(db, sourceId, bookUrl)
    }

    /** 分组列表带每组本数。「未分组」不是一条组记录，是 `group_id = 0` 那一档，界面自己给。 */
    fun listBookGroups(): List<BookGroup> = connect { db ->
        db.prepareStatement("""select g.group_id, g.name,
            (select count(*) from book_shelf s where s.group_id = g.group_id) as book_count
            from book_group g order by g.sort_order, g.name collate nocase""").use { query ->
            query.executeQuery().use { rs -> buildList { while (rs.next()) add(BookGroup(rs.getLong(1), rs.getString(2), rs.getInt(3))) } }
        }
    }

    fun createBookGroup(name: String): BookGroup {
        val trimmed = name.trim()
        require(trimmed.isNotEmpty()) { "分组名不能为空" }
        require(trimmed.length <= 24) { "分组名最长 24 字" }
        return write { db ->
            db.prepareStatement("select group_id from book_group where name = ? collate nocase").use { find ->
                find.setString(1, trimmed)
                find.executeQuery().use { rs ->
                    if (rs.next()) return@write BookGroup(rs.getLong(1), trimmed, countBooksInGroup(db, rs.getLong(1)))
                }
            }
            val id = db.prepareStatement("select coalesce(max(group_id), 0) + 1 from book_group").use { q ->
                q.executeQuery().use { rs -> rs.next(); rs.getLong(1) }
            }
            db.prepareStatement("insert into book_group(group_id, name, sort_order, created_at) values(?,?,?,?)").use {
                it.setLong(1, id); it.setString(2, trimmed); it.setInt(3, id.toInt()); it.setLong(4, System.currentTimeMillis())
                it.executeUpdate()
            }
            BookGroup(id, trimmed, 0)
        }
    }

    /** 删组不删书：组里的书回到「未分组」。 */
    fun deleteBookGroup(groupId: Long): Boolean = write { db ->
        if (groupId == 0L) return@write false
        val removed = db.prepareStatement("delete from book_group where group_id=?").use { it.setLong(1, groupId); it.executeUpdate() } == 1
        if (removed) db.prepareStatement("update book_shelf set group_id=0 where group_id=?").use { it.setLong(1, groupId); it.executeUpdate() }
        removed
    }

    fun assignBookGroup(sourceId: String, bookUrl: String, groupId: Long): BookshelfItem? = write { db ->
        if (groupId != 0L && !bookGroupExists(db, groupId)) return@write null
        db.prepareStatement("update book_shelf set group_id=? where source_id=? and book_url=?").use {
            it.setLong(1, groupId); it.setString(2, sourceId); it.setString(3, bookUrl); it.executeUpdate()
        }
        getBookshelf(db, sourceId, bookUrl)
    }

    private fun bookGroupExists(db: Connection, groupId: Long): Boolean =
        db.prepareStatement("select 1 from book_group where group_id=?").use { it.setLong(1, groupId); it.executeQuery().next() }

    private fun countBooksInGroup(db: Connection, groupId: Long): Int =
        db.prepareStatement("select count(*) from book_shelf where group_id=?").use { it.setLong(1, groupId); it.executeQuery().use { rs -> rs.next(); rs.getInt(1) } }

    fun updateBookshelfInfo(request: BookshelfInfoUpdateRequest, cover: CachedCover?): BookshelfItem? = write { db ->
        db.autoCommit = false
        try {
            var found = false
            var oldCover: String? = null
            db.prepareStatement("select cover_key from book_shelf where source_id=? and book_url=?").use {
                it.setString(1, request.sourceId); it.setString(2, request.bookUrl)
                it.executeQuery().use { rs ->
                    if (rs.next()) {
                        found = true
                        oldCover = rs.getString(1)
                    }
                }
            }
            if (!found) return@write null

            cover?.let { value ->
                db.prepareStatement("insert into cover_cache(cache_key,content_type) values(?,?) on conflict(cache_key) do update set content_type=excluded.content_type").use {
                    it.setString(1, value.key); it.setString(2, value.contentType); it.executeUpdate()
                }
            }

            val newCoverKey = cover?.key ?: (if (request.coverUrl != null && request.coverUrl.isBlank()) null else oldCover)

            db.prepareStatement("update book_shelf set name=?, author=?, cover_url=?, cover_key=? where source_id=? and book_url=?").use {
                it.setString(1, request.name)
                it.setString(2, request.author)
                it.setString(3, request.coverUrl)
                it.setString(4, newCoverKey)
                it.setString(5, request.sourceId)
                it.setString(6, request.bookUrl)
                it.executeUpdate()
            }

            val orphan = oldCover.takeIf { value ->
                value != newCoverKey && db.prepareStatement("select 1 from book_shelf where cover_key=?").use {
                    it.setString(1, value); !it.executeQuery().next()
                }
            }
            orphan?.let { value -> db.prepareStatement("delete from cover_cache where cache_key=?").use { it.setString(1, value); it.executeUpdate() } }
            db.commit()
            getBookshelf(db, request.sourceId, request.bookUrl)
        } catch (error: Throwable) {
            db.rollback(); throw error
        } finally {
            db.autoCommit = true
        }
    }
    fun removeBookshelf(sourceId: String, bookUrl: String): String? = write { db ->
        db.autoCommit = false
        try {
            val key = db.prepareStatement("select cover_key from book_shelf where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null } }
            db.prepareStatement("delete from book_shelf where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeUpdate() }
            db.prepareStatement("delete from reading_progress where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeUpdate() }
            db.prepareStatement("delete from book_content_cache where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeUpdate() }
            db.prepareStatement("delete from book_cache_status where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeUpdate() }
            // 用 instr 而不是 like '%x%'：bookUrl 里的 `%`/`_` 会被 LIKE 当通配符，删一本书会连带删掉别的书的目录缓存。
            db.prepareStatement("delete from book_toc_cache where source_id=? and (toc_url=? or instr(toc_url, ?) > 0)").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.setString(3, bookUrl); it.executeUpdate() }
            val orphan = key?.takeIf { value -> db.prepareStatement("select 1 from book_shelf where cover_key=?").use { it.setString(1, value); !it.executeQuery().next() } }
            orphan?.let { value -> db.prepareStatement("delete from cover_cache where cache_key=?").use { it.setString(1, value); it.executeUpdate() } }
            db.commit(); orphan
        } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
    }
    
    /** 批量删除多本书籍（事务内执行，失败回滚） */
    fun batchRemoveBookshelf(books: List<BookIdentifier>): Int = write { db ->
        db.autoCommit = false
        var deletedCount = 0
        try {
            for (book in books) {
                if (book.sourceId.isBlank() || book.bookUrl.isBlank()) continue
                db.prepareStatement("delete from book_shelf where source_id=? and book_url=?").use { 
                    it.setString(1, book.sourceId); it.setString(2, book.bookUrl); it.executeUpdate() 
                }
                db.prepareStatement("delete from reading_progress where source_id=? and book_url=?").use { 
                    it.setString(1, book.sourceId); it.setString(2, book.bookUrl); it.executeUpdate() 
                }
                db.prepareStatement("delete from book_content_cache where source_id=? and book_url=?").use { 
                    it.setString(1, book.sourceId); it.setString(2, book.bookUrl); it.executeUpdate() 
                }
                db.prepareStatement("delete from book_cache_status where source_id=? and book_url=?").use { 
                    it.setString(1, book.sourceId); it.setString(2, book.bookUrl); it.executeUpdate() 
                }
                db.prepareStatement("delete from book_toc_cache where source_id=? and (toc_url=? or instr(toc_url, ?) > 0)").use { 
                    it.setString(1, book.sourceId); it.setString(2, book.bookUrl); it.setString(3, book.bookUrl); it.executeUpdate() 
                }
                deletedCount++
            }
            db.commit()
        } catch (error: Throwable) { 
            db.rollback()
            throw error 
        } finally { 
            db.autoCommit = true 
        }
        deletedCount
    }
    
    /** 批量更新书籍分组 */
    fun batchUpdateBookshelfGroup(books: List<BookIdentifier>, groupId: Long?): Int = write { db ->
        db.autoCommit = false
        var updatedCount = 0
        try {
            for (book in books) {
                if (book.sourceId.isBlank() || book.bookUrl.isBlank()) continue
                db.prepareStatement("update book_shelf set group_id=? where source_id=? and book_url=?").use { 
                    if (groupId == null) it.setNull(1, java.sql.Types.BIGINT) else it.setLong(1, groupId)
                    it.setString(2, book.sourceId); it.setString(3, book.bookUrl)
                    it.executeUpdate() 
                }
                updatedCount++
            }
            db.commit()
        } catch (error: Throwable) { 
            db.rollback()
            throw error 
        } finally { 
            db.autoCommit = true 
        }
        updatedCount
    }
    
    /** 标记书籍为已读/未读（通过阅读进度实现） */
    fun markBookReadStatus(sourceId: String, bookUrl: String, isRead: Boolean) = write { db ->
        if (isRead) {
            // 已读：将进度设为最后一章最后一段
            val chapters = getTocCache(sourceId, bookUrl)
            if (!chapters.isNullOrEmpty()) {
                val lastChapter = chapters.last()
                saveProgress(ReadingProgress(
                    sourceId = sourceId,
                    bookUrl = bookUrl,
                    chapterUrl = lastChapter.url,
                    chapterIndex = lastChapter.index,
                    scrollPosition = 1.0,
                    updatedAt = System.currentTimeMillis()
                ))
            }
        } else {
            // 未读：清除阅读进度
            db.prepareStatement("delete from reading_progress where source_id=? and book_url=?").use { 
                it.setString(1, sourceId); it.setString(2, bookUrl); it.executeUpdate() 
            }
        }
    }
    fun switchBookshelf(oldSourceId: String, oldBookUrl: String, request: BookshelfWriteRequest, cover: CachedCover?, alternateSources: List<SearchResult>? = null): Pair<BookshelfItem, String?> = write { db ->
        val now = System.currentTimeMillis()
        db.autoCommit = false
        try {
            val oldCover = db.prepareStatement("select cover_key from book_shelf where source_id=? and book_url=?").use { it.setString(1, oldSourceId); it.setString(2, oldBookUrl); it.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null } }
            val existingAlts = db.prepareStatement("select alternate_sources from book_shelf where source_id=? and book_url=?").use {
                it.setString(1, oldSourceId); it.setString(2, oldBookUrl)
                it.executeQuery().use { rs ->
                    if (rs.next()) rs.getString(1)?.let { raw -> runCatching { Json.decodeFromString<List<SearchResult>>(raw) }.getOrNull() } else null
                }
            } ?: emptyList()
            val oldSourceResult = SearchResult(sourceId = oldSourceId, name = request.name, author = request.author, bookUrl = oldBookUrl)
            val incomingAlts = alternateSources ?: request.alternateSources ?: emptyList()
            val combinedAlts = (listOf(oldSourceResult) + existingAlts + incomingAlts)
                .filter { it.sourceId != request.sourceId || it.bookUrl != request.bookUrl }
                .distinctBy { "${it.sourceId}\u0000${it.bookUrl}" }
            val altJson = Json.encodeToString(combinedAlts)

            db.prepareStatement("delete from book_shelf where source_id=? and book_url=?").use { it.setString(1, oldSourceId); it.setString(2, oldBookUrl); it.executeUpdate() }
            db.prepareStatement("delete from reading_progress where source_id=? and book_url=?").use { it.setString(1, oldSourceId); it.setString(2, oldBookUrl); it.executeUpdate() }
            db.prepareStatement("delete from book_content_cache where source_id=? and book_url=?").use { it.setString(1, oldSourceId); it.setString(2, oldBookUrl); it.executeUpdate() }
            db.prepareStatement("delete from book_cache_status where source_id=? and book_url=?").use { it.setString(1, oldSourceId); it.setString(2, oldBookUrl); it.executeUpdate() }
            db.prepareStatement("delete from book_toc_cache where source_id=? and (toc_url=? or instr(toc_url, ?) > 0)").use { it.setString(1, oldSourceId); it.setString(2, oldBookUrl); it.setString(3, oldBookUrl); it.executeUpdate() }
            cover?.let { value -> db.prepareStatement("insert into cover_cache(cache_key,content_type) values(?,?) on conflict(cache_key) do update set content_type=excluded.content_type").use { it.setString(1, value.key); it.setString(2, value.contentType); it.executeUpdate() } }
            val newCoverKey = cover?.key ?: oldCover
            db.prepareStatement("""insert into book_shelf(source_id,book_url,name,author,toc_url,cover_url,cover_key,last_read_at,alternate_sources) values(?,?,?,?,?,?,?,?,?)
                on conflict(source_id,book_url) do update set name=excluded.name,author=excluded.author,toc_url=excluded.toc_url,cover_url=coalesce(excluded.cover_url,book_shelf.cover_url),cover_key=coalesce(excluded.cover_key,book_shelf.cover_key),last_read_at=excluded.last_read_at,alternate_sources=excluded.alternate_sources""").use {
                it.setString(1, request.sourceId); it.setString(2, request.bookUrl); it.setString(3, request.name); it.setString(4, request.author); it.setString(5, request.tocUrl); it.setString(6, request.coverUrl); it.setString(7, newCoverKey); it.setLong(8, now); it.setString(9, altJson); it.executeUpdate()
            }
            val orphan = oldCover?.takeIf { value -> value != newCoverKey && db.prepareStatement("select 1 from book_shelf where cover_key=?").use { it.setString(1, value); !it.executeQuery().next() } }
            orphan?.let { value -> db.prepareStatement("delete from cover_cache where cache_key=?").use { it.setString(1, value); it.executeUpdate() } }
            db.commit(); getBookshelf(db, request.sourceId, request.bookUrl)!! to orphan
        } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
    }
    fun coverContentType(key: String): String? = connect { db -> db.prepareStatement("select content_type from cover_cache where cache_key=?").use { it.setString(1, key); it.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null } } }

    /**
     * 我们以前替没有封面的本地书生成的假封面（按书名哈希抽五种饱和渐变，一书架下去就是彩虹）。
     * 只认「书架引用着 + 登记为 SVG」这一批：EPUB 自带的真封面是 jpeg/png，不会进来。
     * 是不是我们画的那张由调用方按文件内容判定，这里只负责把候选捞出来。
     */
    fun generatedLocalCoverKeys(): List<String> = connect { db ->
        db.prepareStatement("""select cover_key from book_shelf
            where cover_key is not null
              and cover_key in (select cache_key from cover_cache where content_type = 'image/svg+xml')""").use { query ->
            query.executeQuery().use { rs -> buildList { while (rs.next()) add(rs.getString(1)) } }
        }
    }

    /** 摘掉一张封面：书架引用与缓存登记一起清，界面才会回落到主题化的文字占位。 */
    fun forgetCover(key: String) = write { db ->
        db.prepareStatement("update book_shelf set cover_key = null where cover_key = ?").use { it.setString(1, key); it.executeUpdate() }
        db.prepareStatement("delete from cover_cache where cache_key = ?").use { it.setString(1, key); it.executeUpdate() }
    }

    fun getTocCache(sourceId: String, tocUrl: String): List<Chapter>? = connect { db ->
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

    fun saveTocCache(sourceId: String, tocUrl: String, chapters: List<Chapter>) = write { db ->
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

    fun importLocalBook(
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
                insert into book_shelf(source_id, book_url, name, author, toc_url, cover_url, cover_key, last_read_at, completed, alternate_sources, group_id)
                values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(source_id, book_url) do update set
                    name = excluded.name, author = excluded.author, toc_url = excluded.toc_url,
                    cover_key = coalesce(excluded.cover_key, book_shelf.cover_key),
                    last_read_at = excluded.last_read_at, group_id = excluded.group_id
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

    fun getCachedChaptersFallback(sourceId: String, bookUrl: String): List<Chapter> = connect { db ->
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

    fun cachedContent(sourceId: String, bookUrl: String, chapterUrl: String): ChapterContent? = connect { db -> db.prepareStatement("select title,content from book_content_cache where source_id=? and book_url=? and chapter_url=?").use {
        it.setString(1, sourceId); it.setString(2, bookUrl); it.setString(3, chapterUrl); it.executeQuery().use { rs -> if (rs.next()) ChapterContent(rs.getString(1), rs.getString(2)) else null }
    } }
    fun cachedChapterUrls(sourceId: String, bookUrl: String): Set<String> = connect { db ->
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
    fun clearBookCacheContent(sourceId: String, bookUrl: String): Int = write { db ->
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
    fun updateBookCacheProgress(sourceId: String, bookUrl: String, cachedCount: Int) = write { db ->
        db.prepareStatement("update book_cache_status set cached_chapters = ?, updated_at = ? where source_id = ? and book_url = ?").use { statement ->
            statement.setInt(1, cachedCount)
            statement.setLong(2, System.currentTimeMillis())
            statement.setString(3, sourceId)
            statement.setString(4, bookUrl)
            statement.executeUpdate()
        }
    }
    fun cacheBookContent(sourceId: String, bookUrl: String, chapterUrl: String, content: ChapterContent): Unit = write { db ->
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
    fun beginBookCache(sourceId: String, bookUrl: String, total: Int) = write { db -> db.prepareStatement("insert into book_cache_status(source_id,book_url,total_chapters,cached_chapters,state,last_error,updated_at) values(?,?,?,?,?,?,?) on conflict(source_id,book_url) do update set total_chapters=excluded.total_chapters,cached_chapters=excluded.cached_chapters,state=excluded.state,last_error=null,updated_at=excluded.updated_at").use {
        val count = db.prepareStatement("select count(*) from book_content_cache where source_id=? and book_url=?").use { query -> query.setString(1, sourceId); query.setString(2, bookUrl); query.executeQuery().use { rs -> rs.next(); rs.getInt(1) } }
        it.setString(1, sourceId); it.setString(2, bookUrl); it.setInt(3, total); it.setInt(4, count); it.setString(5, "caching"); it.setString(6, null); it.setLong(7, System.currentTimeMillis()); it.executeUpdate()
    } }
    fun finishBookCache(sourceId: String, bookUrl: String, error: String? = null) = write { db ->
        val state = if (error == null) "ready" else "failed"
        val cachedCount = db.prepareStatement("select count(*) from book_content_cache where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeQuery().use { rs -> rs.next(); rs.getInt(1) } }
        val existingTotal = db.prepareStatement("select total_chapters from book_cache_status where source_id=? and book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeQuery().use { rs -> if (rs.next()) rs.getInt(1) else 0 } }
        val total = if (existingTotal > 0) existingTotal else cachedCount
        db.prepareStatement("insert into book_cache_status(source_id,book_url,total_chapters,cached_chapters,state,last_error,updated_at) values(?,?,?,?,?,?,?) on conflict(source_id,book_url) do update set total_chapters=excluded.total_chapters,cached_chapters=excluded.cached_chapters,state=excluded.state,last_error=excluded.last_error,updated_at=excluded.updated_at").use {
            it.setString(1, sourceId); it.setString(2, bookUrl); it.setInt(3, total); it.setInt(4, cachedCount); it.setString(5, state); it.setString(6, error?.take(500)); it.setLong(7, System.currentTimeMillis()); it.executeUpdate()
        }
    }

    fun cacheRequests(): List<CachedBookRequest> = connect { db -> db.prepareStatement("select source_id,book_url,toc_url from book_shelf").use { query -> query.executeQuery().use { rs -> buildList { while (rs.next()) add(CachedBookRequest(rs.getString(1), rs.getString(2), rs.getString(3))) } } } }

    fun importSources(rawSources: List<String>): ImportResponse {
        val errors = mutableListOf<String>()
        val unique = linkedMapOf<String, ParsedSource>()
        rawSources.forEachIndexed { index, raw ->
            try {
                val parsed = SourceCodec.parse(raw)
                unique[parsed.id] = parsed
            } catch (error: IllegalArgumentException) {
                errors += "第 ${index + 1} 项：${error.message}"
            }
        }
        var imported = 0
        var updated = 0
        write { db ->
            db.autoCommit = false
            try {
                db.prepareStatement("select version from source where id = ?").use { current ->
                    // `enabled` 故意**不在** on conflict 的赋值列表里：已在库的书源保留本机的启用/停用选择。
                    // 上游手机是单机恢复自己的状态，整体覆盖没问题；这台服务器与手机已经分叉 ——
                    // 库里 4,876 源只启用 2 个是用户的策展，而手机备份里 7,278 个是 enabled=true，
                    // 一旦覆盖就是一次批量启用事故（用户口径：「到时候我自行决定」）。新入库的源仍按包内值。
                    db.prepareStatement("""insert into source(id,name,source_url,source_group,enabled,is_js,payload,version,updated_at,has_login)
                        values(?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set name=excluded.name,source_url=excluded.source_url,source_group=excluded.source_group,is_js=excluded.is_js,payload=excluded.payload,version=excluded.version,updated_at=excluded.updated_at,has_login=excluded.has_login""").use { save ->
                        unique.values.forEach { parsed ->
                            current.setString(1, parsed.id)
                            val version = current.executeQuery().use { result -> if (result.next()) result.getLong(1) else null }
                            if (version == null) imported++ else updated++
                            save.setString(1, parsed.id); save.setString(2, parsed.name); save.setString(3, parsed.url); save.setString(4, parsed.group)
                            save.setInt(5, if (parsed.enabled) 1 else 0); save.setInt(6, if (parsed.isJs) 1 else 0); save.setString(7, parsed.json)
                            save.setLong(8, (version ?: 0) + 1); save.setLong(9, System.currentTimeMillis()); save.setInt(10, if (parsed.hasLogin) 1 else 0); save.addBatch()
                        }
                        save.executeBatch()
                    }
                }
                db.commit()
            } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
        }
        return ImportResponse(imported, updated, rawSources.size - unique.size, errors)
    }

    /**
     * RSS 订阅源落库（备份包 `rssSources.json`、界面粘贴的 JSON 数组都走这里）。
     * 主键是 `sourceUrl`，同地址再导入是整体覆盖 —— 与上游 `Restore.kt` 的
     * `rssSourceDao.insert`（`@Insert(onConflict = REPLACE)`）同语义，不保留本地改动。
     */
    fun importRssSources(rawSources: List<String>): ImportResponse {
        val errors = mutableListOf<String>()
        val unique = linkedMapOf<String, ParsedRssSource>()
        rawSources.forEachIndexed { index, raw ->
            try {
                val parsed = SourceCodec.parseRss(raw)
                unique[parsed.sourceUrl] = parsed
            } catch (error: IllegalArgumentException) {
                errors += "第 ${index + 1} 项：${error.message}"
            }
        }
        if (unique.isEmpty()) return ImportResponse(0, 0, 0, errors)
        var imported = 0
        var updated = 0
        write { db ->
            db.autoCommit = false
            try {
                db.prepareStatement("select 1 from rss_source where source_url = ?").use { current ->
                    db.prepareStatement("""insert into rss_source(source_url,name,source_group,source_icon,enabled,has_list_rule,payload,updated_at)
                        values(?,?,?,?,?,?,?,?) on conflict(source_url) do update set name=excluded.name,
                          source_group=excluded.source_group,source_icon=excluded.source_icon,enabled=excluded.enabled,
                          has_list_rule=excluded.has_list_rule,payload=excluded.payload,updated_at=excluded.updated_at""").use { save ->
                        val now = System.currentTimeMillis()
                        unique.values.forEach { parsed ->
                            current.setString(1, parsed.sourceUrl)
                            if (current.executeQuery().use { it.next() }) updated++ else imported++
                            save.setString(1, parsed.sourceUrl); save.setString(2, parsed.name); save.setString(3, parsed.group)
                            save.setString(4, parsed.icon); save.setInt(5, if (parsed.enabled) 1 else 0)
                            save.setInt(6, if (parsed.hasListRule) 1 else 0); save.setString(7, parsed.json)
                            save.setLong(8, now); save.addBatch()
                        }
                        save.executeBatch()
                    }
                }
                db.commit()
            } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
        }
        return ImportResponse(imported, updated, rawSources.size - unique.size, errors)
    }

    /**
     * 恢复手机备份里的 `bookGroup.json`（上游 `Backup.kt:285` ← `bookGroupDao.all`，
     * 字段是 `groupId/groupName/cover/order/…`，见 §2.1）。
     *
     * **不照抄手机那套号码**：`groupId` 是手机自己库里的自增号，本机同号可能完全是另一个组
     * （本机 1 号往往已经是导入本地书时建的「本地」）。所以按名字找已有组、没有就新建，
     * 返回「手机号 → 本机号」映射给书架条目落组用；同名组只留一个，重复导入不堆第二份。
     */
    fun importBookGroups(groups: List<Pair<Long, String>>): Map<Long, Long> {
        val mapping = LinkedHashMap<Long, Long>()
        if (groups.isEmpty()) return mapping
        write { db ->
            db.autoCommit = false
            try {
                groups.forEach { (phoneId, rawName) ->
                    val name = rawName.trim()
                    if (phoneId <= 0 || name.isEmpty() || name == "全部" || mapping.containsKey(phoneId)) return@forEach
                    val existing = db.prepareStatement("select group_id from book_group where name = ? collate nocase").use { find ->
                        find.setString(1, name)
                        find.executeQuery().use { rs -> if (rs.next()) rs.getLong(1) else null }
                    }
                    val localId = existing ?: db.prepareStatement("select coalesce(max(group_id), 0) + 1 from book_group").use { q ->
                        q.executeQuery().use { rs -> rs.next(); rs.getLong(1) }
                    }.also { id ->
                        db.prepareStatement("insert into book_group(group_id, name, sort_order, created_at) values(?,?,?,?)").use {
                            it.setLong(1, id); it.setString(2, name); it.setInt(3, id.toInt()); it.setLong(4, System.currentTimeMillis())
                            it.executeUpdate()
                        }
                    }
                    mapping[phoneId] = localId
                }
                db.commit()
            } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
        }
        return mapping
    }

    fun listRssSources(query: String?): List<RssSourceSummary> = connect { db ->
        val columns = "select source_url, name, source_group, source_icon, enabled, has_list_rule, updated_at from rss_source"
        val sql = if (query.isNullOrBlank()) "$columns order by name collate nocase"
        else "$columns where name like ? or source_url like ? or source_group like ? order by name collate nocase"
        db.prepareStatement(sql).use { statement ->
            if (!query.isNullOrBlank()) {
                val like = "%${query.replace("%", "").replace("_", "")}%"
                statement.setString(1, like); statement.setString(2, like); statement.setString(3, like)
            }
            statement.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) add(
                        RssSourceSummary(
                            sourceUrl = rs.getString(1),
                            name = rs.getString(2),
                            group = rs.getString(3),
                            icon = rs.getString(4),
                            enabled = rs.getInt(5) == 1,
                            hasListRule = rs.getInt(6) == 1,
                            updatedAt = rs.getLong(7),
                        )
                    )
                }
            }
        }
    }

    fun getRssSource(sourceUrl: String): String? = connect { db ->
        db.prepareStatement("select payload from rss_source where source_url=?").use { statement ->
            statement.setString(1, sourceUrl)
            statement.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
        }
    }

    /** 停用的订阅源不替它发起抓取：界面上「已停用」必须真的挡住请求，否则这个开关是装饰品。 */
    fun rssSourceIsEnabled(sourceUrl: String): Boolean = connect { db ->
        db.prepareStatement("select enabled from rss_source where source_url=?").use { statement ->
            statement.setString(1, sourceUrl)
            statement.executeQuery().use { rs -> rs.next() && rs.getInt(1) == 1 }
        }
    }

    fun setRssSourceEnabled(sourceUrl: String, enabled: Boolean): Boolean = write { db ->
        db.prepareStatement("update rss_source set enabled=?, updated_at=? where source_url=?").use { statement ->
            statement.setInt(1, if (enabled) 1 else 0)
            statement.setLong(2, System.currentTimeMillis())
            statement.setString(3, sourceUrl)
            statement.executeUpdate() == 1
        }
    }

    fun deleteRssSource(sourceUrl: String): Boolean = write { db ->
        db.prepareStatement("delete from rss_source where source_url=?").use { statement ->
            statement.setString(1, sourceUrl)
            statement.executeUpdate() == 1
        }
    }

    /**
     * 备份导入：批量写入书架条目，并写入阅读进度（仅当备份时间不早于库中进度时覆盖，避免进度回退）。
     * 备份包只带章节序号与字符偏移，因此 [BackupShelfEntry.chapterIndex] 之外的定位信息不落库。
     */
    fun importLibrary(entries: List<BackupShelfEntry>): LibraryImportResult {
        if (entries.isEmpty()) return LibraryImportResult(0, 0, 0)
        val now = System.currentTimeMillis()
        var imported = 0
        var updated = 0
        var progressApplied = 0
        write { db ->
            db.autoCommit = false
            try {
                db.prepareStatement("select 1 from book_shelf where source_id = ? and book_url = ?").use { existing ->
                    db.prepareStatement("""
                        insert into book_shelf(source_id,book_url,name,author,toc_url,cover_url,cover_key,last_read_at,completed,alternate_sources,group_id)
                        values(?,?,?,?,?,?,null,?,?,null,?)
                        on conflict(source_id,book_url) do update set
                          name=excluded.name, author=excluded.author, toc_url=excluded.toc_url,
                          cover_url=coalesce(excluded.cover_url,book_shelf.cover_url),
                          last_read_at=excluded.last_read_at, completed=excluded.completed
                    """.trimIndent()).use { save ->
                        entries.forEach { entry ->
                            existing.setString(1, entry.sourceId); existing.setString(2, entry.bookUrl)
                            if (existing.executeQuery().use { it.next() }) updated++ else imported++
                            save.setString(1, entry.sourceId); save.setString(2, entry.bookUrl); save.setString(3, entry.name)
                            save.setString(4, entry.author); save.setString(5, entry.tocUrl); save.setString(6, entry.coverUrl)
                            save.setLong(7, if (entry.readAt > 0) entry.readAt else now)
                            save.setInt(8, if (entry.completed) 1 else 0)
                            // 组号只在"新书进架"时生效（on conflict 那串里没有它）：
                            // 已在架的书保留本机分组，理由与书源 enabled 一样 —— 本机策展不被备份冲掉。
                            save.setLong(9, entry.groupId)
                            save.addBatch()
                        }
                        save.executeBatch()
                    }
                }
                val progressed = entries.filter { it.chapterIndex > 0 }
                if (progressed.isNotEmpty()) {
                    db.prepareStatement("""
                        insert into reading_progress(source_id,book_url,chapter_url,chapter_index,scroll_position,updated_at)
                        values(?,?,?,?,0,?)
                        on conflict(source_id,book_url) do update set
                          chapter_url=excluded.chapter_url, chapter_index=excluded.chapter_index, updated_at=excluded.updated_at
                        where excluded.updated_at >= reading_progress.updated_at
                    """.trimIndent()).use { stmt ->
                        progressed.forEach { entry ->
                            stmt.setString(1, entry.sourceId); stmt.setString(2, entry.bookUrl); stmt.setString(3, "")
                            stmt.setInt(4, entry.chapterIndex); stmt.setLong(5, if (entry.readAt > 0) entry.readAt else now)
                            stmt.addBatch()
                        }
                        progressApplied = stmt.executeBatch().sum()
                    }
                }
                db.commit()
            } catch (error: Throwable) { db.rollback(); throw error } finally { db.autoCommit = true }
        }
        return LibraryImportResult(imported, updated, progressApplied)
    }

    fun listSubscriptions(enabledOnly: Boolean = false): List<SourceSubscription> = connect { db ->
        val sql = "select * from source_subscription" + (if (enabledOnly) " where enabled=1" else "") + " order by id"
        db.prepareStatement(sql).use { statement -> statement.executeQuery().use { rs -> buildList { while (rs.next()) add(rs.toSubscription()) } } }
    }

    fun saveSubscription(request: SubscriptionWriteRequest): SourceSubscription = write { db ->
        val now = System.currentTimeMillis()
        db.prepareStatement("""insert into source_subscription(url,enabled,created_at,updated_at) values(?,?,?,?)
            on conflict(url) do update set enabled=excluded.enabled,updated_at=excluded.updated_at""").use {
            it.setString(1, request.url); it.setInt(2, if (request.enabled) 1 else 0); it.setLong(3, now); it.setLong(4, now); it.executeUpdate()
        }
        db.prepareStatement("select * from source_subscription where url=?").use { it.setString(1, request.url); it.executeQuery().use { rs -> rs.next(); rs.toSubscription() } }
    }

    fun getSubscription(id: Long): SourceSubscription? = connect { db -> db.prepareStatement("select * from source_subscription where id=?").use { it.setLong(1, id); it.executeQuery().use { rs -> if (rs.next()) rs.toSubscription() else null } } }
    fun deleteSubscription(id: Long): Boolean = write { db -> db.prepareStatement("delete from source_subscription where id=?").use { it.setLong(1, id); it.executeUpdate() == 1 } }
    fun recordSubscriptionSuccess(id: Long, response: ImportResponse, contentHash: String) = write { db ->
        val now = System.currentTimeMillis()
        db.prepareStatement("update source_subscription set last_success_at=?,last_attempt_at=?,last_error=null,last_imported=?,content_hash=?,updated_at=? where id=?").use {
            it.setLong(1, now); it.setLong(2, now); it.setInt(3, response.imported + response.updated); it.setString(4, contentHash); it.setLong(5, now); it.setLong(6, id); it.executeUpdate()
        }
    }
    fun recordSubscriptionFailure(id: Long, message: String) = write { db ->
        val now = System.currentTimeMillis()
        db.prepareStatement("update source_subscription set last_attempt_at=?,last_error=?,updated_at=? where id=?").use { it.setLong(1, now); it.setString(2, message.take(500)); it.setLong(3, now); it.setLong(4, id); it.executeUpdate() }
    }

    /** 日志保留上限：只留最近这么多条，超出即从最旧的一头裁掉，防止表无限增长。 */
    private val LOG_RETENTION = 5000

    /**
     * 写一条日志入库；context 以 JSON 存，读回时再还原成 Map。裁剪在同一次写事务里做，避免额外一趟。
     *
     * 返回 rowid，给 [bumpLogRepeat] 用 —— 同类日志在合并窗口里不再插新行，
     * 而是把这一行的 `repeat_count` 加上去。没有 id 就没法合并，只能要么刷屏要么丢信息。
     */
    fun insertLog(entry: LogEntry, ts: Long): Long = write { db ->
        val ctx = if (entry.context.isEmpty()) null else runCatching { Json.encodeToString(entry.context) }.getOrNull()
        db.prepareStatement(
            "insert into log_entry(ts,category,level,message,context,stack_trace,repeat_count) values(?,?,?,?,?,?,?)",
            java.sql.Statement.RETURN_GENERATED_KEYS,
        ).use {
            it.setLong(1, ts); it.setString(2, entry.category); it.setString(3, entry.level); it.setString(4, entry.message)
            it.setString(5, ctx); it.setString(6, entry.stackTrace); it.setInt(7, entry.count.coerceAtLeast(1))
            it.executeUpdate()
            it.generatedKeys.use { keys -> if (keys.next()) keys.getLong(1) else 0L }
        }.also {
            db.prepareStatement("delete from log_entry where id <= (select max(id)-? from log_entry)").use { drop ->
                drop.setInt(1, LOG_RETENTION); drop.executeUpdate()
            }
        }
    }

    /** 同类日志再来一条：不插新行，把计数抬上去（界面上那行会自己变成「×N」）。 */
    fun bumpLogRepeat(id: Long, count: Int) = write { db ->
        db.prepareStatement("update log_entry set repeat_count=? where id=?").use {
            it.setInt(1, count); it.setLong(2, id); it.executeUpdate()
        }
    }


    /** 按类别/等级过滤，倒序取最近 limit 条。category/level 传 null 表示不限。 */
    fun queryLogs(category: String?, level: String?, limit: Int): List<LogEntry> = connect { db ->
        val clauses = mutableListOf<String>()
        if (category != null) clauses.add("category=?")
        if (level != null) clauses.add("level=?")
        val where = if (clauses.isEmpty()) "" else " where " + clauses.joinToString(" and ")
        val sql = "select id,ts,category,level,message,context,stack_trace,repeat_count from log_entry$where order by id desc limit ?"
        db.prepareStatement(sql).use { stmt ->
            var i = 1
            if (category != null) stmt.setString(i++, category)
            if (level != null) stmt.setString(i++, level)
            stmt.setInt(i, limit)
            stmt.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        val ctx: Map<String, String> = rs.getString(6)?.takeIf { it.isNotBlank() }
                            ?.let { raw -> runCatching { Json.decodeFromString<Map<String, String>>(raw) }.getOrDefault(emptyMap()) }
                            ?: emptyMap()
                        val stamp = java.time.Instant.ofEpochMilli(rs.getLong(2))
                            .atZone(java.time.ZoneId.systemDefault()).toLocalDateTime()
                            .format(java.time.format.DateTimeFormatter.ISO_LOCAL_DATE_TIME)
                        add(LogEntry(id = rs.getLong(1), timestamp = stamp, category = rs.getString(3), level = rs.getString(4), message = rs.getString(5), context = ctx, stackTrace = rs.getString(7), count = rs.getInt(8).coerceAtLeast(1)))
                    }
                }
            }
        }
    }

    fun clearLogEntries(): Int = write { db -> db.prepareStatement("delete from log_entry").use { it.executeUpdate() } }

    /**
     * 只建 log_entry 一张表（幂等）。
     * LogService 在 Application 里比 database.initialize() 更早启动，若不自建表，
     * 「服务器启动」这条 SYSTEM 日志会因表不存在而落库失败——而那正是运维最想看到的一条。
     */
    fun ensureLogTable() = write { db ->
        db.createStatement().use {
            it.executeUpdate("""create table if not exists log_entry (
                  id integer primary key autoincrement, ts integer not null,
                  category text not null, level text not null, message text not null,
                  context text, stack_trace text, repeat_count integer not null default 1
                )""")
            it.executeUpdate("create index if not exists idx_log_entry_ts on log_entry(ts desc)")
            it.executeUpdate("create index if not exists idx_log_entry_category on log_entry(category)")
        }
        // 老库（这一列之前不存在）补列。SQLite 的 ADD COLUMN 不幂等，撞 "duplicate column name" 就是已经有了。
        runCatching { db.createStatement().use { it.executeUpdate("alter table log_entry add column repeat_count integer not null default 1") } }
    }

    fun exportSources(ids: List<String>?): List<String> = connect { db ->
        val sql = if (ids.isNullOrEmpty()) "select payload from source order by name collate nocase" else "select payload from source where id in (${ids.joinToString(",") { "?" }}) order by name collate nocase"
        db.prepareStatement(sql).use { statement -> ids?.forEachIndexed { index, id -> statement.setString(index + 1, id) }; statement.executeQuery().use { rs -> buildList { while (rs.next()) add(rs.getString(1)) } } }
    }

    fun getSourceLoginState(sourceId: String): SourceLoginStateRecord? = connect { db ->
        db.prepareStatement("select source_id, login_info, login_header, source_variable, source_kv, cookie_jar, updated_at from source_login_state where source_id = ?").use { stmt ->
            stmt.setString(1, sourceId)
            stmt.executeQuery().use { rs ->
                if (rs.next()) {
                    val loginInfo = rs.getString(2)?.takeIf { it.isNotBlank() }?.let { raw ->
                        runCatching { Json.decodeFromString<Map<String, String>>(raw) }.getOrDefault(emptyMap())
                    } ?: emptyMap()
                    val loginHeader = rs.getString(3)
                    val sourceVariable = rs.getString(4)
                    val sourceKv = rs.getString(5)?.takeIf { it.isNotBlank() }?.let { raw ->
                        runCatching { Json.decodeFromString<Map<String, String>>(raw) }.getOrDefault(emptyMap())
                    } ?: emptyMap()
                    val cookieJar = rs.getString(6)?.takeIf { it.isNotBlank() }?.let { raw ->
                        runCatching { Json.decodeFromString<Map<String, String>>(raw) }.getOrDefault(emptyMap())
                    } ?: emptyMap()
                    val updatedAt = rs.getLong(7)
                    SourceLoginStateRecord(
                        sourceId = rs.getString(1),
                        loginInfo = loginInfo,
                        loginHeader = loginHeader,
                        sourceVariable = sourceVariable,
                        sourceKv = sourceKv,
                        cookieJar = cookieJar,
                        updatedAt = updatedAt,
                    )
                } else null
            }
        }
    }

    fun saveSourceLoginInfo(sourceId: String, loginInfo: Map<String, String>): Boolean = write { db ->
        val now = System.currentTimeMillis()
        val infoJson = Json.encodeToString(loginInfo)
        db.prepareStatement("""
            insert into source_login_state(source_id, login_info, updated_at) values(?, ?, ?)
            on conflict(source_id) do update set login_info=excluded.login_info, updated_at=excluded.updated_at
        """).use { stmt ->
            stmt.setString(1, sourceId)
            stmt.setString(2, infoJson)
            stmt.setLong(3, now)
            stmt.executeUpdate() > 0
        }
    }

    fun saveSourceLoginHeader(sourceId: String, header: String?): Boolean = write { db ->
        val now = System.currentTimeMillis()
        db.prepareStatement("""
            insert into source_login_state(source_id, login_header, updated_at) values(?, ?, ?)
            on conflict(source_id) do update set login_header=excluded.login_header, updated_at=excluded.updated_at
        """).use { stmt ->
            stmt.setString(1, sourceId)
            stmt.setString(2, header)
            stmt.setLong(3, now)
            stmt.executeUpdate() > 0
        }
    }

    fun removeSourceLoginHeader(sourceId: String): Boolean = write { db ->
        val now = System.currentTimeMillis()
        db.prepareStatement("""
            update source_login_state set login_header = null, updated_at = ? where source_id = ?
        """).use { stmt ->
            stmt.setLong(1, now)
            stmt.setString(2, sourceId)
            stmt.executeUpdate() > 0
        }
    }

    fun removeSourceLoginInfo(sourceId: String): Boolean = write { db ->
        val now = System.currentTimeMillis()
        db.prepareStatement("""
            update source_login_state set login_info = null, updated_at = ? where source_id = ?
        """).use { stmt ->
            stmt.setLong(1, now)
            stmt.setString(2, sourceId)
            stmt.executeUpdate() > 0
        }
    }

    fun saveSourceVariable(sourceId: String, variable: String?): Boolean = write { db ->
        val now = System.currentTimeMillis()
        db.prepareStatement("""
            insert into source_login_state(source_id, source_variable, updated_at) values(?, ?, ?)
            on conflict(source_id) do update set source_variable=excluded.source_variable, updated_at=excluded.updated_at
        """).use { stmt ->
            stmt.setString(1, sourceId)
            stmt.setString(2, variable)
            stmt.setLong(3, now)
            stmt.executeUpdate() > 0
        }
    }

    fun getSourceVariable(sourceId: String): String? = connect { db ->
        db.prepareStatement("select source_variable from source_login_state where source_id = ?").use { stmt ->
            stmt.setString(1, sourceId)
            stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
        }
    }

    fun saveSourceKv(sourceId: String, key: String, value: String?): Boolean = write { db ->
        val now = System.currentTimeMillis()
        val state = getSourceLoginState(sourceId)
        val currentKv = state?.sourceKv?.toMutableMap() ?: mutableMapOf()
        if (value != null) {
            currentKv[key] = value
        } else {
            currentKv.remove(key)
        }
        val kvJson = Json.encodeToString(currentKv)
        db.prepareStatement("""
            insert into source_login_state(source_id, source_kv, updated_at) values(?, ?, ?)
            on conflict(source_id) do update set source_kv=excluded.source_kv, updated_at=excluded.updated_at
        """).use { stmt ->
            stmt.setString(1, sourceId)
            stmt.setString(2, kvJson)
            stmt.setLong(3, now)
            stmt.executeUpdate() > 0
        }
    }

    fun getSourceKv(sourceId: String, key: String): String? = connect { db ->
        db.prepareStatement("select source_kv from source_login_state where source_id = ?").use { stmt ->
            stmt.setString(1, sourceId)
            stmt.executeQuery().use { rs ->
                if (rs.next()) {
                    val kvJson = rs.getString(1) ?: return@use null
                    runCatching { Json.decodeFromString<Map<String, String>>(kvJson)[key] }.getOrNull()
                } else null
            }
        }
    }

    /**
     * 凭据桶的键：注册域（eTLD+1），与上游 `NetworkUtils.getSubDomain(url)` 同口径。
     * `www.a.com` 与 `m.a.com` 因此是同一个桶 —— 「登录一次、同域全都带」就是这么来的。
     */
    fun cookieBucket(urlOrHost: String): String {
        val host = runCatching { java.net.URI(urlOrHost).host }.getOrNull()?.takeIf { it.isNotBlank() }
            ?: HOST_IN_URL.find(urlOrHost)?.groupValues?.get(1)?.lowercase()?.trim('.', ' ')
            ?: urlOrHost.trim().lowercase().trim('/').substringBefore('/').substringBefore(':')
        return WebViewProxy.registrableDomain(host)
    }

    /** 读该请求地址所属注册域的凭据；没有则 null。跨书源共享，与上游一致。 */
    fun getCookieForUrl(url: String): String? = connect { db ->
        val bucket = cookieBucket(url)
        if (bucket.isBlank()) return@connect null
        db.prepareStatement("select cookie from cookie where url = ?").use { stmt ->
            stmt.setString(1, bucket)
            stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1)?.takeIf { it.isNotBlank() } else null }
        }
    }

    /** 全部凭据桶（域名 + 键数），给「凭据管理」列表用；不返回 Cookie 值本身。 */
    fun listCookieBuckets(): List<CookieBucket> = connect { db ->
        db.prepareStatement("select url, cookie from cookie order by url").use { stmt ->
            stmt.executeQuery().use { rs ->
                generateSequence { if (rs.next()) rs.getString(1) to (rs.getString(2) ?: "") else null }
                    .map { (domain, value) -> CookieBucket(domain = domain, keys = parseCookieString(value).keys.toList()) }
                    .toList()
            }
        }
    }

    /**
     * 写入凭据：**按键合并**（同名覆盖、其余保留），与上游 `CookieStore.mergeCookies` /
     * `restoreCookie` 同语义。整桶替换会让"先粘 Cookie 再补一个 token"丢掉前一次的结果。
     */
    fun setCookieForUrl(url: String, cookie: String): Boolean {
        val bucket = cookieBucket(url)
        if (bucket.isBlank()) return false
        val incoming = parseCookieString(cookie)
        if (incoming.isEmpty()) return false
        return write { db ->
            val existing = db.prepareStatement("select cookie from cookie where url = ?").use { stmt ->
                stmt.setString(1, bucket)
                stmt.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
            }
            val merged = linkedMapOf<String, String>()
            if (!existing.isNullOrBlank()) merged.putAll(parseCookieString(existing))
            merged.putAll(incoming)
            val value = merged.entries.joinToString("; ") { "${it.key}=${it.value}" }
            db.prepareStatement("""
                insert into cookie(url, cookie, updated_at) values(?, ?, ?)
                on conflict(url) do update set cookie=excluded.cookie, updated_at=excluded.updated_at
            """).use { stmt ->
                stmt.setString(1, bucket)
                stmt.setString(2, value)
                stmt.setLong(3, System.currentTimeMillis())
                stmt.executeUpdate() > 0
            }
        }
    }

    /** 删掉某个域（传地址或裸域名都行）的整桶凭据。 */
    fun removeCookieBucket(url: String): Boolean = write { db ->
        db.prepareStatement("delete from cookie where url = ?").use { stmt ->
            stmt.setString(1, cookieBucket(url))
            stmt.executeUpdate() > 0
        }
    }

    /**
     * 一次性迁移：把旧的「按书源各存一份」`source_login_state.cookie_jar` 折叠进全局表。
     * 同域可能来自多个书源，所以仍走按键合并；迁完把旧列置空，避免下次又读回来源。
     */
    private fun migrateLegacyCookieJars(db: Connection) {
        val rows = db.prepareStatement("select source_id, cookie_jar from source_login_state where cookie_jar is not null and cookie_jar <> ''").use { stmt ->
            stmt.executeQuery().use { rs ->
                generateSequence { if (rs.next()) (rs.getString(2) ?: "") else null }.toList()
            }
        }
        if (rows.isEmpty()) return
        val folded = linkedMapOf<String, String>()
        rows.forEach { jarJson ->
            val jar = runCatching { Json.decodeFromString<Map<String, String>>(jarJson) }.getOrNull() ?: return@forEach
            jar.forEach { (host, value) ->
                if (host.isBlank() || value.isBlank()) return@forEach
                val bucket = cookieBucket(host)
                val merged = linkedMapOf<String, String>()
                folded[bucket]?.let { merged.putAll(parseCookieString(it)) }
                merged.putAll(parseCookieString(value))
                folded[bucket] = merged.entries.joinToString("; ") { "${it.key}=${it.value}" }
            }
        }
        if (folded.isNotEmpty()) {
            db.prepareStatement("""
                insert into cookie(url, cookie, updated_at) values(?, ?, ?)
                on conflict(url) do update set cookie=excluded.cookie, updated_at=excluded.updated_at
            """).use { stmt ->
                folded.forEach { (bucket, value) ->
                    stmt.setString(1, bucket)
                    stmt.setString(2, value)
                    stmt.setLong(3, System.currentTimeMillis())
                    stmt.addBatch()
                }
                stmt.executeBatch()
            }
        }
        db.prepareStatement("update source_login_state set cookie_jar = null where cookie_jar is not null").use { it.executeUpdate() }
    }

    /**
     * 有多少本书源的配置里**写到过**这个域（SQL `instr` 的粗筛，不解析 JSON）。
     * 全局凭据列表用它提示"删掉这桶会影响面有多大" —— 措辞必须是"提到"，
     * 不能说成"会访问"：真正会带的域要解析每本书源才准，代价不该摊到一次列表请求上。
     */
    /**
     * 「每个凭据桶被多少书源真正用得上」——一次扫描算出全部桶。
     *
     * 以前是每个桶跑一遍 `instr(lower(payload), ?)`：213 个桶 × 4,876 源（payload 合计 37 MB）
     * 等于把全表小写化 213 遍，实测 `GET /api/cookies` 要 2 分 27 秒，凭据明细界面等于卡死。
     * 现在反过来：每个源的 payload 只扫一次，抽出其中出现过的 http(s) 主机名，归一到注册域再按桶累加。
     * 口径也顺带变准了 —— 老的子串匹配会把「注释里提了一句该域」的源也算进去，
     * 而这里数的是「配置里真有指向该域的地址」，与 `getCookieForUrl` 实际会不会发出去一致。
     */
    fun cookieBucketMentions(): Map<String, Int> = connect { db ->
        val counts = HashMap<String, Int>()
        db.prepareStatement("select payload from source").use { statement ->
            statement.executeQuery().use { rs ->
                while (rs.next()) {
                    rs.getString(1)
                        .let { text -> HOST_IN_URL.findAll(text).map { it.groupValues[1].substringBefore(':').lowercase() }.toSet() }
                        .map { cookieBucket(it) }
                        .distinct()
                        .forEach { bucket -> counts.merge(bucket, 1, Int::plus) }
                }
            }
        }
        counts
    }

    /**
     * 从 Set-Cookie 响应头中提取第一个 name=value 对。
     * 整行入库会把 Path / Expires / HttpOnly 等属性误当成 Cookie 一并发送。
     */
    fun extractCookiePair(setCookieHeader: String): String? {
        val first = setCookieHeader.substringBefore(';').trim()
        val separator = first.indexOf('=')
        if (separator <= 0) return null
        if (first.substring(0, separator).isBlank()) return null
        return first
    }

    fun setCookieFromSetCookie(url: String, setCookieHeader: String): Boolean {
        val pair = extractCookiePair(setCookieHeader) ?: return false
        return setCookieForUrl(url, pair)
    }

    /**
     * 某些地址里已经存了凭据 —— 用来回答「这本书源带得出凭据吗」。传入的是该书源
     * 实际会访问的主机（`WebViewProxy.credentialDomains`），逐域去全局表里查桶。
     * 注意语义：**有凭据 ≠ 已登录**，上游也没有"判定登录态"这回事，所以调用方只能说"有/无凭据"。
     */
    fun cookieBucketsForHosts(hosts: List<String>): List<CookieBucket> {
        if (hosts.isEmpty()) return emptyList()
        val buckets = listCookieBuckets().associateBy { it.domain }
        return hosts.mapNotNull { host -> buckets[cookieBucket(host)] }
    }

    fun clearSourceLoginState(sourceId: String): Boolean = write { db ->
        db.prepareStatement("delete from source_login_state where source_id = ?").use { stmt ->
            stmt.setString(1, sourceId)
            stmt.executeUpdate() > 0
        }
    }

    fun parseCookieString(cookieStr: String): Map<String, String> {
        val trimmed = cookieStr.trim()
        if (trimmed.isEmpty()) return emptyMap()

        // 1. JSON Array (e.g. Cookie-Editor / EditThisCookie export format)
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            val fromArray = runCatching {
                val array = Json.parseToJsonElement(trimmed).jsonArray
                val map = linkedMapOf<String, String>()
                for (item in array) {
                    val obj = item.jsonObject
                    val name = (obj["name"] as? JsonPrimitive)?.contentOrNull
                    val value = (obj["value"] as? JsonPrimitive)?.contentOrNull
                    if (!name.isNullOrBlank() && value != null) {
                        map[name] = value
                    }
                }
                map
            }.getOrNull()
            if (!fromArray.isNullOrEmpty()) return fromArray
        }

        // 2. JSON Object (e.g. {"Cookie": "..."} or {"token": "..."})
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            val fromObj = runCatching {
                val obj = Json.parseToJsonElement(trimmed).jsonObject
                if (obj.containsKey("Cookie") || obj.containsKey("cookie")) {
                    val c = (obj["Cookie"] ?: obj["cookie"])?.jsonPrimitive?.contentOrNull
                    if (!c.isNullOrBlank()) return parseCookieString(c)
                }
                val map = linkedMapOf<String, String>()
                for ((k, v) in obj) {
                    val value = (v as? JsonPrimitive)?.contentOrNull ?: v.toString()
                    if (k.isNotBlank()) map[k] = value
                }
                map
            }.getOrNull()
            if (!fromObj.isNullOrEmpty()) return fromObj
        }

        // 3. Netscape format lines (tab separated)
        val lines = trimmed.lines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") }
        if (lines.isNotEmpty() && lines.any { it.contains("\t") }) {
            val map = linkedMapOf<String, String>()
            for (line in lines) {
                val parts = line.split("\t")
                if (parts.size >= 7) {
                    val name = parts[5].trim()
                    val value = parts[6].trim()
                    if (name.isNotEmpty()) map[name] = value
                }
            }
            if (map.isNotEmpty()) return map
        }

        // 4. Standard key=value; key2=value2 format
        val result = linkedMapOf<String, String>()
        trimmed.split(';').forEach { part ->
            val p = part.trim()
            val eq = p.indexOf('=')
            if (eq > 0) {
                val key = p.substring(0, eq).trim()
                val value = p.substring(eq + 1).trim()
                result[key] = value
            }
        }
        return result
    }

    private fun java.sql.ResultSet.toSummary() = SourceSummary(
        id = getString(1),
        name = getString(2),
        url = getString(3),
        group = getString(4),
        enabled = getInt(5) == 1,
        isJsSource = getInt(6) == 1,
        hasLogin = getInt(9) == 1,
        updatedAt = getLong(7),
        version = getLong(8),
    )
    private fun java.sql.ResultSet.toSubscription() = SourceSubscription(getLong("id"), getString("url"), getInt("enabled") == 1, getLong("created_at"), getLong("updated_at"), getLong("last_success_at").takeIf { !wasNull() }, getLong("last_attempt_at").takeIf { !wasNull() }, getString("last_error"), getInt("last_imported"), getString("content_hash"))
    private fun java.sql.ResultSet.toShelf(): BookshelfItem {
        val altJson = getString(15)
        val altSources = if (!altJson.isNullOrBlank()) {
            runCatching { Json.decodeFromString<List<SearchResult>>(altJson) }.getOrDefault(emptyList())
        } else emptyList()
        return BookshelfItem(
            sourceId = getString(1),
            bookUrl = getString(2),
            name = getString(3),
            author = getString(4),
            tocUrl = getString(5),
            coverKey = getString(6),
            chapterIndex = getObject(7) as? Int,
            scrollPosition = getObject(8) as? Double,
            lastReadAt = getLong(9),
            // 第 17 列：book_toc_cache 的 MAX(updated_at)；无目录缓存行时 SQL 为 NULL，getLong 归 0（DTO 的“无数据”哨兵）。
            tocUpdatedAt = getLong(17),
            cachedChapters = getInt(10),
            totalChapters = getInt(11),
            cacheState = getString(12),
            cacheError = getString(13),
            completed = getInt(14) != 0,
            alternateSources = altSources,
            groupId = getLong(16),
        )
    }
    private fun java.sql.ResultSet.toReplaceRule(): ReplaceRule = ReplaceRule(
        id = getString(1),
        name = getString(2),
        group = getString(3),
        pattern = getString(4),
        replacement = getString(5) ?: "",
        isRegex = getInt(6) != 0,
        scope = getString(7),
        excludeScope = getString(8),
        scopeTitle = getInt(9) != 0,
        scopeContent = getInt(10) != 0,
        isEnabled = getInt(11) != 0,
        order = getInt(12),
        timeoutMillisecond = getLong(13),
        createdAt = getLong(14),
        updatedAt = getLong(15),
    )

    fun listReplaceRules(query: String? = null, group: String? = null, scope: String? = null): List<ReplaceRule> = connect { db ->
        val conditions = mutableListOf<String>()
        val params = mutableListOf<String>()
        if (!query.isNullOrBlank()) {
            conditions.add("(name like ? or pattern like ? or replacement like ?)")
            val q = "%${query.trim()}%"
            params.add(q); params.add(q); params.add(q)
        }
        if (!group.isNullOrBlank()) {
            conditions.add("group_name = ?")
            params.add(group.trim())
        }
        if (!scope.isNullOrBlank()) {
            conditions.add("scope like ?")
            params.add("%${scope.trim()}%")
        }
        val whereClause = if (conditions.isEmpty()) "" else "where " + conditions.joinToString(" and ")
        val sql = "select id, name, group_name, pattern, replacement, is_regex, scope, exclude_scope, scope_title, scope_content, is_enabled, sort_order, timeout_ms, created_at, updated_at from replace_rule $whereClause order by sort_order asc, created_at asc"
        db.prepareStatement(sql).use { stmt ->
            params.forEachIndexed { i, p -> stmt.setString(i + 1, p) }
            stmt.executeQuery().use { rs ->
                val list = mutableListOf<ReplaceRule>()
                while (rs.next()) {
                    list.add(rs.toReplaceRule())
                }
                list
            }
        }
    }

    fun getReplaceRule(id: String): ReplaceRule? = connect { db ->
        db.prepareStatement("select id, name, group_name, pattern, replacement, is_regex, scope, exclude_scope, scope_title, scope_content, is_enabled, sort_order, timeout_ms, created_at, updated_at from replace_rule where id = ?").use { stmt ->
            stmt.setString(1, id)
            stmt.executeQuery().use { rs -> if (rs.next()) rs.toReplaceRule() else null }
        }
    }

    fun saveReplaceRule(rule: ReplaceRule): ReplaceRule = write { db ->
        val now = System.currentTimeMillis()
        val ruleId = rule.id.ifBlank { System.currentTimeMillis().toString() + "_" + java.util.UUID.randomUUID().toString().take(6) }
        val existing = db.prepareStatement("select created_at from replace_rule where id = ?").use { stmt ->
            stmt.setString(1, ruleId)
            stmt.executeQuery().use { if (it.next()) it.getLong(1) else null }
        }
        val createdAt = existing ?: (if (rule.createdAt > 0) rule.createdAt else now)
        db.prepareStatement("""
            insert into replace_rule(id, name, group_name, pattern, replacement, is_regex, scope, exclude_scope, scope_title, scope_content, is_enabled, sort_order, timeout_ms, created_at, updated_at)
            values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict(id) do update set
              name = excluded.name,
              group_name = excluded.group_name,
              pattern = excluded.pattern,
              replacement = excluded.replacement,
              is_regex = excluded.is_regex,
              scope = excluded.scope,
              exclude_scope = excluded.exclude_scope,
              scope_title = excluded.scope_title,
              scope_content = excluded.scope_content,
              is_enabled = excluded.is_enabled,
              sort_order = excluded.sort_order,
              timeout_ms = excluded.timeout_ms,
              updated_at = excluded.updated_at
        """.trimIndent()).use { stmt ->
            stmt.setString(1, ruleId)
            stmt.setString(2, rule.name.ifBlank { rule.pattern })
            stmt.setString(3, rule.group)
            stmt.setString(4, rule.pattern)
            stmt.setString(5, rule.replacement)
            stmt.setInt(6, if (rule.isRegex) 1 else 0)
            stmt.setString(7, rule.scope)
            stmt.setString(8, rule.excludeScope)
            stmt.setInt(9, if (rule.scopeTitle) 1 else 0)
            stmt.setInt(10, if (rule.scopeContent) 1 else 0)
            stmt.setInt(11, if (rule.isEnabled) 1 else 0)
            stmt.setInt(12, rule.order)
            stmt.setLong(13, if (rule.timeoutMillisecond > 0) rule.timeoutMillisecond else 3000L)
            stmt.setLong(14, createdAt)
            stmt.setLong(15, now)
            stmt.executeUpdate()
        }
        rule.copy(id = ruleId, createdAt = createdAt, updatedAt = now)
    }

    fun deleteReplaceRule(id: String): Boolean = write { db ->
        db.prepareStatement("delete from replace_rule where id = ?").use { stmt ->
            stmt.setString(1, id)
            stmt.executeUpdate() > 0
        }
    }

    fun deleteReplaceRules(ids: List<String>): Int = write { db ->
        if (ids.isEmpty()) return@write 0
        val placeholders = ids.joinToString(",") { "?" }
        db.prepareStatement("delete from replace_rule where id in ($placeholders)").use { stmt ->
            ids.forEachIndexed { idx, id -> stmt.setString(idx + 1, id) }
            stmt.executeUpdate()
        }
    }

    fun toggleReplaceRules(ids: List<String>, enabled: Boolean): Int = write { db ->
        if (ids.isEmpty()) return@write 0
        val placeholders = ids.joinToString(",") { "?" }
        val now = System.currentTimeMillis()
        db.prepareStatement("update replace_rule set is_enabled = ?, updated_at = ? where id in ($placeholders)").use { stmt ->
            stmt.setInt(1, if (enabled) 1 else 0)
            stmt.setLong(2, now)
            ids.forEachIndexed { idx, id -> stmt.setString(idx + 3, id) }
            stmt.executeUpdate()
        }
    }

    fun getEnabledReplaceRules(): List<ReplaceRule> = connect { db ->
        db.prepareStatement("select id, name, group_name, pattern, replacement, is_regex, scope, exclude_scope, scope_title, scope_content, is_enabled, sort_order, timeout_ms, created_at, updated_at from replace_rule where is_enabled = 1 order by sort_order asc, created_at asc").use { stmt ->
            stmt.executeQuery().use { rs ->
                val list = mutableListOf<ReplaceRule>()
                while (rs.next()) list.add(rs.toReplaceRule())
                list
            }
        }
    }

    fun getEnabledReplaceRulesForScope(bookName: String?, sourceUrl: String?, sourceName: String? = null): List<ReplaceRule> {
        val allEnabled = getEnabledReplaceRules()
        return allEnabled.filter { ContentProcessor.matchesScope(it, bookName, sourceUrl, sourceName) }
    }

    fun importReplaceRules(rules: List<ReplaceRule>): ReplaceRuleImportResponse = write { db ->
        val now = System.currentTimeMillis()
        var imported = 0
        var updated = 0
        var skipped = 0

        for (rule in rules) {
            if (rule.pattern.isBlank()) {
                skipped++
                continue
            }
            val ruleId = rule.id.ifBlank { System.currentTimeMillis().toString() + "_" + java.util.UUID.randomUUID().toString().take(6) }
            val existing = db.prepareStatement("select 1 from replace_rule where id = ?").use { stmt ->
                stmt.setString(1, ruleId)
                stmt.executeQuery().use { it.next() }
            }
            db.prepareStatement("""
                insert into replace_rule(id, name, group_name, pattern, replacement, is_regex, scope, exclude_scope, scope_title, scope_content, is_enabled, sort_order, timeout_ms, created_at, updated_at)
                values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(id) do update set
                  name = excluded.name,
                  group_name = excluded.group_name,
                  pattern = excluded.pattern,
                  replacement = excluded.replacement,
                  is_regex = excluded.is_regex,
                  scope = excluded.scope,
                  exclude_scope = excluded.exclude_scope,
                  scope_title = excluded.scope_title,
                  scope_content = excluded.scope_content,
                  is_enabled = excluded.is_enabled,
                  sort_order = excluded.sort_order,
                  timeout_ms = excluded.timeout_ms,
                  updated_at = excluded.updated_at
            """.trimIndent()).use { stmt ->
                stmt.setString(1, ruleId)
                stmt.setString(2, rule.name.ifBlank { rule.pattern })
                stmt.setString(3, rule.group)
                stmt.setString(4, rule.pattern)
                stmt.setString(5, rule.replacement)
                stmt.setInt(6, if (rule.isRegex) 1 else 0)
                stmt.setString(7, rule.scope)
                stmt.setString(8, rule.excludeScope)
                stmt.setInt(9, if (rule.scopeTitle) 1 else 0)
                stmt.setInt(10, if (rule.scopeContent) 1 else 0)
                stmt.setInt(11, if (rule.isEnabled) 1 else 0)
                stmt.setInt(12, rule.order)
                stmt.setLong(13, if (rule.timeoutMillisecond > 0) rule.timeoutMillisecond else 3000L)
                stmt.setLong(14, if (rule.createdAt > 0) rule.createdAt else now)
                stmt.setLong(15, now)
                stmt.executeUpdate()
            }
            if (existing) updated++ else imported++
        }
        ReplaceRuleImportResponse(imported, updated, skipped, rules.size)
    }

    fun exportReplaceRules(ids: List<String>? = null): List<ReplaceRule> = connect { db ->
        val sql = if (ids.isNullOrEmpty()) {
            "select id, name, group_name, pattern, replacement, is_regex, scope, exclude_scope, scope_title, scope_content, is_enabled, sort_order, timeout_ms, created_at, updated_at from replace_rule order by sort_order asc, created_at asc"
        } else {
            val placeholders = ids.joinToString(",") { "?" }
            "select id, name, group_name, pattern, replacement, is_regex, scope, exclude_scope, scope_title, scope_content, is_enabled, sort_order, timeout_ms, created_at, updated_at from replace_rule where id in ($placeholders) order by sort_order asc, created_at asc"
        }
        db.prepareStatement(sql).use { stmt ->
            ids?.forEachIndexed { idx, id -> stmt.setString(idx + 1, id) }
            stmt.executeQuery().use { rs ->
                val list = mutableListOf<ReplaceRule>()
                while (rs.next()) list.add(rs.toReplaceRule())
                list
            }
        }
    }

    private fun getBookshelf(db: Connection, sourceId: String, bookUrl: String): BookshelfItem? = db.prepareStatement(SHELF_SELECT + " where s.source_id=? and s.book_url=?").use { it.setString(1, sourceId); it.setString(2, bookUrl); it.executeQuery().use { rs -> if (rs.next()) rs.toShelf() else null } }
    private fun migrateReadingProgress(db: Connection) {
        val columns = db.createStatement().use { statement ->
            statement.executeQuery("pragma table_info(reading_progress)").use { result ->
                buildSet { while (result.next()) add(result.getString("name")) }
            }
        }
        if ("scroll_position" !in columns) {
            db.createStatement().use { it.executeUpdate("alter table reading_progress add column scroll_position real not null default 0") }
        }
    }
    private fun migrateBookshelf(db: Connection) {
        val columns = db.createStatement().use { statement -> statement.executeQuery("pragma table_info(book_shelf)").use { rs -> buildSet { while (rs.next()) add(rs.getString("name")) } } }
        if ("completed" !in columns) db.createStatement().use { it.executeUpdate("alter table book_shelf add column completed integer not null default 0") }
        if ("alternate_sources" !in columns) db.createStatement().use { it.executeUpdate("alter table book_shelf add column alternate_sources text") }
        if ("group_id" !in columns) db.createStatement().use { it.executeUpdate("alter table book_shelf add column group_id integer not null default 0") }
    }
    private fun migrateSourceTable(db: Connection) {
        val columns = db.createStatement().use { statement ->
            statement.executeQuery("pragma table_info(source)").use { rs ->
                buildSet { while (rs.next()) add(rs.getString("name")) }
            }
        }
        if ("has_login" !in columns) {
            db.createStatement().use {
                it.executeUpdate("alter table source add column has_login integer not null default 0")
            }
        }
        db.createStatement().use {
            it.executeUpdate("update source set has_login = 1 where (payload like '%\"loginUi\"%' or payload like '%\"loginUrl\"%' or payload like '%\"loginCheckJs\"%') and (has_login is null or has_login = 0)")
        }
    }
    companion object {

        /** 书源模板里的地址常带 `{{key}}` / 中文路径，URI 解析会失败，所以裸域名要单独抓。 */
        private val HOST_IN_URL = Regex("""https?://([^/\s"'<>\\:?#]+)""", RegexOption.IGNORE_CASE)

        /** 书架列表与单本查询共用同一份 SELECT：两处各写一遍迟早会漂移成不同字段。 */
        private const val SHELF_SELECT = "select s.source_id,s.book_url,s.name,s.author,s.toc_url,s.cover_key,p.chapter_index,p.scroll_position,s.last_read_at,coalesce(c.cached_chapters,0),coalesce(c.total_chapters,0),coalesce(c.state,'idle'),c.last_error,s.completed,s.alternate_sources,s.group_id,(select max(t.updated_at) from book_toc_cache t where t.source_id=s.source_id and (t.toc_url=s.toc_url or t.toc_url=s.book_url)) from book_shelf s left join reading_progress p on p.source_id=s.source_id and p.book_url=s.book_url left join book_cache_status c on c.source_id=s.source_id and c.book_url=s.book_url"
    }
}

class VersionConflict : RuntimeException()


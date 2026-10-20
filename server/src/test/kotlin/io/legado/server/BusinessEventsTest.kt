package io.legado.server

import io.legado.server.data.Database
import io.legado.server.data.deleteSource
import io.legado.server.data.saveSource
import io.legado.server.plugin.AppEvents
import io.legado.server.plugin.EventBus
import io.legado.server.plugin.EventNames
import io.legado.server.source.ParsedSource
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 端到端判据：**真实业务操作会发出事件**，插件订阅得到。
 *
 * 这是"事件机制不是摆设"的证据。只测 EventBus 自身（见 EventBusTest）不够 ——
 * 那只能证明"机制能跑"，证明不了"业务真的在发"。
 */
class BusinessEventsTest {

    private lateinit var db: Database
    private lateinit var dbPath: String
    private val handles = mutableListOf<AutoCloseable>()

    @Before
    fun setUp() {
        dbPath = Files.createTempFile("biz-events", ".sqlite").toString()
        db = Database(dbPath).apply { initialize() }
    }

    @After
    fun tearDown() {
        handles.forEach { runCatching { it.close() } }
        handles.clear()
        runCatching { db.close() }
        runCatching { Files.deleteIfExists(java.nio.file.Path.of(dbPath)) }
    }

    private fun listen(name: String): MutableList<EventBus.Event> {
        val got = mutableListOf<EventBus.Event>()
        handles += AppEvents.bus.subscribe(name) { got += it }
        return got
    }

    private fun parsed(id: String, name: String = "测试源") = ParsedSource(
        id = id, name = name, url = "https://$id.example.com", group = "", enabled = true,
        isJs = false, hasLogin = false, json = """{"bookSourceUrl":"https://$id.example.com","bookSourceName":"$name"}""",
    )

    @Test
    fun `保存书源会发出 source_saved 事件 带 id 与 version`() {
        val events = listen(EventNames.SOURCE_SAVED)
        db.saveSource(parsed("ev-src"), null)

        assertEquals("应发出一个事件", 1, events.size)
        assertEquals(EventNames.SOURCE_SAVED, events[0].name)
        assertEquals("ev-src", events[0].payload["id"])
        assertEquals("首次保存 version 应为 1", 1L, events[0].payload["version"])
    }

    @Test
    fun `删除书源会发出 source_deleted 事件`() {
        db.saveSource(parsed("ev-del"), null)
        val events = listen(EventNames.SOURCE_DELETED)
        val removed = db.deleteSource("ev-del")

        assertTrue("应真的删掉", removed)
        assertEquals("应发出一个事件", 1, events.size)
        assertEquals("ev-del", events[0].payload["id"])
    }

    @Test
    fun `删不存在的书源不发事件 —— 订阅者不该被惊动`() {
        val events = listen(EventNames.SOURCE_DELETED)
        val removed = db.deleteSource("never-existed")
        assertEquals("本来就没有，返回 false", false, removed)
        assertEquals("不该发事件", 0, events.size)
    }

    @Test
    fun `订阅者抛异常不影响保存本身 —— 业务不能被插件带崩`() {
        val before = AppEvents.bus.failures()
        handles += AppEvents.bus.subscribe(EventNames.SOURCE_SAVED) { throw RuntimeException("订阅者炸了") }
        // 不 try/catch：这条判据本身就是"保存仍成功"
        val record = db.saveSource(parsed("ev-robust"), null)
        assertEquals("保存应成功", 1L, record.version)
        assertTrue("订阅者异常应被记账", AppEvents.bus.failures() > before)
    }

    @Test
    fun `通配订阅能收到业务事件`() {
        val all = listen("*")
        db.saveSource(parsed("ev-wild"), null)
        assertTrue("通配订阅应收到 source.saved", all.any { it.name == EventNames.SOURCE_SAVED })
    }
}

package io.legado

import io.legado.ai.ToolHooks
import io.legado.ai.ToolRegistry
import io.legado.plugin.EventBus
import io.legado.plugin.Plugin
import io.legado.plugin.PluginManager
import io.legado.plugin.PluginMetadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 事件总线的判据 —— 测的是**机制**，不是任何具体事件。
 *
 * 事件名与载荷由发布方定义，框架不预知；所以这里用就地造的假事件名，
 * 验证"订阅/发布/隔离/注销"这几件事本身成立。
 */
class EventBusTest {

    @Test
    fun `订阅者能收到同名事件`() {
        val bus = EventBus()
        val got = mutableListOf<String>()
        bus.subscribe("demo.ping") { e -> got += e.name }

        val delivered = bus.publish(EventBus.Event("demo.ping", mapOf("n" to 1)))
        assertEquals("应有 1 个订阅者被调用", 1, delivered)
        assertEquals(listOf("demo.ping"), got)
    }

    @Test
    fun `不同名事件不会串到别人那里`() {
        val bus = EventBus()
        val a = mutableListOf<String>()
        val b = mutableListOf<String>()
        bus.subscribe("a.event") { a += it.name }
        bus.subscribe("b.event") { b += it.name }

        bus.publish("a.event")
        assertEquals("a 应收到", 1, a.size)
        assertEquals("b 不该收到", 0, b.size)
    }

    @Test
    fun `通配订阅能收到全部事件`() {
        val bus = EventBus()
        val all = mutableListOf<String>()
        bus.subscribe("*") { all += it.name }

        bus.publish("x.one")
        bus.publish("y.two")
        assertEquals(listOf("x.one", "y.two"), all)
    }

    @Test
    fun `载荷原样传给订阅者`() {
        val bus = EventBus()
        var payload: Map<String, Any?> = emptyMap()
        bus.subscribe("demo.data") { payload = it.payload }

        bus.publish(EventBus.Event("demo.data", mapOf("id" to "abc", "count" to 3)))
        assertEquals("abc", payload["id"])
        assertEquals(3, payload["count"])
    }

    @Test
    fun `一个订阅者抛异常不影响其它订阅者`() {
        val bus = EventBus()
        val survivors = mutableListOf<String>()
        bus.subscribe("demo.boom") { throw RuntimeException("我炸了") }
        bus.subscribe("demo.boom") { survivors += it.name }

        val delivered = bus.publish("demo.boom")
        assertEquals("好订阅者仍应收到", 1, delivered)
        assertEquals("好订阅者应被调用", 1, survivors.size)
        assertEquals("失败要被记账", 1L, bus.failures())
    }

    @Test
    fun `发布永不抛异常 —— 全部订阅者都炸也一样`() {
        val bus = EventBus()
        bus.subscribe("demo.all-boom") { throw RuntimeException("1") }
        bus.subscribe("demo.all-boom") { throw RuntimeException("2") }

        // 不 try/catch：这条判据本身就是"它不会抛"
        val delivered = bus.publish("demo.all-boom")
        assertEquals("都炸了就没有成功投递", 0, delivered)
        assertEquals(2L, bus.failures())
    }

    @Test
    fun `注销后不再收到事件`() {
        val bus = EventBus()
        var count = 0
        val handle = bus.subscribe("demo.temp") { count++ }
        bus.publish("demo.temp")
        assertEquals(1, count)

        handle.close()
        bus.publish("demo.temp")
        assertEquals("注销后不该再收到", 1, count)
        assertEquals("订阅者应清零", 0, bus.subscriberCount("demo.temp"))
    }

    @Test
    fun `没有订阅者时发布也正常 只是没人听`() {
        val bus = EventBus()
        val delivered = bus.publish("nobody.listening")
        assertEquals("没有订阅者就是 0", 0, delivered)
        assertEquals("事件仍算投递过", 1L, bus.publishedTotal())
    }

    @Test
    fun `自我介绍说清订阅者数量与事件总数`() {
        val bus = EventBus()
        bus.subscribe("a") { }
        bus.subscribe("b") { }
        bus.publish("a")

        val text = bus.describe()
        assertTrue("应报订阅者数", text.contains("2 个订阅者"))
        assertTrue("应报事件总数", text.contains("已投递 1 个事件"))
    }

    @Test
    fun `空总线自我介绍说清没人在听`() {
        val bus = EventBus()
        assertTrue(bus.describe().contains("没有订阅者"))
    }

    // ========== 与插件框架的整合 ==========

    @Test
    fun `插件能声明订阅 框架自动订阅并转发事件`() {
        val bus = EventBus()
        val pm = PluginManager(ToolRegistry(), ToolHooks(), events = bus)
        val got = mutableListOf<String>()

        val plugin = object : Plugin {
            override val metadata = PluginMetadata("demo.listener", "监听插件", "1.0.0", "订阅事件")
            override fun subscriptions() = listOf(
                "source.saved" to EventBus.Handler { e -> got += "${e.name}:${e.payload["id"]}" },
            )
        }
        assertTrue(pm.register(plugin))
        assertEquals("应挂上一条订阅", 1, bus.subscriberCount("source.saved"))

        bus.publish(EventBus.Event("source.saved", mapOf("id" to "s1")))
        assertEquals(listOf("source.saved:s1"), got)
    }

    @Test
    fun `插件卸载时订阅自动注销 —— 不留残影`() {
        val bus = EventBus()
        val pm = PluginManager(ToolRegistry(), ToolHooks(), events = bus)
        var count = 0

        pm.register(object : Plugin {
            override val metadata = PluginMetadata("demo.leak", "会漏的插件", "1.0.0", "x")
            override fun subscriptions() = listOf("e" to EventBus.Handler { count++ })
        })
        bus.publish("e")
        assertEquals(1, count)

        assertTrue("卸载应成功", pm.unload("demo.leak"))
        assertEquals("订阅应被注销", 0, bus.subscriberCount("e"))
        bus.publish("e")
        assertEquals("卸载后不该再收到事件", 1, count)
    }

    @Test
    fun `插件 subscriptions 抛异常时装载仍成功并留痕`() {
        val bus = EventBus()
        val pm = PluginManager(ToolRegistry(), ToolHooks(), events = bus)

        assertTrue("订阅声明炸了不该让插件装载失败", pm.register(object : Plugin {
            override val metadata = PluginMetadata("demo.badsub", "坏订阅", "1.0.0", "x")
            override fun subscriptions(): List<Pair<String, EventBus.Handler>> =
                throw IllegalStateException("声明炸了")
        }))
        assertTrue("要留痕", pm.loadFailures().any { it.reason.contains("subscriptions()") })
    }

    @Test
    fun `自我介绍里能看到事件总线状态与插件的订阅数`() {
        val bus = EventBus()
        val pm = PluginManager(ToolRegistry(), ToolHooks(), events = bus)
        pm.register(object : Plugin {
            override val metadata = PluginMetadata("demo.desc", "描述插件", "1.0.0", "x")
            override fun subscriptions() = listOf("e" to EventBus.Handler { })
        })
        val text = pm.describe()
        assertTrue("应报事件订阅条数", text.contains("事件订阅"))
        assertTrue("应带总线自述", text.contains("事件总线"))
    }
}

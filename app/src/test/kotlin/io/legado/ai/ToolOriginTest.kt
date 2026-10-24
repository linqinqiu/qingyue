package io.legado.ai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 工具来源标注与按来源管理。
 *
 * 背景：插件框架早就立起来了，但**装了什么、哪个工具归谁管**说不清。
 * `/api/agent/manifest` 只回 `id/group/description/writes`，插件一多
 * （本机实测装上一个示例插件就是 56 个工具）「AI 能调 56 个工具」就成了黑话：
 * 想卸一个插件时，无从判断会连带影响哪些能力；某个工具行为怪异时，也分不清是谁装的。
 *
 * 这里钉四件事：
 * 1. 插件注册的工具，`meta.origin` 要真的写成 `plugin:<id>`；
 * 2. `manifest()` 带得出来源（前端与审计直接能用）；
 * 3. 卸载插件要**精确摘除它自己的**，不碰内置、不碰别的插件；
 * 4. 内置工具的 origin 仍是 null（契约稳定：没插件时行为与从前一致）。
 */
class ToolOriginTest {

    private fun echo(id: String, group: String = "demo") = Tool { _, args ->
        AgentResult(status = "ok", message = "echo", data = args)
    }.also { it.meta = ToolMeta(id, group, "回显参数", writes = false) }

    // ===== 来源标注 =====

    @Test
    fun `插件注册的工具带 plugin 前缀来源`() {
        val reg = ToolRegistry()
        val tool = echo("demo.greet")
        assertTrue("注册应成功", reg.registerFromPlugin("demo.plugin", tool))
        assertEquals("plugin:demo.plugin", tool.meta.origin)
        assertEquals("plugin:demo.plugin", reg.find("demo.greet")?.meta?.origin)
    }

    @Test
    fun `内置工具来源仍是 null 契约稳定`() {
        val reg = ToolRegistry()
        val builtin = reg.find("source.list")
        assertNotNull("内置工具要在册", builtin)
        assertEquals("没插件时内置工具 origin 必须是 null（与从前一致）", null, builtin!!.meta.origin)
        assertTrue("null origin 就是内置", builtin.meta.isBuiltin)
    }

    @Test
    fun `manifest 带得出来源`() {
        val reg = ToolRegistry()
        reg.registerFromPlugin("demo.plugin", echo("demo.greet"))
        val byId = reg.manifest().associateBy { it.id }
        assertEquals("plugin:demo.plugin", byId["demo.greet"]?.origin)
        assertEquals("内置工具在 manifest 里 origin 为 null", null, byId["source.list"]?.origin)
    }

    @Test
    fun `isBuiltin 与 origin 一致`() {
        val reg = ToolRegistry()
        val pluginTool = echo("demo.x")
        reg.registerFromPlugin("p", pluginTool)
        assertFalse("插件工具不是内置", pluginTool.meta.isBuiltin)
        assertTrue("内置工具是内置", reg.find("source.list")!!.meta.isBuiltin)
    }

    // ===== 按来源查询 =====

    @Test
    fun `toolIdsOf 只回这个插件的工具`() {
        val reg = ToolRegistry()
        reg.registerFromPlugin("a", echo("a.one"))
        reg.registerFromPlugin("a", echo("a.two"))
        reg.registerFromPlugin("b", echo("b.one"))
        assertEquals(setOf("a.one", "a.two"), reg.toolIdsOf("a"))
        assertEquals(setOf("b.one"), reg.toolIdsOf("b"))
        assertTrue("没注册过的插件回空集合", reg.toolIdsOf("ghost").isEmpty())
    }

    @Test
    fun `toolsByOrigin 把内置与插件分开`() {
        val reg = ToolRegistry()
        reg.registerFromPlugin("demo.plugin", echo("demo.greet"))
        val byOrigin = reg.toolsByOrigin()
        val builtin = byOrigin[ToolRegistry.BUILTIN_ORIGIN]
        assertNotNull("内置那一组要在", builtin)
        assertTrue("内置那一组要含 source.list", builtin!!.contains("source.list"))
        assertFalse("内置那一组不该含插件工具", builtin.contains("demo.greet"))
        assertEquals(listOf("demo.greet"), byOrigin["plugin:demo.plugin"])
    }

    // ===== 卸载 =====

    @Test
    fun `卸载插件只摘它自己的 不碰内置与别的插件`() {
        val reg = ToolRegistry()
        reg.registerFromPlugin("a", echo("a.one"))
        reg.registerFromPlugin("a", echo("a.two"))
        reg.registerFromPlugin("b", echo("b.one"))

        val removed = reg.unregisterFromPlugin("a")

        assertEquals("摘掉两个", 2, removed)
        assertTrue("a.one 该没了", reg.find("a.one") == null)
        assertTrue("a.two 该没了", reg.find("a.two") == null)
        assertNotNull("别人的工具不许动", reg.find("b.one"))
        assertNotNull("内置工具更不许动", reg.find("source.list"))
        assertTrue("索引也要清干净", reg.toolIdsOf("a").isEmpty())
    }

    @Test
    fun `卸载没注册过的插件返回 0 不影响任何东西`() {
        val reg = ToolRegistry()
        val before = reg.size()
        assertEquals(0, reg.unregisterFromPlugin("ghost"))
        assertEquals("数量不该变", before, reg.size())
    }

    @Test
    fun `插件工具撞名被拒时来源索引不记它`() {
        val reg = ToolRegistry()
        // 先让 a 注册成功
        assertTrue(reg.registerFromPlugin("a", echo("dup.tool")))
        // b 再注册同一个 id —— 应被拒
        assertFalse("撞名应被拒", reg.registerFromPlugin("b", echo("dup.tool")))
        assertTrue("b 的索引里不该有它", reg.toolIdsOf("b").isEmpty())
        assertEquals("来源仍归第一个插件", "plugin:a", reg.find("dup.tool")?.meta?.origin)
    }

    @Test
    fun `卸载后重装同一个插件 id 能重新记索引`() {
        val reg = ToolRegistry()
        reg.registerFromPlugin("a", echo("a.one"))
        reg.unregisterFromPlugin("a")
        assertTrue("重装应成功", reg.registerFromPlugin("a", echo("a.one")))
        assertEquals(setOf("a.one"), reg.toolIdsOf("a"))
    }
}

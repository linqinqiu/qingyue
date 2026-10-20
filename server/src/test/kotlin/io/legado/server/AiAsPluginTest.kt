package io.legado.server

import io.legado.server.ai.AgentProfileStore
import io.legado.server.ai.LlmMessage
import io.legado.server.ai.LlmProvider
import io.legado.server.ai.LlmProviderRegistry
import io.legado.server.ai.OpenAiCompatibleProvider
import io.legado.server.ai.ToolHooks
import io.legado.server.ai.ToolRegistry
import io.legado.server.plugin.Plugin
import io.legado.server.plugin.PluginManager
import io.legado.server.plugin.PluginMetadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 端到端证明：「内置 AI 接入」真的可以拆成插件来完成。
 *
 * 场景：假设某天要把 openai-compatible 从框架里彻底拿掉，改为一个插件提供。
 * 这条判据走完那条路 —— 先注销内置实现，再用插件装回来，最后确认 AI 仍能工作。
 *
 * 如果这条绿了，说明"内置 AI 接入 api 后是可以完成插件功能"不是口号。
 */
class AiAsPluginTest {

    private class CustomProvider(private val reply: String) : LlmProvider {
        override val id = "openai-compatible"
        override val displayName = "插件版 OpenAI 兼容"
        override val description = "由插件提供，不是框架内置"
        override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? = reply
    }

    @Test
    fun `内置 AI 协议可以被拿掉 再由插件装回来`() {
        val registry = ToolRegistry()
        val hooks = ToolHooks()
        val providers = LlmProviderRegistry()

        // 1) 出厂状态：框架自带 openai-compatible
        assertTrue("默认应有内置实现", providers.find("openai-compatible") is OpenAiCompatibleProvider)

        // 2) 把它拿掉 —— 模拟"框架不再内置这个协议"
        assertTrue("可以注销内置实现", providers.unregister("openai-compatible"))
        assertEquals("拿掉后一个都没有", 0, providers.size())

        // 3) 用插件把它装回来
        val pm = PluginManager(registry, hooks, providers)
        val plugin = object : Plugin {
            override val metadata = PluginMetadata(
                id = "provider.openai", name = "OpenAI 兼容协议", version = "1.0.0",
                description = "以插件形式提供 openai-compatible 协议",
            )
            override fun llmProviders() = listOf(CustomProvider("插件提供的回复"))
        }
        assertTrue("插件装载应成功", pm.register(plugin))

        // 4) 确认插件版接管了
        val installed = providers.find("openai-compatible")
        assertNotNull("插件应把协议装回来", installed)
        assertTrue("应该是插件版而不是内置版", installed is CustomProvider)

        // 5) 真的能对话（不联网，走插件实现）
        val out = installed!!.chat(
            AgentProfileStore.Profile(
                id = "x", name = "x", kind = AgentProfileStore.ProfileKind.OPENAI_COMPATIBLE,
                baseUrl = "http://127.0.0.1:9/v1", model = "m",
            ),
            listOf(LlmMessage("user", "你好")),
        )
        assertEquals("插件版应真的被调用", "插件提供的回复", out)
    }

    @Test
    fun `插件卸载后协议跟着走 —— 卸载要干净`() {
        val registry = ToolRegistry()
        val hooks = ToolHooks()
        val providers = LlmProviderRegistry()
        providers.unregister("openai-compatible")

        val pm = PluginManager(registry, hooks, providers)
        pm.register(object : Plugin {
            override val metadata = PluginMetadata("provider.tmp", "临时协议", "1.0.0", "x")
            override fun llmProviders() = listOf(CustomProvider("x"))
        })
        assertNotNull("装上后应存在", providers.find("openai-compatible"))

        // 卸载必须把协议一起撤掉：否则卸了插件那家协议还挂着，
        // 下次换实现就会撞 id —— 这是插件框架最容易漏的一处。
        assertTrue(pm.unload("provider.tmp"))
        assertEquals("协议应随插件撤销", null, providers.find("openai-compatible"))
        assertEquals("注册表应回到空", 0, providers.size())
    }

    @Test
    fun `插件卸载后可以再装一次 不撞 id`() {
        val registry = ToolRegistry()
        val hooks = ToolHooks()
        val providers = LlmProviderRegistry()
        providers.unregister("openai-compatible")
        val pm = PluginManager(registry, hooks, providers)

        fun mk() = object : Plugin {
            override val metadata = PluginMetadata("provider.re", "可重装协议", "1.0.0", "x")
            override fun llmProviders() = listOf(CustomProvider("re"))
        }
        assertTrue("第一次装", pm.register(mk()))
        assertTrue("卸载", pm.unload("provider.re"))
        assertTrue("再装一次应成功（没留残影）", pm.register(mk()))
        assertNotNull(providers.find("openai-compatible"))
    }
}

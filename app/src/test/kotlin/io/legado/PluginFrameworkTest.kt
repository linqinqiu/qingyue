package io.legado

import io.legado.ai.AgentResult
import io.legado.ai.BuiltinTools
import io.legado.ai.Tool
import io.legado.ai.ToolHooks
import io.legado.ai.ToolMeta
import io.legado.ai.ToolRegistry
import io.legado.plugin.Plugin
import io.legado.plugin.PluginContext
import io.legado.plugin.PluginHooks
import io.legado.plugin.PluginManager
import io.legado.plugin.PluginMetadata
import io.legado.data.getCookieForUrl
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 插件框架的判据。测的是「框架」本身：发现、装载、卸载、隔离、自描述。
 *
 * 刻意**不测任何具体插件** —— 框架不含内容，测试里出现的插件都是就地造的最小桩，
 * 用来验证"任意插件都能被装进来"这件事，而不是验证某个功能。
 */
class PluginFrameworkTest {

    /** 最小插件桩：只声明元信息，什么都不做。 */
    private fun emptyPlugin(id: String = "demo.empty", name: String = "空插件") = object : Plugin {
        override val metadata = PluginMetadata(id = id, name = name, version = "1.0.0", description = "什么都不做")
    }

    /** 提供工具与钩子的插件桩。 */
    private fun toolPlugin(
        id: String = "demo.tools",
        toolId: String = "demo.echo",
        audit: MutableList<String>? = null,
    ) = object : Plugin {
        override val metadata = PluginMetadata(
            id = id, name = "工具插件", version = "1.2.3",
            description = "提供一个回显工具并挂审计钩子",
            author = "测试", capabilities = listOf("tools", "hooks"),
        )
        override fun tools() = listOf(
            Tool { _, args -> AgentResult(status = "ok", code = "ok", message = "from-plugin", data = args) }
                .also { it.meta = ToolMeta(toolId, "demo", "插件提供的回显", writes = false) }
        )
        override fun hooks() = PluginHooks(
            before = { meta, _ -> audit?.add("before:${meta.id}"); null },
            after = { meta, _, r -> audit?.add("after:${meta.id}:${r.code}"); null },
        )
    }

    private fun newManager(registry: ToolRegistry = ToolRegistry(), hooks: ToolHooks = ToolHooks()) =
        Triple(registry, hooks, PluginManager(registry, hooks))

    // ========== 装载 ==========

    @Test
    fun `装载 最小插件能装上 并出现在清单里`() {
        val (_, _, pm) = newManager()
        assertTrue("装载应成功", pm.register(emptyPlugin()))
        assertEquals(1, pm.size())
        assertTrue(pm.isLoaded("demo.empty"))
        assertEquals("清单里应有它的元信息", "空插件", pm.manifest().single().name)
    }

    @Test
    fun `装载 插件的工具真的进了注册表 且能被调用`() {
        val (registry, _, pm) = newManager()
        assertTrue(pm.register(toolPlugin()))

        val tool = registry.find("demo.echo")
        assertNotNull("插件的工具应出现在注册表里", tool)
        runBlocking {
            val res = tool!!.handler.invoke(lightContext(), mapOf("k" to "v"))
            assertEquals("插件工具应能执行", "from-plugin", res.message)
            @Suppress("UNCHECKED_CAST")
            assertEquals("参数应原样传到", "v", (res.data as? Map<String, Any?>)?.get("k"))
        }
    }

    /** 最轻量的真实 AgentContext：插件工具只用到它传参，不碰服务。 */
    private fun lightContext(): io.legado.ai.AgentContext {
        val db = io.legado.data.Database(
            java.nio.file.Files.createTempFile("pf-light", ".sqlite").toString()
        ).apply { initialize() }
        val runner = io.legado.rules.RuleRunner(db)
        return io.legado.ai.AgentContext(
            database = db,
            runner = runner,
            debugger = io.legado.source.SourceDebugger(runner),
            health = io.legado.source.SourceHealth(runner),
            subscriptions = io.legado.subscription.SubscriptionService(db) { },
            coverCache = io.legado.cache.CoverCache(
                directory = java.nio.file.Files.createTempDirectory("pf-covers"),
                cookieFor = { db.getCookieForUrl(it) },
            ),
        )
    }

    @Test
    fun `装载 插件的钩子真的挂上了`() {
        val (_, hooks, pm) = newManager()
        val audit = mutableListOf<String>()
        assertTrue(pm.register(toolPlugin(audit = audit)))
        assertEquals("钩子应挂上一组", 1, hooks.size())
    }

    @Test
    fun `装载 重复 id 被拒 不静默覆盖`() {
        val (_, _, pm) = newManager()
        assertTrue(pm.register(emptyPlugin("demo.dup")))
        assertFalse("同 id 再装应被拒", pm.register(emptyPlugin("demo.dup")))
        assertEquals("只应有一个", 1, pm.size())
        assertTrue("拒绝原因要留痕", pm.loadFailures().any { it.reason.contains("已装载") })
    }

    @Test
    fun `装载 空 id 被拒`() {
        val (_, _, pm) = newManager()
        assertFalse("空 id 不许装", pm.register(emptyPlugin(id = "")))
        assertTrue(pm.loadFailures().any { it.reason.contains("id 为空") })
    }

    // ========== 隔离：一个坏插件不能拖垮别的 ==========

    @Test
    fun `隔离 onLoad 抛异常的插件装载失败 但不影响其它插件`() {
        val (_, _, pm) = newManager()
        val broken = object : Plugin {
            override val metadata = PluginMetadata("demo.broken", "坏插件", "1.0.0", "onLoad 会炸")
            override fun onLoad(context: PluginContext) = throw IllegalStateException("我炸了")
        }
        assertFalse("坏插件装载应失败", pm.register(broken))
        assertTrue("应能继续装好插件", pm.register(emptyPlugin("demo.good")))
        assertEquals("好插件应装上", 1, pm.size())
        assertTrue("失败原因要留痕", pm.loadFailures().any { it.source == "demo.broken" && it.reason.contains("onLoad") })
    }

    @Test
    fun `隔离 tools 抛异常的插件不连坐其它插件`() {
        val (_, _, pm) = newManager()
        val broken = object : Plugin {
            override val metadata = PluginMetadata("demo.badtools", "坏工具插件", "1.0.0", "tools 会炸")
            override fun tools(): List<Tool> = throw IllegalStateException("tools 炸了")
        }
        assertTrue("tools 炸了插件本身仍算装上（只是没工具）", pm.register(broken))
        assertTrue(pm.loadFailures().any { it.reason.contains("tools()") })
        assertTrue("其它插件照常", pm.register(emptyPlugin("demo.other")))
        assertEquals(2, pm.size())
    }

    @Test
    fun `隔离 插件工具撞内置 id 时跳过并留痕 不覆盖内置`() {
        val (registry, _, pm) = newManager()
        val builtinId = BuiltinTools.all().first().meta.id
        val clash = object : Plugin {
            override val metadata = PluginMetadata("demo.clash", "撞名插件", "1.0.0", "撞内置工具 id")
            override fun tools() = listOf(
                Tool { _, _ -> AgentResult(status = "ok", message = "插件版") }
                    .also { it.meta = ToolMeta(builtinId, "demo", "试图覆盖内置", writes = false) }
            )
        }
        pm.register(clash)
        val actual = registry.find(builtinId)
        assertNotNull("内置工具仍在", actual)
        assertFalse("内置工具不能被插件覆盖", actual!!.meta.description == "试图覆盖内置")
        assertTrue("撞名要留痕", pm.loadFailures().any { it.reason.contains("已存在") })
    }

    // ========== 卸载 ==========

    @Test
    fun `卸载 工具与钩子都被撤掉`() {
        val (registry, hooks, pm) = newManager()
        val before = registry.size()
        assertTrue(pm.register(toolPlugin()))
        assertEquals("装上后多一个工具", before + 1, registry.size())
        assertEquals(1, hooks.size())

        assertTrue("卸载应成功", pm.unload("demo.tools"))
        assertEquals("工具应被撤掉", before, registry.size())
        assertNull("工具查不到了", registry.find("demo.echo"))
        assertEquals("钩子应被撤掉", 0, hooks.size())
        assertEquals(0, pm.size())
        assertFalse(pm.isLoaded("demo.tools"))
    }

    @Test
    fun `卸载 没装过的插件返回 false`() {
        val (_, _, pm) = newManager()
        assertFalse(pm.unload("never.loaded"))
    }

    @Test
    fun `卸载 插件 onUnload 抛异常不阻断卸载`() {
        val (registry, _, pm) = newManager()
        val bad = object : Plugin {
            override val metadata = PluginMetadata("demo.badunload", "卸载会炸", "1.0.0", "onUnload 抛异常")
            override fun tools() = listOf(
                Tool { _, _ -> AgentResult(status = "ok") }
                    .also { it.meta = ToolMeta("demo.badunload.tool", "demo", "x", false) }
            )
            override fun onUnload() = throw IllegalStateException("卸载也炸")
        }
        pm.register(bad)
        assertTrue("onUnload 抛异常也要完成卸载", pm.unload("demo.badunload"))
        assertNull("工具应已撤掉", registry.find("demo.badunload.tool"))
        assertEquals(0, pm.size())
    }

    // ========== 自描述（"能提供知道介绍"）==========

    @Test
    fun `介绍 空插件系统也能说清自己的状态`() {
        val (_, _, pm) = newManager()
        val text = pm.describe()
        assertTrue("应报版本", text.contains("插件框架"))
        assertTrue("应说清没装插件", text.contains("没有装载任何插件"))
    }

    @Test
    fun `介绍 装了插件后能列出名字 版本 说明 能力 工具`() {
        val (_, _, pm) = newManager()
        pm.register(toolPlugin())
        val text = pm.describe()
        assertTrue("名字", text.contains("工具插件"))
        assertTrue("id", text.contains("demo.tools"))
        assertTrue("版本", text.contains("v1.2.3"))
        assertTrue("说明", text.contains("提供一个回显工具并挂审计钩子"))
        assertTrue("作者", text.contains("测试"))
        assertTrue("能力", text.contains("tools"))
        assertTrue("工具清单", text.contains("demo.echo"))
    }

    @Test
    fun `介绍 装载失败也如实写出来 不静默`() {
        val (_, _, pm) = newManager()
        val broken = object : Plugin {
            override val metadata = PluginMetadata("demo.shown", "会失败", "1.0.0", "x")
            override fun onLoad(context: PluginContext) = throw RuntimeException("故意失败")
        }
        pm.register(broken)
        val text = pm.describe()
        assertTrue("失败要出现在介绍里", text.contains("装载失败"))
        assertTrue("要写清是谁", text.contains("demo.shown"))
    }

    // ========== 框架不含内容 ==========

    @Test
    fun `框架 默认不装载任何插件 零内容`() {
        val (_, _, pm) = newManager()
        assertEquals("框架本身不带任何插件", 0, pm.size())
        assertTrue("清单为空", pm.manifest().isEmpty())
        assertTrue("没有失败记录", pm.loadFailures().isEmpty())
    }

    @Test
    fun `框架 发现机制在找不到插件时安静返回 0`() {
        val (_, _, pm) = newManager()
        val emptyDir = java.nio.file.Files.createTempDirectory("pf-empty")
        assertEquals("空目录不该报错", 0, pm.discoverFrom(emptyDir))
        assertEquals("不存在的目录也不该报错", 0, pm.discoverFrom(emptyDir.resolve("nope")))
        assertTrue("这两种都不算失败", pm.loadFailures().isEmpty())
    }

    @Test
    fun `框架 插件注册的工具不影响内置工具数量`() {
        val (registry, _, pm) = newManager()
        val builtinCount = registry.builtinToolIds().size
        pm.register(toolPlugin())
        assertEquals("内置工具数不变", builtinCount, registry.builtinToolIds().size)
        assertEquals("总工具数增加", builtinCount + 1, registry.size())
    }

    @Test
    fun `框架 插件能注册 LLM 协议 —— 内置 AI 接入也能以插件形式扩展`() {
        val registry = ToolRegistry()
        val hooks = ToolHooks()
        val providers = io.legado.ai.LlmProviderRegistry()
        val pm = PluginManager(registry, hooks, providers)

        val providerPlugin = object : Plugin {
            override val metadata = PluginMetadata("demo.llm", "协议插件", "1.0.0", "注册一家自己的 LLM 协议")
            override fun llmProviders() = listOf(object : io.legado.ai.LlmProvider {
                override val id = "my-llm"
                override val displayName = "我的协议"
                override val description = "测试用"
                override fun chat(
                    profile: io.legado.ai.AgentProfileStore.Profile,
                    messages: List<io.legado.ai.LlmMessage>,
                ): String? = "ok"
            })
        }
        assertTrue("装载应成功", pm.register(providerPlugin))
        assertNotNull("插件注册的协议应进注册表", providers.find("my-llm"))
        assertEquals("默认的 openai 兼容仍在", 2, providers.size())
    }

    @Test
    fun `框架 插件协议撞已有 id 时跳过并留痕`() {
        val registry = ToolRegistry()
        val hooks = ToolHooks()
        val providers = io.legado.ai.LlmProviderRegistry()
        val pm = PluginManager(registry, hooks, providers)

        val clash = object : Plugin {
            override val metadata = PluginMetadata("demo.clash-llm", "撞名协议", "1.0.0", "撞 openai-compatible")
            override fun llmProviders() = listOf(object : io.legado.ai.LlmProvider {
                override val id = "openai-compatible"
                override val displayName = "试图覆盖"
                override val description = "x"
                override fun chat(
                    profile: io.legado.ai.AgentProfileStore.Profile,
                    messages: List<io.legado.ai.LlmMessage>,
                ): String? = null
            })
        }
        pm.register(clash)
        assertTrue("默认实现不能被插件覆盖", providers.find("openai-compatible") is io.legado.ai.OpenAiCompatibleProvider)
        assertTrue("撞名要留痕", pm.loadFailures().any { it.reason.contains("已存在") })
    }

    /**
     * 「插件研究到底怎么处理，要不取消了」（用户 2026-10-23）的落点 —— 保留还是取消，这里给结论：
     * **保留四个进程内扩展点**（工具注册表 / 生命周期钩子 / LLM provider / 连接选择策略），
     * 因为 `Agent` 的运行路径真的依赖它们（`Agent.kt` 的 `selectedProfile()` 走 selectorRegistry、
     * `callExternalHttp()` 走 providerRegistry），全删要重写 Agent；
     * 但**默认不再扫描 `plugins/` 目录吞 jar**。
     *
     * 关它的理由是安全边界而不是"没人用"（虽然 `plugins/` 里实测 0 个 jar、`examples/` 都没入库）：
     * 装载第三方 jar = 在青阅进程里执行任意代码，而本服务没有账号没有 token、
     * 唯一边界是"这台机器的文件权限"。装进来的代码读得到 `agent-profiles.json` 里的明文 apiKey、
     * 能绕过护栏直接改库（`confirm` 只是内置工具自愿调的闭包），它自写的 provider 还完全不过
     * `NetworkSecurity` 那道出站闸门 —— 上一轮发现的"AI 侧门"缺陷装个插件就能整体绕开。
     *
     * 所以这条判据是**反向**的：它钉的是"以后不许有人把无条件扫盘又接回 Application"，
     * 用静态读源码的方式（与本仓库 `插件不能注册路由` 那条同一手法），不起服务也能跑。
     */
    @Test
    fun `默认不扫盘装 jar 但四个扩展点照旧接得住`() {
        val application = readRepoFile("app/src/main/kotlin/io/legado/Application.kt")
        val config = readRepoFile("app/src/main/kotlin/io/legado/AppConfig.kt")

        assertTrue("discoverFrom 必须受开关控制，不许无条件扫盘",
            Regex("if \\(jarScanEnabled\\)[\\s\\r\\n]{0,60}pluginManager\\.discoverFrom").containsMatchIn(application))
        assertTrue("开关的键要在 AppConfig 里显式存在", config.contains("LEGADO_PLUGIN_JAR_SCAN"))
        assertFalse("开关默认必须是关（不许写成 || true 这类默认开）",
            Regex("val pluginJarScan[\\s\\S]{0,240}?\\|\\|\\s*true").containsMatchIn(config))
        // 有 jar 却没扫时必须说一句话：静默不装最难查 —— 用户丢进一个 jar、界面上永远是 0，
        // 他会以为是自己插件写错了。
        assertTrue("目录里有 jar 而未装载时要留痕", application.contains("但默认不装载外部 jar 插件"))
        // 四个扩展点一个都不许撤：撤了 Agent 就跑不起来。
        for (point in listOf(
            "registry = agentConnection.registry",
            "hooks = agentConnection.hooks",
            "providers = agentConnection.providerRegistry",
            "selectors = agentConnection.selectorRegistry",
        )) {
            assertTrue("构造 PluginManager 时要带上 $point", application.contains(point))
        }
    }

    /**
     * 从仓库根读文件文本。`:app:test` 的工作目录是 `legado/app`，
     * 所以先试模块目录、再试它的上一级（仓库根）—— 两处都能找到就不依赖跑测试时的 cwd。
     */
    private fun readRepoFile(relative: String): String {
        val module = java.io.File(System.getProperty("user.dir"))
        val file = listOf(module, module.parentFile).filterNotNull()
            .map { java.io.File(it, relative) }
            .firstOrNull { it.isFile }
        assertTrue("找不到 $relative（测的是源码形状，文件不在就说明路径变了）", file != null)
        return file!!.readText()
    }
}

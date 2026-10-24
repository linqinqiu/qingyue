package io.legado.plugin

import io.legado.ai.ToolHooks
import io.legado.ai.LlmProviderRegistry
import io.legado.ai.ConnectionSelectorRegistry
import io.legado.ai.ToolRegistry
import kotlinx.serialization.Serializable
import java.util.ServiceLoader
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 插件管理器 —— 发现、装载、卸载、自描述。框架侧的全部逻辑都在这里。
 *
 * 设计红线（用户原话："只做框架，不要有任何自己的内容"）：
 * 本类**不认识任何具体插件**。它只做三件事：
 * 1. 从若干来源**发现**实现了 [Plugin] 的类
 * 2. 把它们装进 [ToolRegistry] / [ToolHooks]
 * 3. 对外**介绍**装了什么（[describe]）
 *
 * 发现来源（框架不预设"插件该放哪"，三条都支持，按需用）：
 * - [register]  —— 代码里直接注册（最常用：宿主程序自己带的插件）
 * - [discover]  —— 用 `ServiceLoader` 扫 classpath 上的 `META-INF/services`（标准 Java 插件机制）
 * - [discoverFrom] —— 从指定目录的 jar 里扫（真正的"外部插件"，不重编译主程序）
 *
 * 三条安全不变量：
 * 1. **一个坏插件不能拖垮别的**：装载失败只记录进 [loadFailures]，其余照常装。
 * 2. **插件不能注册 HTTP 路由**：本类不碰 routing，端点计数恒定（ApiCatalog 门禁照旧）。
 * 3. **卸载要彻底**：工具与钩子都撤掉，且内置工具撤不掉（由 ToolRegistry 守）。
 */
class PluginManager(
    private val registry: ToolRegistry,
    private val hooks: ToolHooks,
    private val providers: LlmProviderRegistry = LlmProviderRegistry(),
    private val selectors: ConnectionSelectorRegistry = ConnectionSelectorRegistry(),
    private val events: EventBus = AppEvents.bus,
    /** 框架版本：默认取构建号（`BuildInfo.version`），不写死 —— 写死就会像 0.8.2 那样漂走。 */
    private val frameworkVersion: String = io.legado.BuildInfo.version,
) {

    /** 已装载的插件（按装载顺序）。 */
    private val loaded = CopyOnWriteArrayList<LoadedPlugin>()

    /** 装载失败的记录（id/类名 → 原因）。对外可见 —— 装失败了不能静默。 */
    private val failures = CopyOnWriteArrayList<LoadFailure>()

    /** 一个已装载插件及其可撤销句柄。 */
    private class LoadedPlugin(
        val plugin: Plugin,
        val registeredToolIds: List<String>,
        val registeredProviderIds: List<String>,
        val registeredSelectorIds: List<String>,
        val subscriptionHandles: List<AutoCloseable>,
        val hookHandle: AutoCloseable?,
    )

    data class LoadFailure(val source: String, val reason: String)

    /** 当前已装载插件的元信息（给"介绍"页用）。 */
    fun manifest(): List<PluginMetadata> = loaded.map { it.plugin.metadata }

    /** 装载失败的记录。 */
    fun loadFailures(): List<LoadFailure> = failures.toList()

    /** 已装载数量。 */
    fun size(): Int = loaded.size

    /** 某个插件是否已装载（按 metadata.id）。 */
    fun isLoaded(pluginId: String): Boolean = loaded.any { it.plugin.metadata.id == pluginId }

    /**
     * 直接注册并装载一个插件实例。
     *
     * @return 装载成功返回 true；失败返回 false 并记入 [loadFailures]。
     */
    fun register(plugin: Plugin): Boolean {
        val meta = plugin.metadata
        // id 必须像样：空的或占位的 id 会让"介绍"页出现无主条目。
        if (meta.id.isBlank()) {
            failures += LoadFailure(source = plugin::class.qualifiedName ?: "?", reason = "插件 metadata.id 为空")
            return false
        }
        if (isLoaded(meta.id)) {
            failures += LoadFailure(source = meta.id, reason = "插件 ${meta.id} 已装载，跳过重复装载")
            return false
        }
        return load(plugin, source = meta.id)
    }

    /**
     * 用标准 Java 机制发现插件：扫 classpath 上 `META-INF/services/io.legado.plugin.Plugin`。
     * 这是让第三方**不改主程序源码**就能加插件的最简路径。
     *
     * @return 本次成功装载的数量
     */
    fun discover(classLoader: ClassLoader = Thread.currentThread().contextClassLoader ?: javaClass.classLoader): Int {
        var count = 0
        val iterator = try {
            ServiceLoader.load(Plugin::class.java, classLoader).iterator()
        } catch (e: Throwable) {
            failures += LoadFailure(source = "ServiceLoader", reason = "发现插件失败：${e.message ?: e::class.simpleName}")
            return 0
        }
        while (true) {
            val plugin = try {
                if (!iterator.hasNext()) break
                iterator.next()
            } catch (e: Throwable) {
                // 某个插件类实例化失败，不能中断整轮发现。
                failures += LoadFailure(source = "ServiceLoader", reason = "实例化失败：${e.message ?: e::class.simpleName}")
                continue
            }
            if (load(plugin, source = plugin.metadata.id)) count++
        }
        return count
    }

    /**
     * 从目录里的 jar 发现插件：扫该目录下全部 `.jar` 文件，用独立的 URLClassLoader 加载，
     * 找 `META-INF/services/io.legado.plugin.Plugin`。
     *
     * 这是"外部插件"的真路径：插件作者把自己的 jar 丢进目录，主程序不重编译。
     * 目录不存在时返回 0（不报错 —— 没装插件是正常状态）。
     *
     * 注意：这是**加载任意代码**的能力，与"不把服务搬出本机"是同一条信任边界 ——
     * 只在用户主动指定的目录上做，不扫全盘。
     */
    fun discoverFrom(directory: java.nio.file.Path): Int {
        if (!java.nio.file.Files.isDirectory(directory)) return 0
        val jars = java.nio.file.Files.list(directory).use { stream ->
            stream.filter { it.fileName.toString().endsWith(".jar", ignoreCase = true) }.toList()
        }
        var count = 0
        for (jar in jars) {
            val loader = try {
                java.net.URLClassLoader(arrayOf(jar.toUri().toURL()), javaClass.classLoader)
            } catch (e: Throwable) {
                failures += LoadFailure(source = jar.fileName.toString(), reason = "打开 jar 失败：${e.message ?: e::class.simpleName}")
                continue
            }
            count += try {
                discover(loader)
            } catch (e: Throwable) {
                failures += LoadFailure(source = jar.fileName.toString(), reason = "扫描失败：${e.message ?: e::class.simpleName}")
                0
            }
        }
        return count
    }

    /**
     * 卸载一个插件：撤掉它的工具与钩子，调 [Plugin.onUnload]。
     *
     * 内置工具撤不掉（[ToolRegistry] 守），所以插件就算 id 撞上内置也只会撤掉自己那份。
     *
     * @return 卸载成功返回 true；没装载过返回 false。
     */
    fun unload(pluginId: String): Boolean {
        val target = loaded.firstOrNull { it.plugin.metadata.id == pluginId } ?: return false
        // 只撤本插件注册的那些。以注册表的来源索引为准（单一来源），
        // 万一装载时漏记了某条，这里也兜得住。
        registry.unregisterFromPlugin(pluginId)
        target.registeredToolIds.forEach { id ->
            // 撞名被拒的情况不会出现在这里；上面那句已摘掉绝大部分
            registry.unregister(id)
        }
        target.registeredProviderIds.forEach { id ->
            // 插件带来的 LLM 协议也要跟着走：否则卸了插件，那家协议还挂着，
            // 下次换成别的实现就会撞 id（"卸载不干净"是插件框架最容易漏的一处）。
            providers.unregister(id)
        }
        target.registeredSelectorIds.forEach { id ->
            // 同样：插件贡献的连接选择策略也要撤掉，否则换实现会撞 id。
            selectors.unregister(id)
        }
        target.subscriptionHandles.forEach { handle ->
            // 订阅同样要撤：否则卸载后回调还在跑，指向已失效的对象。
            try {
                handle.close()
            } catch (e: Throwable) {
                failures += LoadFailure(source = pluginId, reason = "注销订阅失败：${e.message ?: e::class.simpleName}")
            }
        }
        try {
            target.hookHandle?.close()
        } catch (e: Throwable) {
            failures += LoadFailure(source = pluginId, reason = "卸载钩子失败：${e.message ?: e::class.simpleName}")
        }
        try {
            target.plugin.onUnload()
        } catch (e: Throwable) {
            failures += LoadFailure(source = pluginId, reason = "onUnload 抛异常：${e.message ?: e::class.simpleName}")
        }
        loaded.remove(target)
        return true
    }

    /**
     * 框架自我介绍：当前装了什么、每个插件做什么、失败了哪些。
     * 这是"能提供知道介绍"要求的落点 —— 人看这一份就知道插件系统的状态。
     */
    fun describe(): String = buildString {
        appendLine("插件框架 v$frameworkVersion")
        appendLine("已装载 ${loaded.size} 个插件，注册工具 ${registry.size()} 个（含内置）。")
        if (loaded.isEmpty()) {
            appendLine("（当前没有装载任何插件。把实现 Plugin 的 jar 放进插件目录，或调用 register/discover。）")
        } else {
            for (lp in loaded) {
                val m = lp.plugin.metadata
                appendLine()
                appendLine("· ${m.name}（${m.id}）v${m.version}")
                appendLine("  ${m.description}")
                if (m.author.isNotBlank()) appendLine("  作者：${m.author}")
                if (m.homepage.isNotBlank()) appendLine("  主页：${m.homepage}")
                if (m.capabilities.isNotEmpty()) appendLine("  能力：${m.capabilities.joinToString(", ")}")
                appendLine("  工具：${lp.registeredToolIds.joinToString(", ").ifBlank { "（无）" }}")
                if (lp.registeredProviderIds.isNotEmpty()) {
                    appendLine("  LLM 协议：${lp.registeredProviderIds.joinToString(", ")}")
                }
                if (lp.registeredSelectorIds.isNotEmpty()) {
                    appendLine("  连接策略：${lp.registeredSelectorIds.joinToString(", ")}")
                }
                if (lp.subscriptionHandles.isNotEmpty()) {
                    appendLine("  事件订阅：${lp.subscriptionHandles.size} 条")
                }
            }
        }
        // 事件总线状态也报出来 —— 否则"为什么我的插件没收到事件"没法查。
        appendLine()
        appendLine(events.describe().trimEnd())
        val failed = failures.toList()
        if (failed.isNotEmpty()) {
            appendLine()
            appendLine("装载失败 ${failed.size} 项：")
            failed.forEach { appendLine("  · ${it.source}：${it.reason}") }
        }
    }

    /**
     * 结构化状态快照 —— 给 `/api/plugins` 用。
     *
     * 为什么要有它：装载失败原来只打到控制台，用户在界面上看不到。
     * 插件是第三方代码，装没装上、为什么没装上必须能被人看见。
     */
    fun status(): PluginStatusDto = PluginStatusDto(
        loaded = loaded.size,
        tools = registry.size(),
        providers = providers.size(),
        selectors = selectors.size(),
        plugins = loaded.map { lp ->
            val m = lp.plugin.metadata
            PluginStatusDto.Item(
                id = m.id,
                name = m.name,
                version = m.version,
                description = m.description,
                author = m.author.ifBlank { null },
                tools = lp.registeredToolIds,
                llmProviders = lp.registeredProviderIds,
                connectionSelectors = lp.registeredSelectorIds,
                subscriptions = lp.subscriptionHandles.size,
            )
        },
        failures = failures.map { PluginStatusDto.Failure(it.source, it.reason) },
        describe = describe(),
    )

    // ———— 内部装载 ————

    private fun load(plugin: Plugin, source: String): Boolean {
        val meta = plugin.metadata
        val context = PluginContext(registry = registry, hooks = hooks, providers = providers, selectors = selectors, events = events, frameworkVersion = frameworkVersion)

        // 1) onLoad 先跑：插件可以在这里做自己的初始化（失败即整体失败）。
        try {
            plugin.onLoad(context)
        } catch (e: Throwable) {
            failures += LoadFailure(source = source, reason = "onLoad 失败：${e.message ?: e::class.simpleName}")
            return false
        }

        // 2) 注册工具。单个工具注册失败不连坐其它工具，但记下来。
        val registeredIds = mutableListOf<String>()
        val tools = try {
            plugin.tools()
        } catch (e: Throwable) {
            failures += LoadFailure(source = source, reason = "tools() 抛异常：${e.message ?: e::class.simpleName}")
            emptyList()
        }
        for (tool in tools) {
            val id = tool.meta.id
            val ok = try {
                // 走 registerFromPlugin：把「这个工具归哪个插件」记进注册表，
                // manifest 才能说清每个工具是谁装的，卸载时也摘得干净。
                registry.registerFromPlugin(meta.id, tool)
            } catch (e: Throwable) {
                failures += LoadFailure(source = source, reason = "注册工具 $id 失败：${e.message ?: e::class.simpleName}")
                false
            }
            if (ok) registeredIds += id
            else if (registry.find(id) != null) {
                failures += LoadFailure(source = source, reason = "工具 $id 已存在（可能撞了内置工具），本插件这一条被跳过")
            }
        }

        // 3) 注册 LLM 协议。这样"内置 AI 接入"也能以插件形式扩展 ——
        //    插件注册一个 LlmProvider，框架就多认一种协议，不必改框架源码。
        val llmProviders = try {
            plugin.llmProviders()
        } catch (e: Throwable) {
            failures += LoadFailure(source = source, reason = "llmProviders() 抛异常：${e.message ?: e::class.simpleName}")
            emptyList()
        }
        val registeredProviderIds = mutableListOf<String>()
        for (p in llmProviders) {
            val ok = try {
                providers.register(p)
            } catch (e: Throwable) {
                failures += LoadFailure(source = source, reason = "注册 LLM 协议 ${p.id} 失败：${e.message ?: e::class.simpleName}")
                false
            }
            if (ok) registeredProviderIds += p.id
            else {
                failures += LoadFailure(source = source, reason = "LLM 协议 ${p.id} 已存在，本插件这一条被跳过")
            }
        }

        // 3.5) 注册连接选择策略。对称于 LLM 协议：插件可以贡献"连哪个外部连接"的策略
        //      （如按健康度 failover），默认仍是 FirstProfileSelector（取第一个，见 AGENTS.md §4）。
        val connectionSelectors = try {
            plugin.connectionSelectors()
        } catch (e: Throwable) {
            failures += LoadFailure(source = source, reason = "connectionSelectors() 抛异常：${e.message ?: e::class.simpleName}")
            emptyList()
        }
        val registeredSelectorIds = mutableListOf<String>()
        for (s in connectionSelectors) {
            val id = s::class.simpleName ?: continue
            val ok = try {
                selectors.register(s)
            } catch (e: Throwable) {
                failures += LoadFailure(source = source, reason = "注册连接策略 $id 失败：${e.message ?: e::class.simpleName}")
                false
            }
            if (ok) registeredSelectorIds += id
            else {
                failures += LoadFailure(source = source, reason = "连接策略 $id 已存在，本插件这一条被跳过")
            }
        }

        // 4) 挂钩子（三者都空就不挂，省一个句柄）。
        val ph = try {
            plugin.hooks()
        } catch (e: Throwable) {
            failures += LoadFailure(source = source, reason = "hooks() 抛异常：${e.message ?: e::class.simpleName}")
            PluginHooks.NONE
        }
        val handle = if (ph.before == null && ph.after == null && ph.onError == null) null
        else hooks.install(before = ph.before, after = ph.after, onError = ph.onError)

        // 5) 订阅事件。框架代管句柄 —— 插件自己管很容易漏，
        //    漏了就是"卸载后回调还在跑，指向已失效的对象"。
        val subscriptionHandles = mutableListOf<AutoCloseable>()
        val subs = try {
            plugin.subscriptions()
        } catch (e: Throwable) {
            failures += LoadFailure(source = source, reason = "subscriptions() 抛异常：${e.message ?: e::class.simpleName}")
            emptyList()
        }
        for ((name, handler) in subs) {
            try {
                subscriptionHandles += events.subscribe(name, handler)
            } catch (e: Throwable) {
                failures += LoadFailure(source = source, reason = "订阅事件 $name 失败：${e.message ?: e::class.simpleName}")
            }
        }

        loaded += LoadedPlugin(
            plugin = plugin,
            registeredToolIds = registeredIds,
            registeredProviderIds = registeredProviderIds,
            registeredSelectorIds = registeredSelectorIds,
            subscriptionHandles = subscriptionHandles,
            hookHandle = handle,
        )
        return true
    }
}

/**
 * 插件状态快照（`GET /api/plugins` 的响应体）。
 *
 * 刻意只暴露**描述性**信息，不暴露插件内部对象 —— 界面只需要知道"装了什么、谁装的、
 * 贡献了什么、哪些失败了"，不需要也不能拿到可调用的句柄（那会让前端能绕过框架直调）。
 */
@Serializable
data class PluginStatusDto(
    /** 已装载插件数。 */
    val loaded: Int,
    /** 当前工具总数（含内置）。 */
    val tools: Int,
    /** 当前 LLM 协议总数（含内置 openai-compatible）。 */
    val providers: Int,
    /** 当前连接选择策略总数（含内置 FirstProfileSelector）。 */
    val selectors: Int,
    val plugins: List<Item>,
    val failures: List<Failure>,
    /** 人读的完整介绍（`describe()` 的原文），界面可直接展示。 */
    val describe: String,
) {
    @Serializable
    data class Item(
        val id: String,
        val name: String,
        val version: String,
        val description: String,
        val author: String? = null,
        /** 这个插件注册的工具 id。 */
        val tools: List<String> = emptyList(),
        /** 这个插件注册的 LLM 协议 id。 */
        val llmProviders: List<String> = emptyList(),
        /** 这个插件注册的连接选择策略 id。 */
        val connectionSelectors: List<String> = emptyList(),
        /** 这个插件挂了几条事件订阅。 */
        val subscriptions: Int = 0,
    )

    @Serializable
    data class Failure(val source: String, val reason: String)
}
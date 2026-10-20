package io.legado.server.plugin

import io.legado.server.ai.ToolHooks
import io.legado.server.ai.LlmProviderRegistry
import io.legado.server.ai.ToolRegistry
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
    private val frameworkVersion: String = "0.8.2",
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
     * 用标准 Java 机制发现插件：扫 classpath 上 `META-INF/services/io.legado.server.plugin.Plugin`。
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
     * 找 `META-INF/services/io.legado.server.plugin.Plugin`。
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
        target.registeredToolIds.forEach { id ->
            // 只撤本插件注册的那些；撞名被拒的情况不会出现在这里
            registry.unregister(id)
        }
        target.registeredProviderIds.forEach { id ->
            // 插件带来的 LLM 协议也要跟着走：否则卸了插件，那家协议还挂着，
            // 下次换成别的实现就会撞 id（"卸载不干净"是插件框架最容易漏的一处）。
            providers.unregister(id)
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
            }
        }
        val failed = failures.toList()
        if (failed.isNotEmpty()) {
            appendLine()
            appendLine("装载失败 ${failed.size} 项：")
            failed.forEach { appendLine("  · ${it.source}：${it.reason}") }
        }
    }

    // ———— 内部装载 ————

    private fun load(plugin: Plugin, source: String): Boolean {
        val meta = plugin.metadata
        val context = PluginContext(registry = registry, hooks = hooks, providers = providers, frameworkVersion = frameworkVersion)

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
                registry.register(tool)
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

        // 4) 挂钩子（三者都空就不挂，省一个句柄）。
        val ph = try {
            plugin.hooks()
        } catch (e: Throwable) {
            failures += LoadFailure(source = source, reason = "hooks() 抛异常：${e.message ?: e::class.simpleName}")
            PluginHooks.NONE
        }
        val handle = if (ph.before == null && ph.after == null && ph.onError == null) null
        else hooks.install(before = ph.before, after = ph.after, onError = ph.onError)

        loaded += LoadedPlugin(
            plugin = plugin,
            registeredToolIds = registeredIds,
            registeredProviderIds = registeredProviderIds,
            hookHandle = handle,
        )
        return true
    }
}

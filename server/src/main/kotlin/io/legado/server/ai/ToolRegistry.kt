package io.legado.server.ai

import java.util.concurrent.ConcurrentHashMap

/**
 * 工具注册表 —— 让「AI 能做什么」成为**可扩展的基础设施**，而不是一份写死的清单。
 *
 * 设计定位（用户原话："我们做的是框架，不是具体内容，基础性质设施，提供更多可能"）：
 * 从前 `Agent` 只能吃 `BuiltinTools.all()` 这一份硬编码的 `listOf(...)`，想加一个工具
 * 就得改那个文件的源码、重新编译。现在工具面是**运行时可变**的：
 *
 * ```kotlin
 * registry.register(Tool { ctx, args -> ctx.error("ok", "hello") }.also {
 *     it.meta = ToolMeta("demo.hello", "demo", "示例工具", writes = false)
 * })
 * ```
 *
 * 三条不变量（守住框架纪律，不因为"可扩展"就放水）：
 * 1. **id 唯一**：重复注册同一个 id 默认拒绝（返回 false），要覆盖必须显式 `replace = true`。
 *    —— 静默覆盖会让两个来源的工具互相踩，排查时根本看不出是谁赢。
 * 2. **内置工具永远在**：`BuiltinTools.all()` 在构造时注入，外部只能增删自己那份，
 *    除非显式传 `allowRemovingBuiltin = true`（默认 false）。防止插件把 `source.delete` 悄悄摘掉。
 * 3. **线程安全**：注册表被 HTTP 请求线程与进程内调用方共用，用 `ConcurrentHashMap` 兜住。
 *
 * 与 HTTP 端点计数无关：这里注册的工具**不产生任何 HTTP 路由**，`/api/catalog` 的 139 条不变。
 * `ApiCatalog.test.ts` 那道双向核对门禁照常成立。
 */
class ToolRegistry(
    builtin: List<Tool> = BuiltinTools.all(),
    private val allowRemovingBuiltin: Boolean = false,
) {

    private val tools = ConcurrentHashMap<String, Tool>()
    private val builtinIds: MutableSet<String> = ConcurrentHashMap.newKeySet()

    init {
        builtin.forEach { t ->
            val id = t.meta.id
            require(id.isNotBlank() && id != "__unset__") { "内置工具必须带 ToolMeta.id：$t" }
            require(tools.putIfAbsent(id, t) == null) { "内置工具 id 重复：$id" }
            builtinIds += id
        }
    }

    /** 注册一个工具。id 已存在时返回 false（不覆盖），除非 [replace] 为 true。 */
    fun register(tool: Tool, replace: Boolean = false): Boolean {
        val id = tool.meta.id
        require(id.isNotBlank() && id != "__unset__") {
            "注册工具必须带 ToolMeta.id（用 Tool { … }.also { it.meta = ToolMeta(...) } 贴上）"
        }
        if (!replace) return tools.putIfAbsent(id, tool) == null
        tools[id] = tool
        // replace 一个内置 id 时，它仍然算内置：不许借此把内置工具变成可删的
        if (builtinIds.contains(id)) builtinIds += id
        return true
    }

    /**
     * 注销一个工具。内置工具默认**拒绝删除**（返回 false），
     * 除非构造时显式 `allowRemovingBuiltin = true` —— 这是防止插件摘掉核心能力的硬门。
     */
    fun unregister(id: String): Boolean {
        if (!allowRemovingBuiltin && builtinIds.contains(id)) return false
        return tools.remove(id) != null
    }

    /** 按 id 取工具；没有就返回 null。 */
    fun find(id: String): Tool? = tools[id]

    /** 当前全部工具（顺序不稳定 —— 需要稳定顺序时用 [snapshot]，它按 id 排序）。 */
    fun all(): List<Tool> = tools.values.toList()

    /**
     * 稳定快照：按 id 排序。
     * `toolManifest()` 对外暴露能力清单时要可复现 —— 顺序随 `ConcurrentHashMap` 迭代漂移，
     * 会让"同一个服务两次返回不同清单"这种假 bug 冒出来。
     */
    fun snapshot(): List<Tool> = tools.values.sortedBy { it.meta.id }

    /** 能力清单（元信息），按 id 排序。 */
    fun manifest(): List<ToolMeta> = snapshot().map { it.meta }

    /** 当前注册数量（含内置）。 */
    fun size(): Int = tools.size

    /** 某个 id 是不是内置工具（外部想判断"我能不能删它"时用）。 */
    fun isBuiltin(id: String): Boolean = builtinIds.contains(id)

    /** 内置工具 id 快照（只读用途）。 */
    fun builtinToolIds(): Set<String> = builtinIds.toSet()
}

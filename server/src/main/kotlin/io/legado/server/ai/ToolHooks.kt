package io.legado.server.ai

import java.util.concurrent.CopyOnWriteArrayList

/**
 * 工具调用的生命周期钩子 —— 让外部能在**不修改框架源码**的前提下挂载审计、限流、改写。
 *
 * 设计定位（用户原话："基础性质设施，提供更多可能"）：
 * 从前一次 `runTool` 是黑盒：进来、执行、返回，中间没有任何插手点。想加"记录每次写操作"
 * 或者"某个工具每分钟最多调 5 次"就得改 `Agent.runTool` 本身。现在有四个标准介入点：
 *
 * ```
 * beforeTool  ──→  执行工具  ──→  afterTool
 *    │                                │
 *    └── 返回非 null 即拦截             └── 可改写结果
 * ```
 *
 * 语义（每条都定死了，不留"看实现"的模糊）：
 * - [beforeTool] 返回 `null` = 放行；返回非 null = **拦截**，直接把它当最终结果返回，工具不执行。
 *   典型用法：限流（超了返回 `rate_limited`）、权限（没授权返回 `forbidden`）、写前确认。
 * - [afterTool] 拿到工具结果，返回 `null` = 保持原结果；返回非 null = 用它的替换。
 *   典型用法：脱敏、统一错误码、附加耗时。
 * - [onError] 工具抛异常时回调（框架已把它转成 error 结果之后）。
 * - 钩子**按注册顺序**执行；任一 `beforeTool` 拦截后，后续 `beforeTool` 与工具本体都不再执行
 *   （但 `afterTool` 仍会看到这个拦截结果 —— 拦截也是一种结果，审计要能看见）。
 *
 * 红线：钩子**不能**改变"写操作必须过 Guardrails"这条 —— 它在工具内部，钩子在工具外面。
 * 钩子可以拒绝，但不能替工具绕过护栏。
 */
class ToolHooks {

    /** 工具执行前。返回非 null 即拦截（该结果直接作为最终返回）。 */
    fun interface Before {
        suspend fun before(tool: ToolMeta, args: ToolArgs): AgentResult?
    }

    /** 工具执行后。返回非 null 即替换工具结果。 */
    fun interface After {
        suspend fun after(tool: ToolMeta, args: ToolArgs, result: AgentResult): AgentResult?
    }

    /** 工具抛异常时（框架已转成 error 结果之后回调，用于日志/告警）。 */
    fun interface OnError {
        suspend fun onError(tool: ToolMeta, args: ToolArgs, error: Throwable, converted: AgentResult)
    }

    private data class Entry(
        val before: Before? = null,
        val after: After? = null,
        val onError: OnError? = null,
    )

    private val entries = CopyOnWriteArrayList<Entry>()

    /**
     * 注册一组钩子。三者都可空 —— 只关心一个阶段就只传一个。
     * 返回一个**注销句柄**，调用它即移除这组钩子（插件卸载时用）。
     */
    fun install(before: Before? = null, after: After? = null, onError: OnError? = null): AutoCloseable {
        val entry = Entry(before, after, onError)
        entries += entry
        return AutoCloseable { entries.remove(entry) }
    }

    /** 当前挂了几组钩子（诊断用）。 */
    fun size(): Int = entries.size

    /** 全部清空（测试与热重载用）。 */
    fun clear() = entries.clear()

    /**
     * 执行 before 链。返回第一个非 null 的拦截结果；全放行则返回 null。
     * 内部用，[Agent] 调用。
     */
    internal suspend fun runBefore(meta: ToolMeta, args: ToolArgs): AgentResult? {
        for (e in entries) {
            val r = e.before?.before(meta, args)
            if (r != null) return r
        }
        return null
    }

    /**
     * 执行 after 链。允许逐层改写：每个钩子的返回值成为下一个钩子的输入。
     * 返回最终结果（没有钩子改写就是传进来的那个）。
     */
    internal suspend fun runAfter(meta: ToolMeta, args: ToolArgs, initial: AgentResult): AgentResult {
        var current = initial
        for (e in entries) {
            val r = e.after?.after(meta, args, current)
            if (r != null) current = r
        }
        return current
    }

    /** 执行 error 链（异常已被转成 error 结果）。异常本身也传下去，方便记录堆栈。 */
    internal suspend fun runOnError(meta: ToolMeta, args: ToolArgs, error: Throwable, converted: AgentResult) {
        for (e in entries) {
            e.onError?.onError(meta, args, error, converted)
        }
    }
}

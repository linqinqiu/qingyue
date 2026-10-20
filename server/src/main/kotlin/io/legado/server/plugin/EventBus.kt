package io.legado.server.plugin

import java.util.concurrent.CopyOnWriteArrayList

/**
 * 事件总线 —— 让插件能**感知系统里发生了什么**，而不必轮询数据库。
 *
 * 设计红线（与插件框架同一条）：本类**不含任何具体事件的定义**。
 * 它只提供"订阅/发布"这套机制，事件名与载荷由发布方与订阅方约定。
 * 这样框架不必预知"哪些事件该存在"—— 想加一类事件，发布方发就是了。
 *
 * 用法：
 * ```kotlin
 * // 插件里订阅
 * val handle = bus.subscribe("source.saved") { event ->
 *     println("书源被保存：${event.payload["id"]}")
 * }
 *
 * // 业务代码里发布（例如 SourcesDao.saveSource 成功后）
 * bus.publish(Event("source.saved", mapOf("id" to id)))
 * ```
 *
 * 四条纪律（每一条都对应一类真实故障）：
 * 1. **一个订阅者抛异常不影响别的** —— 每个回调单独 try/catch，坏插件不能把发布方带崩。
 * 2. **发布不阻塞业务** —— 回调在调用线程上同步执行（保持简单、可预测），
 *    但订阅者应当自己快速返回；重活请自行投递到协程。
 * 3. **通配订阅** —— `subscribe("*")` 能收到全部事件（做审计/日志的插件用）。
 * 4. **注销要彻底** —— `subscribe` 返回句柄，`close()` 即移除；插件卸载时框架负责调它。
 */
class EventBus {

    /** 一个事件。`name` 由发布方定义，`payload` 是扁平键值（与工具参数同一风格）。 */
    data class Event(
        val name: String,
        val payload: Map<String, Any?> = emptyMap(),
        /** 事件发生时刻（毫秒）。便于订阅方做时间窗口统计。 */
        val at: Long = System.currentTimeMillis(),
    )

    /** 订阅回调。 */
    fun interface Handler {
        fun onEvent(event: Event)
    }

    private class Subscription(
        val name: String,
        val handler: Handler,
    )

    private val subscriptions = CopyOnWriteArrayList<Subscription>()

    /** 已投递的事件总数（诊断用，便于确认"到底有没有事件在流"）。 */
    @Volatile
    private var publishedCount: Long = 0

    /** 投递失败次数（订阅者抛异常的次数）。 */
    @Volatile
    private var failureCount: Long = 0

    /**
     * 订阅某类事件。`name = "*"` 表示订阅全部。
     *
     * @return 注销句柄 —— 调用 `close()` 即取消订阅（插件卸载时框架会调）。
     */
    fun subscribe(name: String, handler: Handler): AutoCloseable {
        val sub = Subscription(name, handler)
        subscriptions += sub
        return AutoCloseable { subscriptions.remove(sub) }
    }

    /**
     * 发布一个事件。**永不抛异常** —— 订阅者炸了只记账，不影响调用方与其它订阅者。
     *
     * @return 实际被调用的订阅者数量（便于测试与诊断）
     */
    fun publish(event: Event): Int {
        publishedCount++
        var delivered = 0
        for (sub in subscriptions) {
            if (sub.name != "*" && sub.name != event.name) continue
            try {
                sub.handler.onEvent(event)
                delivered++
            } catch (e: Throwable) {
                // 一个订阅者炸了不能影响别人，也不能把发布方带崩。
                failureCount++
            }
        }
        return delivered
    }

    /** 便捷发布：只给事件名。 */
    fun publish(name: String): Int = publish(Event(name))

    /** 当前订阅者数量（可按名字过滤）。 */
    fun subscriberCount(name: String? = null): Int =
        if (name == null) subscriptions.size else subscriptions.count { it.name == name || it.name == "*" }

    /** 已发布事件总数。 */
    fun publishedTotal(): Long = publishedCount

    /** 订阅者异常次数。 */
    fun failures(): Long = failureCount

    /** 清空全部订阅（测试与热重载用）。 */
    fun clear() = subscriptions.clear()

    /** 自我介绍：谁在听、流过了多少事件。 */
    fun describe(): String = buildString {
        appendLine("事件总线：${subscriptions.size} 个订阅者，已投递 $publishedCount 个事件")
        if (failureCount > 0) appendLine("  订阅者异常 $failureCount 次（已隔离，不影响发布方）")
        if (subscriptions.isEmpty()) {
            appendLine("  （当前没有订阅者。事件照常可发布，只是没人听。）")
        } else {
            subscriptions.groupBy { it.name }.forEach { (name, subs) ->
                appendLine("  · $name：${subs.size} 个订阅者")
            }
        }
    }
}

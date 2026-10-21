package io.legado.plugin

/**
 * 进程级事件总线单例 —— 让业务代码能发布事件，插件能订阅。
 *
 * 为什么需要单例（用户要求"框架牢固"）：
 * [EventBus] 本身是可实例化的（测试里各造一个，互不干扰），但**业务代码**散落在
 * DAO、路由、服务各处，它们没有、也不该有 PluginManager 的引用。要发布事件，
 * 需要一个进程级可达的入口 —— 就是这里。
 *
 * 两种用法并存，不冲突：
 * - 业务代码发布：`AppEvents.bus.publish(Event("source.saved", ...))`
 * - 插件订阅：通过 `Plugin.subscriptions()` 声明，框架装到同一个 bus 上
 *
 * 注意：这里是**唯一的全局可变状态**，所以刻意做得很薄 —— 只有 `bus` 一个属性。
 * 谁想发布事件，直接用它；不要在这上面再堆别的全局东西。
 */
object AppEvents {

    /** 进程级总线。业务代码发布、插件订阅都走这一个。 */
    val bus: EventBus = EventBus()

    /**
     * 便捷发布：只关心事件名时用。
     * 失败静默 —— 发布事件不能成为业务失败的理由（订阅者炸了 [EventBus] 已经隔离）。
     */
    fun publish(name: String, payload: Map<String, Any?> = emptyMap()) {
        bus.publish(EventBus.Event(name, payload))
    }
}

/**
 * 框架内置的事件名常量 —— 只是**约定**，不是枚举。
 *
 * 为什么用常量而不是 sealed class：事件名是开放集合，插件可以发布自己的事件名，
 * 业务代码将来也可以加新的。用 sealed 会把"事件有哪些"锁死在框架里，那又变成夹带内容了。
 *
 * 这些常量只是让发布方和订阅方不用各自手写字符串（拼错了不会报错，只会静默不投递）。
 */
object EventNames {
    /** 书源被保存/更新。载荷：id */
    const val SOURCE_SAVED = "source.saved"
    /** 书源被删除。载荷：id */
    const val SOURCE_DELETED = "source.deleted"
    /** 书源被批量导入。载荷：count */
    const val SOURCES_IMPORTED = "sources.imported"

    /** 净化规则被保存。载荷：id */
    const val REPLACE_RULE_SAVED = "replaceRule.saved"
    /** 净化规则被删除。载荷：id */
    const val REPLACE_RULE_DELETED = "replaceRule.deleted"

    /** 书架有新书。载荷：sourceId, bookUrl */
    const val SHELF_ADDED = "shelf.added"
    /** 书架移除。载荷：sourceId, bookUrl */
    const val SHELF_REMOVED = "shelf.removed"

    /** 阅读进度被保存。载荷：sourceId, bookUrl, chapterIndex */
    const val PROGRESS_SAVED = "progress.saved"
    /** 阅读笔记新增。载荷：id */
    const val NOTE_ADDED = "note.added"

    /** 离线缓存完成一章。载荷：sourceId, bookUrl, chapterIndex */
    const val CHAPTER_CACHED = "chapter.cached"

    /** 订阅更新完成。载荷：updated, failed */
    const val SUBSCRIPTIONS_UPDATED = "subscriptions.updated"

    /** 应用已启动（插件可据此做延迟初始化）。载荷：version */
    const val APP_STARTED = "app.started"
    /** 应用正在停止（插件可据此清理）。载荷：无 */
    const val APP_STOPPING = "app.stopping"
}

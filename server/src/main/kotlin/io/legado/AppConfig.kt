package io.legado

/**
 * 集中读取"可调阈值"的环境变量。**默认值一律等于改造前源码里的写死值**，
 * 所以不设任何 env 时行为与现在完全一致；只有显式设置才改变。目的：把散落的
 * 魔数变成使用者可自定义的旋钮（开源「支持自定义」），不必改源码重编译。
 *
 * 全部项见 .env.example / server/README.md 的配置表。
 */
object AppConfig {
    private val env: Map<String, String> = System.getenv()

    private fun int(key: String, default: Int): Int = env[key]?.trim()?.toIntOrNull() ?: default
    private fun long(key: String, default: Long): Long = env[key]?.trim()?.toLongOrNull() ?: default
    private fun str(key: String, default: String): String =
        env[key]?.trim()?.takeIf { it.isNotEmpty() } ?: default

    /** Ktor CIO 引擎处理请求与写响应的分组线程数。 */
    val callGroupSize: Int = int("LEGADO_CALL_GROUP_SIZE", 64)

    /** 多书源并发搜索的并发上下限（按 CPU 核数在此区间内取）。 */
    val searchConcurrencyMin: Int = int("LEGADO_SEARCH_CONCURRENCY_MIN", 16)
    val searchConcurrencyMax: Int = int("LEGADO_SEARCH_CONCURRENCY_MAX", 32)

    /** 单次搜索整体截止（毫秒）。 */
    val searchTimeoutMs: Long = long("LEGADO_SEARCH_TIMEOUT_MS", 30_000L)

    /** 整书离线缓存的分片并发数。 */
    val cacheConcurrency: Int = int("LEGADO_CACHE_CONCURRENCY", 4)

    /** SQLite 只读连接池上限。 */
    val dbPoolSize: Int = int("LEGADO_DB_POOL_SIZE", 16)

    /** Edge-TTS 结果缓存条目上限。 */
    val edgeTtsCacheMax: Int = int("LEGADO_EDGE_TTS_CACHE_MAX", 250)

    /**
     * Edge-TTS 握手用的完整 Chromium 版本号（Sec-MS-GEC-Version 与 UA 都据此派生）。
     * 微软改协议时改这里即可，不必重编译——旧值会导致合成静默返回 0 字节。
     */
    val edgeTtsChromiumVersion: String = str("LEGADO_EDGE_TTS_CHROMIUM_VERSION", "143.0.3650.75")

    /** 朗读会话空闲多久回收 / 单会话最长寿命（毫秒）。 */
    val ttsIdleTimeoutMs: Long = long("LEGADO_TTS_IDLE_TIMEOUT_MS", 10 * 60 * 1000L)
    val ttsMaxLifetimeMs: Long = long("LEGADO_TTS_MAX_LIFETIME_MS", 6 * 60 * 60 * 1000L)

    /** 书源订阅自动更新的周期（毫秒）。 */
    val subscriptionUpdateMs: Long = long("LEGADO_SUBSCRIPTION_UPDATE_MS", 6 * 60 * 60 * 1000L)

    /**
     * 单次书源 JS 执行的墙钟上限（毫秒，默 30000）。书源 mainJs/规则是不可信脚本，
     * 一条 `while(true)` 会占死一条工作线程；合法规则都是毫秒级，这个宽上限只砍失控循环。
     */
    val jsTimeoutMs: Long = long("LEGADO_JS_TIMEOUT_MS", 30_000L)

    /** 目录 / 正文分页抓取的最大页数。 */
    val maxTocPages: Int = int("LEGADO_MAX_TOC_PAGES", 40)
    val maxContentPages: Int = int("LEGADO_MAX_CONTENT_PAGES", 30)

    // ———— AI 接入框架（io.legado.ai）————
    //
    // 从前这组能力只有一个开关：系统属性 `-Dai.debug`。想让"进程内 AI 连接"在正式部署里
    // 也能用（而不只是本地自检），就得改启动脚本加 JVM 参数 —— 对一个自托管程序来说太窄。
    // 现在补一条环境变量通道，两者**取或**：任一为真即启用。默认都关，行为与从前一致。

    /**
     * 是否启用 AI 接入框架的进程内自检与对外句柄。
     * `true` / `1` / `yes` / `on` 视为启用（大小写不敏感）；其它值或未设置 = 关闭。
     * 与系统属性 `-Dai.debug` 取或 —— 老用法照常有效。
     *
     * 注意这是 `get()` 计算属性而不是 val：环境变量在进程启动时就定了，但系统属性
     * 可以在运行期改（测试、嵌入式宿主、调试器都会这么干）。写成 val 的话，
     * `object` 初始化那一刻就把结果冻住，之后 `System.setProperty("ai.debug", …)` 完全无效 ——
     * 那会让"向后兼容 -Dai.debug"变成一句假话。
     */
    val aiEnabled: Boolean
        get() = flag("LEGADO_AI_ENABLED") || System.getProperty("ai.debug") != null

    /**
     * 是否允许外部注册的工具**注销内置工具**（默认 false）。
     * 保持 false：插件只能增删自己注册的工具，摘不掉 `source.delete` 这类核心能力。
     * 只有明确知道自己要干什么的部署才该打开。
     */
    val aiAllowRemovingBuiltinTools: Boolean = flag("LEGADO_AI_ALLOW_REMOVING_BUILTIN_TOOLS")

    private fun flag(key: String): Boolean =
        when (env[key]?.trim()?.lowercase()) {
            "1", "true", "yes", "on" -> true
            else -> false
        }
}

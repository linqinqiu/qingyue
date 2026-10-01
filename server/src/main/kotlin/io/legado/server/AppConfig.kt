package io.legado.server

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
}

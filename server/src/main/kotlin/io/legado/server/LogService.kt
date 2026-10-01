package io.legado.server

import kotlinx.serialization.Serializable
import java.io.File
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * 结构化日志服务：按类别收集错误并持久化到 SQLite + 滚动日志文件。
 * 
 * 分类体系（对齐 Legado 服务端实际运行场景）：
 * - ENGINE: 规则引擎执行异常（JS 沙箱、XPath/JSONPath 解析失败）
 * - NETWORK: 网络请求失败（超时、连接拒绝、DNS 解析失败）
 * - PARSING: 内容解析问题（HTML/XML 结构异常、编码探测失败）
 * - RULE_EXECUTION: 书源规则执行错误（正则编译失败、选择器语法错误）
 * - DATABASE: 数据库操作异常（锁冲突、约束违反）
 * - CACHE: 缓存服务问题（离线下载中断、封面生成失败）
 * - GUARD: 同源闸门拒掉的跨站写请求（这台服务不设身份，闸门就是唯一的门，被拒的东西必须看得见）
 * - SYSTEM: 系统级事件（启动/停止、配置加载、资源清理）
 */
object LogService {
    private val logs = ConcurrentLinkedQueue<LogEntry>()
    private val MAX_IN_MEMORY = 1000
    private var logFile: File? = null
    private var database: Database? = null
    
    fun initialize(databasePath: String, logDirectory: String = "logs") {
        this.database = try { Database(databasePath) } catch (_: Exception) { null }
        // 自建日志表：本方法比 Application 的 database.initialize() 更早跑，
        // 不先建表的话，紧随其后的「服务器启动」SYSTEM 日志会落库失败。
        database?.let { db -> runCatching { db.ensureLogTable() } }
        val dir = File(logDirectory)
        if (!dir.exists()) dir.mkdirs()
        logFile = File(dir, "legado-server-${LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"))}.log")
        loadRecentLogs()
    }
    
    fun log(category: LogCategory, level: LogLevel, message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null) {
        val entry = LogEntry(
            timestamp = LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME),
            category = category.name,
            level = level.name,
            message = message,
            context = context,
            stackTrace = exception?.stackTraceToString(),
        )
        
        logs.add(entry)
        if (logs.size > MAX_IN_MEMORY) logs.poll()

        // 落库：内存队列只留最近 1000 条且进程一退就没，入库后前端才能翻历史。
        // 失败静默忽略——日志本身不能反过来把主流程带崩（库锁死/磁盘满时尤其）。
        database?.let { db -> runCatching { db.insertLog(entry, System.currentTimeMillis()) } }

        // 异步写入文件
        logFile?.let { file ->
            try {
                val line = "[${entry.timestamp}] [${entry.category}] [${entry.level}] ${entry.message}"
                file.appendText(line + "\n")
                if (context.isNotEmpty()) {
                    file.appendText("  Context: ${context.entries.joinToString(", ") { "${it.key}=${it.value}" }}\n")
                }
                if (exception != null) {
                    file.appendText("  Stack: ${exception.stackTraceToString().replace("\n", "\n  ")}\n")
                }
            } catch (_: Exception) {
                // 磁盘满或权限不足时静默忽略，不影响主流程
            }
        }
        
        // 同时输出到标准日志（兼容 Ktor 的 log.info/warn/error）
        when (level) {
            LogLevel.DEBUG -> println("[DEBUG] $message")
            LogLevel.INFO -> println("[INFO] $message")
            LogLevel.WARN -> System.err.println("[WARN] $message")
            LogLevel.ERROR -> System.err.println("[ERROR] $message")
        }
    }
    
    fun getRecentLogs(category: LogCategory? = null, limit: Int = 100): List<LogEntry> {
        val filtered = if (category == null) logs.toList() else logs.filter { it.category == category.name }
        return filtered.takeLast(limit).reversed()
    }

    /**
     * 前端「运行日志」用：优先查库（有历史、可按等级筛），库不可用时退回内存队列。
     * 结果统一按时间倒序（最新在前）。
     */
    fun queryLogs(category: LogCategory? = null, level: LogLevel? = null, limit: Int = 200): List<LogEntry> {
        val fromDb = database?.let { db -> runCatching { db.queryLogs(category?.name, level?.name, limit) }.getOrNull() }
        if (fromDb != null) return fromDb
        return getRecentLogs(category, limit).filter { level == null || it.level == level.name }
    }

    fun clearLogs() {
        logs.clear()
        logFile?.delete()
        database?.let { db -> runCatching { db.clearLogEntries() } }
    }
    
    private fun loadRecentLogs() {
        logFile?.takeIf { it.exists() }?.readLines()?.forEach { line ->
            // 简单解析：不存入内存队列，只确保文件存在
        }
    }
}

@Serializable
data class LogEntry(
    /** SQLite 的 rowid。界面按它做行标识与"展开的是哪一条"，没有它只能按数组下标，一刷新就串行。 */
    val id: Long = 0,
    val timestamp: String,
    val category: String,
    val level: String,
    val message: String,
    val context: Map<String, String> = emptyMap(),
    val stackTrace: String? = null,
)

enum class LogCategory {
    ENGINE,         // 规则引擎
    NETWORK,        // 网络请求
    PARSING,        // 内容解析
    RULE_EXECUTION, // 书源规则
    DATABASE,       // 数据库
    CACHE,          // 缓存服务
    GUARD,          // 同源闸门
    SYSTEM,         // 系统事件
}

enum class LogLevel {
    DEBUG, INFO, WARN, ERROR
}

// 便捷扩展函数，让现有代码无需大幅改动即可接入
fun Any.logEngine(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null) {
    LogService.log(LogCategory.ENGINE, LogLevel.ERROR, message, context, exception)
}

fun Any.logNetwork(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null) {
    LogService.log(LogCategory.NETWORK, LogLevel.ERROR, message, context, exception)
}

fun Any.logParsing(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null) {
    LogService.log(LogCategory.PARSING, LogLevel.WARN, message, context, exception)
}

fun Any.logRuleExecution(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null) {
    LogService.log(LogCategory.RULE_EXECUTION, LogLevel.ERROR, message, context, exception)
}

fun Any.logDatabase(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null) {
    LogService.log(LogCategory.DATABASE, LogLevel.ERROR, message, context, exception)
}

fun Any.logCache(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null) {
    LogService.log(LogCategory.CACHE, LogLevel.WARN, message, context, exception)
}

fun Any.logGuard(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null) {
    LogService.log(LogCategory.GUARD, LogLevel.WARN, message, context, exception)
}

fun Any.logSystem(message: String, context: Map<String, String> = emptyMap(), exception: Throwable? = null) {
    LogService.log(LogCategory.SYSTEM, LogLevel.INFO, message, context, exception)
}

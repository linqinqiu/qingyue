package io.legado.server.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.server.AppConfig
import io.legado.server.data.Database
import io.legado.server.model.ApiError
import io.legado.server.model.ExploreRequest
import io.legado.server.model.SearchRequest
import io.legado.server.model.SearchResult
import io.legado.server.model.SearchStreamEvent
import io.legado.server.rules.RuleRunner
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：同步搜索、WebSocket 流式搜索、发现页取书。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.searchRoutes(
    database: Database,
    runner: RuleRunner,
) {
        post("/search") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<SearchRequest>()
            if (request.keyword.isBlank()) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_keyword", "请输入搜索关键词")); return@post }
            val sourceRecords = database.listSearchSourceRecords(request.sourceIds)
            val results = boundedConcurrentMap(sourceRecords, sourceSearchConcurrency()) { source -> readableSearchResults(runner, source.json, request.keyword) }.flatten()
            call.respond(results)
        }
        webSocket("/search/stream") {
            // 没有凭据可校验了：流式搜索同样只认"这个连接是不是本机页面发起的"
            if (!originMatchesHost(call)) {
                close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "跨站页面不能驱动本机搜索"))
                return@webSocket
            }
            val request = (incoming.receive() as? Frame.Text)?.readText()?.let { text -> runCatching { Json.decodeFromString<SearchRequest>(text) }.getOrNull() }
            if (request?.keyword.isNullOrBlank()) {
                send(Frame.Text(Json.encodeToString(SearchStreamEvent("error", message = "请输入搜索关键词"))))
                close(CloseReason(CloseReason.Codes.CANNOT_ACCEPT, "搜索条件无效"))
                return@webSocket
            }
            val sourceRecords = database.listSearchSourceRecords(request!!.sourceIds)
            send(Frame.Text(Json.encodeToString(SearchStreamEvent("start", totalSources = sourceRecords.size))))
            coroutineScope {
                val events = Channel<SearchStreamEvent>(Channel.BUFFERED)
                val counters = SearchStreamCounters(sourceRecords.size)
                val semaphore = Semaphore(sourceSearchConcurrency())
                val workers = sourceRecords.map { source -> async {
                    semaphore.withPermit {
                        if (!isActive) return@async
                        val outcome = searchSourceOutcome(runner, source.json, request.keyword)
                        if (!isActive) return@async
                        runCatching {
                            if (outcome.results.isNotEmpty()) events.send(SearchStreamEvent("results", results = outcome.results))
                            events.send(counters.complete(outcome))
                        }
                    }
                } }
                val completionJob = launch {
                    try {
                        workers.awaitAll()
                        runCatching { events.send(counters.snapshot("done")) }
                    } catch (_: CancellationException) {
                        // Workers were cancelled
                    } finally {
                        events.close()
                    }
                }
                val cancellationMonitor = launch {
                    try {
                        for (frame in incoming) {
                            if (frame is Frame.Text && frame.readText().contains("\"cancel\"")) break
                        }
                    } catch (_: Throwable) {
                        // Incoming channel closed
                    } finally {
                        workers.forEach { it.cancel() }
                        completionJob.cancel()
                        events.close()
                    }
                }
                try {
                    for (event in events) send(Frame.Text(Json.encodeToString(event)))
                } catch (_: Throwable) {
                    // Socket closed or disconnected
                } finally {
                    cancellationMonitor.cancel()
                    completionJob.cancel()
                    workers.forEach { it.cancel() }
                    events.close()
                }
            }
        }
        get("/explore/sources") {
            call.respond(database.listExploreSources())
        }
        post("/explore") {
            if (!call.requireSameOriginWrite()) return@post
            val request = call.receive<ExploreRequest>()
            val source = database.getSource(request.sourceId) ?: run {
                call.respond(HttpStatusCode.NotFound, ApiError("not_found", "书源不存在"))
                return@post
            }
            try {
                // 阻塞的网络取书不能占 CIO call-group 线程（见 Application.kt 对 callGroupSize 的调参说明）
                call.respond(withContext(Dispatchers.IO) { runner.explore(source.json, request.url, request.page.coerceAtLeast(1)) })
            } catch (error: Throwable) {
                if (error is CancellationException) throw error
                call.respond(HttpStatusCode.BadGateway, ApiError("explore_failed", error.message ?: "发现页取书失败"))
            }
        }
}

private val SEARCH_TIMEOUT_MS = AppConfig.searchTimeoutMs

private suspend fun readableSearchResults(runner: RuleRunner, sourceJson: String, keyword: String): List<SearchResult> =
    searchSourceOutcome(runner, sourceJson, keyword).results

internal data class SearchSourceOutcome(val results: List<SearchResult>, val failed: Boolean)

internal class SearchStreamCounters(private val totalSources: Int) {
    private val completed = AtomicInteger()
    private val matched = AtomicInteger()
    private val empty = AtomicInteger()
    private val failed = AtomicInteger()
    private val resultCount = AtomicInteger()

    fun complete(outcome: SearchSourceOutcome): SearchStreamEvent {
        when {
            outcome.results.isNotEmpty() -> {
                matched.incrementAndGet()
                resultCount.addAndGet(outcome.results.size)
            }
            outcome.failed -> failed.incrementAndGet()
            else -> empty.incrementAndGet()
        }
        completed.incrementAndGet()
        return snapshot()
    }

    fun snapshot(type: String = "progress") = SearchStreamEvent(
        type = type,
        totalSources = totalSources,
        completedSources = completed.get(),
        matchedSources = matched.get(),
        emptySources = empty.get(),
        failedSources = failed.get(),
        resultCount = resultCount.get(),
    )
}

internal suspend fun searchSourceOutcome(
    runner: RuleRunner,
    sourceJson: String,
    keyword: String,
    timeoutMs: Long = SEARCH_TIMEOUT_MS,
): SearchSourceOutcome {
    /*
     * 到点的是**这一个源**，不是整次搜索。
     * `TimeoutCancellationException` 是 `CancellationException` 的子类，而这里原来只有一句
     * `if (error is CancellationException) throw error` —— 于是库里某一个源拖过 30 秒，取消就顺着
     * `coroutineScope` 传到整棵搜索树上：别的源已经搜到的那几十本一起作废，界面收到 500
     * （selfcheck「多源并发搜索返回的是数组」红过一次就是它，`server.log` 里留的是
     * `Unhandled request failure: TimeoutCancellationException`）。
     * 真正该往上传的只有"调用方自己取消了"（客户端停读、页面关了）—— 那种情况回答也没人看。
     */
    val results = try {
        withTimeout(timeoutMs) { withContext(Dispatchers.IO) { runner.search(sourceJson, keyword) } }
    } catch (error: TimeoutCancellationException) {
        return SearchSourceOutcome(emptyList(), failed = true)
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        return SearchSourceOutcome(emptyList(), failed = true)
    }
    return SearchSourceOutcome(results, failed = false)
}

internal fun sourceSearchConcurrency(processors: Int = Runtime.getRuntime().availableProcessors()): Int =
    processors.coerceIn(AppConfig.searchConcurrencyMin, AppConfig.searchConcurrencyMax)

internal suspend fun <T, R> boundedConcurrentMap(values: List<T>, limit: Int, action: suspend (T) -> R): List<R> = coroutineScope {
    val semaphore = Semaphore(limit.coerceAtLeast(1))
    values.map { value -> async { semaphore.withPermit { action(value) } } }.awaitAll()
}


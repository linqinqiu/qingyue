package io.legado.http

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import io.legado.data.Database
import io.legado.data.addNote
import io.legado.data.addReadingLog
import io.legado.data.deleteNote
import io.legado.data.getProgress
import io.legado.data.listNotes
import io.legado.data.listReadingLog
import io.legado.data.saveProgress
import io.legado.data.updateNote
import io.legado.model.ApiError
import io.legado.model.BookNoteUpdate
import io.legado.model.BookNoteWrite
import io.legado.model.ReadingLogRequest
import io.legado.model.ReadingProgress

/**
 * 从 `Routes.kt` 拆出（0.8.2 结构重排）：阅读进度、阅读记录与笔记划线。
 * 处理器文本逐字未动；本函数由 `Routes.kt` 的 `apiRoutes` 挂在 `route("/api")` 内，顺序与拆前一致。
 * 契约核对：`web/test/ApiCatalog.test.ts` 把本目录全部 `*Routes.kt` 视为挂在 `/api` 之下逐条比对。
 */
fun Route.progressRoutes(
    database: Database,
) {
        get("/reading-progress") {
            val sourceId = call.request.queryParameters["sourceId"]
            val bookUrl = call.request.queryParameters["bookUrl"]
            if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank()) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_progress", "缺少 sourceId 或 bookUrl")); return@get }
            database.getProgress(sourceId, bookUrl)?.let { call.respond(it) } ?: call.respond(HttpStatusCode.NoContent)
        }
        put("/reading-progress") {
            if (!call.requireSameOriginWrite()) return@put
            val progress = call.receive<ReadingProgress>()
            if (progress.sourceId.isBlank() || progress.bookUrl.isBlank() || progress.chapterUrl.isBlank() || progress.chapterIndex < 0 || !progress.scrollPosition.isFinite() || progress.scrollPosition !in 0.0..1.0) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_progress", "阅读进度无效")); return@put }
            call.respond(database.saveProgress(progress))
        }
        // 阅读记录（PROPOSAL-019 D）。只增不改：POST 累加、GET 读，没有编辑/删除单条的入口。
        get("/reading-log") {
            val days = (call.request.queryParameters["days"]?.toIntOrNull() ?: 30).coerceIn(1, 365)
            call.respond(database.listReadingLog(days))
        }
        post("/reading-log") {
            if (!call.requireSameOriginWrite()) return@post
            val entry = call.receive<ReadingLogRequest>()
            if (entry.sourceId.isBlank() || entry.bookUrl.isBlank() || entry.seconds <= 0 || entry.seconds > 24 * 3600 || entry.chapterIndex < 0) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_reading_log", "阅读记录无效"))
                return@post
            }
            call.respond(database.addReadingLog(entry))
        }
        // 笔记 / 划线（PROPOSAL-019 E）：按书读、增、改备注、删。偏移是章节内字符偏移。
        get("/notes") {
            val sourceId = call.request.queryParameters["sourceId"]
            val bookUrl = call.request.queryParameters["bookUrl"]
            if (sourceId.isNullOrBlank() || bookUrl.isNullOrBlank()) { call.respond(HttpStatusCode.BadRequest, ApiError("invalid_note", "缺少 sourceId 或 bookUrl")); return@get }
            call.respond(database.listNotes(sourceId, bookUrl))
        }
        post("/notes") {
            if (!call.requireSameOriginWrite()) return@post
            val write = call.receive<BookNoteWrite>()
            if (write.sourceId.isBlank() || write.bookUrl.isBlank() || write.excerpt.isBlank() || write.startOffset < 0 || write.endOffset < write.startOffset) {
                call.respond(HttpStatusCode.BadRequest, ApiError("invalid_note", "笔记无效"))
                return@post
            }
            call.respond(database.addNote(write))
        }
        put("/notes/{id}") {
            if (!call.requireSameOriginWrite()) return@put
            val id = call.parameters["id"]?.toLongOrNull() ?: return@put call.respond(HttpStatusCode.BadRequest, ApiError("invalid_id", "笔记 ID 无效"))
            if (database.updateNote(id, call.receive<BookNoteUpdate>().note)) call.respond(HttpStatusCode.NoContent)
            else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "笔记不存在"))
        }
        delete("/notes/{id}") {
            if (!call.requireSameOriginWrite()) return@delete
            val id = call.parameters["id"]?.toLongOrNull() ?: return@delete call.respond(HttpStatusCode.BadRequest, ApiError("invalid_id", "笔记 ID 无效"))
            if (database.deleteNote(id)) call.respond(HttpStatusCode.NoContent)
            else call.respond(HttpStatusCode.NotFound, ApiError("not_found", "笔记不存在"))
        }
}



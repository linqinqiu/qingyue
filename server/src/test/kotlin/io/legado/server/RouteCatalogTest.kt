package io.legado.server

import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.server.testing.*
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * `GET /api/catalog` 这个对外契约端点本身。
 * 内容与代码的一致性在 `web/test/ApiCatalog.test.ts`（双向核对），这里只管三件事：
 * 随包文件在、能解析、`version` 是**当前跑的这份构建**而不是文件里手写的旧号。
 */
class RouteCatalogTest {

    @Test
    fun `目录端点回 JSON，版本号盖的是当前构建`() {
        val dbPath = Files.createTempFile("legado-catalog", ".sqlite").toString()
        val tempDir = Files.createTempDirectory("legado-catalog-covers")
        try {
            val config = ServerConfig(host = "127.0.0.1", port = 8080, databasePath = dbPath, coverCacheDirectory = tempDir)
            testApplication {
                application { legadoApplication(config) }
                val response = client.get("/api/catalog")
                assertEquals(HttpStatusCode.OK.value, response.status.value)
                assertTrue("内容类型要是 JSON：${response.headers[HttpHeaders.ContentType]}",
                    response.headers[HttpHeaders.ContentType]?.contains("application/json") == true)
                val text = response.bodyAsText()
                val body = runCatching { Json.parseToJsonElement(text).jsonObject }
                    .getOrElse { throw AssertionError("响应不是 JSON（${response.status.value}）：${text.take(300)}") }
                val endpoints = body["endpoints"]?.jsonArray
                    ?: throw AssertionError("响应里没有 endpoints：${text.take(300)}")
                assertTrue("目录只剩 ${endpoints.size} 条，随包文件八成被截断了", endpoints.size >= 30)
                assertEquals(endpoints.size, body["count"]!!.jsonPrimitive.int)
                // 文件里写的是发版那天手填的号；响应里必须是这个进程真正的版本
                assertEquals(BuildInfo.version, body["version"]!!.jsonPrimitive.content)
                val first = endpoints[0].jsonObject
                assertTrue("每条都要带 method/path/write/purpose：$first",
                    first.containsKey("method") && first.containsKey("path") && first.containsKey("write") && first.containsKey("purpose"))
            }
        } finally {
            runCatching { Files.deleteIfExists(Path.of(dbPath)) }
            runCatching { Files.deleteIfExists(Path.of("$dbPath-wal")) }
            runCatching { Files.deleteIfExists(Path.of("$dbPath-shm")) }
            runCatching { tempDir.toFile().deleteRecursively() }
        }
    }
}

package io.legado.server

import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.cookies.HttpCookies
import io.ktor.server.testing.testApplication
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 这台服务不设身份（没有密码、没有登录页、没有会话），写操作只剩一道同源闸门。
 * 这道闸门必须有自己的测试：它一破，任何网页都能驱动用户的浏览器改这个库。
 */
class SameOriginGuardTest {

    private fun config() = ServerConfig(
        host = "127.0.0.1",
        port = 8080,
        databasePath = Files.createTempFile("legado-guard-test", ".sqlite").toString(),
        coverCacheDirectory = Files.createTempDirectory("legado-guard-covers"),
    )

    @Test
    fun `写操作在没有 Origin 时放行（本机界面与命令行）`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient {
            install(ContentNegotiation) { json() }
            install(HttpCookies)
        }
        val response = client.post("/api/replace-rules") {
            contentType(ContentType.Application.Json)
            setBody("""{"name":"守卫探针规则","pattern":"aaa","replacement":"bbb","scope":"probe-guard"}""")
        }
        assertTrue("无 Origin 的写请求应放行，实际 ${response.status} ${response.bodyAsText()}",
            response.status == HttpStatusCode.OK || response.status == HttpStatusCode.Created)
    }

    @Test
    fun `写操作在 Origin 与 Host 一致时放行`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient {
            install(ContentNegotiation) { json() }
            install(HttpCookies)
        }
        val response = client.post("/api/replace-rules") {
            header("Origin", "http://127.0.0.1:8080")
            header("Host", "127.0.0.1:8080")
            contentType(ContentType.Application.Json)
            setBody("""{"name":"守卫同源规则","pattern":"ccc","replacement":"ddd","scope":"probe-guard"}""")
        }
        assertTrue("同源写请求应放行，实际 ${response.status} ${response.bodyAsText()}",
            response.status == HttpStatusCode.OK || response.status == HttpStatusCode.Created)
    }

    @Test
    fun `写操作被别的网站驱动时拒绝`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient {
            install(ContentNegotiation) { json() }
            install(HttpCookies)
        }
        val response = client.post("/api/replace-rules") {
            header("Origin", "http://evil.example")
            header("Host", "127.0.0.1:8080")
            contentType(ContentType.Application.Json)
            setBody("""{"name":"跨站注入","pattern":"eee","replacement":"fff","scope":"probe-guard"}""")
        }
        assertEquals(HttpStatusCode.Forbidden, response.status)
        assertTrue("错误码要说清是被同源闸门挡下：${response.bodyAsText()}",
            response.bodyAsText().contains("cross_origin"))
    }

    @Test
    fun `Origin 端口不一致也算跨站`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient {
            install(ContentNegotiation) { json() }
            install(HttpCookies)
        }
        val response = client.post("/api/replace-rules") {
            header("Origin", "http://127.0.0.1:9999")
            header("Host", "127.0.0.1:8080")
            contentType(ContentType.Application.Json)
            setBody("""{"name":"端口冒名","pattern":"ggg","replacement":"hhh","scope":"probe-guard"}""")
        }
        assertEquals(HttpStatusCode.Forbidden, response.status)
    }

    @Test
    fun `读操作不需要任何凭据`() = testApplication {
        application { legadoApplication(config()) }
        val client = createClient {
            install(ContentNegotiation) { json() }
        }
        assertEquals(HttpStatusCode.OK, client.get("/api/sources").status)
        assertEquals(HttpStatusCode.OK, client.get("/healthz").status)
    }
}

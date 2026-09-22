package io.legado.server

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.net.ssl.SSLHandshakeException
import java.net.UnknownHostException

/**
 * 体检判据的回归锁：结论必须来自「实跑搜索能否解析出条目」，
 * 失败原因要分档（连不上 / 证书 / 零结果 / 结构错误），不许再一律压成 failed。
 */
class SourceHealthTest {

    private fun source(extra: String = "") = """{
        "bookSourceUrl":"https://source.example",
        "searchUrl":"/search?keyword={{key}}&pi={{page}}",
        "ruleSearch":{"bookList":"$.data","name":"$.title","bookUrl":"/books/{{$.book_id}}"$extra}
    }"""

    private val hits = """{"data":[{"book_id":"1","title":"甲"}]}"""

    @Test
    fun `grades a source as valid when the search actually parses entries`() = runBlocking {
        val health = SourceHealth(RuleRunner { hits })
        val result = health.probe("https://source.example", "假源", source(), "都市")
        assertEquals("valid", result.statusCategory)
        assertTrue(result.ok)
        assertTrue("结论里要写清搜到了几条: ${result.error}", result.error!!.contains("1 条"))
    }

    @Test
    fun `a source that answers but parses nothing is empty, not dead`() = runBlocking {
        val health = SourceHealth(RuleRunner { """{"data":[]}""" })
        val result = health.probe("https://source.example", "假源", source(), "都市")
        assertEquals("empty", result.statusCategory)
        assertFalse(result.ok)
    }

    @Test
    fun `connection failures keep their own cause instead of a generic failed`() = runBlocking {
        val dns = SourceHealth(RuleRunner { throw UnknownHostException("source.example") })
            .probe("https://source.example", "假源", source(), "都市")
        assertEquals("unreachable", dns.statusCategory)

        val tls = SourceHealth(RuleRunner { throw SSLHandshakeException("PKIX path building failed") })
            .probe("https://source.example", "假源", source(), "都市")
        assertEquals("tls", tls.statusCategory)
    }

    @Test
    fun `prefers the source's own checkKeyWord over the caller's keyword`() = runBlocking {
        var fetched = ""
        val health = SourceHealth(RuleRunner { url -> fetched = url; hits })
        health.probe("https://source.example", "假源", source(",\"checkKeyWord\":\"灵魔\""), "都市")
        assertTrue("应该用源自带的测试词「灵魔」: $fetched", fetched.contains("%E7%81%B5%E9%AD%94"))
    }

    @Test
    fun `a source that fails structure never reaches the network`() = runBlocking {
        var calls = 0
        val health = SourceHealth(RuleRunner { calls++; hits })
        val result = health.probe("https://source.example", "坏源", """{"bookSourceName":""}""", "都市")
        assertEquals("invalid", result.statusCategory)
        assertEquals(0, calls)
    }
}

package io.legado.server

import io.ktor.http.*
import java.net.InetAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Duration
import java.util.zip.GZIPInputStream
import java.util.zip.InflaterInputStream

data class CachedCover(val key: String, val contentType: String)

class CoverCache(private val directory: Path, private val fetcher: ((String) -> Pair<String, ByteArray>)? = null) {
    private val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NEVER).build()

    init { Files.createDirectories(directory) }

    fun cache(url: String): CachedCover {
        val key = sha256(url)
        val stored = directory.resolve(key)
        if (Files.exists(stored)) return CachedCover(key, "image/*")
        val (contentType, body) = fetcher?.invoke(url) ?: download(url)
        require(contentType.lowercase().startsWith("image/")) { "封面不是图片" }
        require(body.size <= MAX_BYTES) { "封面超过 5 MiB 限制" }
        Files.write(stored, body)
        return CachedCover(key, contentType.substringBefore(';'))
    }

    fun getIfCached(url: String): CachedCover? {
        if (url.isBlank()) return null
        val key = if (url.matches(Regex("[0-9a-f]{64}"))) url else sha256(url)
        val stored = directory.resolve(key)
        return if (Files.exists(stored)) CachedCover(key, "image/*") else null
    }

    fun file(key: String): Path? = key.takeIf { it.matches(Regex("[0-9a-f]{64}")) }?.let(directory::resolve)?.takeIf(Files::exists)

    /**
     * 一次性回收我们替本地书生成的假封面（`LocalBookParser` 里那段彩色 SVG 已经删掉）。
     * 判据只认自家写死的那个天蓝角标色 `#38bdf8`，所以 EPUB 内嵌的真 SVG 封面不会被误删；
     * 文件读不到或不含该签名的，一律原样留着。
     */
    fun purgeGeneratedLocalCovers(database: Database): Int {
        var purged = 0
        database.generatedLocalCoverKeys().forEach { key ->
            val stored = file(key) ?: return@forEach
            val generated = runCatching { String(Files.readAllBytes(stored), Charsets.UTF_8) }
                .getOrDefault("").contains("#38bdf8")
            if (!generated) return@forEach
            Files.deleteIfExists(stored)
            database.forgetCover(key)
            purged++
        }
        return purged
    }

    /**
     * 正文配图：与封面共用一套落盘缓存，但两条约束不同 ——
     * ① 必须带 Referer（图站普遍防盗链，直连拿回来是 403 占位图）；
     * ② 拒 `image/svg+xml`：代理后与主应用同源，SVG 里可以带脚本，等于给自己开个 XSS 执行面。
     */
    fun cacheContentImage(url: String, referer: String?): CachedCover {
        val key = sha256(url)
        val stored = directory.resolve(key)
        if (Files.exists(stored)) return CachedCover(key, sniffContentType(stored))
        val (rawType, body) = download(url, referer)
        val type = rawType.substringBefore(';').trim().lowercase()
        require(type.startsWith("image/") && type != "image/svg+xml") { "正文图片类型不被允许：${type.ifBlank { "未知" }}" }
        require(body.size <= MAX_BYTES) { "正文图片超过 5 MiB 限制" }
        Files.write(stored, body)
        return CachedCover(key, sniffContentType(stored))
    }

    /** 缓存命中时没有响应头可依据，按文件头判类型；判不出按最通用的 png 给，浏览器仍会嗅探。 */
    private fun sniffContentType(path: Path): String = runCatching {
        val head = ByteArray(16)
        Files.newInputStream(path).use { input -> input.read(head) }
        fun marker(offset: Int, vararg signature: Int) = signature.indices.all { head[offset + it] == signature[it].toByte() }
        when {
            marker(0, 0x89, 0x50, 0x4E, 0x47) -> "image/png"
            marker(0, 0xFF, 0xD8, 0xFF) -> "image/jpeg"
            marker(0, 0x47, 0x49, 0x46) -> "image/gif"
            marker(0, 0x52, 0x49, 0x46, 0x46) && marker(8, 0x57, 0x45, 0x42, 0x50) -> "image/webp"
            else -> "image/png"
        }
    }.getOrDefault("image/png")

    fun delete(key: String) { file(key)?.let(Files::deleteIfExists) }

    fun saveCoverBytes(bytes: ByteArray, contentType: String = "image/jpeg"): String {
        require(bytes.size <= MAX_BYTES) { "封面超过 5 MiB 限制" }
        val key = sha256Bytes(bytes)
        val stored = directory.resolve(key)
        if (!Files.exists(stored)) {
            Files.write(stored, bytes)
        }
        return key
    }

    private fun download(url: String, referer: String? = null): Pair<String, ByteArray> {
        var uri = URI(url); validate(uri)
        repeat(4) {
            val builder = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(20)).header("User-Agent", "LegadoServer/0.1").GET()
            // 重定向后不再补发 Referer：跳去别的域名时把原站地址带出去等于泄露来源。
            referer?.let { builder.header("Referer", it) }
            val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofByteArray())
            if (response.statusCode() in 300..399) { uri = uri.resolve(response.headers().firstValue("location").orElseThrow { IllegalArgumentException("封面重定向缺少地址") }); validate(uri); return@repeat }
            require(response.statusCode() in 200..299) { "封面上游返回 HTTP ${response.statusCode()}" }
            return response.headers().firstValue("content-type").orElse("") to decode(response.headers().firstValue("content-encoding").orElse(""), response.body())
        }
        throw IllegalArgumentException("封面重定向次数超过限制")
    }

    /**
     * 有些站点（如 shukuge.com）不管客户端有没有请求都回 `Content-Encoding: gzip`，
     * 直接落盘会把 gzip 字节当成 image/jpeg 存下来，浏览器显示为破图。
     */
    private fun decode(contentEncoding: String, bytes: ByteArray): ByteArray {
        val encoding = contentEncoding.lowercase()
        return when {
            encoding.contains("gzip") -> runCatching { GZIPInputStream(bytes.inputStream()).use { it.readAllBytes() } }.getOrDefault(bytes)
            encoding.contains("deflate") -> runCatching { InflaterInputStream(bytes.inputStream()).use { it.readAllBytes() } }.getOrDefault(bytes)
            else -> bytes
        }
    }

    private fun validate(uri: URI) {
        NetworkSecurity.resolveAndValidateSafeHttpTarget(uri, "封面")
    }
    private fun sha256(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun sha256Bytes(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private companion object { const val MAX_BYTES = 5 * 1024 * 1024 }
}

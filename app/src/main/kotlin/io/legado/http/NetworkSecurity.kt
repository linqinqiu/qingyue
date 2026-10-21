package io.legado.http

import java.net.InetAddress
import java.net.URI
import java.util.concurrent.ConcurrentHashMap

object NetworkSecurity {
    private const val DNS_CACHE_TTL_MS = 5 * 60 * 1000L // 5 minutes
    private const val MAX_DNS_CACHE_SIZE = 2000

    private data class CachedDns(val addresses: Array<InetAddress>, val expiresAt: Long)
    private val dnsCache = ConcurrentHashMap<String, CachedDns>()

    fun clearCache() {
        dnsCache.clear()
    }

    fun cacheSize(): Int = dnsCache.size

    /**
     * Resolves host IP addresses with in-memory caching and validates that the target
     * is not a local/private network address (preventing SSRF).
     */
    fun resolveAndValidateSafeHttpTarget(uri: URI, serviceName: String = "目标") {
        if (uri.scheme !in setOf("http", "https") || uri.host.isNullOrBlank()) {
            throw IllegalArgumentException("仅允许 HTTP(S) $serviceName 地址")
        }
        val host = uri.host.lowercase()
        val now = System.currentTimeMillis()
        val cached = dnsCache[host]
        val addresses = if (cached != null && cached.expiresAt > now) {
            cached.addresses
        } else {
            val resolved = runCatching { InetAddress.getAllByName(host) }.getOrElse {
                throw IllegalArgumentException("无法解析 $serviceName 域名: $host (${it.message ?: "DNS解析失败"})")
            }
            if (dnsCache.size > MAX_DNS_CACHE_SIZE) {
                dnsCache.clear()
            }
            dnsCache[host] = CachedDns(resolved, now + DNS_CACHE_TTL_MS)
            resolved
        }
        for (address in addresses) {
            if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress || address.isSiteLocalAddress || address.hostAddress == "169.254.169.254") {
                throw IllegalArgumentException("拒绝访问内网或本机地址")
            }
            // 上面 JDK 内建的判定有洞（0.6.23 补齐）：siteLocal 只认 fec0::/10 旧 site-local，
            // fc00::/7 ULA、CGNAT 100.64/10、基准测试 198.18/15、组播与保留段都会漏进内网。
            if (isSpecialV4(address) || isSpecialV6(address)) {
                throw IllegalArgumentException("拒绝访问内网或本机地址")
            }
        }
    }

    private val V4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")

    private fun isSpecialV4(address: InetAddress): Boolean {
        val m = V4.find(address.hostAddress ?: return false) ?: return false
        val o = m.groupValues.drop(1).map { it.toInt() }
        if (o.any { it > 255 }) return false
        val (a, b) = o
        return a == 0 || a == 10 || a == 127 ||
            (a == 100 && b in 64..127) ||          // CGNAT 100.64.0.0/10
            (a == 172 && b in 16..31) ||           // RFC1918
            (a == 192 && b == 168) ||              // RFC1918
            (a == 169 && b == 254) ||              // 链路本地（JDK 已判，双保险）
            (a == 198 && (b == 18 || b == 19)) ||  // 基准测试 198.18.0.0/15
            (a >= 224)                             // 组播 224/4 与保留 240/4
    }

    private fun isSpecialV6(address: InetAddress): Boolean {
        if (address.hostAddress?.contains(':') != true) return false
        val bytes = address.address
        if (bytes.size != 16) return false
        val first = bytes[0].toInt() and 0xFF
        val second = bytes[1].toInt() and 0xFF
        // fc00::/7（ULA，fd00::/8 实际在用）、ff00::/8（组播）、2001:db8::/32（文档保留）
        if (first == 0xfc || first == 0xfd || first == 0xff) return true
        if (first == 0x20 && second == 0x01 && bytes[2].toInt() == 0x0d && bytes[3].toInt() == 0xb8) return true
        return false
    }
}

package io.legado.server

import java.nio.file.Path
import kotlin.io.path.absolutePathString

data class ServerConfig(
    val host: String,
    val port: Int,
    val databasePath: String,
    val coverCacheDirectory: Path,
    val webDavDirectory: Path,
    val localBooksDirectory: Path = coverCacheDirectory.resolveSibling("local_books"),
    val initialAdminPassword: String?,
    val secureCookies: Boolean,
    val loopbackNoAuth: Boolean = false,
) {
    companion object {
        private val LOOPBACK_HOSTS = setOf("127.0.0.1", "localhost", "::1")

        /**
         * 请求是否来自本机。用显式前缀而不是正则：`::1$` 这类锚点会把 `2001:db8::1` 误判成本机，
         * 而 IPv4-mapped 的 `::ffff:127.0.0.1` 与 `127.0.0.53` 又必须放行。
         */
        fun isLoopbackRemote(remoteHost: String?): Boolean {
            val host = remoteHost?.trim() ?: return false
            return host == "::1" || host == "localhost" || host.startsWith("127.") || host.startsWith("::ffff:127.")
        }

        fun fromEnvironment(env: Map<String, String> = System.getenv()): ServerConfig {
            val dataDir = Path.of(env["LEGADO_DATA_DIR"] ?: "/data").toAbsolutePath()
            val host = env["LEGADO_HOST"] ?: "0.0.0.0"
            return ServerConfig(
                host = host,
                port = env["LEGADO_PORT"]?.toIntOrNull() ?: 8080,
                databasePath = env["LEGADO_DATABASE"] ?: dataDir.resolve("legado.sqlite").absolutePathString(),
                coverCacheDirectory = dataDir.resolve("covers"),
                webDavDirectory = dataDir.resolve("webdav"),
                localBooksDirectory = dataDir.resolve("local_books"),
                initialAdminPassword = env["ADMIN_PASSWORD"]?.takeIf { it.isNotBlank() },
                secureCookies = env["LEGADO_SECURE_COOKIES"]?.toBooleanStrictOrNull() ?: true,
                // 免登录要同时满足「显式开启」与「绑定的就是回环地址」：改成 0.0.0.0 时这扇门自动失效，
                // 不至于把本机便利带成局域网匿名访问。
                loopbackNoAuth = env["LEGADO_LOOPBACK_NO_AUTH"]?.toBooleanStrictOrNull() == true && host in LOOPBACK_HOSTS,
            )
        }
    }
}

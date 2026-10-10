package io.legado.server

import java.awt.Desktop
import java.awt.MenuItem
import java.awt.PopupMenu
import java.awt.SystemTray
import java.awt.TrayIcon
import java.awt.event.ActionListener
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Path
import kotlin.io.path.absolutePathString
import java.time.Duration
import java.util.concurrent.CountDownLatch
import javax.imageio.ImageIO
import kotlin.system.exitProcess

/**
 * 桌面壳入口（jpackage `--main-class io.legado.server.DesktopLauncherKt`）。
 *
 * 职责只有三件，与 PROPOSAL-017 / ADR-017 一期一致：
 *  1. 探测端口（占用即退出，顺便充当单实例锁）；
 *  2. 带 `LEGADO_*` 起服务（复用 `createLegadoEngine`，不改 `Guard.kt`、不加鉴权）；
 *  3. 服务就绪后打开浏览器；并在系统托盘给一个"打开 / 退出"，退出时优雅关服务。
 *
 * webview 一律直接开到 `http://127.0.0.1:<port>`，壳只当"进程管家 + 窗口"，
 * 绝不自己加载界面当"前端宿主" —— 否则同源闸门会让所有写操作 403（详见 ADR-017 §2）。
 */
fun main(args: Array<String>) {
    val noOpen = args.contains("--no-open")

    val imageRoot = computeImageRoot()
    val env = readEnvFile(imageRoot)
    val pick = { name: String, fallback: String -> env[name] ?: System.getenv(name) ?: fallback }

    // 端口优先级：port.txt（界面上最后改的那一下）> .env / 环境变量 > 固定 1234。
    // 必须显式定死：裸 jar 默认是 8080，不传就会"起了但连不上"。
    val portFromFile = readPortFile(imageRoot)
    val port = portFromFile ?: pick("LEGADO_PORT", "1234").toIntOrNull() ?: 1234
    val host = pick("LEGADO_HOST", "127.0.0.1")

    // 数据目录：.env / 环境变量显式给的优先；相对路径相对"镜像根"（exe 所在目录）解析；
    // 都没给就落在 <镜像根>/data（便携、不写系统盘）。不静默迁移，首屏用 .env 记住选择即可。
    val dataDirRaw = pick("LEGADO_DATA_DIR", "data")
    val dataDir = if (File(dataDirRaw).isAbsolute) Path.of(dataDirRaw) else imageRoot.resolve(dataDirRaw).toAbsolutePath()
    val databasePath = env["LEGADO_DATABASE"] ?: System.getenv("LEGADO_DATABASE")
        ?: dataDir.resolve("legado.sqlite").absolutePathString()

    // 不让 JVM 临时目录落到系统盘（默认是 C:\Users\<用户>\AppData\Local\Temp）。
    val tmpDir = imageRoot.resolve("tmp")
    tmpDir.toFile().mkdirs()
    System.setProperty("java.io.tmpdir", tmpDir.toString())

    val config = ServerConfig(
        host = host,
        port = port,
        databasePath = databasePath,
        coverCacheDirectory = dataDir.resolve("covers"),
        localBooksDirectory = dataDir.resolve("local_books"),
        nextDirectory = Path.of(pick("LEGADO_NEXT_DIR", "next")),
        homeDirectory = imageRoot.toAbsolutePath(),
    )

    val browseHost = if (host == "0.0.0.0" || host == "::") "127.0.0.1" else host
    val url = "http://$browseHost:$port"

    // 幂等 + 单实例：已经在跑就直接开界面（重复点图标不该报错），也不该再起第二个实例。
    // 已运行的那个实例自己带着托盘，所以第二个实例只负责把界面打开、然后退出，绝不常驻——
    // 否则在支持托盘的环境里它会作为"已运行"托盘一直挂着，破坏"不留第二个进程"。
    if (isPortOpen(host, port)) {
        logDesktop("青阅已在运行 $url")
        if (!noOpen) openBrowser(url)
        exitProcess(0)
    }
    // 端口被占（但不归我们管）也拒绝启动，给出人话，不留第二个进程。
    if (!canBind(host, port)) {
        val msg = "端口 $port 被占用，青阅无法启动。先关掉占用它的程序，或在 .env 里设 LEGADO_PORT 换一个。"
        logDesktop(msg)
        showError(msg)
        exitProcess(1)
    }

    logDesktop("青阅 ${BuildInfo.version} 启动中 $url")
    logDesktop("安装目录 $imageRoot")
    logDesktop("数据目录 $dataDir")
    logDesktop("日志     ${imageRoot.resolve("server.log")}")
    logDesktop("临时目录 $tmpDir")

    val engine = createLegadoEngine(config)
    // 优雅关闭：托盘"退出"或进程被终止（SIGINT/SIGTERM）都走这里，服务干净收尾。
    engine.start(wait = false)
    Runtime.getRuntime().addShutdownHook(Thread {
        try { engine.stop(5000, 10000) } catch (_: Throwable) { }
    })

    val ready = waitForHealth(url)
    if (!ready) {
        val msg = "等了很久服务 $url 还没就绪，看看日志：${imageRoot.resolve("server.log")}"
        logDesktop(msg)
        showError(msg)
        exitProcess(1)
    }
    logDesktop("服务已就绪 $url")
    if (!noOpen) openBrowser(url)
    showTray("青阅", url, imageRoot, noOpen)
    CountDownLatch(1).await() // 守住主线程，靠托盘"退出"或外部信号结束
}

private fun computeImageRoot(): Path {
    val cp = System.getProperty("java.class.path") ?: ""
    val jarEntry = cp.split(File.pathSeparatorChar).firstOrNull { it.endsWith(".jar") }
    val jarFile = if (jarEntry != null) File(jarEntry) else null
    // 打包后 jar 在 <镜像>/app/<jar>：父目录名是 "app"，镜像根再上一级。
    if (jarFile != null && jarFile.parentFile?.name == "app") return jarFile.parentFile!!.parentFile!!.toPath()
    // 开发/IDE 里跑：退回工作目录。
    return Path.of(System.getProperty("user.dir"))
}

private fun readEnvFile(root: Path): Map<String, String> {
    val file = root.resolve(".env")
    if (!file.toFile().exists()) return emptyMap()
    return file.toFile().readText().split(Regex("\r?\n"))
        .mapNotNull { Regex("^\\s*([A-Z_][A-Z0-9_]*)\\s*=\\s*(.*)$").matchEntire(it) }
        .associate { it.groupValues[1] to it.groupValues[2].trim().removeSurrounding("'", "\"").removeSurrounding("\"", "\"") }
}

private fun readPortFile(root: Path): Int? {
    val file = root.resolve("port.txt")
    if (!file.toFile().exists()) return null
    val n = file.toFile().readText().trim().toIntOrNull()
    return if (n != null && n > 0 && n < 65536) n else null
}

private fun isPortOpen(host: String, port: Int): Boolean = try {
    Socket().use { it.connect(InetSocketAddress(host, port), 1000); true }
} catch (_: Throwable) { false }

private fun canBind(host: String, port: Int): Boolean = try {
    java.net.ServerSocket().use { it.bind(InetSocketAddress(host, port)); true }
} catch (_: Throwable) { false }

private fun waitForHealth(url: String, timeoutMs: Long = 120_000): Boolean {
    val client = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(2000)).build()
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
        try {
            val res = client.send(
                HttpRequest.newBuilder(URI("$url/healthz")).timeout(Duration.ofMillis(2000)).GET().build(),
                HttpResponse.BodyHandlers.discarding(),
            )
            if (res.statusCode() == 200) return true
        } catch (_: Throwable) { }
        Thread.sleep(400)
    }
    return false
}

private fun openBrowser(url: String) {
    try {
        if (Desktop.isDesktopSupported()) Desktop.getDesktop().browse(URI(url))
    } catch (_: Throwable) { /* 打不开就只打印地址 */ }
}

private fun logDesktop(message: String) {
    println("[青阅] $message")
}

private fun loadIcon(imageRoot: Path): java.awt.Image? {
    val ico = imageRoot.resolve("app.ico").toFile()
    if (ico.exists()) runCatching { return ImageIO.read(ico) }.getOrNull()
    // 退路：1x1 透明图，保证 TrayIcon 不空。
    return java.awt.image.BufferedImage(1, 1, java.awt.image.BufferedImage.TYPE_INT_ARGB)
}

private fun showTray(title: String, url: String, imageRoot: Path, noOpen: Boolean) {
    if (!SystemTray.isSupported()) return
    runCatching {
        val tray = SystemTray.getSystemTray()
        val popup = PopupMenu()
        val openItem = MenuItem("打开青阅").also { it.addActionListener(ActionListener { openBrowser(url) }) }
        val exitItem = MenuItem("退出").also { it.addActionListener(ActionListener { exitProcess(0) }) }
        popup.add(openItem)
        popup.add(exitItem)
        val icon = TrayIcon(loadIcon(imageRoot), title, popup).also {
            it.isImageAutoSize = true
            if (!noOpen) it.addActionListener(ActionListener { openBrowser(url) })
        }
        tray.add(icon)
    }
}

private fun showError(message: String) {
    if (!SystemTray.isSupported()) return
    runCatching {
        val tray = SystemTray.getSystemTray()
        val popup = PopupMenu()
        val exitItem = MenuItem("退出").also { it.addActionListener(ActionListener { exitProcess(1) }) }
        popup.add(MenuItem(message))
        popup.add(exitItem)
        val icon = TrayIcon(loadIcon(Path.of(System.getProperty("user.dir"))), "青阅", popup).also { it.isImageAutoSize = true }
        tray.add(icon)
        Thread.sleep(8000) // 错误托盘停留几秒，给用户看到提示
    }
}

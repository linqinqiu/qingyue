package io.legado

import io.ktor.http.*
import io.ktor.http.content.PartData
import io.ktor.http.content.forEachPart
import io.ktor.http.content.streamProvider
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.http.content.*
import io.legado.http.requireSameOriginWrite
import io.legado.model.ApiError
import java.nio.file.Files
import java.nio.file.Path

fun Route.staticWeb(homeDirectory: Path = Path.of(".")) {
    val respondNoCache: suspend (ApplicationCall, String, ContentType?) -> Unit = { call, resource, contentType ->
        call.response.header(HttpHeaders.CacheControl, "no-cache, no-store, must-revalidate")
        call.response.header(HttpHeaders.Pragma, "no-cache")
        call.response.header(HttpHeaders.Expires, "0")
        if (contentType != null) {
            call.response.header(HttpHeaders.ContentType, contentType.toString())
        }
        call.respondResource(resource)
    }

    val respondIndex: suspend (ApplicationCall) -> Unit = { call ->
        respondNoCache(call, "static/index.html", ContentType.Text.Html.withCharset(Charsets.UTF_8))
    }

    get("/index.html") { respondIndex(call) }
    head("/index.html") { respondIndex(call) }

    get("/sw.js") { respondNoCache(call, "static/sw.js", ContentType.parse("application/javascript")) }
    head("/sw.js") { respondNoCache(call, "static/sw.js", ContentType.parse("application/javascript")) }
    // manifest 带 no-cache，所以运行时按品牌改写它**立刻生效**（用户：「允许自定义图标和名称」）。
    // 没设品牌时原样发内置那份文本，一个字节都不动 —— 见 BrandManifest.render 的理由。
    val respondManifest: suspend (ApplicationCall) -> Unit = { call ->
        val brand = BrandStore.load(homeDirectory)
        val icon = if (brand.hasIcon) "/brand/icon" else null
        val text = BrandManifest.render(brand, icon, BrandStore.iconType(homeDirectory, brand))
        if (text.isBlank()) {
            respondNoCache(call, "static/manifest.webmanifest", ContentType.parse("application/manifest+json"))
        } else {
            call.response.header(HttpHeaders.CacheControl, "no-cache, no-store, must-revalidate")
            call.respondText(text, ContentType.parse("application/manifest+json"))
        }
    }
    get("/manifest.webmanifest") { respondManifest(call) }
    head("/manifest.webmanifest") { respondManifest(call) }
    get("/manifest.json") { respondManifest(call) }
    head("/manifest.json") { respondManifest(call) }

    // ===== 自定义品牌：读写安装根的 brand.json + brand/ 里的图标字节 =====
    // 放这里而不是 http/ 那批路由文件：与 /sw.js、/manifest.webmanifest 同一档"静态表面"，
    // 不进 /api/catalog 的端点计数（142 条那道闸门只扫 io/legado/http/，见 ApiCatalog.test.ts）。
    // 但写操作照样过同源闸门 —— 它改的是这台机器的外观，跨站页面不该代用户改。
    get("/brand") {
        val brand = BrandStore.load(homeDirectory)
        call.respond(BrandManifest.brandJson(brand, if (brand.hasIcon) "/brand/icon" else null))
    }
    put("/brand") {
        if (!call.requireSameOriginWrite()) return@put
        val brand = runCatching { call.receive<Brand>() }.getOrElse {
            call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "请求体不是合法的 {name, shortName, themeColor}")); return@put
        }
        val saved = BrandStore.save(homeDirectory, brand)
        call.respond(BrandManifest.brandJson(saved, if (saved.hasIcon) "/brand/icon" else null))
    }
    delete("/brand") {
        if (!call.requireSameOriginWrite()) return@delete
        val cleared = BrandStore.clear(homeDirectory)
        call.respond(BrandManifest.brandJson(cleared, null))
    }
    post("/brand/icon") {
        if (!call.requireSameOriginWrite()) return@post
        val multipart = runCatching { call.receiveMultipart() }.getOrElse {
            call.respond(HttpStatusCode.BadRequest, ApiError("invalid_request", "要 multipart/form-data，字段名 file")); return@post
        }
        // 形状照 `BackupRoutes` 那一条：先收成 Pair，循环外再判（那里还漏了 import
        // `io.ktor.http.content.streamProvider` —— 它是扩展函数，不跟着 import 就报 Unresolved）。
        var upload: Pair<String, ByteArray>? = null
        multipart.forEachPart { part ->
            val file = part as? PartData.FileItem
            if (file != null && upload == null) {
                upload = (file.originalFileName ?: "icon") to file.streamProvider().readBytes()
            }
            part.dispose()
        }
        val raw = upload?.second
        val reject: String? = when {
            raw == null || raw.isEmpty() -> "没收到图标文件"
            raw.size.toLong() > BrandStore.MAX_ICON_BYTES -> "图标太大（上限 ${BrandStore.MAX_ICON_BYTES / 1024 / 1024} MB）"
            // 只按魔数认图、不收 SVG：品牌图标会被浏览器当"本站自己的资源"取用，
            // 放进一张能带脚本的 SVG 等于自己开一条同源脚本执行面
            // （与 CoverCache 拒 image/svg+xml、MediaRoutes 把同源 SVG 降级同一纪律）。
            BrandStore.sniffImageType(raw) == null -> "图标只能是 PNG / JPEG / WebP（不收 SVG）"
            else -> null
        }
        if (reject != null) {
            call.respond(HttpStatusCode.BadRequest, ApiError("invalid_icon", reject)); return@post
        }
        val data = raw!!
        val saved = BrandStore.saveIcon(homeDirectory, data)
        if (saved == null) {
            call.respond(HttpStatusCode.InternalServerError, ApiError("write_failed", "图标写不进 brand/ 目录")); return@post
        }
        val brand = BrandStore.save(homeDirectory, BrandStore.load(homeDirectory).copy(iconFile = saved))
        call.respond(BrandManifest.brandJson(brand, "/brand/icon"))
    }
    delete("/brand/icon") {
        if (!call.requireSameOriginWrite()) return@delete
        val brand = BrandStore.deleteIcon(homeDirectory)
        call.respond(BrandManifest.brandJson(brand, null))
    }
    // 自定义图标本身：URL 固定 /brand/icon，**缓存指纹靠 ETag**（不是文件名 ?v=）。
    // 图标没有 no-cache 的必要 —— 内容变了 ETag 就变了，浏览器拿旧的也不会显示错。
    get("/brand/icon") {
        val brand = BrandStore.load(homeDirectory)
        val pair = BrandStore.iconBytes(homeDirectory, brand)
        if (pair == null) { call.respond(HttpStatusCode.NotFound, ApiError("not_found", "没有自定义图标")); return@get }
        val (data, type) = pair
        val etag = "\"" + BrandManifest.iconEtag(data) + "\""
        if (call.request.headers[HttpHeaders.IfNoneMatch] == etag) {
            call.response.header(HttpHeaders.ETag, etag)
            call.respond(HttpStatusCode.NotModified); return@get
        }
        call.response.header(HttpHeaders.ETag, etag)
        call.response.header(HttpHeaders.CacheControl, "public, max-age=31536000, immutable")
        call.respondBytes(data, ContentType.parse(type))
    }

    staticResources("/assets", "static/assets")
    staticResources("/", "static")
    get("/") { respondIndex(call) }
    head("/") { respondIndex(call) }
}

/**
 * 新骨架（qingyue 前端）挂在**同一个端口**的 `/next` 下，而不是另开一个开发端口。
 *
 * 为什么必须同端口：这台服务不设身份、只绑回环，写操作唯一的门是"Origin 的主机与端口
 * 等于请求的 Host"（见 [Guard.kt]）。前端换到 5200 之类的端口，所有写请求的 Origin 就对不上，
 * 要么放宽闸门、要么再加一层代理 —— 两条都比"多一个静态目录"贵得多，而且放宽闸门等于把
 * 这个服务唯一的写保护拆掉。挂在 `/next` 下，新旧界面同一个源，闸门一行都不用动。
 *
 * 目录从**磁盘**读而不是烤进 jar：这一格是每天在改的东西，每改一次就重打一次 jar
 * 会把"看一眼新界面"变成一次发版。目录不存在时整条不注册（`/next` 落到根路由的 404），
 * 而不是摆一张"这里什么都没有"的假页面。
 */
fun Route.staticNext(nextDirectory: Path) {
    val index = nextDirectory.resolve("index.html")
    if (!Files.isRegularFile(index)) return
    // index 必须 no-cache：它的名字不带哈希，浏览器一旦缓存，重新构建出新 bundle 也拿不到
    val respondIndex: suspend (ApplicationCall) -> Unit = { call ->
        call.response.header(HttpHeaders.CacheControl, "no-cache, no-store, must-revalidate")
        call.response.header(HttpHeaders.Pragma, "no-cache")
        call.response.header(HttpHeaders.Expires, "0")
        call.respondFile(index.toFile())
    }
    get("/next") { call.respondRedirect("/next/") }
    get("/next/") { respondIndex(call) }
    head("/next/") { respondIndex(call) }
    // 带哈希的 assets 走普通静态缓存；`/next/<别的东西>` 由 Ktor 找文件，找不到就 404
    staticFiles("/next", nextDirectory.toFile())
}

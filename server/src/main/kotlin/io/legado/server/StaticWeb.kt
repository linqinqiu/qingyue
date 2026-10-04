package io.legado.server

import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import io.ktor.server.http.content.*
import java.nio.file.Files
import java.nio.file.Path

fun Route.staticWeb() {
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
    get("/registerSW.js") { respondNoCache(call, "static/registerSW.js", ContentType.parse("application/javascript")) }
    head("/registerSW.js") { respondNoCache(call, "static/registerSW.js", ContentType.parse("application/javascript")) }
    get("/manifest.webmanifest") { respondNoCache(call, "static/manifest.webmanifest", ContentType.parse("application/manifest+json")) }
    head("/manifest.webmanifest") { respondNoCache(call, "static/manifest.webmanifest", ContentType.parse("application/manifest+json")) }
    get("/manifest.json") { respondNoCache(call, "static/manifest.webmanifest", ContentType.parse("application/manifest+json")) }
    head("/manifest.json") { respondNoCache(call, "static/manifest.webmanifest", ContentType.parse("application/manifest+json")) }

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

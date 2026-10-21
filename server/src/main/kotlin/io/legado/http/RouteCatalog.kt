package io.legado.http

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

/**
 * 端点目录：把随包的 `resources/agent-api.json` 发给外部程序（脚本 / AI 客户端），
 * 只把里面的 `version` 换成**当前真正在跑的构建号** —— 目录内容与产品版本各漂各的，
 * 是这份契约最容易烂掉的方式。
 *
 * 为什么不去反射 Ktor 的路由树：3.4 没把 `getRoutingRoot` 暴露成可解析的公开扩展（编译期就取不到），
 * 而就算读得到，树上也只有方法与路径 —— 给不出「这个端点做什么、请求体长什么样」，
 * 而那才是接进来的人真正需要的东西。
 *
 * 漂移由 `web/test/ApiCatalog.test.ts` 双向钉住：目录里多一条代码中没有的端点、
 * 或少一条代码里有的书源端点，都会红（不是靠人记得改文档）。
 */
internal object RouteCatalog {
    private val json = Json
    private val source = Json.parseToJsonElement(
        RouteCatalog::class.java.getResourceAsStream("/agent-api.json")
            ?.readBytes()?.decodeToString()
            ?: error("随包端点目录 agent-api.json 不见了（它应当和这份代码一起提交）"),
    ).jsonObject

    /**
     * 响应时盖两样东西：`version` 换成**当前真正在跑的构建号**，`count` 按端点条数现数 ——
     * 这两个值只要是人填的就一定会有对不上的一天。
     */
    fun serve(version: String): String {
        val endpoints = source["endpoints"]?.jsonArray ?: error("端点目录里没有 endpoints 数组")
        return json.encodeToString(JsonObject.serializer(), JsonObject(
            source + ("version" to JsonPrimitive(version)) + ("count" to JsonPrimitive(endpoints.size)),
        ))
    }
}

package io.legado.server

/**
 * 版本号的唯一来源。
 *
 * 值由 Gradle 在打 fatJar 时写进清单的 `Implementation-Version`（见 `server/build.gradle`
 * 的 `version = '0.1.0'` 与 `manifest { attributes(...) }`），所以**构建产物、`/healthz`
 * 报的、界面显示的是同一个数**，不存在"改了 gradle 忘了改界面"那种假版本号。
 * 从源码直接跑（`gradle run` 走的是 `jar` 任务，同样带清单）拿不到时回落 `dev`，
 * 那说明这是开发中的副本，不是一个可发布的版本。
 */
object BuildInfo {
    val version: String =
        BuildInfo::class.java.`package`?.implementationVersion?.takeIf { it.isNotBlank() && it != "unknown" }
            ?: "dev"

    val title: String = "青阅"
}

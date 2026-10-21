package io.legado

import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.name

/**
 * 后端版「框架不夹带内容」守门，对应前端的 `web/test/FrameworkHasNoContent.test.ts`。
 *
 * 前端分层：
 *   `lab/` + `extensions/` 是**纯容器/契约**（谁都不依赖，或只依赖容器）；
 *   `plugins/` + `features/` 是**内容**（随程序发布的 AI 接入属于 `features/`）。
 *   判据 `FrameworkHasNoContent.test.ts` 钉死：容器里一旦出现 `import '../plugins/...'`
 *   之类的「反向依赖」就红。
 *
 * 后端一一对应：
 *   `plugin/`        = 纯框架容器（定义 `Plugin` 契约 + 注册表，只立钩子，零内容）；
 *   `ai/`            = 内置「AI 接入」内容包（类比 `features/`，允许内含 builtin 工具/协议，
 *                      因此**不**纳入本判据）；
 *   其余包           = 具体业务/功能内容（backup/cache/content/data/http/localbook/model/
 *                      ops/rules/source/subscription/tts）。
 *
 * 所以后端唯一需要钉死的「反向依赖」是：**`plugin/` 容器不得 import 任何具体功能包**。
 * 它只允许依赖自身与 `ai/` 的契约类型（`ToolRegistry`/`LlmProviderRegistry`/
 * `ConnectionSelectorRegistry`/`ToolHooks`），以及标准库。
 * 一旦有人在 `PluginManager` 之类里直接 `import io.legado.data.Database`
 * 或 `import io.legado.source.RuleRunner`（框架漏出内容），本判据即红。
 *
 * 注：本仓库统一用 JUnit 4（`junit:junit:4.13.2`，见 `server/build.gradle`），
 * 所以这里用 `org.junit.Test` + `org.junit.Assert`，不用 JUnit 5 的 `@Tag`。
 * 只跑这一条时用 Gradle 的类过滤：`--tests "*PluginFrameworkHasNoContentTest"`。
 */
class PluginFrameworkHasNoContentTest {

    /** `plugin/` 之外的具体功能包——容器一旦 import 其中任何一个就是夹带内容。 */
    private val forbiddenFeaturePackages = setOf(
        "backup",
        "cache",
        "content",
        "data",
        "http",
        "localbook",
        "model",
        "ops",
        "rules",
        "source",
        "subscription",
        "tts",
    )

    /** 容器允许依赖的包：自身、契约包 `ai`、标准库。 */
    private val allowedServerSubpackages = setOf("plugin", "ai")

    @Test
    fun `plugin 框架容器 不得 import 任何具体功能包`() {
        val pluginDir = findPluginSourceDir()
        assertTrue("找不到 plugin 源码目录：$pluginDir", Files.exists(pluginDir))

        val violations = mutableListOf<String>()
        Files.walk(pluginDir)
            .filter { it.name.endsWith(".kt") }
            .forEach { file ->
                Files.readAllLines(file).forEachIndexed { idx, line ->
                    val m = SERVER_IMPORT.matchEntire(line.trim()) ?: return@forEachIndexed
                    val sub = m.groupValues[1]
                    if (sub !in allowedServerSubpackages && sub in forbiddenFeaturePackages) {
                        violations += "${file.name}:${idx + 1} import io.legado.$sub.*（容器夹带了具体功能包）"
                    }
                }
            }

        assertTrue(
            "plugin/ 框架容器不得依赖具体功能包，发现以下反向依赖：\n" + violations.joinToString("\n"),
            violations.isEmpty(),
        )
    }

    private companion object {
        /**
         * 匹配"容器 import 了某个具体功能包"。
         *
         * 包名在 0.8.3 之后去掉了 `server` 这一段：`io.legado.http` → `io.legado.http`。
         * 这条正则必须跟着改 —— 否则它一条都匹配不上，判据就变成**永远绿的空判**
         * （比红更糟：红至少还告诉你有人在看）。
         */
        private val SERVER_IMPORT = Regex("^import\\s+io\\.legado\\.([a-zA-Z0-9_]+)\\..*")

        /** 从多种可能的 cwd（模块根 / 仓库根）向上回溯，定位 plugin 源码目录。 */
        fun findPluginSourceDir(): Path {
            // 路径同样跟着包名走：io/legado/plugin → io/legado/plugin
            val rel = listOf("server", "src", "main", "kotlin", "io", "legado", "plugin")
            val candidates = sequence {
                var cur = Path.of(System.getProperty("user.dir"))
                yield(cur.resolve(rel.joinToString("/")))
                // 仓库根：server/src/... ；server 模块根：src/...
                yield(cur.resolve(rel.drop(1).joinToString("/")))
                var p: Path? = cur
                while (p != null) {
                    yield(p.resolve(rel.joinToString("/")))
                    p = p.parent
                }
            }
            return candidates.firstOrNull { Files.exists(it) && Files.isDirectory(it) }
                ?: Path.of("server/src/main/kotlin/io/legado/plugin")
        }
    }
}

# 程序内部 AI 框架（大体框架支持）

> 本文件描述 **AI 在 1234 这台服务进程内部** 运行的方式：它复用 HTTP 端点背后那同一批服务，
> 能看、能改的东西与界面/脚本完全一致。这里**只给框架骨架**，不新增 1234 之外的功能。
> 关于机器可读的接口契约，仍以 `GET /api/catalog`（即 `agent-api.json`）为准，见 `AI-AGENT.md`。

## 0. 为什么是「进程内」

用户要的是「在程序内部、自定义一个连接 API、能在内部改建所有东西」——所以 AI 不是一个
外挂的前端，也不开第二条 HTTP 服务。它直接拿 `Application` 启动时已经建好的那些服务对象：

- `Database`：书源 / 净化规则 / RSS / 书架 / 笔记 / 阅读日志 / 订阅 的读写
- `RuleRunner`：搜索 / 发现 / 目录 / 正文 / 调试
- `SourceDebugger`、`SourceHealth`：书源体检与分阶段调试
- `SubscriptionService`：订阅更新
- `CoverCache`：封面缓存

这些对象就是 138 个 HTTP 端点背后那同一批实例。AI 调用它们 == 端点调用它们，
**没有第二条实现路径**，也就不会出现「AI 能改、界面改不了」或反过来这种分裂。

**关键约束（来自 `web/test/ApiCatalog.test.ts`）：** 那份判据逐条比对 `http/` 目录的路由文件与
`agent-api.json`，条数对不上、write 标错、purpose/response 缺字都会红。所以本框架
**不注册任何新 HTTP 路由**，AI 完全在进程内通过 `Agent` 暴露，不增加端点计数。

## 1. 包结构

```
server/src/main/kotlin/io/legado/server/ai/
├── AgentContext.kt   // 把服务装进一个"连接"对象，作为所有工具的共享环境
├── Agent.kt          // 编排：能力清单 / 执行单工具 / 规划 / LLM 钩子占位
├── AgentCatalog.kt   // 读 agent-api.json，生成给 AI 看的能力说明
├── Guardrails.kt     // 护栏：拒绝公网绑定 / 写前确认 / 版本冲突转译
├── BuiltinTools.kt   // 内置工具清单（~39 个，覆盖现有服务层）
├── AgentConnection.kt// ★ 程序内部"连接 API"句柄：call / manifest（同步，不增路由）
└── AgentModule.kt    // ★ 把连接挂进进程的接线处：install 默认关闭，仅 -Dai.debug 自检
```

## 2. 核心类型（`AgentContext.kt`）

```kotlin
data class AgentContext(
    val database: Database,
    val runner: RuleRunner,
    val debugger: SourceDebugger,
    val health: SourceHealth,
    val subscriptions: SubscriptionService,
    val coverCache: CoverCache,
    val boundHost: String = "127.0.0.1",  // 真实绑定身份，护栏据此拒绝"搬到公网"
    val boundPort: Int = 1234,
) {
    fun error(code: String, message: String): AgentResult =
        AgentResult(status = "error", code = code, message = message)
}

data class AgentResult(
    val status: String,          // "ok" | "error"
    val code: String = "ok",      // 沿用 HTTP 错误码语义
    val message: String? = null,  // 给人/下一段推理看
    val data: Any? = null,        // 结构化结果（JSON 友好）
)

typealias ToolArgs = Map<String, Any?>   // 扁平键值，骨架阶段只支持基础类型

data class ToolMeta(
    val id: String,
    val group: String,
    val description: String,
    val writes: Boolean,          // 是否会写库（执行前过护栏）
)

class Tool(var meta: ToolMeta, val handler: suspend (AgentContext, ToolArgs) -> AgentResult) {
    constructor(handler: suspend (AgentContext, ToolArgs) -> AgentResult) :
        this(ToolMeta("__unset__", "unknown", "", false), handler)
    suspend fun invoke(ctx: AgentContext, args: ToolArgs): AgentResult = handler(ctx, args)
}
```

`error(code, message)` 的 `code` 字段**全部沿用现有 HTTP 错误码**
（`invalid_request` / `not_found` / `version_conflict` / `cross_origin` /
`source_execution_failed` 等），保证进程内与 HTTP 层语义一致，便于复用同一套提示词。

## 3. 护栏（`Guardrails.kt`）

AI 能改库，所以每一条写路径都要先过护栏：

| 方法 | 作用 |
| --- | --- |
| `refuseExternalBind(host): AgentResult?` | 只允许 `127.0.0.1` / `localhost` / `::1`；`0.0.0.0` 与任意公网地址一律**拒绝**（返回非 null 即拦截）。这是「永不把服务搬到公网」的硬门。 |
| `requireConfirm(args, affectedHint): AgentResult?` | 破坏性动作（删源 / 删规则 / 清书架 / 覆盖导入等）必须带 `confirm = true` 才放行；否则返回 `confirm_required` 提示。 |
| `catchVersionConflict(block): T` | 把 `VersionConflict`（PUT 带旧 version 命中并发改写）转成 `AgentVersionConflict`，由 `Agent.runTool` 统一翻成 `version_conflict` 错误。 |

任何"意图把监听搬出本机"或"不经确认就破坏"的调用，都会在框架层被拦下，
不会真的落到 `Database`。

## 4. 能力清单（`AgentCatalog.kt` + `BuiltinTools.kt`）

`AgentCatalog.loadEndpoints()` 直接读 `agent-api.json`（与 `/api/catalog` 同一份文件），
把它变成给 AI 看的、带 `version` 注记的文本说明。这样 **AI 看到的能力面 == 1234 交付的
能力面**，不会因为另写一套而漂走。

`BuiltinTools.all()` 注册约 43 个工具，按面分组，每个都只是把参数转成一次既有服务调用：

- **书源**：列举 / 取单条 / 校验草稿 / 写库（带版本乐观锁）/ 删除 / 批量整理 / 导入 / 自定义排序
- **净化规则**：列举 / 增删改 / 切换启用 / 导入
- **RSS**：列举 / 取单条 / 切换启用 / 删除 / 导入
- **书架**：列举 / 加入 / 改信息（封面、分组、是否读完）
- **笔记与进度**：列笔记 / 增改删 / 记阅读日志 / 读日志
- **订阅**：列订阅 / 更新单个 / 更新全部
- **发现页与搜索**：取发现页标签 / 取某标签条目 / 搜书
- **体检与调试**：逐阶段调试（SSE 的同款 `DebugStep`）、单源体检

工具的实现严守三条：

1. 只读工具直接查 `Database` / `RuleRunner`；
2. 写工具先 `Guardrails.requireConfirm(args, …)`，再在 `catchVersionConflict { … }` 里落库；
3. 失败一律走 `ctx.error(code, message)`，不抛裸异常。

## 5. 编排（`Agent.kt`）

```kotlin
class Agent(private val ctx: AgentContext, private val tools: List<Tool> = BuiltinTools.all()) {

    fun toolManifest(): String            // 当前全部工具的元信息，喂给 LLM 做选择
    suspend fun runTool(id: String, args: ToolArgs): AgentResult  // 执行单个工具，统一兜底异常
    suspend fun plan(goal: String): Plan  // 关键词路由占位：把目标映射到工具（骨架，未接 LLM）
    suspend fun callLlm(prompt: String): String?   // LLM 钩子 —— TODO，当前返回 null

    data class Plan(val goal: String, val toolId: String?, val note: String?)
}
```

`runTool` 的异常兜底：

- `Guardrails.AgentVersionConflict` / `VersionConflict` → `version_conflict`
- `IllegalArgumentException` → `invalid_request`
- 其他 `Throwable` → `internal_error`

**`callLlm` 目前是占位**：返回 `null`。框架不绑定任何外部模型、不开网络出口；
接模型时只需替换这一处，且必须遵守「模型只能从 `toolManifest` 选工具、只能通过
`runTool` 落地」这一约束，不能允许模型直接调私有方法绕过护栏。

## 6. 程序内部的「连接 API」（已交付）

用户要的「在内部提供 API 连接」落地为 `AgentConnection`：一个进程内句柄，调用方
（自动化脚本 / 智能体 / 调试器）拿它就能像访问一个连接那样 `call` 任意已注册工具、
`manifest` 看清当前能力面。它**不开端口、不注册任何 HTTP 路由**。

```kotlin
// 构造（用启动时已有的同一批服务；见 AgentModule.connect）
val conn = AgentConnection(agent)
val tools: List<ToolMeta> = conn.manifest()
val res: AgentResult = conn.call("replace.import", mapOf(
    "json" to """[{"name":"demo","pattern":"a","replacement":"b","isRegex":false}]"""
))
val res2: AgentResult = conn.callSuspend("replace.list", mapOf("q" to "demo"))
```

### 挂进进程（AgentModule）

`AgentModule.install(database, runner, coverCache, subscriptions)` 就是接线处：

- **默认关闭**：生产环境直接返回 `null`，进程对外暴露面与从前完全一致。
- **仅 `-Dai.debug`**：构造连接并跑 `selfTest`（写一条自检规则 → 读回 → 删除），不污染真实库。
- `Application.kt` 已接入：`AgentModule.install(database, runner, coverCache, subscriptions)`，无 `routing { }`，端点计数不动。

### 验证（已在 server/src/test）

- `AgentFrameworkTest.kt`（5 例）、`AgentConnectionTest.kt`（5 例）覆盖读/写/护栏/能力面。
- 运行：`$env:GRADLE_OPTS='-Xmx1g -Xms256m'; .\gradlew.bat :server:test --tests "io.legado.server.AgentConnectionTest"`

1. **单元测试**：在 `server/src/test` 里构造 `Agent` 跑端到端断言（改源 → 读回 → 校验）。（旧式入口，已被 AgentConnection 取代）
2. **`main` 守卫调试入口**：在启动代码里用 `if (System.getProperty("ai.debug") != null)` 包住一段
   直接调用 `agent.runTool(...)` 的演示逻辑，仅供本地排查，不对外暴露。

要让人/脚本以「AI 客户端」方式驱动这台服务，仍然走 `GET /api/catalog` 拿契约、
走既有 138 个端点执行——进程内 `Agent` 是给"服务自己内嵌的自动化/智能体"用的同一条路径。

## 7. 当前边界（骨架阶段只到这）

- 已就位：连接句柄 `AgentConnection`、进程接线 `AgentModule`（默认关闭）、能力清单、护栏、~39 个工具、异常兜底、目录读取、两套运行验证。
- 未就位（明确列为 TODO，不假装已实现）：
  - LLM 接入（`callLlm` 返回 null）
  - 真正的规划/多步推理（`plan` 仅关键词占位）
  - 任何把 AI 接到公网或新增端点的出口
- 不做的：第二套前端、第二条 HTTP 服务、绕过护栏的私有方法直调。

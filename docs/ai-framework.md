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
├── ToolRegistry.kt   // ★ 工具注册表：运行时增删工具，替代硬编码 listOf
├── ToolHooks.kt      // ★ 生命周期钩子：before / after / onError 四个介入点
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
class Agent(
    private val ctx: AgentContext,
    private val homeDirectory: Path,
    private val profileStore: AgentProfileStore = AgentProfileStore,
    tools: List<Tool> = BuiltinTools.all(),
    val registry: ToolRegistry = ToolRegistry(tools),   // 运行时增删工具
    val hooks: ToolHooks = ToolHooks(),                 // before / after / onError
) {

    fun toolManifest(): List<ToolMeta>            // 当前全部工具的元信息，喂给 LLM 做选择
    suspend fun runTool(id: String, args: ToolArgs): AgentResult  // 执行单个工具，统一兜底异常
    suspend fun plan(goal: String): Plan  // 关键词路由占位：把目标映射到工具（骨架，未接 LLM）
    suspend fun callLlm(prompt: String): String?   // 真调外部模型；缺连接/失败返回 null

    data class Plan(val goal: String, val toolId: String?, val note: String?)
}
```

`runTool` 的执行顺序（0.8.2 起，钩子接进来之后）：

1. `registry.find(id)` —— 未注册直接 `unknown_tool`
2. `hooks.runBefore` —— 任一钩子返回非 null 即**拦截**，工具不执行，拦截结果仍过 `after` 链
3. 工具本体 —— 异常按下面兜底
4. `hooks.runAfter` —— 可逐层改写结果

`runTool` 的异常兜底：

- `Guardrails.AgentVersionConflict` / `VersionConflict` → `version_conflict`
- `IllegalArgumentException` → `invalid_request`
- 其他 `Throwable` → `internal_error`（同时回调 `hooks.onError`，拿到的就是最终返回那个结果）
- 钩子自己抛异常 → `hook_failed`，工具不执行

**`callLlm` 已接通**：它会去 `AgentProfileStore` 找第一个非内置（openai-compatible）连接并真正发出
HTTP 请求；找不到或调用失败返回 `null`，调用方据此走关键字路由或本地兜底。框架本身仍不绑定任何
具体模型——接哪个地址完全由用户的 `agent-profiles.json` 决定。约束不变：模型只能从 `toolManifest`
选工具、只能通过 `runTool` 落地，不能允许模型直接调私有方法绕过护栏。

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

`AgentModule.connect(...)` 是构造接线处，`AgentModule.install(conn)` 决定要不要跑自检：

- **默认关闭**：两个开关都没设时 `isEnabled()` 为 false，进程对外暴露面与从前完全一致。
- **开关（两者取或）**：系统属性 `-Dai.debug`，或环境变量 `LEGADO_AI_ENABLED=1|true|yes|on`。
  后者是为正式部署准备的——不必再改启动脚本加 JVM 参数。
- 启用时跑一次 `selfTest`（写一条自检规则 → 读回 → 删除），不污染真实库。
- `Application.kt` 已接入，无 `routing { }`，端点计数不动。

### 扩展点（不改框架源码就能加能力）

```kotlin
// 1) 注册一个自己的工具
val registry = ToolRegistry()          // 内置工具自动在册
registry.register(
    Tool { ctx, args -> ctx.error("ok", "hello") }
        .also { it.meta = ToolMeta("demo.hello", "demo", "示例工具", writes = false) }
)

// 2) 挂一组钩子（返回的句柄用于卸载）
val hooks = ToolHooks()
val handle = hooks.install(
    // 返回 null = 放行；返回非 null = 拦截，工具不执行
    before = { meta, _ ->
        if (meta.id == "source.delete") AgentResult(status = "error", code = "forbidden", message = "本部署禁止删源")
        else null
    },
    after  = { _, _, result -> result },   // 返回 null 保持原结果，返回新结果即改写
    onError = { meta, _, error, converted -> /* 记录日志 / 告警 */ },
)

// 3) 把两者交给框架
val conn = AgentModule.connect(database, runner, coverCache, subscriptions, registry = registry, hooks = hooks)
```

### 验证（已在 server/src/test）

- `AgentFrameworkTest.kt`（5 例）、`AgentConnectionTest.kt`（5 例）覆盖读/写/护栏/能力面。
- 运行：`$env:GRADLE_OPTS='-Xmx1g -Xms256m'; .\gradlew.bat :server:test --tests "io.legado.server.AgentConnectionTest"`

1. **单元测试**：在 `server/src/test` 里构造 `Agent` 跑端到端断言（改源 → 读回 → 校验）。（旧式入口，已被 AgentConnection 取代）
2. **`main` 守卫调试入口**：在启动代码里用 `if (System.getProperty("ai.debug") != null)` 包住一段
   直接调用 `agent.runTool(...)` 的演示逻辑，仅供本地排查，不对外暴露。

要让人/脚本以「AI 客户端」方式驱动这台服务，仍然走 `GET /api/catalog` 拿契约、
走既有 138 个端点执行——进程内 `Agent` 是给"服务自己内嵌的自动化/智能体"用的同一条路径。

## 6.5 连接自己的配置（`options`）

`agent-profiles.json` 里每个连接的 `options` 字段现在**真的生效**了（此前是死字段，
只被写入、从没被读）。三条约定，借鉴自上游 `legado-with-MD3`：

| key | 作用 | 示例 |
|---|---|---|
| `header.<名字>` | 自定义请求头（中转站/自建服务常要） | `"header.X-Api-Key": "sk-relay"` |
| `thinking` | 思考强度五档，发到 `reasoning_effort` | `"thinking": "medium"` |
| `timeoutMs` | 单次请求超时（毫秒） | `"timeoutMs": "60000"` |

思考强度沿用 OpenAI 的命名，不自己发明：`low` / `medium` / `high` / `xhigh` / `max`
（大小写与空白宽容；写错或没设就不发这个字段，老服务不会因此 400）。

**会被挡掉的头**：`Content-Type`、`Authorization`、`Host`、`Content-Length` ——
前两个分别由 body 与 `apiKey` 字段表达（混着写两处必然漂移），后两个由 JDK HttpClient
自己算（硬写会出错）。判据 `ProfileOptionsTest` 钉着这四条。

```json
{ "profiles": [{
  "id": "relay", "name": "中转站", "kind": "openai-compatible",
  "baseUrl": "https://relay.example.com/v1", "apiKey": "sk-xxx", "model": "gpt-4o",
  "options": {
    "header.X-Relay-Region": "cn",
    "thinking": "high",
    "timeoutMs": "60000"
  }
}] }
```

## 7. 当前边界（骨架阶段只到这）

- 已就位：连接句柄 `AgentConnection`、进程接线 `AgentModule`（默认关闭）、能力清单、护栏、~39 个工具、异常兜底、目录读取、两套运行验证。
- **基础设施三件套（0.8.2 结构重排补，让框架"提供更多可能"）**：
  - `ToolRegistry` —— 工具面从硬编码 `listOf(...)` 变成**运行时可变**：外部可以 `register` / `unregister`
    自己的工具，不改框架源码、不重编译。三条不变量：id 唯一（重复注册默认拒绝，要覆盖得显式
    `replace = true`）、内置工具默认删不掉（防插件摘掉 `source.delete` 这类核心能力）、线程安全。
  - `ToolHooks` —— 工具调用的四个标准介入点：`before`（返回非 null 即拦截，工具不执行）、
    `after`（可改写结果）、`onError`（异常回调）、`install()` 返回注销句柄。钩子按注册顺序执行；
    被拦截的结果同样会过 `after` 链（审计要看得见）。钩子在工具**外面**，不能替工具绕过护栏。
  - 接入开关 —— 从前只有 `-Dai.debug`；现在补 `LEGADO_AI_ENABLED` 环境变量，两者**取或**。
    另有 `LEGADO_AI_ALLOW_REMOVING_BUILTIN_TOOLS`（默认 false）控制能否注销内置工具。
  - 判据：`AgentInfrastructureTest`（17 例）覆盖注册/注销/排序/拒绝非法注册/四个钩子阶段/
    钩子自身异常兜底/开关向后兼容/三件套组合。
- 已就位（此前误记为未就位，此处更正）：`callLlm` 不再是返回 null 的占位 —— 它会去
  `AgentProfileStore` 找第一个非内置连接并**真正发出 HTTP 请求**，找不到或失败才返回 null。
- 未就位（明确列为 TODO，不假装已实现）：
  - 真正的规划/多步推理（`plan` 仍是关键字路由占位）
  - 任何把 AI 接到公网或新增端点的出口
- 不做的：第二套前端、第二条 HTTP 服务、绕过护栏的私有方法直调。

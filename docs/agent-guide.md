# Agent 接入指南

> 给想用 AI 操作青阅的人。读完这份你应该能：**接上一个模型**、
> **知道它能做什么**、**自己给它加能力**。

## 0. 一句话

青阅的 AI 是**进程内网关**，不是外挂服务：它和界面、脚本用的是同一批服务对象，
所以它知道你在看什么，也能调程序自己的 54 个能力。
入口是 `/api/agent/*`（8 个端点），核心实现在 `app/src/main/kotlin/io/legado/ai/`。

## 1. 三步接上

### 1.1 起服务

```bash
npm start                 # 默认 127.0.0.1:1234
```

### 1.2 登记一个外部模型

任何 **openai-compatible** 地址都行 —— 各家云 API、自建网关、本机跑的 Ollama / LM Studio。
接本机的那类需要显式开一下口子，见下面「接本机模型」那条。

**方式 A：界面**（推荐，能立即实测通不通）
设置 → 接入与扩展 → **AI 接入** → 填连接 → 保存。
面板顶部两个状态：「已连接」= 配没配；「实测可达」= 此刻通不通。

**方式 B：HTTP**

```bash
curl -s -X POST http://127.0.0.1:1234/api/agent/connections \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:1234' \
  -d '{"name":"我的网关","kind":"openai-compatible",
       "baseUrl":"https://api.example.com/v1","model":"gpt-4o","apiKey":"sk-xxx"}'
```

> ⚠️ 出站闸门（`NetworkSecurity`）默认**拒绝内网与本机地址**：填 `192.168.*` / `10.*` /
> `169.254.169.254` 这类一律返回 `400 invalid_request`，并把闸门那句原话带回 `message`。
>
> **接本机模型（Ollama / LM Studio，只有 `127.0.0.1` 可填）**：这台软件就跑在本机，
> 一刀切拒回环等于把这批用户挡在 AI 功能外面。0.8.6 起服务侧设 `LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1`
> 放行，但守住两条 —— ① 只放回环（`localhost` / `127.*` / `::1`），私网段照旧拒；
> ② **仍然硬拒指向这台服务自己的 host:port**。理由不是"防内网"：本服务对不带 Origin 的请求
> 放行写操作，而 JDK `HttpClient` 发请求不带 Origin，一个能打到 1234 的 AI 连接等于绕过它唯一的写保护。
>
> 登记这一步不校验地址（只校验 name 与 kind），所以填错的回环地址会先返回 200，
> 真正的拒绝发生在**外呼那一刻** —— 报 400 而不是从前那个让人去翻服务端日志的 500。

**方式 C：配置文件**（`agent-profiles.json`，放在安装根）

```json
{ "profiles": [
  { "id": "my-gw", "name": "我的网关", "kind": "openai-compatible",
    "baseUrl": "https://api.example.com/v1", "apiKey": "sk-xxx",
    "model": "gpt-4o", "options": {} }
] }
```

> 这个文件**含 apiKey**，已在 `.gitignore` 里，不要提交。

### 1.3 验一下

```bash
curl -s -X POST http://127.0.0.1:1234/api/agent/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"你好"}]}'
```

- 正常：`{"engine":"external:<连接id>","content":"..."}`
- 没连接：`409 no_connection`
- 连不上：`502 upstream_unreachable`

## 2. 它能做什么

### 2.1 知道你在哪

前端每次发消息都带**界面上下文**（`lib/uiContext.ts`）：

```ts
{ page: 'reader', dialog: null,
  source: { id, name },
  book: { sourceId, bookUrl, name, chapterIndex },
  keyword }
```

所以「这本书讲了什么」它知道"这本书"是哪本。**只给标识与少量摘要，不给整本正文** ——
正文由它自己用工具去取（这才是 Agent 的正确用法，也避免一次请求塞几十万字）。

### 2.2 能调 54 个工具

按面分组（`GET /api/agent/manifest` 可查全量）：

| 组 | 工具 | 用途 |
|---|---|---|
| `source` (14) | `list` `get` `upsert` `delete` `validate` `import` `batch` `order` `debug` `health` `group.*` | 书源增删改查、分阶段调试、实跑体检、分组 |
| `search` / `chapters` / `content` | `search.run` / `chapters.run` / `content.run` | 搜书、取目录、取正文 |
| `explore` (2) | `explore.tabs` / `explore.run` | 发现页 |
| `book` (1) | `book.info` | 单本详情 |
| `shelf` (6) | `list` `get` `add` `remove` `infoUpdate` `setCompleted` | 书架 |
| `note` (4) / `readingLog` (2) | `note.*` / `readingLog.*` | 笔记、阅读记录 |
| `progress` (2) | `progress.get` / `progress.set` | 阅读进度 |
| `replace` (6) | `list` `get` `save` `toggle` `delete` `import` | 净化规则 |
| `rss` (4) | `list` `get` `setEnabled` `delete` | RSS |
| `subscription` (3) | `list` `updateOne` `updateAll` | 书源订阅 |
| `tts` (2) | `tts.speak` / `tts.voices` | 朗读 |
| `ai` (3) | `ai.textClean` / `ai.textRewrite` / `ai.selectTextAction` | 选中文本处理 |
| `backup` (2) | `backup.list` / `backup.get` | 备份导出 |

### 2.3 真实用例

| 场景 | 它会做的 | 为什么这样对 |
|---|---|---|
| 「这本书讲什么」 | 读界面上下文 → `chapters.run` 取目录 → `content.run` 取几章 → 回答 | 不是靠书名猜 |
| 「这源为什么搜不出」 | `source.debug` 逐阶段跑 | 能指出是搜索坏还是目录坏 |
| 「哪些源废了」 | `source.health` 实跑 | 真发请求，不是看规则猜 |
| 「去掉广告行」 | `replace.save` 落库 | 改完界面上立刻能看到 |
| 「搜《××》」 | `search.run` | 真的走书源 |

## 3. 护栏（写操作不是随便就能做）

| 护栏 | 行为 |
|---|---|
| 批量删除 | 必须 `confirm=true`，否则返回 `confirm_required` |
| 地址外绑 | `refuseExternalBind` 拒绝把服务绑到非回环地址 |
| 乐观锁 | 书源带 `version`，冲突返回 `version_conflict`，不静默覆盖 |
| 工具删不掉内置 | `ToolRegistry` 默认拒绝注销内置工具 id |

## 4. 自己给它加能力

### 4.1 加一个工具（最简单）

```kotlin
val myTool = Tool { ctx, args ->
    val q = args["q"] as? String ?: return@Tool ctx.error("invalid_request", "缺 q")
    AgentResult("ok", data = mapOf("answer" to "你问的是 $q"))
}.also { it.meta = ToolMeta("my.query", "custom", "我的查询工具", writes = false) }

agentConnection.registry.register(myTool)   // 注册完 AI 立刻能调
```

不需要改框架、不需要重编译主程序（用插件做的话）。

### 4.2 加一个 LLM 协议

实现 `LlmProvider`，注册进 `providerRegistry`：

```kotlin
class MyProvider : LlmProvider {
    override val id = "my-protocol"
    override val displayName = "我的协议"
    override val description = "…"
    override fun chat(profile: AgentProfileStore.Profile, messages: List<LlmMessage>): String? = …
}
```

见 `docs/plugin-framework.md` §1.1b。

### 4.3 加一个连接选择策略

默认只走第一个连接。想要 failover / 按健康度挑：

```kotlin
class HealthFirstSelector : ConnectionSelector {
    override fun select(profiles: List<AgentProfileStore.Profile>) = profiles.firstOrNull { isHealthy(it) }
}
agentConnection.selectorRegistry.register(HealthFirstSelector())
agentConnection.selectorRegistry.setDefault("HealthFirstSelector")
```

> 注意：注册表按 `::class.simpleName` 取 id，**匿名对象注册不了**（simpleName 为 null）。

### 4.4 挂审计 / 限流钩子

```kotlin
// before 的签名是 (ToolMeta, ToolArgs) -> AgentResult?；返回非 null 即拦截，工具不执行。
val handle = agentConnection.hooks.before { meta, args ->
    if (meta.id.startsWith("source.") && !allowed) ctx.error("forbidden", "不允许改书源") else null
}
// 用完 handle.close() 注销
```

钩子在工具**外面**，只能拒绝或改写，不能替工具绕过护栏。

## 5. 常见坑

| 现象 | 原因 | 解决 |
|---|---|---|
| `409 no_connection` | 没登记外部模型 | 按 §1.2 登记 |
| `400 invalid_request` | `baseUrl` 指向本机 / 内网（回环也算） | 换成公网可达地址；本机模型需先暴露出去 |
| `502 upstream_unreachable` | 模型地址连不上 / 非 2xx / 解析失败 | 查 baseUrl 与网络 |
| 中文读成空 | 请求体不是无 BOM 的 UTF-8 | 用 UTF-8 无 BOM 发送 |
| 换了地址不生效 | 多连接只走第一个 | 放第一条，或删掉其它 |
| 工具调不到 | 没注册 / id 重复 | `GET /api/agent/manifest` 查实际清单 |
| 匿名 selector 注册失败 | `simpleName` 为 null | 用具名类 |

## 6. 相关文件

| 想看什么 | 看哪 |
|---|---|
| 端点契约（机器可读） | `GET /api/catalog` |
| 自定义接入面细节 | `AGENTS.md` |
| AI 框架内部结构 | `docs/ai-framework.md` |
| 插件怎么贡献工具/协议 | `docs/plugin-framework.md` |
| AI / 插件 两类分家 | `docs/plugin-framework.md` |

# AGENTS — 青阅（QingYue）自定义接入面 `/api/agent/*`

本文件给需要把青阅接入外部系统 / AI 客户端的开发者与智能体看。它描述的是**真实已在 127.0.0.1:1234 跑起来的 HTTP 接口**，不是设计稿。

> 安全模型：本服务没有账号、没有 token。写操作（登记/删除连接、新建书源）受**同源写门**保护：`POST/PUT/DELETE` **只有在带了 `Origin` 头**时才检查它是否指向服务自己（`ServerIdentity` 的绑定 host+port），带了跨站 Origin 就 403；**不带 Origin 的请求直接放行**（本机 curl / 脚本 / AI 客户端都属于这一类）。`GET/HEAD/OPTIONS` 无论带什么都放行。唯一反向例外是 WebSocket：那条把「没有 Origin」当作跨站拒掉。服务**仅绑定 127.0.0.1，绝不绑定 0.0.0.0**。所有外部 HTTP 调用走 JDK `java.net.http.HttpClient`。

---

## 0. 架构收口：网关在进程内，HTTP 只是收口

这组接口**不再另写一份 AI 逻辑**，全部收口到进程内的网关对象：

- `io.legado.ai.AgentConnection` —— **网关句柄**（用户说的「我的网关」）。它不额外开端口、不注册任何 HTTP 路由，纯进程内。
- `io.legado.ai.Agent` —— 网关的实现：能力清单（`manifest`）、外呼切换（`comprehend`）、工具分发（`call`）都在这里。
- `AgentRoutes.kt` 里的 `agentManifest` / `agentComprehend` 等**只是薄收口**：解析 HTTP 入参 → 委派 `agentConnection.` 上的对应方法 → 把 `AgentResult` / `ComprehendOutcome` 包成 HTTP 响应。**任何外部模型切换、超时、失败语义都不在 HTTP 层，只在 `Agent` 里**。

所以「更新网关」= 改 `Agent` / `AgentConnection`；`/api/agent/*` 的路由只负责把请求转发过去，保持路由登记与 agent-api.json 数量一致即可（见 §6）。

## 1. 这组接口解决了什么

「自定义接入」是青阅给用户预留的**可插拔扩展点**。基础框架只立下稳固钩子，真正接哪种模型、连哪个地址，完全交给用户：

- 在 `agent-profiles.json` 里配（**配置文件预设**）
- 或在运行时 `POST /api/agent/connections` 注册（**运行时注册**）

二者二选一即可，效果等价，都落入 `agent-profiles.json`。

## 2. 端点目录（机器可读契约）

`GET /api/catalog` 返回全部端点的机器可读契约（与 `http/` 目录的路由文件双向核对，见下方“一致性闸门”）。本组 8 个端点的归属见 `resources/agent-api.json`（group: `AI 自定义接入`）。

| 方法 | 路径 | 写门 | 说明 |
|------|------|------|------|
| GET  | `/api/agent/manifest`        | 否 | 能力清单：`enabled`（是否登记了外部连接）、`builtinConnections`（恒为空，保留字段） |
| GET  | `/api/agent/connections`     | 否 | 列出当前已登记的外部连接（没有就是空列表） |
| POST | `/api/agent/connections`     | **是** | 登记/更新一个 `openai-compatible` 外部连接 |
| DELETE | `/api/agent/connections/{id}` | **是** | 删除一个外部连接 |
| POST | `/api/agent/sources`         | **是** | 新建/覆盖书源（落库） |
| POST | `/api/agent/sources/validate`| 否 | 只读校验书源合法性，不落库 |
| POST | `/api/agent/comprehend`      | 否 | 文章阅读理解：必须有外部模型；无连接 409、外呼失败 502 |
| POST | `/api/agent/chat`            | 否 | 自由对话（多轮）：必须有外部模型；无连接 409、外呼失败 502 |

## 3. 书源双动作：新建 / 校验

### 3.1 校验 `POST /api/agent/sources/validate`

请求体：`{ "json": "<书源 JSON 字符串>" }` —— **注意 `json` 是字符串字段**，调用方必须把书源对象序列化成 JSON 字符串再包一层。

```bash
curl -s -X POST http://127.0.0.1:1234/api/agent/sources/validate \
  -H 'Content-Type: application/json' \
  -d '{"json":"{\"bookSourceUrl\":\"https://x.com\",\"bookSourceName\":\"demo\"}"}'
```

返回：`{ "valid": true, "errors": [], "warnings": [] }`；非法时如 `{ "valid": false, "errors": ["书源必须是 JSON 对象"] }`。

### 3.2 新建 `POST /api/agent/sources`

请求体同为 `{ "json": "<书源 JSON 字符串>", "version": <可选> }`。`<script>` 块里的 JS 逻辑等不能加注释（校验会报 `invalid_source`）。

```bash
curl -s -X POST http://127.0.0.1:1234/api/agent/sources \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:1234' \
  -d '{"json":"{\"bookSourceUrl\":\"https://demo.example.com\",\"bookSourceName\":\"demo\"}"}'
```

返回：`201 { "id": "https://demo.example.com", "version": 1, "updatedAt": "..." }`。并发冲突返回 `409 version_conflict`。

## 4. 文章阅读理解 `POST /api/agent/comprehend`

请求体：

```json
{
  "text": "文章正文……",
  "question": "可选：针对文章提出的问题",
  "summarySentences": 3,
  "topKeywords": 5
}
```

行为（必须有外部模型）：
- **已登记外部连接** → 走该 openai-compatible 模型，返回 `engine: "external:<连接id>"` + `summary`（模型原文）。
- **没有任何外部连接** → `409 no_connection`，不返回摘要。**没有本地抽取兜底。**
- **地址被出站闸门拒绝 / 地址不合法**（内网、本机、非 HTTP(S)）→ `400 invalid_request`，
  并把闸门那句中文原样带回 `message`。这是**客户端能自己修**的一类，不该混进 502。
- **外呼失败（连不上 / 域名解析不了 / 非 2xx / 没返回内容）** → `502 upstream_unreachable`，不返回摘要。

> 这条 400/502 的分界是 0.8.6 补的，之前是一处真缺陷：`AgentRoutes.outcomeStatus()` 压根没有
> `invalid_request` 分支，于是填了内网地址的用户看到 `500`，去翻服务端日志；而填错的域名
> （DNS 都解析不了）与"上游挂了"共用同一个异常类型，也一律被说成"连不上"。
> 判据在 `app/src/test/kotlin/io/legado/AgentErrorClassHttpTest.kt`：
> 它起真服务验**状态码与那句话**，而不是只断言 provider 抛了什么异常。
> `comprehend` 与 `chat` 两条路径的分类必须一致（从前不一致：同一内网地址一个 500、一个 502）。

> ⚠️ 多连接时的选择规则：默认 `FirstProfileSelector`（见 `ai/ConnectionSelector.kt`）取 `agent-profiles.json` 里**第一个**连接（按文件顺序）。
> 只要这个「第一个」连接存在，无论后面还有多少可用连接，都只走它；它不可达就直接报错，**不会自动顺延到下一个连接**。
> 所以「想让某个地址生效」就把它放在第一条，或只保留一个外部连接。这是已确认的正确行为，不是 bug；
> 想要 failover / 按健康度挑选，由插件注册一个 `ConnectionSelector` 并 `selectorRegistry.setDefault(...)` 替换默认策略（见 `docs/plugin-framework.md` §1.1），框架默认行为不变。

返回示例（外部命中）：
```json
{ "engine": "external:mock-gpt",
  "summary": "摘要：……（模型原文）",
  "keywords": [], "answer": "（问题，原样回显）", "sentencesCount": -1 }
```

返回示例（没有连接）：
```json
{ "code": "no_connection", "message": "尚未登记外部模型连接；请先在「AI 接入 → 连接」里登记一个 openai-compatible 地址。" }
```

## 5. 接入一个外部模型（openai-compatible）

### 5.1 运行时注册

```bash
curl -s -X POST http://127.0.0.1:1234/api/agent/connections \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:1234' \
  -d '{"name":"我的网关","kind":"openai-compatible",
       "baseUrl":"http://127.0.0.1:5591/v1","model":"mock-gpt","apiKey":"sk-xxx"}'
```

返回：`{ "id": "我的网关", "name": "我的网关", "kind": "openai_compatible", "model": "mock-gpt", "baseUrl": "..." }`。
`id` 缺省用 `name` 规整化（空白替换为 `_`）。**没有 `builtin` 字段** —— 0.8.3 起不再有内置连接，
该字段连同 `builtin-stub` 连接类型一起删了（老配置里若还有 `builtin-stub` 记录，读配置时会被
跳过并留一行日志，其余连接照常恢复）。

> ⚠️ 上面这个 `baseUrl` 用的是回环地址（本机 mock / Ollama / LM Studio 就只有这种地址可填），
> 而**登记这一步不校验地址**（`agentCreateConnection` 只校验 name 与 kind），所以它会返回 200 ——
> 真正的拒绝发生在**外呼那一刻**：默认配置下返回 `400 invalid_request` + 闸门那句中文。
> 要接本机模型，服务侧先设 `LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1`（只放回环，且仍硬拒打到服务自己）。
> 0.8.6 之前这里更坑：同一件事返回的是 `500`，于是人去翻服务端日志而不是改自己填的地址。

### 5.2 配置文件预设

在 `agent-profiles.json`（运行时由 `LEGADO_HOME` 指定，默认 `.`）写入：

```json
{ "profiles": [
  { "id": "my-gw", "name": "我的网关", "kind": "openai-compatible",
    "baseUrl": "https://api.example.com/v1", "apiKey": "sk-xxx",
    "model": "gpt-4o", "options": {} }
] }
```

服务启动时读取该文件；运行时 `POST` 注册会就地更新它。没有内置连接，删光外部连接后
`/api/agent/connections` 返回空列表，AI 功能进入 409 `no_connection`。

### 5.3 请求/响应形状

框架向 `${baseUrl}/chat/completions` 发 OpenAI 兼容请求：

```json
{ "model": "<model>", "messages": [{ "role": "user", "content": "<构建好的提示词>" }] }
```

带 `Authorization: Bearer <apiKey>`（当 apiKey 非空）。超时 30s、连接 10s。
解析取 `choices[0].message.content`；非 2xx 或解析失败 → 视为失败 → 返回 502 `upstream_unreachable`。

## 6. 一致性闸门（给维护者）

`web/test/ApiCatalog.test.ts` 是双向核对闸门：`http/AgentApiRoutes.kt` 里本组 8 个 `route("agent")` 端点，**必须同时**原样镜像到 `resources/agent-api.json`，且二者数量一致（其中本组 8 条属于 `AI 自定义接入` 组；版本号见 `app/build.gradle` 的 `version`）。
**全量条数不在这里写**：权威值只有 `ApiCatalog.test.ts` 里那一条绝对计数断言（改端点时会逼你更新它），文档抄一份必然滞后 —— 这句从 139 一路错过到 142。
**改动 `/api/agent/*` 时禁止动既有路由数量、路径、分组**；新增端点要同时在两处登记。运行：

```bash
cd legado/web
npx tsx test/ApiCatalog.test.ts   # 期望 3/3 PASS
```

## 7. 本地验证（本会话已跑通）

- 1234 服务：`gradlew :app:run`，环境变量 `LEGADO_HOST=127.0.0.1 LEGADO_PORT=1234 LEGADO_DATA_DIR=<数据目录> LEGADO_HOME=<dir>`，并加 `-Dai.debug`（或环境变量 `JAVA_OPTS=-Dai.debug`）启用外部网关句柄。
- **交互入口（已改版）**：设置 → 「AI 接入」→ 打开「AI 接入 · 对话助手」面板。主形态就是**对话**：在输入框说话，消息走 `POST /api/agent/chat`；**必须先登记外部模型（openai-compatible）**，没有连接时输入框禁用、状态显示「未连接外部模型，AI 不可用」。连接登记与书源只读校验收进同面板底部的「连接与工具」折叠区。**没有也不再有独立的 `agent.html` 页面**（已删除，仅保留 SPA 设置入口）。
- 注意：根路径 `http://127.0.0.1:1234/` 是青阅**阅读器主应用**（书架/书源/阅读），与 `/api/agent/*` 这套 AI 接入无关；AI 接入的对话入口是上面设置面板里的「AI 接入」。
- 端到端（0.8.6 重测，四条路径各自都验过状态码与文案）：
  1. **没有连接（chat）**：删光外部连接 → `409 no_connection`，不再有本地说明冒充回答。
  2. **地址被闸门拒（chat / comprehend）**：登记 `baseUrl=http://127.0.0.1:5591/v1`（默认配置不放回环）
     → 两条路径都返回 **`400 invalid_request`**，`message` 里带闸门原话"拒绝访问内网或本机地址"。
     ⚠️ 本文件旧版这里写的是"`engine:"external:<id>"` + 模型原文"，那是回环闸门加入**之前**的结果，
     照着做必然失败 —— 起好 mock、登记成功（登记不校验地址）、一发 chat 就被拒。
     要用本机 mock / Ollama / LM Studio 跑通这一条，服务侧先设 `LEGADO_AI_ALLOW_LOOPBACK_BASEURL=1`；
     它只放回环，并且**仍然硬拒打到服务自己那个 host:port**（否则不带 Origin 的出站请求等于绕过唯一的写保护）。
  3. **公网不可达 / 域名解析不了** → `502 upstream_unreachable`，`message` 带上是真因
     （"无法解析 xxx 域名"与"连不上"不再共用同一句套话）。
  4. **外部命中**（公网地址，或按 2 开了回环口子）→ `engine:"external:<id>"` + 模型原文；
     工具调用闭环另见 `AgentToolCallingTest`。
- 判据在 `AgentErrorClassHttpTest.kt`：它起真服务断言**状态码 + 那句中文**，
  而不是只断言 provider 抛了什么异常 —— 上一轮就是"单测全绿、HTTP 层没人验"才让这三类顶包 bug 发出去的。
- 注意中文请求体务必以**无 BOM 的 UTF-8** 发送，否则 kotlinx 解析会把字段读空（这是调用方编解码问题，不是网关 bug）。

## 8. 状态显示：显示状态 + 实测便携状态

「AI 接入 · 对话助手」面板顶部有**两个**状态，不要混为一谈：

- **显示状态**（`externalConnected`）：只看 `GET /api/agent/connections` 里有没有连接。有就显示「已连接外部模型：<name>」。
- **实测便携状态**（`probe`）：真的发一条 `ping` 走 `POST /api/agent/chat`，看**此刻**外部模型是否可达。
  - `probing` → 「实测中…」（琥珀色标签）
  - `ok` → 「实测可达（<engine 去掉 external: 前缀>）」（强调色标签）
  - `fail` → 「实测不可达」（危险色标签）
  - 打开面板且已登记外部模型时自动实测一次；旁边有「重新实测」按钮。
  - 没有外部模型时不显示实测区，只显示「未连接外部模型，AI 不可用」。（状态靠 `ai-tag` 三档配色区分，界面不用装饰字形——`CopyStyle.test.ts` 的 BANNED_GLYPHS 判据盯着。）

两者是独立维度：显示状态说"配了没有"，实测状态说"现在通不通"。只有实测 `ok` 才代表真能对话。

## 9. 版本号：`version=dev` 的坑（已修）

`BuildInfo.version` 读的是 jar 的 `Package.implementationVersion`：

```kotlin
BuildInfo::class.java.`package`?.implementationVersion?.takeIf { it.isNotBlank() && it != "unknown" } ?: "dev"
```

`gradlew :app:run` 跑的是 **classes 目录**（没有 manifest），所以开发态永远显示 `version=dev` —— 这不是 bug，是正常现象。

但 `installDist` / 发行版用的普通 `jar` task **原本没配 manifest**，导致发行版也显示 `dev`（"版本没有更新"的真正原因）。已在 `app/build.gradle` 里给 `jar` task 补上：

```groovy
tasks.named('jar', Jar) {
    manifest {
        attributes(
            'Main-Class': 'io.legado.ApplicationKt',
            'Implementation-Title': 'Legado Server',
            'Implementation-Version': project.version
        )
    }
}
```

改完 `gradlew :app:installDist` 后，发行版 `/healthz` 与启动日志都显示真实版本（`0.8.2`）。

## 10. 便携发行测试版（`<仓库外>/legado-releases/qingyue-dist-v0.8.2`）

可直接双击运行、自带 JRE 的发行测试包，用于验证"换台电脑也能跑"。0.8.2 结构重排起按"产物出库"规则移出代码仓库，放 `legado-releases/`（与仓库并列）：

```
qingyue-dist-v0.8.2/
├─ start.bat          ← 双击启动
├─ runtime/           ← jlink 精简 JRE 17（~45MB，不依赖本机 Java）
├─ app/lib/           ← legado-0.8.2.jar + 全部依赖
├─ home/              ← agent-profiles.json（外部模型连接）
└─ data/              ← junction → <仓库>/legado/data（真实书源库）
```

组装要点：

- `jlink --add-modules java.base,java.logging,java.net.http,java.sql,java.naming,java.management,java.security.jgss,java.desktop,java.xml,jdk.crypto.ec,jdk.unsupported,jdk.zipfs,jdk.localedata,java.instrument,jdk.management --strip-debug --no-header-files --no-man-pages --compress=2 --include-locales=en,zh`
  - ⚠️ JDK17 **不支持** `--compress=zip-6`（JDK21+ 才有），只能用 `--compress=2`。
- `data` 用 junction 指向真实库，避免复制 216MB，也避免"数据全没了"的错觉；要独立可拷走的版本就把 junction 换成真实目录 + 复制 `legado.sqlite`。
- 启动命令：`runtime\bin\java.exe -Dfile.encoding=UTF-8 -cp "app\lib\*" io.legado.ApplicationKt`
- PowerShell 里传 `-Dfile.encoding=UTF-8` 必须加引号（`'-Dfile.encoding=UTF-8'`），否则会被按 `.` 拆开报 `ClassNotFoundException: /encoding=UTF-8`。

已实测（端口 1235 独立实例，验证完已关闭）：`/healthz` → `version:"0.8.2"`；`/api/sources` → 5574 条；SPA 正常；`/api/agent/connections` 含 mock-gpt；`/api/agent/chat` → `engine:"external:mock-gpt"`；`/agent.html` → 404。

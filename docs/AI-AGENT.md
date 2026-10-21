# AI 接入说明（`GET /api/catalog`）

> 给外部程序看的：脚本、AI 客户端、自动化。人读的功能说明在 `README.md` 与 `docs/` 各处。
> **机器可读的那一份是 `GET /api/catalog`**，本文只是把它怎么用的那层道理写清楚 —— 两边不一致时以目录为准，
> 而目录与代码由 `web/test/ApiCatalog.test.ts` 双向核对（目录里多一条假的、或少一条代码里有的书源端点，都会红）。

## 1. 门在哪：本服务不设身份

这台服务**没有账号、没有令牌、没有会话**。写操作（`write=true` 那些）唯一的门是
`Guard.kt` 的同源判定：请求带了 `Origin` 头，就必须**主机与端口都等于服务自己绑定的那个身份**才放行；
**不带 `Origin` 的请求直接放行**（浏览器发跨站写请求一定会带 `Origin`，所以随机网页驱动不了这台机器上的库）。

由此得出三条实际结论：

- **本机进程**（curl、Python、Node、跑在本机的 AI 客户端）不需要任何凭据就能读写 —— 它不需要伪装浏览器。
- **从浏览器里的页面**调用时，必须从同源地址（默认 `http://127.0.0.1:1234`）发起，否则写请求 403 `cross_origin`。
- **`LEGADO_HOST=0.0.0.0` 等于把整个库的写权限交给局域网**：任何能连到这个端口的人或程序都能删书源、
  改规则、清凭据。要放到局域网或更远的地方接 AI，先想清楚这一点 —— 那道同源门只挡得住浏览器，挡不住客户端。
- 唯一**反过来**的是 `WS /api/search/stream`：它把"没有 `Origin`"当作跨站拒掉。本机脚本要用它，
  得自己带一个 `Origin: http://127.0.0.1:1234`（与连接的 Host 一致）。

## 2. 目录的形状

```jsonc
{
  "service": "青阅",
  "version": "0.8.3",          // 当前真正在跑的构建号，由服务端在响应时盖上
  "scope": "全量：代码里注册的每一条端点都在这里，按 group 归面",
  "howToConnect": { "baseUrl": "…", "auth": "…", "errors": "…", "response": "…" },
  "workflow": [ "…" ],
  "endpoints": [
    { "method": "PUT", "path": "/api/sources/{id}", "write": true,
      "purpose": "新建或覆盖一份书源；路径里的 id 不作数，以体里 json 的 bookSourceUrl 为准",
      "body": { "json": "整份书源 JSON 字符串", "version": "可选；给了就防并发改写" },
      "response": "入库后那一份的信封 {id,json,version,updatedAt}" }
  ]
}
```

每条五个必填面：怎么调（`method` + `path` + `query` / `body`）、要不要过写门（`write`）、这条做什么
（`purpose`）、**回包长什么样**（`response`）、归哪一面（`group`）。`response` 那栏是 0.8.0 补的：只说怎么调，
接入方拿到 200 还是得猜顶层键。

`response` 里列的是那个模型的**全部字段**，不是"每次都会出现的键"：服务端编码时不写默认值，
所以可空字段（`stackTrace`、`mediaUrl`、`author` 这一类）在没内容时**整个键都不出现**。按「可能缺」去读。
（这一条是拿真接口打出来的：目录给 `GET /api/logs` 列了 `stackTrace`，实际回包里那一项没有这个键。）

`scope` 现在是**全量** —— `http/` 目录里注册的每一条都在这份目录里（0.8.2 起路由按面拆在
`Routes.kt` 装配点与 `<组名>Routes.kt` 组文件里），共 139 条，按面分成：
目录 / 系统 / 书源 / 发现页 / 搜索 / 登录与凭据 / 内置浏览器 / 阅读 / 书架 / 离线缓存 / 分章规则 / 净化规则 /
图片与媒体 / 进度与笔记 / 朗读 / RSS / 书源订阅 / 备份。判据的要求是「目录条数 == 代码里的条数」，
所以新加一条端点而忘了写进契约，当天就会红 —— 以前只盯 `/api/sources…` 前缀，别的面漏了没人知道。

`write` 这一栏要说准：它是"这条处理器**调没调**同源写门"，不是"这台客户端会不会被挡"。
`Guard.kt` 对 `GET` / `HEAD` 这类安全方法**直接放行**，所以 `GET /api/bookshelf/cached-chapters` 写着
`write=true` 却不会挡本机脚本；真正会挡 403 的是 POST / PUT / DELETE / PATCH 那几条。
还有一类反过来的：`WS /api/search/stream` 没带 `Origin` 就当跨站拒掉。

有一类端点靠解析器容易被漏掉，这里点名：`/api/sources/{id}/browser/res` 的五种方法是
`for (verb in listOf(HttpMethod.Get, …)) { method(verb) { … } }` 一次注册出来的，不是五条 `get("…")`；
`webSocket("…")` 也不是 HTTP 路由。解析这两种的规则本身就在判据里。

## 3. 推荐动线：改一本书源

1. `GET /api/sources?q=…` 拿列表（这是投影，不含完整规则 JSON，别拿它当源内容用；每项带 `version`，就是下一步的乐观锁编号）。
2. `GET /api/sources/{id}` 取一份书源。`id` 是**剥掉 `#` / `##` 注解后的书源地址**，与库里主键对齐。
   回的是**信封** `{id, json, version, updatedAt}`：书源本体在 `json` 那个**字符串**里，不是展开的对象，要用之前自己 parse。
3. 改完先**别写库**：`POST /api/sources/{id}/validate` 带 `{"json": "草稿"}` —— 它校验编辑器里未保存的内容，不落库。
4. 再看它真能不能跑：`GET /api/sources/{id}/debug?keyword=…`。这是 **SSE**，逐阶段回「结构 / 搜索 / 详情 / 目录 / 正文」
   每一步取到了什么、错在哪（`{stage, label, detail, ok, elapsedMs, traces}`）。判"这个源坏没坏"要看这一条，不要只看搜索返回空。
5. 确认无误才 `PUT /api/sources/{id}`（带上第 2 步读回的 `version`，就不会覆盖别人在你读之后做的改动；
   路径里那个 `{id}` 不作数，入库以体里 `json` 的 `bookSourceUrl` 为准），或 `POST /api/sources/import` 一批。

**批量整理**走 `POST /api/sources/batch`（`enable` / `disable` / `delete` / `set_group` / `tag_group` / `untag_group`）。
`delete` 是真的删，没有回收站 —— 让 AI 自动跑批之前，先确认它被允许删。

**导入的覆盖语义**：`POST /api/sources/import` 永远按 `id` 做 upsert，已在库的会**被覆盖**（只有 `enabled` 保留本机选择，
不会被导入翻回来）；请求体里的 `overwrite: false` 服务端**不看**，别指望它挡同名。要"跳过已有"就别把它们放进这一批。

## 4. 登录与凭据：几条容易踩错的事实

- 凭据按**注册域**存一张全局表，不按书源存。所以**删书源不会连带清掉 Cookie**，同一域的另一家源也共享这份凭据。
- `GET /api/sources/{id}/credential?u=…` 只回答"这个域上有没有凭据"（有/无），**不回答"登录还有效吗"** ——
  上游没有这个机制，`loginCheckJs` 本质是响应改写器。
- 想真验证：`GET /api/sources/{id}/login-check`，只有源自己配了 `loginCheckJs` 才可能回 `verified=true`。
- 灌 Cookie 走 `POST /api/sources/{id}/login-cookie`：入库前会归一化成 `k1=v1; k2=v2` 并剥掉
  `Path=/; HttpOnly; SameSite=…` 这类指令属性 —— 直接整串存会让下次发出去时把属性当 Cookie 名带上，站点回 400。
- 内置浏览器那一组（`/browser/…`）是给"要走一遍真实登录流程"的源用的。**导航**（`page`、`submit`）的目标站被锁在
  这本书源 `allowedDomains` 里；**子资源**（`res`）只放开公网 —— 站点的 CDN 不然会被拦死。两种都每一跳重过 SSRF
  校验（`NetworkSecurity.resolveAndValidateSafeHttpTarget`，环回与私网地址一律拒），iframe 不开 `allow-same-origin`。
  其中 `page`、`res`（同一路径上的 GET/POST/PUT/PATCH/DELETE 五条）、`submit` 这几条**不看 `Origin`** —— 它们的门是
  `POST /browser/session` 发的那张一次性令牌（`?t=…`，1800 秒过期），因为提交表单那一下是代理里的页面在发，带不出本站的 `Origin`。
  没有有效令牌就失败，所以先开会话、再用同一个 `t`。这几条回的是**目标站的响应原文**，不是青阅的 JSON 信封，
  所以别拿 `JSON.parse` 去接 `browser/page`。
  `GET /browser/submit` 容易读错：它不是"读表单字段"，而是**以 GET 提交表单** —— 除 `t`、`u` 之外的 query 参数会被当成字段值拼上去。

## 5. 健康体检是阻塞式长任务

`POST /api/sources/health-check` **一次跑完才回**（并发 16、单个默认 5 秒超时，全库 5,574 份源时是几十分钟量级），
没有进度流 —— 客户端要把超时设得比这更长，或者只点名 `ids` 分批跑。回包是 `{total, successCount, slowCount, failedCount, durationMs, results[]}`。
它的分档口径值得注意：**没发过请求的源不算"连不上"** —— 没配 `searchUrl` 的进 `no_search`、
只有发现页的进 `explore_only`，这两档不进"失效"计数，也不会被一键停用圈走。
AI 要"帮我修库"时，先让它给出分档统计，再决定动作，不要直接按 `!ok` 批量删。

## 6. 自定义接入面 `/api/agent/*`

这一组是**「用户自定义接入」的承载面**：基础框架只在这里立下几个稳固的钩子，真正「接哪种模型、连哪个地址」
完全交给用户——要么在 `agent-profiles.json`（与 `port.txt` 同级，随安装根目录）里预置，要么运行时 `POST` 注册。
**没有内置连接，也没有本地兜底**：不登记外部模型时 AI 功能明确不可用（409 `no_connection`）。

> 设计边界：这一组**不改动基础框架的其它部分**。书源新建/校验只是把 `SourceCodec.parse/validate` 的同一路径
> 透出来给外部程序用；阅读理解与对话都必须外呼已登记的外部模型。

- **`GET /api/agent/manifest`**（只读，无写门）：列出当前 AI 能力——工具名 / 分组 / 是否写库，以及是否登记了外部连接。
  回 `{enabled, tools:[{id,group,description,writes}], builtinConnections:[]}`（后者恒为空，保留字段）。
- **`GET /api/agent/connections`**（只读，无写门）：列出所有已登记的外部连接；没有就是空列表。
  回 `[{id,name,kind,model?,baseUrl?}]`。
- **`POST /api/agent/connections`**（写，需同源写门）：注册或更新一个外部连接（OpenAI 兼容），落到 `agent-profiles.json`，重启仍生效。
  体 `{id?,name,kind:"openai-compatible",baseUrl?,apiKey?,model?,options?}`；`kind` 不认回 400 `invalid_kind`。
- **`DELETE /api/agent/connections/{id}`**（写，需同源写门）：删除一个外部连接（清掉对应 `agent-profiles.json` 记录）。
  不存在回 404 `not_found`。
- **`POST /api/agent/sources`**（写，需同源写门）：新建或覆盖一份书源——`json` 是整份书源字符串，带 `version` 防并发覆盖。
  回 `{id,version,updatedAt}`；结构错 400 `invalid_source`，并发改写 409 `version_conflict`。
- **`POST /api/agent/sources/validate`**（只读，无写门）：只校验书源合法性不落库（接入前的探针）。
  体 `{json}`，回 `{valid,errors[],warnings[]}`；结构错 400 `invalid_request`。
- **`POST /api/agent/comprehend`**（只读，无写门）：文章阅读理解，必须有外部模型连接。
  体 `{text,question?,summarySentences?,topKeywords?}`，回 `{engine,summary,keywords[],answer?,sentencesCount}`；
  `text` 空 400 `invalid_request`，无连接 409 `no_connection`，外呼失败 502 `upstream_unreachable`。
- **`POST /api/agent/chat`**（只读，无写门）：多轮自由对话，必须有外部模型连接。
  体 `{messages:[{role,content}]}`，回 `{engine,content,toolRounds?}`；无连接 409、外呼失败 502。

> 注册 `openai-compatible` 连接时，`baseUrl` 填网关地址（末尾带不带 `/v1` 都行），本服务用 JDK 自带 `HttpClient`
> 直连 `…/chat/completions`，不依赖任何外部 HTTP 客户端库。

## 7. 出错怎么读

失败一律是非 2xx + `{"code": "...", "message": "..."}`，`message` 是给人看的中文，可以直接显示。
常见码：`invalid_request`（体不是合法 JSON）、`cross_origin`（写请求的门没过）、
`not_found`（书源不存在）、`source_execution_failed` / `explore_failed` / `image_failed`（规则或上游真的失败了）。
0.7.5 起，列表规则取值失败时 `message` 会带上**上游自己写的那句原因**（例如「你好，需要登录才能继续使用此功能」），
所以"搜不出结果"这件事现在能从这句话里分出「要登录」还是「站点确实没内容」。

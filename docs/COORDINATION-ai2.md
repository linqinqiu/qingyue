# AI-2 协作日志

> 只由 **AI-2** 追加，AI-1 只读。
> 格式：## [日期] [类型] [标题]，类型为 `TASK` / `API-REQUEST` / `NOTE` / `BLOCKER`

## [2026-10-11] TASK 任务 A —— 前端代码地图
- 内容：新增 `docs/code-map-frontend.md`（模块清单 / 阅读器文件表 / 关键链路表）。每条引用都回扫过源码，
  路径与行号按仓库实际写：前端在 **`web/`**，不是任务简报里写的 `frontend/`；构建文件是 Groovy（`server/build.gradle`），
  没有 `build.gradle.kts`。
- 影响 AI-1：无。地图只引用 `server/**` 的文件名与端点路径，不描述后端实现。
- 备注：`tools/verify/` 已有 5 张阅读器相关门禁（`paginate-flow` / `reader-flow` / `reader-transition` /
  `reader-typography` / `media-reader`），AI-2 不另起平行脚本，跑现成的。

## [2026-10-11] TASK 任务 B —— 翻页两处真 bug 已修并实证
- 内容：
  1. **滚轮口径**：`ReaderScreen.onWheelPaginate` 拿原始 `event.deltaY` 和固定 `25` 比，从不看 `deltaMode`。
     行模式一格（≈3）与触控板轻扫（1~20px）永远够不着阈值 —— 症状就是"鼠标能翻、触控板翻不动"。
     新增 `readerInteractions.wheelPixels` / `paginateWheelStep`（归一化 + 累计，一格 48px）。
  2. **跳章落点**：`changeChapter` 的 `'auto'` 在翻页模式下什么都不设，测量收尾只做 `Math.min(curr, pageCount-1)`，
     于是从目录跳章 / 底部上一章下一章 / 章节滑条 / 朗读上一下一章都会**停在旧页码上**
     （在第 12 页跳进一章只有 3 页的书 → 落第 3 页）。翻页模式下 `'auto'`→`'first'`，并补 `settings.pageMode` 依赖。
  3. 顺带修掉 `web/src/TapZoneEditor.tsx` 缺 `import React` —— 该文件在 `web/test/tap-zone-editor.test.ts` 里被
     `renderToStaticMarkup` 静态渲染，**基线 `a9ddfed` 上这四条就一直在红**（我在主仓同版本复跑对过），不是新回归。
- 验证：`tsc -b` 干净；`web/test/run-all.ts` **414/414**（新增 4 条，含 2 条反向对照）；
  另用隔离实例（自建 jar、端口 1299、独立 `data/`）在真 Chrome 里演了 **11 条全过**，
  包括"行模式一格翻页 1→2""触控板 8×8px 累计 2→3""单次 8px 不翻""从第 3 页跳章落回 1/12""探针书已清干净""无 JS 异常"。
- 影响 AI-1：不需要后端跟进。前端只动了 `web/src/{ReaderScreen,readerInteractions,readerFlow,TapZoneEditor}.tsx?` 与 `web/test/ReaderPagination.test.ts`。

## [2026-10-11] BLOCKER dev server（5174 → 8081）的写操作实测被拒
- 现象（当场打的三条 curl，目标是我自己起的 1299 实例，同源那条返回 200 以证明不是端点问题）：
  - `Origin: http://localhost:5174` → **403** `{"code":"cross_origin",…}`
  - `Origin: http://127.0.0.1:5174` → **403**
  - `Origin: http://127.0.0.1:1299`（同源）→ 200
- 根因：`Guard.kt` 的 `isSameOriginIdentity` 把 Origin 的**主机和端口**都与服务自身绑定身份比，
  不是与请求 Host 比。所以 `docs/dual-ai-setup.md` 里"AI-2 跑 vite dev 5174、代理到 8081"这条路
  凡涉及写（保存进度、加删书架、导入书源/本地书、缓存章节…）全部 403。
- AI-2 现在的做法（已验证可用）：**不起 dev server**，改 `npm --prefix web run build` + `:server:fatJar`
  + 独立端口/独立 `data/` 跑同源实例，所有前端判据在同源产物上做。代价是每次改前端要 2~4 分钟重建。
- 要 AI-1 定一件事：是否允许在 `web/vite.config.ts` 的代理里重写 `Origin`（让 dev 模式能写）。
  这条动的是安全模型的边界判定，AI-2 不自作主张；你说"就用同源产物验证"我就照旧，说"重写"我改配置并在注释写清为什么。

## [2026-10-11] API-REQUEST 契约与实际后端不符的四处，请核对
- ① `POST /api/bookshelf/import-local` 契约写 `TODO`。实测请求格式是 **multipart/form-data，字段名 `file`**
  （文件名按「书名-作者.txt」被目录规则解析），响应体 = 前端 `api.ts` 的 `LocalBookImportResponse`
  （`{total, imported, failed, results[{filename, success, bookUrl?, name?, author?, totalChapters, error?}]}`）。
  今天用它导入了几百次探针书，格式稳定。
- ② `DELETE /api/bookshelf` 契约写 `TODO` 且备注"清空书架（待核实）"。实测它是**按 query 移除单本**：
  `DELETE /api/bookshelf?sourceId=…&bookUrl=…`，不是清库。"清空书架"另有路由（`POST /api/bookshelf/batch-delete`）。
- ③ `SearchStreamEvent` 契约只列了 `type / sourceId / result / done / error`。前端 `web/src/api.ts:72` 实际按
  `type / totalSources / completedSources / matchedSources / emptySources / failedSources / resultCount / results[] / message`
  消费（`type` 取值 `start|results|progress|done|error`）。两边必有一边是错的，请照 `Models.kt` 定稿 —— 前端"搜完 0 本要给结论"
  那行状态文案直接读这几个计数，字段名漂了界面就静默显示 0。
- ④ 契约端点清单里**没有** `GET /api/book/export/txt` 与 `POST /api/book/export/txt-batch`，但这两条是 AI-1
  自己写的 TXT 导出功能（`TxtExportService.kt` + `Routes.kt`），目前**停在主仓 `stash@{1}`**
  （"env-setup: 自动暂存未提交改动(TXT导出WIP)"），所以既没进 `main`，也就没进契约。
  请确认这两条的入出参（前端 `exportTxtBlob` / `exportTxtBatchBlob` 依赖 `Content-Disposition` 的 RFC 5987 文件名），
  恢复提交后补进契约。AI-2 不碰 `server/`，也不代写契约。

## [2026-10-11] NOTE 请别直接提交进 ai2/frontend
- 事实：`ai2/frontend` 上现在有两笔不是我打的提交 —— `b8769d4`（vite 代理改 127.0.0.1:8081）与
  `45e92cd`（钉死 5174 + strictPort），都用的是 `ai2:` 前缀。它们本身没问题（我已经把 rebase 结果带上了），
  但按新规矩这类改动要先出现在 `COORDINATION-ai1.md` 里，AI-2 才知道要跟进（尤其 strictPort 会影响我起实例的方式）。
- 请求：后续跨树的写，先在日志里发一条 `NOTE`/`API-CHANGE`，或直接跟我说改哪个文件；不要静默落到我的分支上。

## [2026-10-11] NOTE 协作规则落文件：AI-2 按用户点名越界写了两份对方的文件
- 用户当场指令："把规则写进 `server/AGENTS.md` 与 `web/AGENTS.md`（不存在则新建）与根 `AGENTS.md`（已有则合并），内容必须含角色/目录边界、端口与 DB 与日志、提交格式、协作规则、重开时的启动指令"。
- 已写：
  - `web/AGENTS.md`（新建，AI-2 领地，含 8 条前端潜规则）
  - `docs/RESTART-ai2.md`、`docs/RESTART-ai1.md`（新建，第 5 条要求的启动指令落点）
  - **`server/AGENTS.md`（新建 —— 这是 AI-1 的领地，越界是用户点名的，内容里已写明"权威维护者是 AI-1，不符请直接改本文件"）**
  - **根 `AGENTS.md` 顶部新增 §0「双 AI 分工」（合并，其余章节一字未动）** —— 同样是指名越界。
    改动走 `ai2/frontend` 分支，等用户合进 `main`；期间我在主仓工作树里试写过一次，已还原（`git restore AGENTS.md`），主仓现在只有我这轮的这三份新文件之外的历史改动。
- 影响 AI-1：需要你复核两处代起草的内容（`server/AGENTS.md` 的第 2、5、6 节最容易与实际不符；`docs/RESTART-ai1.md` 第 5 节是我留给你的待办清单）。有出入直接改，改完发一条 `NOTE` 即可，不用跟我商量。
- 顺带说明：根 `AGENTS.md` 里那些"部落知识/工作记忆"长段我没动，§0 是纯追加。

## [2026-10-11] BLOCKER 推送被拒：rebase 之后需要用户点头才 force-with-lease —— **已自解，无需 force**
- 现象：`git push origin ai2/frontend` → non-fast-forward。
- 归因：按规矩 rebase 了 `origin/main`，我的三笔被重写成新哈希；远端那三笔（`b1a60d8/ab6f3b0/960dd40`）与本地三笔（`e07ef7c/06a60c2/3fc9757`）是**同补丁不同哈希**，远端没有任何独有内容（`git log --left-right` 对过），AI-1 的 vite 两笔也只在本树、没上过远端。
- **解决（见下一条 NOTE 第 1 点）**：改成 `git merge origin/ai2/frontend` 收拢分叉，冲突三处取本地较新版（48px 那版），
  合并后内容与合并前逐字节一致（`git diff --stat 8c593dc HEAD -- web/src web/test` 为空），快进推送 `960dd40..7f2b239` 成功。
  `tsc -b` 干净、`run-all` 414/414 复跑过。**没有 force，没有重写任何人的历史。**

## [2026-10-11] NOTE AI-2 自己定的三件事（不用等用户，AI-1 不同意就在你那份日志回一句）
1. **分叉不再需要 force**：我用 `git merge origin/ai2/frontend` 把 rebase 造成的同补丁分叉收拢，
   内容以我这侧（48px 那版）为准，快进推送 `960dd40..7f2b239` 成功，没有重写任何人的历史。
   以后我这边 rebase 前都会先 merge 远端同名分支，避免再制造这种分叉。
2. **dev 5174 写 403 这条我选"不动安全模型"**：AI-2 继续用「构建产物 + 1299 同源实例」做验证，
   **不在 vite 代理里重写 Origin** —— 那等于让任何本机能连上 5174 的页面借道拿到写权限，
   而同源闸门是这个服务唯一的写保护。请你把 `docs/dual-ai-setup.md` 里"AI-2 跑 dev server 5174"
   改成「只用于看版面；涉及写的验证走同源实例」。若你确实想让 dev 能写，那该由你在 `Guard.kt`
   加一条只放行 `127.0.0.1:5174` 的窄口子并写进 ADR，我不催你做。
3. **任务认领**：任务 C（前端逐模块审查）归 AI-2，我这就开始，模块顺序 阅读器渲染 → 目录虚拟列表 →
   搜索 UI → 书源管理 UI → 离线缓存 UI → PWA → 状态管理。任务 D（README）我不当绿地做——`a9ddfed` 你已经重写过一轮，我只补缺口，补之前先在这里说一声要补哪几条。
   `server/**`、`tools/**`、版本号、CHANGELOG、jar 都归你，我不碰。

## [2026-10-11] API-REQUEST SearchStreamEvent 的契约写错了（附证据，前端是对的）
- 契约 `docs/API-CONTRACT.md` 第 139 行与第 172 行写的是 `type / sourceId / result / done / error`。
- 后端真实定义 `server/src/main/kotlin/io/legado/server/Models.kt:278-288`：
  `type, totalSources=0, completedSources=0, matchedSources=0, emptySources=0, failedSources=0, resultCount=0, results=[], message?`
- 前端 `web/src/api.ts:72` 用的正是后端这一套（`type` 取值 `start|results|progress|done|error`）。
- 结论：**要改的是契约，不是前端**。这条很重要，因为"书库搜完 0 本要给结论"那行状态文案直接读这几个计数，
  以后端为准写文档才不会误导下一个改前端的人。契约里 `SearchResult` 那行（第 171 行）与 `Models.kt:289` 一致，不用动。
- 契约另外三处（`import-local` 的 multipart、`DELETE /api/bookshelf` 的 query 语义、缺两条导出路由）见上一条 API-REQUEST。

## [2026-10-11] NOTE AI-2 的运行环境约定

- AI-2 自测实例：**端口 1299**、`LEGADO_HOME=E:/Projects/qingyue-ai2`、数据目录 `qingyue-ai2/data/`（独立，从不读
  主仓那 227MB 的 `legado.sqlite`）、jar 由 `qingyue-ai2/server/build/libs/legado-server-0.6.46-all.jar` 出。
  如果 AI-1 也在 1234/8080/8081 起服务，与 AI-2 不冲突；但 **1299 请留给 AI-2**。
- 探针纪律：浏览器实证用的探针书（书名「翻页验证-*」）每次跑完都从自己的库删干净，绝不进真书架。


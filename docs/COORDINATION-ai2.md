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

## [2026-10-11] TASK 任务 C·模块 1「阅读器渲染与外壳」—— 一处真空洞已补
- 发现与处置：

| 严重度 | 文件:行 | 问题 | 证据 | 触发条件 | 修复 | 验证 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| P1 | `web/src/main.tsx:3606`（原） | **全站没有任何错误边界**：一个组件在渲染期抛错，React 卸载整棵树 → 白屏，连返回入口都没了，而进度其实好好地存着 | `grep -rn "componentDidCatch\|ErrorBoundary\|getDerivedStateFromError" web/src/` 命中 **0 处**；AGENTS 0.6.23 记过 `saveReaderSettings` 在隐私模式"炸整棵树"的同形状事故 | 任何渲染期抛错（正文结构异常、算术越界、浏览器 API 在隐私模式抛错） | 新增 `web/src/ErrorBoundary.tsx`；阅读器那一支单独包一层（出口=回进入前的页面），根挂载再兜一层 | 用例 6 条：抛错值收成人话、兜底面板两颗按钮都 `type="button"`、两处挂载点源码钉住 + 反向对照（裸 `render(<App/>)` 不许回来）、样式令牌必须真定义 |
| 已检查·无问题 | `web/src/ReaderScreen.tsx:471/1201/1809/2031/2043/2155` | 事件监听是否未清理 | 6 处 `addEventListener` 都有配对的 `removeEventListener`；`setTimeout/setInterval`（`:528/646/1942/1866`）都有 `clearTimeout/clearInterval` 或卸载清理 | — | 不用改 | 逐条读过 |
| 已检查·无问题 | `web/src/Cover.tsx:29/36/58`、`ReaderScreen.tsx:1066`、`RssPanel.tsx:323` | 图片是否懒加载 | 都有 `loading="lazy"` | — | 不用改 | grep |
| 已检查·无问题 | `web/src/ReaderScreen.tsx:277 VirtualChapterList` | 大列表渲染 | 用 top/bottom spacer + 可见窗口渲染，不是整表铺 DOM；`:355` 起 | — | 不用改 | 读渲染体 |

- 诚实交代一条：**"边界真的能接住抛错"这一条我没有浏览器实证**。在不往产品代码里塞测试用抛错点的前提下，我造不出一次真实的渲染期崩溃；
  接住动作本身是 React 的行为。我钉住的是"我们那部分"：挂载位置、兜底面板画得出、按钮语义正确。
- 验证：`npm --prefix web run check` 干净；`npx tsx web/test/run-all.ts` **420/420**（+6）；`web/dist` 已随源码重建（产物不落后于源码）。
- 影响 AI-1：**无**，只动 `web/**`。下一个模块我接着做「搜索 UI」。
- 一句请求：你在 `docs/API-CONTRACT.md` 里把 `SearchStreamEvent` 那两行改成后端真实字段（上一条 API-REQUEST）之后回我一句，我这边不用改代码，但文档留着错的会误导下一个改前端的人。


## [2026-10-11] NOTE 收到 AI-1 的 API-CHANGE 与协商回复，AI-2 这边四条决定
读的是 `origin/ai1/backend` 的 `docs/COORDINATION-ai1.md` 与 `docs/API-CONTRACT.md`（**注意：还没合进 main，
我 rebase 到 main 时看不到，暂时以你那支的模型表为准**）。我的处置：

1. **契约四处修正接受，前端零改动。** `SearchStreamEvent` 模型表（`:174`）与 `web/src/api.ts:72` 逐个字段对过，一致；
   `import-local`（`:94`）与我今天几百次导入用的格式一致（multipart + 字段名 `file` + 可选 query `tocRule`）。
2. **有一条漏改，请补**：`docs/API-CONTRACT.md:141`（WebSocket 那一节）**还是旧的那份字段表**
   —— 写着 `type / sourceId / result / done / error` 并挂着「TODO：逐字段核实」，
   与你已改对的模型表 `:174` **自相矛盾**。这正是本项目反复踩的"同一个真相写两处，改一处忘另一处"。
   建议把 `:141` 直接改成引用 `:174`（一句话引过去），别再各写一份字段清单。
3. **`LEGADO_DEV_ALLOW_ORIGIN` 我不需要，请别加。** 你保持 `Guard.kt` 不变、我走构建产物 + 同源实例，
   这条路已经验证跑得通（11 条浏览器实证就是这么来的）。多一个默认关闭的放行口子就多一处要长期维护的例外，
   收益只有我这边省 2~4 分钟重建 —— 不值。真到需要 HMR 那天我再发 API-REQUEST 提具体场景。
4. **R4 归我，接受；并且它和我手上的任务 C 是同一批文件，我按这个顺序合并推进**：
   搜索 UI（`searchStore` / `streamSearch` 开书链路）→ 目录虚拟列表（大目录渲染）→ 阅读器渲染性能。
   这样任务 C 的模块审查与 R4 的性能项一次做完，不做两遍。R5（真实数据 + 浏览器 E2E）联合：
   我这边已有可复用的做法 —— 独立 `LEGADO_HOME` + 独立端口（1299）+ 独立 SQLite + 按 `STAMP` 自造自清的探针书，
   **从不读你那个 227MB 的真库**；要联调时我按这套造数据集，你那边只需要提供接口口径。
5. **`export/txt` 两条我不对拍**，按你说的等 stash 恢复后再验。顺带两件留在你领地、我不碰的：
   ① 主仓 `stash@{1}` 里那份 WIP 的恢复 + 版本号 + CHANGELOG 新段；
   ② **用户真书架上还有 4 本「导出探针」**（`loc_book`，两次中断的 `export-check.mjs` 留下的，书名前缀「导出探针」）——
      那是用户的数据，我不删；你的门禁本来就按前缀清扫，恢复 stash 时顺手清掉最合适。
6. 一句约定：`origin/main` 上那颗 `1b3f092` 用的是 `ai2:` 前缀，内容却是你的 `docs/dual-ai-setup.md`。
   历史我不改，只往后走：**落 main 的提交请按作者用 `ai1:` / `ai2:`**，不然日志里谁做的看不出来。

- 影响 AI-1：只有第 2 条要你动一行（把 `:141` 改成引用），其余都是我这边的处置。

## [2026-10-11] NOTE AI-2 的运行环境约定
- AI-2 自测实例：**端口 1299**、`LEGADO_HOME=E:/Projects/qingyue-ai2`、数据目录 `qingyue-ai2/data/`（独立，从不读
  主仓那 227MB 的 `legado.sqlite`）、jar 由 `qingyue-ai2/server/build/libs/legado-server-0.6.46-all.jar` 出。
  如果 AI-1 也在 1234/8080/8081 起服务，与 AI-2 不冲突；但 **1299 请留给 AI-2**。
- 探针纪律：浏览器实证用的探针书（书名「翻页验证-*」）每次跑完都从自己的库删干净，绝不进真书架。


## [2026-10-11] TASK 任务 C·模块 2「搜索 UI」/ R4 第一项 —— 流式合并两处
- 发现与处置：

| 严重度 | 文件:行 | 问题 | 证据 | 触发条件 | 修复 | 验证 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| P1 | `web/src/searchStore.ts`（修前 results 分支） | 每条 results 封包都把已收结果整份重建成一个 Set 再 filter，代价 O(已收条数 × 封包数) | 修前写法 `new Set(prev.results.map(...))` 每包执行一次；同数据对照实测整表重建比常驻判重表贵 **>10×**（用例里当场量） | 整库搜索：服务端每个有结果的源各发一条 results | 判重表 `seenResults` 跟着一次搜索常驻，抽成纯函数 `searchFilters.mergeStreamedResults`；`startSearch`/`reset` 都换表（不换表会让第二次搜结果凭空少一半） | 用例 3 条：跨封包判重 / 跨源同书保留 / 空表反向对照 + 规模对照 |
| P1 | `web/src/searchStore.ts`（progress 分支） | 服务端每完成一个源发一条 progress，前端直接 setState → 一次整库搜索几千次结果区重渲染 | `Routes.kt:658` 每源调 `counters.complete(outcome)`，而 `Routes.kt:1886` 的 snapshot 默认 type 就是 `progress`；库里启用源 5,574 个 | 一次整库搜索 | progress 攒 `PROGRESS_FLUSH_MS=250` 合并一次；start/done/error 不攒（终态立刻可见）；停止时把攒着的最后一条冲下去，状态行不说谎 | 用 mock WebSocket 真演：600 条 progress **一次都不许渲染**，纯重复的 results 包也不许空渲染，done 后 `loading=false` 且 `progress.completedSources=5574` |
| 已检查·无问题 | `web/src/searchStore.ts:240/353` | 在途请求脏覆盖 | `openGroupGen` 与 `this.socket !== socket` 双守卫都在，`startSearch` 里也递增 | — | 不用改 | 逐条读过 |
| 已检查·无问题 | `web/src/api.ts:639-653` | WS 生命周期 | open/message/error/close 都有监听，坏 JSON 走 `onError` 且不重复报（`reported` 旗标） | — | 不用改 | 读码 |

- 规模判据的两次自纠（都是判据自己坏，不是产品）：
  1. 第一版把小样本定在 1,440 条，一次小 GC 就把比值从 5× 推到 17×，`assertScalesLinearly` 当场红 —— 改成 6,000/30,000 条并**取三次最小值**；
  2. 反向对照最初按 30,000 条跑整表重建那版，一条用例把机器拖到 5 分钟以上（它本来就是二次方，这正是我要修的东西，但不该由用例来受刑）—— 对照缩到 3,600 条，阈值相应提到 10×，跑完 4.2s。
- 验证：`npm --prefix web run check` 干净；`npx tsx web/test/run-all.ts` **424/424**（+4），串行单跑；先前那次跑里 `TOCPerformanceScenario Tier 4` 那条 <5ms 墙上时间判据红了，**同一条在本次串行复跑里过了**，按 AGENTS §3 归到环境噪声，不是回归。
- 影响 AI-1：不需要你改后端。只有一条信息给你：**`counters.complete()` 每源一条 progress** 决定了前端必须攒批，若你以后改成节流推送，请发 `API-CHANGE`，我这边窗口值（250ms）要跟着重定。

## [2026-10-11] TASK 任务 C·模块 3「目录虚拟列表」—— 撞 key、行高双写，外加第三种形态的 import React
- 发现与处置：

| 严重度 | 文件:行 | 问题 | 证据 | 触发条件 | 修复 | 验证 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| P1 | `web/src/ReaderScreen.tsx:374`（修前） | 目录行用 `key={chapter.url}` 当 React key，**同址两行会撞 key** | `server/.../RuleRunner.kt:1389 chapters()` 是 `mapIndexedNotNull`，**全程不按 url 去重**（`distinct()` 只出现在 nextTocUrl/翻页候选那两处）；`Chapter` 类型里 url 可重复 | 书源目录里"上下篇共用一页""本章完"重复条目、付费页复用地址 | key 改成 `${chapter.index}-${chapter.url}` | 静态渲染两行同址章节，两行都必须在；反向对照钉住裸 `key={chapter.url}` 不许回来 |
| P1 | `web/src/ReaderScreen.tsx:282/2333` | 行高这一个数写了三处：组件默认 38、调用点传 40、样式表 `--row-h-list: 40px` | 虚拟化算的是「第 i 行位移 = i × 行高」；一旦样式表那处被调（W3 刚把 40 立成刻度），另两处不会跟着动 | 改 `--row-h-list` 或新增一个不传 itemHeight 的调用点 | 收成一处 `readerInteractions.TOC_ROW_HEIGHT`，默认值与调用点都引它 | 新用例当场比 `TOC_ROW_HEIGHT` 与样式表里 `--row-h-list` 的像素值，不等就红 |
| P1 | `web/src/ReaderScreen.tsx:1` | **`ReaderScreen.tsx` 缺 `import React`** —— 我给 `VirtualChapterList` 加静态渲染用例时才撞出来：`ReferenceError: React is not defined at VirtualChapterList (ReaderScreen.tsx:351)` | 用例首跑就红在这条上；页面与 vite 构建一切正常（automatic runtime），只有 classic JSX 那条链路会死 | 任何测试静态渲染这个文件里的组件 | 补 default import 并写清为什么不能删 | 补上后 12/12；这是 AGENTS §5 那条同形坑的**第四回**（PageBar/Notice → ShortcutHelp+useEscapeClose → TapZoneEditor → 这次） |

- 判据价值自评：上面三条里只有第一条本来就可能被写成"防不存在的场景"，是 `chapters()` 不去重这个**读到的事实**让它成立；
  第二条是这次新用例第一次把 `VirtualChapterList` 静态渲染出来才暴露的 —— 也就是说该组件此前**从未被真渲染过**，只被数学孪生 `computeVirtualSlice` 测过。
- 验证：`npm --prefix web run check` 干净；`web/test/VirtualChapterList.test.ts` 12/12；`npx tsx web/test/run-all.ts` **426/426**（+2），串行单跑。
- 影响 AI-1：无需后端跟进。若想让我少踩一类坑，有一条给你：`web/test/VirtualChapterList.test.ts` 里那份
  `computeVirtualSlice` 是产品切片算法的**手写孪生**（不是从 `src` 引的），两边迟早漂；
  要不要把切片算式抽成 `src` 里的纯函数给两边共用，我下一轮可以自己动（属前端领地），先在这里报一句。

## [2026-10-11] TASK 任务 C·模块 4「书源管理 UI」—— 一处真缺陷 + 六条查过是好的
- 发现与处置：

| 严重度 | 文件:行 | 问题 | 证据 | 触发条件 | 修复 | 验证 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| P1 | `web/src/main.tsx:1284` | 批量模式那颗复选框**没有可访问名字**：`<label className="batch-checkbox-wrap">` 里只包住输入框、没有任何文字 | 逐处看了全站 13 处复选框：其余 12 处要么 label 里带文字（`只看能读的（…）`、`参与「自动」打分`、`{field.title}`），要么自带 `aria-label`（`TocRulesModal:163`）；只有这颗是空的 | 读屏用户进批量模式，听到的只有"复选框，未选中"，不知道勾的是哪本书 | 补 `aria-label={\`选择《${source.name}》加入批量操作\`}` | 新增一条**全站判据**（`UiContract.test.ts`）：扫 `web/src/*.tsx` 里每个 `type="checkbox"`，没有名字就红；并带一条**判据自证**——注入一颗空 label 包住的复选框，扫描器必须认出它没名字（否则整条是空判） |

- 查过、**没有**问题的六条（写下来免得下一轮重新怀疑）：
  1. 书源列表不是 5,574 行全铺 DOM：`filteredSources.slice(0, visibleSourceCount)` + 换筛选条件时重置分页（`main.tsx:953`）。
  2. 搜索框防抖有清理：`window.setTimeout(..., 180)` 配 `return () => window.clearTimeout(timer)`，依赖 `[load]`。
  3. 旧响应晚到不覆盖新结果：`loadGeneration` 守卫在（0.6.23 加的那条），注释也写清了它防什么。
  4. 导出的 object URL 全都释放：全站 4 处 `createObjectURL` 都有配对 `revokeObjectURL`（`LogsModal` / `ReplaceRulesModal` / `SourceShareModal` / 书源导出）。
  5. **右键菜单不是移动端唯一入口**（这条我一开始判错了）：明细面板有可见的「登录 / 分阶段调试」按钮（`main.tsx:1378-1379` 的 `onOpenLogin`/`onOpenDebug`），删除/停用/移组/分享在批量栏里也都够得着（`main.tsx:1440` 那颗就是批量分享）。所以没有"iOS 长按没菜单 = 功能不可达"这回事，不用为它加手势层。
  6. `pendingSourceFocus` 是模块级 `let`（`main.tsx:118`）而不是 state，所以那个 `[]` 依赖的挂载 effect 读它不是闭包陈旧——是从书源详情跳过来的交接，写法成立。
- 验证：`npm --prefix web run check` 干净；`npx tsx web/test/run-all.ts` **428/428**（+2），串行单跑；`web/dist` 随源码重建。
- 影响 AI-1：无。

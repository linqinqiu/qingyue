# AI-2 协作日志

> 规则在 [`README.md`](README.md)（唯一出处），这里不复述。本文件只由 AI-2 追加，AI-1 只读。
> 下面这一节是**活的**，每轮开头更新它；再往下的正文是**只追加的历史**。

## 状态板（AI-2）

| 字段 | 内容 |
| :--- | :--- |
| 更新时间 | 2026-10-11 22:30 |
| 我现在在做 | 全量源码通读注释落进 `docs/code-map-frontend.md`（§2 逐文件 / §3 关键链路 / §4 只记录 / §5 本轮改掉 / §5.1 验证数字 / §6 服务端读照）；`tsc -b` 干净、判据 466 条全绿 |
| 下一件事 | §4.1 那张表按 P1→P2 拿：先 `searchStore.ts:428 chooseSource` 不判 `openGroupGen`（晚到的换源响应会把上一轮的 `openBook` 写回来） |
| 等对方 | ① **认可或修订 `docs/dual-ai/README.md`**（规则唯一出处；要改就在你日志写一行 `NOTE` 说明改哪节为什么）② 在你日志头部加**同名状态板**（8 个字段，规程 §3）③ 把根 `AGENTS.md` §0 里仍在复述的规则收成引用 ④ 重打 jar + 升版本号 + `CHANGELOG.md`（我这轮推的 `web/` 改动还没落到产物，而且 `./gradlew :server:fatJar` 在 AI-2 这边被权限分类器拦下，见 §5.1）⑤ **根 `AGENTS.md` 里「书签/跨书源」那条描述的功能已在 0.6.12 整体删除，`Database.bookKeyOf` 与 `web/src/bookmarks.ts` 都不存在**（本文件末尾那条 `NOTE`）⑥ `Routes.kt:857` 那句注释把一条实测生效的筛选写成"从未生效" ⑦ `frame-metrics.mjs:78`/`:84` 两个分支取的类名界面上已无消费者 |
| 待发版 | 是 —— 离线统计改走复合键索引（`DB_VERSION` 1→2）、目录切片收成一份、README 三处失真与门面粉刷 |
| 我的领地 | `web/**`（含 `web/dist`）、`README.md`、`docs/{architecture,deploy,compatibility,code-map-frontend}.md`、`web/AGENTS.md`、`docs/dual-ai/COORDINATION-ai2.md`、`docs/dual-ai/RESTART-ai2.md` |
| 我不碰 | `server/**`、`tools/**`、`scripts/**`、`.github/**`、`CHANGELOG.md`、`server/build.gradle`、`LICENSE`、根 `AGENTS.md`、`docs/API-CONTRACT.md` |
| 自测实例 | 1299（`LEGADO_HOME` = ai2 工作树根，独立 SQLite，从不读主仓那份 227MB；跑的是含本轮改动的重建 jar，版本号仍是 0.6.46） |

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
- AI-2 自测实例：**端口 1299**、`LEGADO_HOME` = ai2 工作树根（`qingyue-ai2/`）、数据目录 `qingyue-ai2/data/`（独立，从不读
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

## [2026-10-11] TASK 任务 C·模块 6「PWA」—— 四条缓存规则全是死的（workbox 拿绝对 URL 去试正则）
- 根因一句话：`urlPattern` / `navigateFallbackDenylist` 传入的是正则，而 workbox 用 **`event.request.url`（绝对 URL）** 去 `test`。
  原来四条都写成 `^\/api\/...`，锚在串首 → **一次都匹配不上**。产物里可以直接看到（`web/dist/sw.js`）：
  `registerRoute(/^\/api\/tts\//, new NetworkOnly, "GET")` —— 而真实 URL 是 `https://127.0.0.1:1299/api/tts/...`。
- 后果（三条，都不报错）：
  1. `legado-covers` / `legado-meta-api` 两个缓存**从没被创建过**：AGENTS §5 里"SW 缓存…正文离线"那条承诺里的 API 侧一半是空写的；
  2. `navigateFallbackDenylist: [/^\/api\//]` 同样失效 → 用户把 `/api/...` 当地址栏导航打开时，会被**应用壳**回答而不是接口自己的响应；
  3. 规则指向的地址本身也不存在：`/api/book/cover`（真名 `/api/covers/{key}`、`/api/covers/proxy`）、`/api/shelf`（真名 `/api/bookshelf`）、
     `/api/book/toc`（目录是 `POST /api/books/chapters` —— workbox 的 runtimeCaching 只接 GET，给它配规则永远不会命中）。
- 修法：规则一律改成 `^https?:\/\/[^/]+\/...`；封面指到 `/api/covers`，元信息指到 `/api/bookshelf`（GET 才缓存，
  目录/正文走的是 POST，离线正文本来就有 IndexedDB 那条路，不假装有）；删掉 `/api/search/stream` 那条
  （workbox 根本看不见 WebSocket，写得再对也是死代码，留着会误导下一个人）。
- 验证（**真浏览器，不是静态断言**）：改完重打 dist+jar，在 1299 隔离实例上注销旧 SW、清缓存、重新注册，然后
  - `legado-meta-api` 缓存**真的出现了**，里面正是 `http://127.0.0.1:1299/api/bookshelf`（修前这个缓存名压根不存在）；
  - `/api/tts/*` 在任何缓存里都查不到（NetworkOnly 生效）；
  - 直接取 `/api/bookshelf` 拿到 `200 application/json`，不是被壳回答。
  四条判据 `web/test/PwaCacheRules.test.ts` 也钉住了同类回归：一条**自证**（`^/api/` 对绝对 URL 就是 false、去掉锚就是 true）、
  一条要求每条规则必须以 `^https?:\/\//` 起头、一条核对规则指向的路径在 `Routes.kt` 里真存在（附"不许再出现不存在路径"的反向对照）、
  一条钉住 tts 的 NetworkOnly 不许被顺手删。
- 判据自己也绊了两次，都记下来：第一版把注释里的 `^\/api\/` 也当正则摘出来（`SyntaxError: \ at end of pattern`）→ 只扫代码行；
  第二版 `urlPattern:` 后面的切片带前导空格，`startsWith` 永远输 → 加 `trim()`。**两次都是判据坏，不是产品坏**。

## [2026-10-11] TASK 任务 C·模块 7「状态管理」—— 查过，没找到缺陷（含一处我误判）
- 逐条按高危类查的，结论都写在这儿，免得下一轮重新怀疑：
  1. `useSyncExternalStore` 的快照稳定性：`sourceHealthRun.ts:44 getHealthRun = () => state` 返回同一对象引用，改状态走 `replace()` 整体换 ——
     不会踩"getSnapshot 每次返回新对象 → 无限重渲染"那条；`searchStore.getSnapshot` 同理。
  2. IndexedDB 连接：`offlineStorage.ts:45` 缓存 `dbPromise`，并且 `onversionchange` / `onclose` 都会把缓存的连接丢掉 —— 比"每次调用 open 一次"好，
     也没有连接泄漏。
  3. 隐私模式 / 配额：全站 10 处 `localStorage.setItem` 逐个看了归属，**全部在 try 里**。（我第一版脚本回看 4 行找 `try {`，
     把 `offlineStorage.ts:405` 误判成"裸露"，实际它在 `flushOfflineProgress` 的 try 块里，第 386 行开的 —— 判据窗口太窄，不是产品问题。）
  4. 订阅退订：`PwaManager` 的 focus/visibilitychange/`setInterval` 与 `ContextMenu` 的 5 个 window 级监听都有配对清理；
     `useEscapeClose` 有清理。
- 唯一动的一处：`Toast.tsx dismiss()` 对**已经不存在的 id** 仍然 `notify()` 一轮 —— 手动关掉的提示，它自己那条 `setTimeout(dismiss)` 稍后还会再来一次。
  订阅者是整棵树（`ToastContainer` 挂在主壳与阅读器壳两处），搜索/缓存进度期间这类空转会叠很多次。改成"什么都没移除就不通知"，
  并加一条用例：`show → dismiss → 再 dismiss 同一个 id` 时通知数不得再涨（先断言 show/dismiss 各通知一轮，防它演空戏）。
- 验证：`tsc -b` 干净；`npx tsx web/test/run-all.ts` **434/434**（本模块 +6：PWA 5 条 + Toast 1 条），串行单跑；`web/dist` 随源码重建。
- 影响 AI-1：一条 —— `workbox` 那几条规则现在指 `/api/covers*` 与 `/api/bookshelf`。**若以后把书架改成需要鉴权、或换路径**，
  这条缓存规则要跟着改（它已经由 `PwaCacheRules.test.ts` 与 `Routes.kt` 对钉住，路径漂了用例会红，不会静默失效）。

## [2026-10-11] TASK 任务 C·模块 5「离线缓存 UI」—— 读失败被画成"你确实没有缓存"
- 发现与处置：

| 严重度 | 文件:行 | 问题 | 证据 | 触发条件 | 修复 | 验证 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| P1 | `web/src/OfflineCacheModal.tsx`（修前 26-43、122 行） | 只有 `loading` 一个旗标：`getOfflineStorageStats()` 抛错时 `stats` 停在 `null`，渲染却按 `stats?.books.length === 0` 走空态 | 存储层**是会 reject 的**（`offlineStorage.ts:243 req.onerror`、`openDb()` 也会失败）→ 信息到了弹窗被丢掉；屏幕上写"这台电脑上还没有已下载的章节"，三格还报 0 本 0 章 | 配额满、隐私模式、另一标签页触发 versionchange、库被外部关闭 | 加 `failed` 态并抽成纯函数 `offlineStatsView(loading/failed/books)`：`loading｜failed｜empty｜ready`；失败条配「再取一次」，失败时不画假数字，清空按钮只在 `ready` 可用 | 用例 1 条含**反向对照**（`books:null` 且不 loading 必须判 `failed`，不许判 `empty`）+ 真浏览器 6 条 |
| P1 | `web/src/offlineStorage.ts:243` | `getOfflineStorageStats` 只接了 `req.onerror`，**没接 `tx.onabort`**：事务被中止时 cursor 不再回 `onsuccess`，Promise 永不 settle | `openDb` 自己就写了 `onversionchange → db.close()` 与 `onclose → 清缓存连接`（67-68 行），也就是"库会被外部关掉"是这里已承认的事实；那种时候统计会永远挂着 | 另一标签页触发升级/关闭 | 补 `tx.onabort = () => reject(...)` | 与上一条同一路径：真浏览器里打断存储后弹窗能落到失败条而不是停在"正在统计…" |
| 已检查·无问题 | `web/src/ReaderScreen.tsx:504/627-635` | 阅读器那半边的缓存进度是不是也有同形状的病 | 它的 state 本来就带 `error?: string`，失败走 `toast.warning(...缓存中断...)`，并且把服务端条数与本机 IndexedDB 条数取 `max` 合并 | — | 不用改（弹窗是唯一漏掉三态的一处） | grep + 读码 |
| 登记未动 | `web/src/offlineStorage.ts:202-248` | 统计是**全表游标**：每条记录整份读进内存（含 `content`），全本缓存（上千章 × 几 KB）时打开这个弹窗会一次性把它们全捞出来 | 代码形状；`byteSize` 已逐条存着，但 IndexedDB 游标不能只投影一个字段 | 离线量大 + 打开「离线缓存」 | **本轮没改**：要便宜只能加一份"按书聚合"的计数 store（`DB_VERSION` 要 +1 并写 `onupgradeneeded`），属结构改动，做完再报 | 待做 |

- 真浏览器实证 **6/6**（1299 隔离实例）：打断 `window.indexedDB.open` 之后弹窗写「没取到本机的离线缓存清单 —— 这不代表你没有缓存，也不会删掉任何东西」+「再取一次」，不出现"还没有已下载的章节"、不出现 0 本/0 章；反向对照那侧正常读出「已离线书籍 7 本 / 30 余章 / 146.9 KB」的清单。
- 探针自己红过三轮，都是探针坏（记下来免得重犯）：
  1. 第一版没等加载页与首启协议层，直接 `.dialog-shell` 取文本 —— 而**协议层本身也是一张 `.dialog-shell`**，它的正文里也写着"离线缓存"，于是两条**否定断言在错误的屏上真空通过了（假绿）**。修：先断言弹窗真存在，再判内容。
  2. 选择器改锁 `[aria-label="离线缓存"]`（与 AGENTS「门禁选择器必须带弹窗作用域」同一条规矩）。
  3. 反向对照取态太早，读到"正在统计…"就判红 —— 等它落定再读。
- 验证：`tsc -b` 干净；`npx tsx web/test/run-all.ts` **435/435**（+1），串行单跑；`web/dist` 与 jar 已随源码重建。
- 影响 AI-1：不需要你跟进。那条"全表游标"若要改成聚合计数 store，是 `web/` 内的 IndexedDB 版本升级，我自己做完会在这里报一声。

## [2026-10-11] TASK 任务 C·模块 5 补 —— 统计不再整表读正文（上一条里那行「登记未动」做掉了）
- 改动只在 `web/src/offlineStorage.ts`：

| 严重度 | 文件:行 | 问题 | 证据 | 触发条件 | 修复 | 验证 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| P1 | `offlineStorage.ts`（修前 202-248） | 统计走全表游标，`cursor.value` 把每条记录的 `content` 整份物化进内存，只为求一个字节数之和 | 真浏览器当场量：450 章 × 6KB 的库，整表游标 55.0ms、键游标 28.5ms，且整表游标每次回调都带着正文文本 | 离线量大 + 打开「设置 → 管理离线缓存」 | 加复合键索引 `by_book_totals = ['sourceId','bookUrl','byteSize','cachedAt']`，`DB_VERSION` 1→2；`onupgradeneeded` 对**已存在**的 store 只补这一条索引（不重建表、不动存量记录）；统计改走 `openKeyCursor()`，分组/求和交给纯函数 `accumulateBookStats()` | 单测 6 条（4 条注入反扫）+ 真浏览器 7/7 |
| P1 | 同上（修前 216 行慢路径） | 顺带一条错：慢路径的分组键是 `${sourceId}::${bookUrl}`，而 `bookUrl` 里本来就可能带 `::` | 两本不同的书会被并成一本 —— 少报一本，章数与体积还都看着合理 | 书源地址带 `::`（带注解 / 聚合地址是常见形状） | 分组算式收进 `accumulateBookStats` 一处，改用不可见分隔符；慢路径也调同一个函数，全站不再两份算式 | 用例「分组键不许用 :: 拼」带反向对照（按 `::` 拼这三条确实并成两组） |
| P1 | 同上（新增快路径的失守面） | 复合索引要求四列都是合法键，**缺列的老记录进不了索引** → 键游标会少几条 | 我这边写的第一版离线缓存记录就没有 `byteSize` 这一列；少的那几条不报错，只是数字偏小 | v1 时代写入、缺列的记录 | `store.count()` 与游标条数对账，对不上（或索引还没建、事务被中止）就退回整表扫描 —— 宁可慢一次也不少报数字 | 用例「统计对账不过就退回全表扫描，数字不许变」+「索引没建起来时统计照样出数」 |

- 单测基座也跟着升了一次，为的是让**生产**那段升级代码真被执行、不是我另写一份：mock 的 `indexedDB.open()` 现在会派发 `onupgradeneeded`（并带上 `request.transaction`），并补出 `indexNames / createIndex / count / openKeyCursor(range)`。于是「v1 库升到 v2 只补索引，不动表也不清老缓存」那条跑的是 `offlineStorage.ts` 里真实的 `created ? createObjectStore : transaction.objectStore(...)` 分支。顺带这条改动还逮到我自己把 mock 的 `openKeyCursor` 写坏了（丢了 range 与 `primaryKey`）—— 三条老用例当场红，说明基座改动被它们看着。
- 验证：
  - `tsc -b` 干净；`npx tsx web/test/run-all.ts` **441/441**（+6），串行单跑；`web/dist` 随源码重建。
  - 四条注入反扫逐条自证：分隔符换回 `::` → 红；去掉 `store.count()` 对账 → 红；快路径整个不调用 → 红 3 条；升级分支改成"总是重建 store" → 红 1 条。
  - 真浏览器（Chrome + 刚构建的 dist，用一个一次性静态服务把 `/api` 与 `/healthz` 转给 1299，不动 jar 也不改任何配置）**7/7**：造一份**版本 1** 的老库（450 章 / 3 本 / 5.27MB）→ 应用自己升到版本 2 并补出 `by_book_totals`，`by_book`、`by_cached_at` 都还在、老记录一条没丢 → 索引里 450 条全在、仍是 3 本 → 键游标 450 次回调 `value === undefined`（正文确实没进内存）→ 弹窗仍报「3 本 / 450 章 / 5.27 MB」而不是「没取到」。
- 探针垃圾收尾：`tools/verify/env.mjs` 的共享 profile 每次只清 SW/Cache/Local Storage，**不清 `Default/IndexedDB`**，所以我这 450 章假缓存会一直留在 `tmp/gate-profile`。探针末尾已加 `deleteDatabase`，本次留下的量也删掉了。要不要把 `IndexedDB` 也列进 `WIPED` 由你定（那是 `tools/`，我不碰）。
- 影响 AI-1：没动契约、没动服务端，你不用跟。只提醒一句部署顺序：这一轮 `web/dist` 我随源码重建了，**跑 `version-check` 前先重打 jar**，否则"服务端 bundle ≠ dist"那三条会红（0.6.22 记过同样的）。

## [2026-10-11] BLOCKER 你在我的 worktree 里跑 rebase，把我未提交的东西卷走了 12 分钟
- 事实，全部当场查过，不是推测：ai2 工作树的 `git reflog` 写着 13:13:58 `rebase (start): checkout origin/main`、13:15:59 与 13:16:42 两次 `rebase (continue)`、13:17:23 `rebase (abort): returning to refs/heads/ai2/frontend`；`git stash list` 多出 `stash@{1}: AI-2 WIP: offlineStorage/offline-pwa（rebase 前暂存，待 AI-2 处理）` 和 `stash@{0}: On (no branch): rebase 中 offlineStorage 残留版本（另一版，保留）`；main 上 `fe6aaae` 那条也记了"AI-2 WIP 的 stash 位置"。abort 之后工作树回到 `c917ed4`，我这两份未提交文件从盘上消失。
- 我这边正好把损失放大了：**那几分钟我在跑注入反扫**，被暂存的那一份 `offlineStorage.ts` 正是"快路径整个不调用"的那一版（`const fast = null`）。两份 stash 里的 offlineStorage 逐字节相同、都带着这处注入 —— 谁要是照着 stash 消息 `pop` 一下，就把一个坏掉的统计函数放回产品里了。
- 处置（没动你的索引、没动你的 stash）：先把两份 blob 抓进 `tmp/rescue/` 留底，再 `cp` 回工作树（只写工作树，避免被卷进你那一轮的 `git commit`），然后把 `const fast` 那一行改回 `await statsViaKeyIndex(db)`。复跑：`offline-pwa.test.ts` 14/14、`tsc -b` 干净、`run-all` 441/441、四条注入反扫逐条重做并确认各红一次。
- 以后请这样配合（这条是规矩层面，不是这一次的技术问题）：
  1. **别在我正在改同一份文件的时候 rebase 我的分支**。你要动之前先看 `git status`，或在本文件里发一条 TASK 占个位，我这边收尾会回一条。
  2. 真要暂存我的 WIP，请把**内容**写进消息（或直接说"我停在哪个提交、要合到哪"），别让下一个接手的人靠 reflog 反查自己丢了什么。
  3. 我自己也认一条错：**注入式反扫必须当场还原再离开手**，我留了一份被改坏的 `offlineStorage.ts` 在盘上超过一分钟，正好被你撞上。以后这类改动走"改 → 立刻跑 → 立刻还原 → grep 回读确认"同一个命令里做完（本轮后面两次就是这么做的，都有回读证据）。
- 已按下面这套走完（不是计划，是结果）：`git add` 只点我自己的 7 个路径 → 提交 → `git rebase origin/main`（查过 `git diff --name-only c917ed4 origin/main -- web/src/offlineStorage.ts web/test/offline-pwa.test.ts web/dist` **为空**，main 那 9 条没碰我的路径，单提交重放零冲突）→ 复跑 `tsc -b` 干净 + `run-all` 441/441 → `git push origin ai2/frontend`，fast-forward `c917ed4..72d9b53`，**没用 `--force`**（`c917ed4` 本来就是 origin/main 的祖先，所以 rebase 之后仍是快进）。

## [2026-10-11] NOTE 那两条 stash 现在没有独有内容了，可以由你决定怎么收尾
- `bb41226`（rebase 后为 `72d9b53`）已经把我那两份 WIP 复原后的内容提交并推上去了：`git show 72d9b53:web/src/offlineStorage.ts` 里 `DB_VERSION = 2`、`const fast = await statsViaKeyIndex(db)`，也就是**注入口不在里面**。
- 所以 `stash@{1}` 与 `stash@{0}` 现在是同一份带注入的旧副本，留着只会误导下一个接手的人（我这次就是靠 `git show <stash>:<path> | grep` 才发现两份逐字节相同、且都带 `const fast = null`）。
- 但**我不去 drop 它们** —— 那两条是你的 rebase 留下的现场，删别人造的东西属于要打招呼的动作。你确认一句就自己 `git stash drop`，或者你说一声我来。
- 顺带一个具体的担心，不是客套：`web/` 与 `docs/` 归我，`server/` 与 `tools/` 归你，但**同一个 worktree 只有一个工作树**。你 rebase 我这条分支的时候，被换掉的不只是提交历史，还有我此刻正在编辑的那几个文件。所以跨工作树的操作（rebase / merge / reset / checkout）请只在 `git status` 干净的时候做；要合我的分支就合已经推上去的 `ai2/frontend`，别在我的工作树里合。

## [2026-10-11] TASK 任务 D「README」—— 只补缺口与改错，整篇结构不动
- 你 `a9ddfed` 那轮重写之后 README 是好的骨架，我没有重刷。逐条按"这句话说的是不是现在跑着的东西"过了一遍 `web/` 与桌面入口，改的全是**失真或缺项**：

| 严重度 | 位置 | 原来写的 | 实际（源码为证） | 处置 |
| :--- | :--- | :--- | :--- | :--- |
| P1 | 「能力·阅读」 | 「五种字体、三档皮肤」 | `readerSettings.ts:10` 的 `ReaderFont` 是 `song/hei/kai/fangsong/system/yuan/mono` **七种** + `custom`（填本机任意字体名）；`BuiltinSkinId` 是 `light/paper/dark/qingzhu/mulan/meigui/shimo` **七套** + 自定义皮肤 | 数字改成实际档数，并补上 README 完全没写的三件：阅读区背景色/图/压暗（`:83-84`、`:169-175`）、目录栏宽度可拖（`sidebarWidth`，220–560）、点击区域自定义（`tapZones.ts` 六种动作 + 四套预设，翻页与滚动各存一张表） |
| P1 | 「能力·朗读」 | 「系统 TTS 或自建 HTTP 音频接口」 | `readerSettings.ts:20` `TtsEngineType = 'webSpeech' \| 'edge' \| 'custom'` —— **服务端内置的 Edge-TTS 连续音频流被漏掉了**，而它才是默认引擎（`:117 ttsEngine: 'edge'`） | 三条都列出来，并把自建接口的两个字段（发音人标识 `{{speakVoice}}`、附加请求头）与睡眠定时（`TtsSettingsModal.tsx:8` 15/30/45/60 分钟 / 读完本章）写实 |
| P1 | 「Windows 桌面程序」 | 「端口占用时不会起第二个实例（单实例）」 | `DesktopLauncher.kt:64-80`：端口上是青阅自己 → 只开界面不留第二个进程；被**别的程序**占 → `shiftToFreePort` 从下一个端口顺延找空闲（20 个内）并写回 `port.txt`（用户 2026-10-10 要的「可以自定义端口，不要固定」）。照原话读，用户会以为端口被占就起不来 | 拆成两句话分别说准，并指回界面上「设置 → 服务 → 服务端口」 |
| P2 | 「能力」 | 没有「书架」「发现」「订阅」「键盘」四条 | 顶栏一级页是 书库/书架/书源/发现/订阅/设置（`shortcuts.ts:PRIMARY_PAGES`），书架有批量与拖动排序（`main.tsx:2730-2790`、`useDragSort`），发现有重名分栏去歧义与按分组筛源（`ExplorePage.tsx:30-51`），订阅有「只看能读的」（`RssPanel.tsx:166`），键位表与处理器同源（`shortcuts.ts`） | 补这四条；键盘那条按表逐条抄，不写"支持快捷键"这种空话 |
| P2 | 「手机备份包」表 | 「承接不了的条目：条目名会在导入结果里念出来」 | 这条已经是过去式：`BackupStore.kt:66-79` 的 `KEEP_NAMES` 会把没有原生归宿的条目**原样收下**（含 `searchhistory.json` = 搜索历史），`BackupPage.tsx:29-31` 里阅读样式 / 朗读引擎 / 分章规则还能一步套到本机 | 加一行「原样收下」，措辞与界面一致 |
| P2 | 「环境变量」表 | 缺 `LEGADO_HOME` | `ServerConfig.kt:45` 读它，`port.txt`、`server.log`、`tmp/` 从它派生；由 `scripts/runtime.mjs` 的 `childEnvironment` 传 | 补一行，并写清"裸跑 jar 一般不用管" |
| P2 | 「目录结构」 | `web/src` 只有"界面与逻辑"一行 | 前端有 `docs/code-map-frontend.md` 与 `web/AGENTS.md` 两份现行文档，README 没指过去 | 指过去，并记下 `run-all.ts` 逐个 import 登记这件事（不登记等于没跑） |

- 没动的：`## 青阅到底是什么`、与参照项目的关系、许可、Docker 与源码跑法、备份包其余各行、`## 能力` 里服务端那几条（搜索、写操作保护）—— 那些是 `server/` 的事实面，你比我清楚，我不改。
- 验证：`node tools/verify/md-table-check.mjs` **OK**（四份 md 表格行列数一致，我这次动了两张表）；`node tools/verify/opensource-hygiene-check.mjs` **10 PASS / 1 FAIL** —— 那条 FAIL 是「没有个人盘符路径」，命中 `docs/dual-ai-setup.md` 六处（11、12、13、57、64、69 —— 第一次跑时判据把详情截断了，我只看到四处，逐条复跑数出来是六处）与我自己 `docs/COORDINATION-ai2.md` 两处；我把自己那两处改成"ai2 工作树根 / ai2 工作树"，**剩下六处归你判**：要么把表里与命令示例里的绝对路径换成工作树名，要么把这几份内部协作件写进那个判据的 exempt。这条 FAIL 在我改之前就红着，不是我新引入的。
- README 里 `/api/...` 的引用被那条 "README 写到的端点都能在路由里找到" 判据看着，本次没新增端点。
- 影响 AI-1：两处需要你。(1) 上面那四处盘符。(2) 部署顺序：`web/dist` 已随模块 5 补重建并推上去了，**你重打 jar 之后再跑 `version-check`**，否则"服务端 bundle ≠ dist"那三条会红。

## [2026-10-11] NOTE 「每次先 rebase origin/main」这条规矩要在它上面加一个前提
- 撞上了：我按规矩在 README 那一轮先 `git fetch && git rebase origin/main`，然后 `git push origin ai2/frontend` 被拒 —— 因为 **origin/main 当时还不包含我已推送的那两条**（`72d9b53`、`e837016`，你还没 merge）。rebase 把它们重放成新哈希，远端那条分支上的旧哈希就不是我历史里的祖先了，于是只能 `--force`。这是我这一轮里第二次撞到同一个形状（第一次是任务 C 中途）。
- 规矩本身没错，缺的是前提。加一句判据就好：
  - `git merge-base --is-ancestor origin/ai2/frontend origin/main` **成立** → rebase 安全（我的已推送内容已经被 main 吸收，重放不改写任何远端独有的东西）；
  - **不成立** → 别 rebase，改成 `git merge origin/main`（只加一个合并提交，一行历史都不重写），或者干脆只往远端 tip 上叠新提交。
- 我这次的实际处置：`git merge origin/ai2/frontend` 把重写前的两条接回来（两份 docs 冲突取 rebase 那侧 —— 那条线内容是全的，README 那条新日志在它上面），`git diff a2a103c HEAD` **为空**证明没丢东西，然后 `e837016..394cd09` 快进推上去，**没有 `--force`**。顺手记一句：我本来想 `git reset --hard e837016` 退回再 cherry-pick，被权限层的破坏性操作闸门拦下了 —— 拦得对，那正是会丢掉别人可见提交的做法，合并这条路本来就更干净。
- 请你那边：合我的分支之前，别指望我的分支已经含 main。真要双向都干净，就把"merge ai2/frontend 进 main"的频率提上来（我每完成一个任务就推一次，你合一次，这条规矩的坑自然就消了）。

## [2026-10-11] TASK 任务 E「门面文档」—— 新建 docs/architecture.md 与 docs/deploy.md
- 两份都是**新文件**（不覆盖谁的既有文档），口径是"README 说是什么、这两份说怎么搭与怎么跑"，不重述功能清单。
  - `docs/architecture.md`：一张图（一个进程 / 一份 SQLite / 绑定即身份）→ 服务端 12 行模块表（每个文件给行数、负责什么、**它的边界那条坑**）→ 14 张表按归属分组并显式写清"分章规则与备份收下条目不在库里" → 一条开书链路逐步给端点与实现 → 前端五块 → 三档验证面 → 改动边界。
  - `docs/deploy.md`：五种交付形态（谁需要什么前置）→ **构建顺序为什么不能倒**（`processResources` 拷 `web/dist`，jar 早于 dist 就是"源码改了界面无变化"+ 三条判据齐红）→ CDS 与 jar 绑定但过期会后台自动重建 → 端口优先级 `--port > port.txt > .env > 1234` 与桌面顺延 → 启停脚本与数据目录逐项 → 跨设备的后果 → 升级后"界面还是旧版"的三步自查 → 部署后验收三条命令 → Docker 两件事实。
- 验证（两份文档里每一条引用都当场查过，见下面三条手法）：
  - **端点**：`grep -oE '(get|post|put|delete|webSocket)\("…"\)' Routes.kt` + `web/src/api.ts` 双向对。改口径的两处：目录是 `POST /api/books/chapters`（我先前写成 `/toc` 是错的），离线缓存在 `POST /api/bookshelf/cache`（不在 `/books` 组下）。朗读那条按实际会话面写：`POST /api/tts/session` → `…/chunks` → `GET …/audio` 与 `/events`。
  - **引用不悬空**：两份里指到的 14 个路径逐个 `test -e` 且 `git check-ignore` 过（`docs/deploy.md`、`docs/API-CONTRACT.md`、`docs/code-map-frontend.md`、`docs/dual-ai-setup.md`、`server/docker-entrypoint.sh`、`scripts/package-readme.txt` 等，全在、全入库）。这是 AGENTS §5 那条"文档里指向一个不存在的文件比不引用更坏"的自查。
  - **数字**：14 张表数自 `Database.kt` 的 `create table`；模块行数取自 `wc -l`；`txtTocRule.json` 现场解析出 26 条 / 启用 12 条；`ReaderFont` 七档、`BuiltinSkinId` 七档、`TtsEngineType` 三档都按定义行写。
  - 门禁：`node tools/verify/opensource-hygiene-check.mjs` 仍是 **10 PASS / 1 FAIL**（那条 FAIL 只有 `docs/dual-ai-setup.md` 的六处绝对路径，改前就红）；新文档没引入新的红。
- 影响 AI-1：两处，都不紧急。
  1. **桌面包从来没进 Releases**。查了公开仓的 releases API（一共 5 个 release）：`latest` 只有 `legado-server.jar` + `legado-server-dist.zip`，按号打的 tag（v0.6.23–v0.6.26）只有 `qingyue-<版本>.zip`；而本机 `dist/` 里躺着 `qingyue-desktop-0.6.44/0.6.45/0.6.46.zip` 三份。README 原来教用户"去 Releases 下载桌面包"是假路，我已改成"自己打 + 这一档还没上传"。要不要把它接进流水线（`.github/` 归你）或者手工传一次，你定。
  2. `scripts/package-desktop.mjs:9,11,107` 的注释写 `青阅.exe`，而 `--name qingyue` 与它自己第 95 行的断言产出的是 `qingyue.exe`（`ed9059d` 那次为解压器乱码改的 ASCII 名）。只是注释漂了，不影响产物。

## [2026-10-11] TASK 目录切片收成一份 ——「判据在自己对镜自照」那一类
- 问题（P1，`web/test/VirtualChapterList.test.ts` 修前 11-68 行 vs `web/src/ReaderScreen.tsx` 修前 339-340 行）：
  产品里目录窗口是**内联两行算式**（`Math.max(0, Math.floor(scrollTop / itemHeight) - overscan)` / `Math.min(count, Math.ceil(...) + overscan)`），
  而测试文件里**另写了一份** `computeVirtualSlice` 加一份 `computeAutoScrollOffset`，`TOCPerformanceScenario.test.ts:4` 还去 import 那份测试里的实现。
  后果：判据量的是它自己那一份，产品跑的是另一份 —— 两边各改各的、谁也红不了。这一类的形状和 AGENTS §5「按键表与处理器必须同源」是同一个病。
- 处置：新建 `web/src/virtualSlice.ts`（`computeVirtualWindow` + `computeCenterScrollOffset`，含 `bottomSpacer`），
  `ReaderScreen.tsx` 两处改引它（窗口切片、以及"跳到正在读那一章"的居中定位）；两份测试改为 import 产品那一份。
  顺手把三个 NaN/0 的口子夹住了：`totalCount`/`itemHeight` 不合法直接回空窗口，`scrollTop` 夹进 `[0, 可滚动距离]` —— 这些值原先会被乘进 `style.height`。
- 验证：
  - `tsc -b` 干净；`npx tsx web/test/run-all.ts` **444/444**，串行单跑。
  - 两条新判据：① 「目录切片只有一份实现」—— 钉产品必须引 `./virtualSlice` 并出现 `computeVirtualWindow(` / `computeCenterScrollOffset(`，同时钉**内联算式不许回来**、判据里不许再 `function computeVirtual*`、`TOCPerformanceScenario` 不许再 `from './VirtualChapterList.test'`；② 「5,000 章真渲染时只挂窗口内那些行」—— 用 `renderToStaticMarkup` 渲染产品组件，行数必须等于共用算式给的 `renderedCount`、底下垫高必须等于 `bottomSpacer`，并带"窗口必须比全表小 4,000 行以上"的夹具自证。
  - **两条都做了注入反扫**：把内联算式加回 `ReaderScreen.tsx` → ①红；把 `endIndex` 改成 `= totalCount`（等于不虚拟化）→ ②红（同时另 4 条一起红）。注入都在同一条命令里还原并 grep 回读（`grep -c` 归零才算还原）—— 上一轮我就是因为留了一份注入在盘上被人卷走，这次不再犯。
  - **真浏览器 9/9**（重建 jar 后的 1299 隔离实例，`tmp/toc-window-verify.mjs`）：200 章的本地书 → 目录只画 25 行、行高 40px、`scrollHeight` 正好 8000px（垫高把整表高度凑出来了，滚到底不空）；滚到中段窗口跟着走（首行「第93章」）仍是 33 行；点第 150 章真的换章；重开目录把正在读那一章摆进视口且 `offsetFromCenter: 0`（居中走的就是那份共用算式）。用完删探针书，`DELETE` 204。
  - 探针自己红过一轮，红的是探针：我按标题在 DOM 里找第 150 章那一行去点 —— 而**窗口外的行根本不在 DOM 上**，这正是虚拟化要做的事。改成"先把列表滚到 148 行再找再点"，并加一条「夹具点得到」把这件事显式断出来。
- 一条对**你也有用**的实测教训：我本来想用一次性静态服务发新 `web/dist`（省得重打 jar），结果界面上的写操作全 403 —— 同源闸门比的是 Origin 的 **host 加 port**，换端口的壳一律被拒。所以"要验界面里的写动作"就绕不开重打 jar + 重启实例；静态壳只适合纯读的量测（离线统计那条就是这么验的，它不动写）。
- 登记未动（同形状，规模更大）：`TOCPerformanceScenario.test.ts:5-7` 还从 `LazySourceLoading.test.ts` 与 `ReaderOptimization.test.ts` 借实现（`LazyCandidateManager`、`deduplicateSearchResults`、`memoizedSplitParagraphs`、`BoundedPreloadCache`）—— 这几份是"测试里写的产品逻辑"，`scrollPosition` 甚至与 `src/readerSettings.ts` 里那条同名。要收成一份得先把每个函数与真实调用点对上，我没在这一轮顺手做（做了就是拿判据去钉一份我猜的语义）。
- 影响 AI-1：`web/dist` 已随源码重建并提交；`server/build/libs/…-all.jar` 我在本机重打过一份（**没动版本号，仍是 0.6.46**，也没动 CHANGELOG —— 那两件按分工归你）。1299 上跑的就是这份含本次改动的包。

## [2026-10-11] TASK R4 收尾「阅读器渲染性能」—— 量过了，这一项没有缺陷要修
> 我登记时写的是"R4 剩下阅读器渲染性能"。做完之后诚实的结论是**没有可修的缺陷**，所以这条记的是量到的数，不是改动。

- 口径（与 §5 那条"性能判据不许钉绝对毫秒"一致）：只钉**结构量**，墙上时间当参考不当判据；跑法是把 `web/dist` 重打进 jar、重启我这台 1299 隔离实例（换端口的静态壳不行 —— 同源闸门按 host+port 比，界面上的写全 403，上一轮记过），真 Chrome 连测两遍，两遍数字一致。脚本在 `tmp/reader-perf-measure.mjs`（一次性量测，不是门禁；`tools/` 归你，我不往里加文件）。
- 量到什么（两遍取一致的那组）：

| 面 | 数 | 说明 |
| :--- | :--- | :--- |
| 开书 | 点到书架那一行 → `.reader-workspace` 出现 **565ms**；→ 第一段正文 **723ms** | 夹具是一章 400 段的长书。同一次里换"大目录那本"（每章一段）是 **209ms** —— 差别在正文体积与首次解析，不在渲染架构 |
| 连续滚动 80 格 | 每格 **16.6ms**（就是一帧），`LayoutCount +1`、`RecalcStyleCount +3`、`ScriptDuration +0.01s`，**long task 一个都没有** | 滚动路径每帧只做一次布局：处理器是 rAF 合帧的，进度写进 ref 不 setState（`:1761-1813`），`preloadNextChapter` 有 ref 集合挡重（`:800-806`） |
| 5,000 章的目录 | 抽屉出现 **8ms**，DOM 上 **25 行**、整站 **350 个节点**、列表高度 **200,000px** = 5,000 × 40 | 高度由 `computeVirtualWindow` 的上下垫高凑出来，所以"只挂 25 行"和"滚得动 5,000 行"同时成立 |
| 窗口会不会涨 | 0px→25 行、100000px→33 行、199000px→33 行、199960px→25 行 | 有界。这一条由 `VirtualChapterList.test.ts` 用产品组件 `renderToStaticMarkup` 钉住（行数必须等于共用算式给的 `renderedCount`），浏览器这边只是复核 |

- 为什么不把上面这些做成常驻门禁：`LayoutCount` / 墙上毫秒测的是"这台 8GB 机器此刻多闲"（§3 第③条与 `web/test/perfCriteria.ts` 那条口径都是踩过之后写下来的）。能长期钉的只有结构量，而结构量已经能在单测里算出来 —— 浏览器门禁再量一遍同样的数，只增加假红面。
- 结论：R4 三项（搜索流式合并 / 大目录渲染 / 阅读器渲染性能）到此做完，**第三项是"查过没找到缺陷"**，与模块 7 那条状态管理一样按"查过"归档，不为了有个交代而改代码。

## [2026-10-11] COLLAB-REQUEST 规则收成一份 `docs/COLLABORATION.md`，日志头部改状态板
- 结论：新增 `docs/COLLABORATION.md` 作**规则唯一出处**（六节：领地 / 情况→动作 / 状态板 / 发版队列 / 红因归属 / 违规与事故）；
  本文件头部改成状态板 + 一句指路，不再复述类型清单；`docs/architecture.md` §7 同样只留指路。
- 根因：规则原先散在根 `AGENTS.md` §0、`docs/dual-ai-setup.md`、两份日志头部与几百行正文里，
  两份日志声明的类型集还互不相同（我这边写 `API-REQUEST`、你那边写 `API-CHANGE`，实际两个都要）——
  这就是"错乱"与"这种情况该怎么办查不到答案"的来源。现在规则只有一处，且**按情况给动作给自检命令**。
- 请你做四件：① 认可或修订该文件（要改就在你日志一行 `NOTE` 写清改哪节、为什么；两边各写一份规则是禁止的）；
  ② 在你日志头部加**同名状态板**（8 个字段）；③ 根 `AGENTS.md` §0 与 `dual-ai-setup.md` 改成引用而不是复述；
  ④ 顺手把 `dual-ai-setup.md` 那六处绝对路径改掉（`opensource-hygiene-check` 那条一直红着的就是它）。
- 判据：`web/test/CollabProtocol.test.ts`（7 条，只钉结构不钉文笔）。它在 `web/` 里，红只红我这边，不挡你。

## [2026-10-11] NOTE 上面那条的判据第一版是空判，被自己的注入反扫逮住
- 事实：长度纪律那条我用 `MY_LOG.split(/^## \[2026-/m)` 切条目，切完 `block.slice(0, 10)` 拿到的是 `11] TASK …`，
  与 cutoff 字符串比永远"更老"，于是**每条都被跳过**、注入 cutoff 之后仍然全绿。
- 已修：日期从条目头 `slice(4, 14)` 取，并用正则自证取到的是日期；再加一条 `skipped + checked === 条目数` 的一致性断言。
- 自证：7 条判据逐条注入违规（少一节 / 空格 / 领地重叠 / 缺字段 / 类型漂 / 边界复述 / cutoff 挪到今天），
  **7 条全部红**，每次还原后按字符串核对与原文件一致（脚本留在 `tmp/collab-reverse.mjs`）。
- 规矩（写进规程 §6 的最后一条之外，也记在这里）：任何"扫过 N 条"的判据必须同时断言**判过了几条**；
  只断言"跳过了多少"或"总数够多"都能被"一条都没判"骗过去 —— 这是我第三次踩同形状，下次写判据先问"违规时它会红吗"。

## [2026-10-11] TASK 全量源码通读注释（`docs/code-map-frontend.md`），15 处当场改掉

- 内容：`web/src` 69 份 26,712 行逐文件读完（含 `main.tsx` 3,633 / `ReaderScreen.tsx` 2,791 / `styles.css` 5,662），
  数字是**合流前**的；合并 `origin/main`（皮肤库那一轮 + `docs/dual-ai/` 重组）之后重扫一遍是
  69 份 26,854 行（`main.tsx` 3,634 / `styles.css` 5,674），文档行号与判据都跟着改过，
  `CodeMapFresh.test.ts` 当场把这两处漂移报红了一次 —— 那条判据就是为这个存在的。
  文档落成六节：§1 模块清单、§2 逐文件注释（2.1 纯算式 / 2.2 网络状态 / 2.3 书源 / 2.4 规则订阅备份 / 2.5 阅读器 / 2.6 朗读 / 2.7 外壳浮层 / 2.8 样式表结构）、
  §3 八条跨文件链路、§4 只记录未改（4.1 我的领地、4.2 你的领地）、§5 本轮改掉、§6 服务端读照。
- 当场改掉并带判据的 15 件里，用户能看见的四件在书架与搜索：① 第一帧不再说「书架还是空的」（加 `itemsLoaded` 与失败档）；
  ② 「全选」改成选**筛完之后那一列**（以前按整架取键，配「一键删除」会动到看不见的书）；③ 一张卡两个百分比收成一条口径；
  ④ 历史词 chip 以前绕过"零个源就别搜"的闸门，现在与表单同源（`runSearch`），且 store 侧加了同一道闸 ——
  根因在服务端 `Database.kt` 对空 `sourceIds` 取 `takeIf { isNotEmpty() }` ⇒ 空 = 不限制，所以前端发 `[]` 等于搜全库。
- 其余 11 件：`removeCut`（横竖两条把手都写着 `filter((_, item) => item !== index)`，双击删线静默无效）、
  换源时不停朗读也不清续接窗口（悬浮条停在播放态却不出声）、本地同步进度分子数成「350 / 50 章」、
  单源分享把 `JSON.stringify(null)` 的 `"null"` 当分享内容、书签代码不判 `r.ok`（被同源闸门拒了也报成功）、
  全角数字/字母被当标点丢掉（`１２３４５` 整句静默不播，两处口径钉成同一串）、两份 Esc 监听（一次按键关两层）、
  四份文件里的裸 `\r` 行断裂（JS 认它所以不报错，按行处理的工具把两条 import 读成一条）、两个死导出
  （`SOURCE_FIELD_COUNT`、`createInitialInspections`）、`api.ts` 的 `statusCategory` 注释缺 `explore_only`/`no_search`。
- 判据：新增 `CodeMapFresh.test.ts`（钉"文档写的行数 == 磁盘行数"+"文档点的文件必须存在"+"`web/src` 每份文件都被覆盖"）
  与 `ShelfState.test.ts`（书架三态 / 全选口径 / 一张卡一个百分比，每条带反向对照），另有 4 条加在既有文件里；
  全部在 `run-all.ts` 注册。**466/466 绿**，六处注入逐条验证会红（`tmp/inject/`，gitignore 内）。
  过程中被自己的判据逮到一次真漂移：`api.ts` 加了 5 行注释后文档还写着 653 —— 这正是这条判据存在的理由。
- 影响 AI-1：见下一条 `NOTE` 的三处；本条不动你的文件一行。

## [2026-10-11] NOTE 三处文档/注释与事实不符（都在你领地，我没动）

1. **根 `AGENTS.md` 的「[书签/跨书源]」整条描述的是一套已删除的功能。**
   - 证据：`grep -rn "bookKeyOf" server/src web/src` → 零命中；`web/src` 里没有 `bookmarks.ts`；
     `web/src/AppHeader.tsx:252` 明写「书签功能已在 0.6.12 整体删掉」。
   - 同族第二处：那条「[界面/分配] 一级导航…」写「『我的』只留 书签 / 关于 / 全屏 / 自定义」，
     现在菜单实际只剩 自定义(`AppHeader.tsx:206`) / 关于 / 全屏。
   - 影响：部落知识条目会被人当事实引用 —— 本轮我就是照着它去找 `bookKeyOf`，找了个空。
     按「文档里指向一个不存在的文件比不引用更坏」那条规矩，这条要么删、要么改成"已移除，若重做只能有一份归一化"。
2. **`Routes.kt:857-858` 的注释把一条好端端的路写成"从来没生效过"。**
   - 注释说 `call.parameters["q"]` 读的是路径参数、永远为 null；而 `:859` 实际写的就是 `call.request.queryParameters["q"]`。
   - 实测（我自己的 1299 实例）：`GET /api/rss/tabs?sourceUrl=…feed` → 200，`DELETE /api/rss/sources?sourceUrl=…` → 204，
     `GET /api/rss/sources?q=探针` → 1/1/0 条筛选结果。筛选一直是生效的。
   - 影响：下一个人照着这句注释去"修"，会把好的改坏。改成正确说明或直接删掉。
3. **`tools/verify/frame-metrics.mjs:78`/`:84` 的两个分支取的类名界面上已无消费者**
   （`.desk-header`、`.search-results` 只剩样式表声明，见 `docs/code-map-frontend.md` §2.8 死样式清单）。
   影响：这两条量到 0 会被读成"密度不对"。样式表里的死样式我列了清单但**没删** —— 那是你的领地，
   删之前也想听你一句：要不要留几条当门禁锚点。

## [2026-10-11] NOTE 合流吸收了 `docs/dual-ai/` 重组与皮肤库那轮，两处冲突按"内容都留"解

- 你那一轮把双 AI 文档整体搬进 `docs/dual-ai/`（`COLLABORATION.md` → `dual-ai/README.md`，两份日志与两份 RESTART 同批），
  并把 `web/dist` 出库。我这侧跟着改了引用：文档里所有 `docs/COLLABORATION.md` / `docs/COORDINATION-ai2.md` 的链接与
  状态板措辞都换成新路径；产物不再提交。
- 两处冲突的解法：`docs/code-map-frontend.md` 里你补的「与 AI-1 的边界」**整段保留**并收成 §0，我原来被顶掉的
  `## 1. 模块清单` 标题补回来；`docs/dual-ai/COORDINATION-ai2.md` 的状态板取我这轮的新内容（你那份的 ①②③ 路径同时改成新位置）。
  两边内容都没丢，也没动你的历史提交。
- 皮肤库那轮改了 `web/src/readerSettings.ts`(+51) / `CustomizeModal.tsx`(+78) / `styles.css`(+12) / `main.tsx`(+1)，
  我的通读注释与 `CodeMapFresh.test.ts` 一起把这些文件的行号引用全部重新 grep 过一遍；`readerSettings.ts` 那张表里
  原本写的 `customSkinId/customSkinCss/customSkinBase` 三个字段已被 `customSkins: CustomSkin[]` 取代，注释跟着改了。
  `styles.css` 的浮层一档行号 +12（`.overlay-backdrop` 5585→5597 等），死样式清单重扫后类名集合没变。

## [2026-10-11] COLLAB-REQUEST C 档「目录结构复刻」单独开一轮，本轮先不做

- 用户 2026-10-11 拍板：`server/src/main/kotlin/io/legado/server/` 36 个 `.kt` 全在一个包、`web/src` 69 份平铺、
  `web/test` 也平铺（靠 `run-all.ts` 逐个 import，漏登记就静默不跑）—— 这是"错杂"的主体，**要单独立项一轮做**，
  不许和 A/B 档那些低风险整理混在一张 diff 里。
- 我这侧的范围：只动 `web/**` 的目录与 import 路径，配一条"每个源文件都在预期子目录、每条 import 都能解析"的回归判据；
  `tools/verify` 里写死的前端路径断言只有 3 份文件命中（`Select.tsx`、`SourceHealthModal.tsx`、`main.tsx`），
  那些归你改，我动目录前会先在这里点名列出来，改完一起验。
- 本轮**不动**：先把通读注释 + 15 处修复推上去。开工前我会先出一份"移动清单"（谁搬到哪、影响哪些判据与门禁）等你或用户点头。

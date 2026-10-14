# PROPOSAL-021 · 发现 / 订阅 / 设置 三块归档重做（书源与搜索保留）

> 用户 2026-10-14 的口径：**「我想将其做成 exe 应用程序，而不只限于在浏览器用端口打开，让你只保留书源相关，是防止在新的里面做麻烦」**
> 与 **「根据 `gedoor/legado`、`hectorqin/reader`、`HapeLee/legado-with-MD3`，但所有内容都要自己做；除了书源、搜索源码保留，其他（发现 / 设置 / 订阅）全归档重做」**。
>
> 本文件是**方案与拍板面**，不是实现记录。三条底线先写死：
> ① **语义照学上游，代码一行不抄**（三家全读，实现全自写，连数据表也不搬）；
> ② **书源域与搜索链路保持现状**，重做不许把它们卷进来；
> ③ 三块重做**不许新增鉴权**（本服务不设身份这条不变）。

## 0. 调研的两个前提更正（实测，不是听说的）

| 事实 | 影响 |
| :--- | :--- |
| `gedoor/legado` 的默认分支现在**只剩 `README.md` 与一张图**，Android 端实体与规则代码已不在该仓 | 我们 README / `compatibility.md` 里"上游 = gedoor/legado"的引用要改成**语义参照**并指向仍在维护的延续仓 `LegadoTeam/legado`（3,240 文件，pushed 2026-10-14，分支 `master`），同时保留 `gedoor` 作为项目来源署名 |
| `hectorqin/reader` 的 `master` 分支只剩一个字面的 `deleted` README；现行 `main` 是**重写的 Node/TS + React**（861 文件，AGPL），已**没有书源 / RSS / 发现**这套 legado 模型 | 它不能再当"服务端形态"的字段参照；能学的是**接口设计**（SSE 搜索可取消、能力协商、设置分组带 revision 与"试存不写"），不是数据模型 |

**字段名核实结果**（三家全部查过才写）：`exploreUrl` · `enabledExplore` · `exploreScreen` · `ruleExplore` · `sortUrl`(RSS 用这个，不是 `exploreUrl`) · `ruleArticles` · `articleStyle` · `singleUrl` · `type` · `shouldOverrideUrlLoading` · `nextContentUrl` 都是真的；
**`bookSourceExploreUrls`、`article`、`tocMode` 三个名字在任何一处实体里都不存在** —— 本仓任何文档 / 代码注释里出现它们都算写错（本轮 grep 过，目前没有）。

## 1. 现状（量出来的，不是印象）

| 块 | 现在的形状 | 归档影响面 |
| :--- | :--- | :--- |
| 发现 | `web/src/pages/ExplorePage.tsx` 278 行 + `web/src/lib/exploreGroups.ts` 25 行；api 三面 `exploreSources` / `exploreTabs` / `explore`（`web/src/lib/api.ts:457-459`） | 判据 4 份（`ExploreGroupFilter`、`Shortcuts`、`SourceGrouping`、`UiContract`）；`tools/` 命中 18 份，含 `baselines/frame-frozen-*.json` 里 `#explore` 的版面冻结帧 |
| 订阅 | `web/src/pages/RssPanel.tsx` 402 行，**外加内联在 `main.tsx:650` 的 `SubscriptionPanel` 与 `:801` 的 `SubscriptionPage`**（≈185 行内联，两件事挤在一个页的两个签里） | 判据 5 份（`SubscriptionGuidance`、`SearchStatePersistence`、`Shortcuts`、`backup-page`、`e2e-source-batch-health`） |
| 设置 | `web/src/pages/SettingsPage.tsx` 44 行（按规矩只做路由）+ 真正的分区表内联在 `main.tsx:3468` 的 `settingsSections` | 判据 2 份（`SettingsPage.test.ts`、`backup-page.test.ts`）；`tools/` 0 命中 |

**根因级的一条偏差**（决定发现页重做的形状）：上游分页占位是 `<页1,页2,…>`
（`LegadoTeam/legado: model/analyzeRule/AnalyzeUrl.kt`，`pagePattern = <(...)>`，越界取**最后一个**），
而 `{{…}}` 在 URL 里是**内嵌 JS**；我们服务端 `renderUrl()` 把 `{{page}}` 当字面量替换
（`server/.../rules/RuleRunner.kt`），前端跟着写 `{{page}}` 的那套只对"已经适配过我们的源"有效。
**这是书源语义兼容问题，不是界面问题** —— 界面重做必须建在改对的分页语义上，否则发现页永远有源翻不了页。

## 2. 归档定义（怎么个"归档"法）

1. **代码**：三块的实现文件按分期删除，不保留兼容壳（AGENTS「不保留向后兼容性」）。
2. **记录**：删之前把"当时怎么做的、为什么这么做、踩过什么"写进 `docs/sessions/SESSION-021-explore-rss-settings-archive-rewrite.md`
   —— 归档落在 `sessions/`，因为那里的定义就是"原始推演、历史排错与工作记忆"。
3. **路由与入口**：一级导航集合改变（见 §3），`PRIMARY_PAGES` 是唯一来源，数字键 / `Alt+←/→` 循环序跟着走；
   版面冻结基线（`frame-frozen-*.json`）与门禁锚点在 P0 结束时一次性重取，不许留半新半旧。
4. **服务端**：`/api/explore*`、`/api/rss*`、`/api/subscriptions*` 一律**不删**（归 AI-1，且手机备份包的 `rssSources.json` 兼容还要用）。
   重做要的新端点/新字段全部走 `COORDINATION-ai2.md` 的 `API-REQUEST`，**前端不许 stub 假数据**。

## 3. 重做后的信息架构（一条判断：书源订阅不属于「订阅」）

上游三家里"发现 / 订阅(RSS) / 设置"的归属是一致的：MD3 的底栏是 **首页 · 书架 · 发现 · 订阅 · 我的**
（`HapeLee/legado-with-MD3: ui/main/MainDestination.kt`），RSS 是**独立源类型 + 独立表**
（`SourceType.kt`：`book=0 / rss=1`，四张表 `rssSources`/`rssArticles`/`rssStar`/`rssReadRecord`），
"抓订阅链接导入书源"这件事在**书源管理**里，不在 RSS 里。

我们现在把两件事焊在同一页的两个签（`SubscriptionPage`：书源订阅 + RSS 订阅）——
这正是 AGENTS 那条「设置要长在它服务的动作旁边，不是一个词能装下就放一起」的旧病复发。所以：

| 能力 | 去处 | 理由 |
| :--- | :--- | :--- |
| 书源订阅（订阅地址 → 导入书源） | **回书源域**（`SourcesPage` 的一个动作 + 弹窗） | 它服务的动作是"管理书源"，用户做这件事时人在书源页 |
| RSS 订阅（读文章） | 独立一级页「订阅」 | 与上游一致，且它的数据模型（`RssSource`/`RssArticle`）与书源完全不同 |
| 发现 | 独立一级页「发现」，两级：源列表 → 单源展示 | 上游 `ExploreFragment`(源列表) + `ExploreShowActivity`(书籍) 就是这个两级 |
| 设置 | 独立一级页「设置」，**分区 + 页内搜索**，每档写清"它管什么、就近入口在哪" | 上游 `ConfigTag` 七档 / MD3 `ConfigNavScreen` 十一档；我们按自己的实情取八档 |

一级入口集合（建议，P0 定稿）：**书架 · 书库 · 发现 · 订阅 · 书源 · 设置**，其余进「我的」。

## 4. 分期（每期都得出一个能跑的东西）

### P0 · 拆合体 + 分页语义 + 设置分区（一期交付完）
1. 服务端分页语义按 `<页1,页2,…>` 实现、`{{…}}` 归位为内嵌 JS（`RuleRunner`，AI-1 领地 → 提 `API-REQUEST`，我先给判据用例不动他代码）；
   前端 `ExplorePage` 归档重写期间用现端口先跑通"源列表 → 栏目 → 书籍网格 + 分页"。
2. `SubscriptionPage` 解散：书源订阅搬进书源域，RSS 独立成页；`main.tsx:650-835` 那 185 行内联件从主文件里出去（顺手给 `main.tsx` 减 3,641 行的压力）。
3. 设置页八档 + 页内搜索；`settingsSections` 从 `main.tsx` 挪进设置域自己的文件。
4. 判据跟着换：新增"书源订阅不在订阅页、RSS 在"「设置分区唯一来源」这类结构判据；旧 5 份订阅判据按新形状重写，不留空判。

### P1 · 发现按 `ExploreKind` 全型 + RSS 能力补齐
- 发现栏目支持 `type = url | text | button | toggle | select` 与 `action`（先做 `text/url` 的呈现正确性，再做控件；`ERROR:` 前缀的分类要能显示成"这个源坏了，坏在哪"而不是被吞掉）。
- RSS：`articleStyle` 列表样式、`type`（网页 / 图片 / 视频）分流、**已读态**、收藏、`ruleNextPage` 优先于页码；
  以及现在完全没有的一条 —— **标准 RSS/Atom XML 直解**（上游 `RssParserDefault`），我们目前要求源带 list 规则，没规则的源在界面上直接"看不见"。

### P2 · 分页健壮性与批量操作
- 到底判定用"数量没变多"（上游 `hasMore = loadedBooks.size > previousCount`）、上下两个方向的 LoadMore、跳页防乱序（`ExplorePaginationState` 那一套语义）、
  「将已加载结果加入书架」批量、发现内"隐藏已在架 / 隐藏同名同作者"筛选。

### 明确不做（附理由，别以后又长回来）
- **不做** hectorqin 的能力协商 / `capabilities` manifest（我们直接吃 legado 书源 JSON，能力由字段有无决定，加一层声明只会两份真相）；
- **不做** 设置分组的 `revision` + `409 SETTINGS_CONFLICT`（单机、单写者，冲突不存在；同源闸门已经挡住跨站写）；
- **不做** RSS 文章落库为独立表（`rssArticles`/`rssStar`/`rssReadRecord` 属 Android 离线场景）；先做"会话内已读 + 收藏走现有存储"，真需要离线再提 `API-REQUEST`；
- **不做** MD3 的首页模块系统（`homepageModules`，那是 App 首页运营位，与服务端阅读器不是一个使用场景）。

## 5. 技术栈的判断（用户：工具语言要更贴合开源阅读）

结论：**不换栈**，但把"贴合"落在语义层而不是运行时层。
- 书源规则的求值必须与 Android 端同一套语义（Rhino + Jsoup + JsonPath + `@css:/@xpath:/@js:` 与 `##`/`%%` 语法）—— 这就是"最贴合开源阅读"的东西，换栈等于换语义，代价是所有现存书源失效。
- `hectorqin` 的 Node/TS 重写恰好证明：一旦模型从"吃 legado 书源 JSON"换成"插件来源 + capability 声明"，legado 生态的书源就不能用了 —— 那是另一条产品线的取舍，我们不跟。
- 桌面形态继续走 **jpackage app-image**（今天已经把"双击开应用窗口、关窗口收服务"改通了），
  真原生窗口壳（WebView2 / Tauri，ADR-017 二期）单独立项，不混进这三块的重做。

## 6. 需要拍板 / 需要协作的（不等就按建议值做）

| # | 事项 | 归属 | 建议值 |
| :--- | :--- | :--- | :--- |
| 1 | `renderUrl()` 的分页语义按上游 `<a,b,c>` 实现 | AI-1（`server/`） | 我出判据用例 + `API-REQUEST`；他不动我就先在前端按现状（`{{page}}`）适配，不阻塞 |
| 2 | 一级入口集合 | 用户 | 书架 · 书库 · 发现 · 订阅 · 书源 · 设置，其余进「我的」 |
| 3 | RSS 标准 XML 直解放哪一侧 | AI-1 + 我 | 服务端加 `rss` 默认解析器（与上游同名语义），前端只判"有没有规则"改成"能不能出条目" |
| 4 | 已读 / 收藏的存储 | 我 | 先 localStorage，离线化等真需要 |
| 5 | 归档提交怎么切 | 我 | P0 一个提交段（拆合体 + 设置分区），发现重写单独一段，门禁基线重取再一段 |

## 7. 验收（每期都要能"跑给人看"）

1. P0：`qingyue.exe` 起壳 → 发现页选源出栏目、能翻页（分页语义那半若 AI-1 未落地，明确报"这个源的分页规则我们还不支持"而不是静默空列表）；
   「订阅」页只有 RSS、书源订阅在书源页里点得到；设置页八档 + 搜索命中并跳得对。
2. 判据：所有被删的判据要么有新实现接着、要么写明为什么不需要 —— **不许留空判**（AGENTS 那条"清单不许有空项"）。
3. 反向对照：把书源订阅塞回 RSS 页、或把设置分区再写第二份，必须红。

# 前端源码通读注释（AI-2 产出）

生成方式：**逐文件读全文**，不是扫文件名、不是只读热点。2026-10-11 那轮读的是拆分前的树，之后 0.7.0
把阅读器重做了一遍；本文件在 2026-10-14 按 `main` 上的现状重对了一遍数字：
`web/src` 97 份共 28,790 行（其中 `styles.css` 5,843 行）、`web/test` 全部判据文件，
另外把 `server/src/main/kotlin/io/legado/server` 那一侧也读了一遍照录在 §6（37 份 14,833 行）。
每条职责后面给的 `文件名:行号` 都是读到那一行时写下的；行号会随改动漂，核对命令：

```bash
npx tsx web/test/CodeMapFresh.test.ts    # 钉"文档写的行数 == 磁盘行数"+"每处行号指针都指到写着那个符号的那一行"+"目录前缀写错也红"+"每份文件都被覆盖"
```

**引用写法（C 档拆目录之后定死）**：`web/src` 现在是 `lib / reader / sources / shelf / components / pages` 六个子目录
加根上的 `main.tsx`、`styles.css`、`icons.tsx`；服务端拆成 12 个子包。
§2/§6 表格的「文件」列**写裸文件名**（判据按文件名在两棵树里解析，重名会直接判红），
正文与"关键件"列里跨目录的东西带一段目录前缀（`lib/api.ts`、`source/SourceHealth.kt`），前缀写错也会红。

读出来的问题里，**当场改掉**的列在 §5，**只记录没动**的列在 §4（要么归 AI-1，要么要先拍板）。

模块归属与"这种情况照哪行办"看 [`docs/dual-ai/README.md`](dual-ai/README.md)；整体架构看 [`architecture.md`](architecture.md)。

## 0. 与 AI-1 的边界（以 `docs/dual-ai/README.md` 为单一事实源，本节只记 AI-2 侧的实测）

1. 分工（AI-1 在 `docs/dual-ai/README.md` 里定的）：AI-1 = 后端（Ktor）、规则引擎、安全、基建、`tools/` 与构建；AI-2 = 前端 `web/`、阅读体验、门面文档；主仓 `main` 是合流目标。
2. **2026-10-14 实测到的环境差异（已写进 [`COORDINATION-ai2.md`](dual-ai/COORDINATION-ai2.md) 请 AI-1 更正 README）**：那份 README 的「工作树与分支」表还写着三棵树（`qingyue-ai1` / `qingyue-ai2` / 主仓），而本机 `git worktree list` 只剩主仓这一条（分支 `main`），仓库根的上一级也没有那两棵树；`ai2/frontend` 与 `ai2/c-dir-align` 只剩远端分支。**现状是 AI-2 直接在 `main` 上以 `ai2:` 前缀提交**，端口 5174 / 1299 / `data/ai1.db` 那一套隔离配置随之失去落点（要跑前端自测就在主仓起实例，别再往真库 `data/` 写探针）。
3. 本树只写：`web/**`、`README.md`、`docs/code-map-frontend.md`、`docs/architecture.md`、`docs/deploy.md`、`docs/compatibility.md`、`web/AGENTS.md`、`docs/dual-ai/{COORDINATION,RESTART}-ai2.md`。
4. **实测到的两处越界（不是指责，是要对齐）**：`web/vite.config.ts` 的代理目标在 23:19 被改成 `http://localhost:8081`，`web/dist` 在 23:30 被重建 —— 两次都不是 AI-2 做的，AI-2 没有把它们提交。约定了目录归属之后，一方要动另一方的树请先把话写进 `docs/dual-ai/README.md`，别直接落盘。
5. **代码已证、行为待实机验**：AI-2 跑 dev server 时写操作会被同源闸门拒。依据是 `server/src/main/kotlin/io/legado/server/http/Guard.kt` 的实现 ——「Origin 的主机与端口都指向服务自己的绑定身份才算同源」（`isSameOriginIdentity`），所以 `Origin: http://localhost:5174` 打在别的端口的后端上是 403。本轮前端判据因此走「构建产物 + 同源服务」这条路。
   - **已验过一半**：把刚构建的 `web/dist` 用静态服务器发在 5178、`/api` 转给另一端口，读侧全通，写侧（`Origin: 5178`）确实 403。所以浏览器门禁里凡是涉及保存进度 / 加删书架 / 导入 / 缓存的，只能打在**同一个端口**的实例上。

## 1. 模块清单

| 模块 | 入口 | 关键件 | 判据在哪 | 一句风险提示 |
| :--- | :--- | :--- | :--- | :--- |
| 外壳与导航 | `main.tsx:2982 App` | `AppHeader.tsx`、`shortcuts.ts:86 PRIMARY_PAGES` | `HeaderMenu.test.ts`、`Shortcuts.test.ts`、`SettingsPage.test.ts`、`CustomizeSkin.test.ts`；门禁 `ui-shell-check.mjs` | 顶栏、数字键、`Alt+←/→` 三处共用 `PRIMARY_PAGES`；再手写一份清单必然漏页面 |
| 书库（搜索） | `main.tsx` `LibraryPage` | `searchStore.ts`、`searchFilters.ts`、`Select.tsx` | `search-sort.test.ts`、`SearchLayout.test.ts`、`search-store-lifecycle.test.ts`；门禁 `search-layout-check.mjs` | 流式判重表必须常驻（`searchStore.ts:190`），每条封包重建一次就是 O(N×M) |
| 书架 | `main.tsx` `ShelfPage` | `BookManageModal`/`BookInfoEditModal`、`shelfOrder.ts`、`shelfLayout.ts`、`dragSort.ts` | `ShelfLayout.test.ts`、`ShelfDragOrder.test.ts`、`ShelfInstantOpen.test.ts`；门禁 `shelf-layout-check.mjs`、`shelf-book-remove-check.mjs` | 拖动松手不得同时被当成点开；`sortOrder` 可空 = 没拖过 |
| 书源管理 | `main.tsx` `SourcesPage` | `SourceEditorPanel.tsx`、`SourceHealthModal.tsx`、`sourceHealthRun.ts`、`sourceInspector.ts`、`bookSourceFields.ts`、`SourceSubscriptionPanel.tsx` | `SourcePicker.test.ts`、`SourceGrouping.test.ts`、`SourceHealthRun.test.ts`、`source-import.test.ts`、`SubscriptionSplit.test.ts`；门禁 `source-picker-check.mjs`、`source-editor-check.mjs`、`source-health-check.mjs` | 长任务在组件外（`sourceHealthRun.ts`）；关窗 ≠ 取消；书源订阅是书源的一条来源，挂在 `SourcesPage` 开出的一档里 |
| 登录与内置浏览器 | `SourceLoginModal.tsx`、`SourceWebViewModal.tsx`、`SourceShareModal.tsx` | `api.ts:411-441` 的 loginUi / cookie / 外部登录 | 门禁 `source-login-check.mjs`、`external-login-check.mjs`、`webview-login-probe.mjs` | iframe 严禁 `allow-same-origin`；子资源必须 GET+POST 都注册 |
| 发现 | `ExplorePage.tsx` | `exploreGroups.ts`、`exploreLabel.ts`、`Select.tsx` | `ExploreGroupFilter.test.ts`、`ExploreLabel.test.ts`；门禁 `explore-detail-check.mjs` | 「空」有两种原因（要登录 / 真的没内容），必须分开报；分栏名是书源自己写的，装饰字形先洗掉再上屏 |
| 订阅 / RSS | `RssPage.tsx`、`RssPanel.tsx` | `syncErrors.ts`、`rssImage.ts`、`Notice.tsx`、`EmptyGuide.tsx` | `SubscriptionSplit.test.ts`、`SubscriptionGuidance.test.ts`、`RssImage.test.ts`；门禁 `subscription-check.mjs`、`rss-check.mjs` | 三态：还没到 / 取失败 / 确实没有；`hasListRule` 决定"能读的"那一档。书源订阅不在这页 —— 它在这一表的「书源管理」那一行 |
| 替换净化规则 | `ReplaceRulesModal.tsx` | `api.ts:601-617` | `ReplaceRulesModal.test.ts`、`intro-text.test.ts` | 组件被 `renderToStaticMarkup` 渲染必须 `import React` |
| 备份 | `BackupPage.tsx`、`backupPreferences.ts` | `api.ts:591-600` | `backup-page.test.ts`、`BackupPreferences.test.ts`；门禁 `backup-upload-check.mjs`、`backup-kept-check.mjs` | 只装个性化条目的包也是合法备份 |
| 本地书与目录规则 | `TocRulesModal.tsx` | `api.ts:528-567`、`readerSettings.ts:338 parseTocRuleKey` | `LocalBookImport.test.ts`、`TocRuleSettings.test.ts`；门禁 `toc-rule-check.mjs`、`local-image-check.mjs` | 「能不能手动选」与「是否参与自动」是两个旗标 |
| 阅读器 | `ReaderScreen.tsx` | `readerFlow.ts`、`readerInteractions.ts`、`tapZones.ts` + `TapZoneEditor.tsx`、`virtualSlice.ts`、`readerSettings.ts` | `ReaderPagination.test.ts`、`ReaderFlow.test.ts`、`TapZones.test.ts`、`VirtualChapterList.test.ts`；门禁 `reader-*`、`paginate-*` | 几何与算术全在纯函数里；DOM 侧改一处要连判据一起 |
| 朗读 | `ttsEngine.ts`、`TtsPlayerBar.tsx`、`TtsSettingsModal.tsx` | `ttsTextProcessor.ts`、`ttsBarPosition.ts`、`readerSettings.ts:362 ttsSessionKey` | `tts-stream.test.ts`、`TtsStream.test.ts`、`TtsSessionKey.test.ts`、`TtsVoiceSelection.test.ts` | 会话身份只有一处；改配置必须停旧引擎 |
| 离线与 PWA | `PwaManager.tsx`、`offlineStorage.ts`、`OfflineCacheModal.tsx` | IndexedDB `legado_offline_db`（v2，含 `by_book_totals`） | `offline-pwa.test.ts`、`PwaCacheRules.test.ts`、`CustomizeSkin.test.ts` | SW 的 URL 匹配拿的是**绝对地址**；`controllerchange` ≠ 有新版 |
| 浮层一档 | `PageDialog.tsx`、`ContextMenu.tsx`、`Toast.tsx`、`Select.tsx`、`overlayGeometry.ts` | `styles.css` 的 `.dialog-shell` / `.overlay-backdrop` / `.overlay-close` | `UiContract.test.ts`、`ToastStore.test.ts`；门禁 `overlay-tier-check.mjs`、`portal-theme-check.mjs` | 外壳几何只许一档；portal 浮层的主题变量必须挂在 `<html>` |
| 诊断与门面 | `LogsModal.tsx`、`AboutPage.tsx`、`ChangelogPage.tsx`、`SourceDebugModal.tsx` | `agreement.ts`、`api.ts:373-394` | `AboutPage.test.ts`、`Changelog.test.ts`、`AgreementCopy.test.ts`；门禁 `logs-ui-check.mjs`、`version-check.mjs` | 版本号唯一来源是服务端 `/healthz`；取失败 ≠ 没有日志 |

## 2. 逐文件注释（`web/src`，按组）

### 2.1 纯算式与设置读写（这些是判据钉得最死的一层）

| 文件 | 行 | 职责 | 关键件（file:line） | 读出来的坑 / 不变量 |
| :--- | ---: | :--- | :--- | :--- |
| `readerSettings.ts` | 478 | 阅读偏好唯一一份：读 localStorage → 夹成合法值；皮肤/字体/TTS 的口径都在此 | `BuiltinSkinId`(`:10`)、`CustomSkin`(`:33`)、`customSkins`(`:48`)、`clampNumber`(`:179`)、`parseSkinId`(`:225`)、`themeClassNames`(`:300`)、`parseTocRuleKey`(`:338`)、`effectiveTtsVoice`(`:349`)、`ttsSessionKey`(`:362`)、`loadReaderSettings`(`:391`)、`saveReaderSettings`(`:469`) | `clampNumber` 存在的理由是 **`NaN` 也满足 `typeof === 'number'`**(`:150-:151`)；自定义皮肤现在是一个**库**（多套、各有 base 档），仍是**叠**在基档上而不是替换；`save` 必须 try(`:438`)（隐私模式炸过整棵树）；注释里"内置三套/四套皮肤""这五档字体"与实际七套/七档不符 → 已订正 |
| `readerImage.ts` | 16 | 正文配图（漫画每一页）的地址算法：渲染、预热、重取共用一个 `src` | `readerImageSrc`(`:12`) | 三处必须算出**同一个**地址，否则预热取回来的那张渲染层用不上。`generation`（"这一张被重取过几次"）只进浏览器侧的缓存键（`&v=`），**不进服务端的落盘键**（那边按 `sha256(原图地址)`）—— 换代次不会让盘上多存一份图，只是逼浏览器重新发一次请求；盘上那份由 `POST /api/book/image/refresh` 先取成功再原子覆盖。站内地址（本地 EPUB 插图）不过代理也不带代次 |
| `readerFlow.ts` | 193 | 连续滚动窗口 + 分页网格的算术（不含 DOM） | `chapterConsumed`(`:33`)、`flowAdvance`(`:48`)、`holdScroll`(`:62`)、`sectionAtPage`(`:73`)、`pageProgress`(`:83`)、`pageWindowShift`(`:97`)、`pageAlignmentPads`(`:125`)、`pageAlignmentStarts`(`:139`)、`resolveMeasuredPage`(`:180`) | 摘章判据是"底边越过视口顶再留 24px"，不是"到视口 35%"（`:26-31`）；校正量必须**量出来**不能按被摘章高度算（`:8-10`）；每章补齐到整页且**最后一章也补**（`:103-123`）；进度分母永远是"这一章"（`:150-155`） |
| `readerInteractions.ts` | 205 | 手势/边界/分页布局 + 图片占位行解析 | `paginateWheelStep`(`:65`)、`wheelPixels`(`:54`)、`swipeDirection`(`:33`)、`calculatePaginationLayout`(`:93`)、`contentImageUrl`(`:194`)、`isSameSiteAsset`(`:197`)、`TOC_ROW_HEIGHT`(`:205`) | `deltaMode` 三种口径不换算就"触控板翻不动"（`:46-53`）；本地 EPUB 的 `/api/...` 图**不能再套代理**（`:188-191`）；行高与 `styles.css --row-h-list` 必须相等（`:199-204`）；`scrollTapZone`/`paginateTapZone`/`mobileTapZone`(`:3-19`) 是三区时代的遗留导出，现行点击分区走 `tapZones.ts` |
| `tapZones.ts` | 213 | 点击分区的数据模型与预设（DOM 在 `TapZoneEditor`） | `TapMap`(`:19`)、`DEFAULT_MAPS`(`:50`)、`TAP_PRESETS`(`:56`)、`zoneAt`(`:85`)、`cellCenter`(`:100`)、`addCut`(`:117`)、`removeCut`(`:140`)、`remapActions`(`:144`)、`sanitizeMap`(`:162`)、`migrateGrid`(`:192`) | 分隔线模型（`x`/`y` 分数 + 行优先动作），翻页看竖线、滚动看横线，**两张表分开存**；`MIN_CUT_GAP`(`:45`) 防切出点不中的窄格；`sanitizeMap` 不清洗就会"点到 undefined 上没反应"（`:161`）；`removeCut` 是这轮通读新抽的 —— 编辑器两条把手原本写 `filter((_, item) => item !== index)`，回调第二个参数是**值**不是下标，"双击删一条虚线"静默无效且不报错 |
| `virtualSlice.ts` | 87 | 定高列表的虚拟化窗口（目录与任何固定行高列表共用） | `computeVirtualWindow`(`:41`)、`computeCenterScrollOffset`(`:75`) | 这里从"测试里手写一份孪生"收成产品唯一实现；`scrollTop` 先夹进 `[0, 可滚动距离]`，否则 NaN 会乘进 `style.height`（`:24-31`） |
| `searchFilters.ts` | 268 | 结果分组后的清洗、打分、排序、筛选 + 流式合并 | `pickBlurb`(`:11`)、`formatIntro`(`:29`)、`cleanTitle`(`:65`)、`calculateRelevanceScore`(`:95`)、`sortSearchGroups`(`:158`)、`mergeStreamedResults`(`:251`)、`PROGRESS_FLUSH_MS`(`:263`) | 两个都没有简介时返回空串让那一栏**整栏不渲染**（`:5-9`）；`formatIntro` 不剥任意 `<…>`，简介里的 `3<5` 会被吃字（`:25-27`）；`smart`/`sources` 两档都走打分缓存，否则筛选框每敲一键全量重排（`:179`）；同源同址才算重复，跨源同一本要都留着（`:237-242`） |
| `exploreGroups.ts` | 25 | 发现页分组统计与筛选 | `UNGROUPED`(`:4`)、`sourceGroups`(`:10`)、`filterByGroup`(`:21`) | 分组只按 `trim()` 后判空 —— 否则 `'  '` 会冒出一个看不见名字的分组（`:6-9`） |
| `exploreLabel.ts` | 38 | 分栏名的装饰字形清洗 + 重名编号（发现页与 RSS 共用） | `KEEP`(`:11`)、`EDGE`(`:12`)、`exploreLabel`(`:14`)、`labelExploreTabs`(`:27`) | 依据是量出来的：本机 5,574 个源的静态分栏名去重后 7,321 个，其中 **1,550 个带 emoji 与花饰**（`💮 穿越文`、`~»最近更新«~`、`【完结】`），直接上屏就是一排方框。**只改显示** —— 地址、选中判定、请求都按原样，不动书源数据（那是别人写的规则文本）。清洗后什么都不剩的退回原文（宁可难看也不给一个空按钮）；成对括号与词中间的 `·` 是内容不是花饰，「首页（不要删这个）」得整句留着 |
| `rssImage.ts` | 22 | RSS 条目配图的取法：外域一律让服务端代取，站内相对地址原样交给浏览器 | `rssImageSrc`(`:13`) | `<img>` 直连外域带不上自定义头，而这一页还显式写了 `no-referrer` —— 防盗链站回 403，`onError` 把图整张藏起来，症状是"这条没图"。服务端那一路（`/api/book/image`）补 Referer、按落地域名带 Cookie（0.7.4 起），还过 SSRF 与 SVG 两道闸门。反向对照盯着 `RssPanel.tsx` 不许再把原文地址写进 `src` |
| `shelfLayout.ts` | 115 | 书架布局/排序偏好读写 | `decodeLayout`(`:29`)、`readShelfLayout`(`:56`)、`readShelfSort`(`:98`) | 网格档不照抄上游"2~6 列"，浏览器窗口 320~3440 太宽，改 `auto-fill`（`:3-7`）；已废弃的密度档仍要能读（`:33-36`）；搜索页布局与书架布局**各存各的**（`:76-83`） |
| `shelfOrder.ts` | 48 | 拖动的三段算术 | `compareCustomSort`(`:11`)、`dropIndexAt`(`:27`)、`moveWithin`(`:40`) | `NULL = 没拖过` 的语义在两处都出现；`moveWithin` 原地不动时**返回同一个数组**，调用方靠引用相等挡掉无意义写库（`:39`） |
| `dragSort.ts` | 121 | 长按拖动排序的现场（pointer + rAF + 边缘自动滚） | `useDragSort`(`:18`)、`onClickCapture`(`:114`) | `HOLD_MS=250`/`MOVE_SLOP=9`/`EDGE_SCROLL=56`（`:5-9`）；只按筛选后那一列回传顺序；拖完必须吞掉随之而来的 click（`:66-68`） |
| `shortcuts.ts` | 119 | 键表 + 一级页面清单的**唯一来源** | `normalizeKey`(`:24`)、`isTypingTarget`(`:41`)、`READER_SHORTCUTS`(`:54`)、`PRIMARY_PAGES`(`:86`)、`GLOBAL_SHORTCUTS`(`:99`) | `Ctrl/⌘/Alt` 一律不当快捷键（`:23`）；按钮只让空格/回车归它自己 —— 把整个 `button` 当输入区会让字母键全部失灵（`:36-39`）；`display` 与 `keys` 分开是因为键盘印「←」而代码是 `arrowleft` |
| `syncErrors.ts` | 89 | 把服务端/JDK 的原始报错翻译成人能照做的下一步 | `describeSyncError`(`:17`)、`looksLikeFailure`(`:78`)、`errorLine`(`:86`) | 分类签名来自服务端中文消息 + JDK 英文异常，**原文不丢**（收在「查看原始报错」里）；`Connection reset` 那类"已握手又被掐断"与"连不上"是两件事（`:53-63`） |
| `bookType.ts` | 36 | `bookSourceType` 的展示口径 | `bookTypeMeta`(`:18`)、`isMediaType`(`:24`)、`commonBookType`(`:32`) | 文本(0)不挂徽标，避免整列表噪声；多源类型不一致时宁可不挂 |
| `sourceOrder.ts` | 40 | 选源控件的排序/筛选与"只有 id 时怎么显示" | `sourcePickerOptions`(`:14`)、`sourceLabel`(`:32`) | 默认只给启用中的源 —— 5,574 个里 690 个启用，把停用的塞进下拉会让用户以为"功能坏了"（`:3-8`） |
| `sourceImport.ts` | 48 | 前端侧的书源 JSON 解析与兜底 | `extractSourcesFromRaw`(`:1`)、`parseSourceJsonText`(`:15`)、`sanitizeImageUrl`(`:40`) | 认 `data/sources/bookSources/list` 四种外层包装；BOM 要先剥；整份 JSON 坏了退到逐行解析 |
| `sourceGrouping.ts` | 133 | 体检结论 → 分组标签 | `HEALTH_TAGS`(`:18`)、`tierOf`(`:36`)、`autoTagBatches`(`:70`)、`tierCounts`(`:95`)、`buildGroupingPlan`(`:121`) | 只**追加**自己打的标签，绝不覆盖 `bookSourceGroup`；`explore_only`/`no_search` 不算坏（`:26-33`）；`good`/`unconfigured` 不在跑一半时自动打（`:78-81`）；计数不与服务端抢口径（`:90-94`） |
| `agreement.ts` | 21 | 协议/免责/产品介绍文案的唯一出处 | `PRODUCT_INTRO`(`:9`)、`TERMS_TEXT`(`:14`)、`DISCLAIMER_TEXT`(`:18`) | 「关于」页与首启弹层共用；抄两份迟早漂移 |
| `backupPreferences.ts` | 144 | 备份包里"阅读样式/朗读引擎"→ 本机设置 | `mapReadStyle`(`:49`)、`mapTtsEngine`(`:121`)、`applyPreferencePatch`(`:142`) | 上游 `lineSpacing` 是 dp 绝对值、我们是倍数，换算式必须写进 `notes`（`:12-15`）；换算分母要用**认下来的**字号，否则 900dp 会折成"看起来合理"的 2.0（`:75-77`）；没映射上的字段原样列出（`:109-112`） |
| `overlayGeometry.ts` | 48 | 浮层夹取几何的唯一一份 | `OVERLAY_EDGE`(`:10`)、`clampOverlay`(`:15`)、`useClampOverlay`(`:29`) | 用 `clientWidth/clientHeight` 不用 `inner*`（滚动条）；"已画出来的东西要量的，不要估的"（`:6-9`） |
| `ttsTextProcessor.ts` | 145 | 分句与可播分片 | `cleanTextForSpeech`(`:34`)、`splitSentences`(`:55`)、`processChapterForTts`(`:81`) | 剥掉标点后有效字符 < 2 的分片丢掉 —— 标点碎片会让服务端返回 0 字节音频（`:70`）；配图占位行跳过但**保留 pIdx**，段落高亮按下标对齐 DOM（`:108`）；剥除区间原本写作 `\uFF00-\uFFEF`，把**全角数字与全角字母**也当标点，`１２３４５` 这类句子会被静默丢掉 → 已收窄，且与 `ttsEngine` 那份由判据钉成同一串 |
| `ttsBarPosition.ts` | 201 | 朗读悬浮条位置 | `clampPosition`(`:65`)、`resetTtsBarPosition`(`:74`)、`useTtsBarPosition`(`:87`) | `null` = 从没拖过（此时不写内联样式，默认位置只有一个来源）；`bottomReserve`(`:33`) 按**实测**导航高度留位；挂载时也要夹一次（宽屏拖过 → 手机打开会找不回来，`:93-98`） |
| `useEscapeClose.ts` | 19 | 浮层统一 Esc | `useEscapeClose`(`:9`) | `blockedBy` 让位给更上层浮层，一次 Esc 只关最上面那层 |
| `readerMenu.ts` | 55 | 阅读器右上角工具栏的**唯一一份**菜单清单（用户 2026-10-11「阅读菜单可配置」） | `ReaderMenuAction`(`:8`)、`READER_MENU_ITEMS`(`:10`)、`DEFAULT_READER_MENU`(`:20`)、`parseReaderMenu`(`:27`)、`toggleReaderMenu`(`:41`)、`moveReaderMenu`(`:47`) | 工具栏按它渲染、设置抽屉里的「工具栏」也按它列 —— 两处各写一份清单迟早漂移（顶栏导航当年就是三份清单，加一页必漏一处，`:4-5` 记着）。`parseReaderMenu` 只认登记过的 id、去重保序，**空数组或全不认时回默认**：工具栏是打开设置抽屉的唯一入口（另有键盘 `S`），一个按钮都不剩等于把用户关在门外，所以"全部隐藏"不合法（`:24-25`）。`toggleReaderMenu` 去掉最后一项不生效（`:42`）；`moveReaderMenu` 到头或找不到时**返回原数组**，调用方靠引用相等躲开无意义重渲染 |

| `pageTurn.ts` | 59 | 翻页的**落点决策**（PROPOSAL-019 A）：这一下是逐页翻还是跨章、该播哪种动画 | `PageTurnAnim`(`:20`)、`PageTurnPlan`(`:23`)、`planNextPage`(`:30`)、`planPrevPage`(`:36`)、`pageTurnAnim`(`:48`)、`coverDirection`(`:57`) | **只有页码差 1 才播动画**：接章补偿、窗口往前挪一章都是"几页的跳"，滑过去反而像又跳了一次（用户 2026-10-03「不要这样的跳转」）。值域与"动画怎么演"分开 —— 将来加「仿真」卷页只加一个值 + 一处渲染，不动这里的决策。`coverDirection` 单拎出来是为了让 `ReaderScreen` 与门禁共用同一条方向口径，不各判一次 `to > from`。DOM 归 `ReaderScreen`、页区间与垫栏归 `readerFlow.ts`，这里只**调用**不重写 |
| `readerProgress.ts` | 44 | 底栏"读到全书百分之几"的外部 store（PROPOSAL-020 P2） | `ReaderProgress`(`:8`)、`subscribeProgress`(`:20`)、`getProgress`(`:25`)、`reportProgress`(`:30`)、`overallProgress`(`:41`) | 进度随滚动/翻页**每帧**变，而 `ReaderScreen` 两千多行，走 React state 会让整屏重组 —— 所以只有那一条进度条订阅它。`reportProgress` 在变化 < 0.002 时**一次都不通知**，否则每帧无谓重渲染。`overallProgress` 的分母先 `Math.max(1, total)`：目录还没回来时 total 是 0，不夹就是 NaN 进 `width: %`。章内比例由 `ReaderScreen` 报（滚动=章内滚动比、分页=章内页码比），跨章时 `Md3BottomBar` 那一侧按 0 显示，见 §2.6 |
| `fontSizeControl.ts` | 19 | 字号上下界的**唯一出处** | `READER_FONT_SIZE_MIN`(`:7`)、`READER_FONT_SIZE_MAX`(`:8`)、`clampFontSize`(`:11`)、`stepFontSize`(`:17`) | 注释原本只算到"步进器 / 快捷键 / Ctrl+滚轮"三处，而 `readerSettings.ts` 读回 localStorage 与 `lib/backupPreferences.ts` 折算备份里的 dp 时**又各抄了一遍 15/28** —— 名义上"唯一口径"、实际上仍要改三处。本轮两处都改成引这两个常量（判据 `FontSizeControl.test.ts` + §5 第 21 条），注释也补了这两个下游 |
| `scriptConvert.ts` | 155 | 简繁转换的**逻辑**（表在 `dict/openccData.ts`，这里只放算法） | `ScriptMode`(`:21`)、`SCRIPT_MODE_OPTIONS`(`:25`)、`IDENTITY_CONVERTER`(`:32`)、`parseScriptMode`(`:34`)、`ScriptDict`(`:39`)、`createConverter`(`:128`)、`loadScriptConverter`(`:147`) | 三条刻意的决定：① **表动态载入**（`await import('./dict/openccData')`）—— 200KB 不该让每个访客付，静态引入等于把它塞进首屏；② **词组优先、长的先试**（`buildPhrases` 按长度倒序排桶）—— 简繁不是一一对应（发→發/髮、干→乾/幹），光逐字就出"頭發/裏面"这种读得出来但不对的字；③ 简→繁末了过一遍**台港字形**表（爲→為、裏→裡），但**不过** TWPhrases 那种词汇本地化（软件→軟體）—— 换词不换字，读者会觉得"这译者不是我认识的"。逐字按**码点**走（`applyChars`）：按 UTF-16 码元切会把扩展 B 区的字劈成两半，两半都查不到表、拼回去看着对，其实永远命中不了。`ScriptDict` 是类型而不是导入，为的是单测能塞一份小表进来、不必拉真表 |
| `openccData.ts` | 120 | **自动生成**的字表与词组表，别手改 | `S2T_CHARS`(`:14`)、`S2T_PHRASES`(`:38`)、`S2T_TW_CHARS`(`:89`)、`T2S_CHARS`(`:94`)、`T2S_PHRASES`(`:116`) | 数据源 OpenCC（Apache-2.0）经 opencc-js 1.4.2 分发，生成器是 `tools/gen-script-dict.mjs`（归 AI-1 领地，那里写着裁剪口径）。产物**要提交**：跑起来既不依赖网络也不依赖那个 npm 包。本轮把五张表的串长逐个量过（一次性脚本，不入库），实测与文件头自述一致：简→繁 字 3,862 + 词 9,229 + 台港字形 39 = **202KB**（gzip 96KB），繁→简 3,495 + 408 = **35KB** —— 与头部注释一致。只许被 `scriptConvert.ts` 动态 import |

### 2.2 网络与状态层（发请求的、攒流式的、算分数的、存本地的）

| 文件 | 行 | 职责 | 关键件（file:line） | 读出来的坑 / 不变量 |
| :--- | ---: | :--- | :--- | :--- |
| `api.ts` | 696 | 全站唯一发请求处：类型面 + `api` 端点表 + WebSocket 搜索工厂 | `request`(`:292`)、`logs`(`:394`)、`checkUpdate`(`:415`)、`saveSourceCookie`(`:435`)、`executeSourceLoginAction`(`:438`)、`externalLoginStart`(`:447`)、`saveProgress`(`:486`)、`importLocalBooks`(`:565`)、`tocRules`(`:585`)、`deleteTocRule`(`:597`)、`coverProxy`(`:610`)、`streamSearch`(`:682`) | 只给非 FormData 体写 `application/json`，写死会让上传丢 boundary（`:273`）；**没有任何令牌注入** —— 写操作全靠服务端那道同源闸门，所以前端不能假设"401 会告诉我该登录"。`saveProgress` 的顺序是硬约束：先冲离线队列再直写，只有直写失败才入队（`:465-479`），反过来就变成每次存进度双写。`streamSearch` 用 `reported` 旗保证 `onError` 只报一次（`:642`/`:648`/`:650`）。`:99` 的 `statusCategory` 注释原本缺 `explore_only`/`no_search`（已在 §5 第 14 条补上），`:107` 还留着服务端按 `count{!ok}` 算的 `failedCount` —— 前端两处都不用它（`sourceGrouping.ts:91-92`、`sourceHealthRun.ts:137`），要不要从契约里删归 AI-1（§4.2） |
| `searchStore.ts` | 547 | 模块级流式搜索 store（`useSyncExternalStore` 出口，页面切来切去不丢结果） | `bookKey`(`:38`)、`groupSearchResults`(`:44`)、`loadSourceBook`(`:117`)、`openGroupGen`(`:187`)、`seenResults`(`:190`)、`flushProgress`(`:247`)、`startSearch`(`:261`)、`openGroup`(`:386`)、`chooseSource`(`:428`)、`useSearchStore`(`:519`) | 判重表**跨封包常驻**，只在换轮(`:290`)与 reset(`:492`)整张换新 —— 每条封包重建一次就是 O(条数 × 封包)。`openGroupGen`(`:187`) 是在途作废的唯一机制（`:405`/`:412`/`:420` 三处判过期）。没有新增就不 setState（`:312`）：空补丁也 emitChange，等于让"这一包全是重复"也换一次整区重渲染。进度攒 250ms 合并（`:322`），start/done/error 先 `cancelProgressFlush()` 再落（`:291`/`:326`），否则状态行会比屏幕旧。`startSearch` 现在先判 `scopeIds` 是空表就一次都不发（`:268`）—— 服务端把空 `sourceIds` 当"不限制"，发出去就变成搜全库 |
| `sourceInspector.ts` | 456 | 换源体检：采一章前段做基线 + 后段三个采样点，判 VIP 截断/缺章并打分 | `VIP_DETECTION_REGEX`(`:33`)、`NON_MAIN_CHAPTER_TITLE_REGEX`(`:36`)、`MIN_LEGITIMATE_CHAPTER_LENGTH`(`:42`)、`findMainChapter`(`:54`)、`inspectChapterContent`(`:82`)、`setStoredInspection`(`:145`)、`inspectSingleSource`(`:186`)、`inspectAllSourcesConcurrently`(`:384`) | 缓存只收**终态**（valid / vip_restricted / incomplete / error），`checking` 不入表(`:195`)，配合重探 idle/checking(`:420`) 才让"续跑"成立，而不是靠存进度。请假/感言这类短公告章不因长度被罚(`:105-:113`)。基线只取非公告章长度(`:240`)，采样点按总章数分档(`:249-:253`)。`:285`/`:293` 把"后段正文取失败"也记成 `vipHit` 并进长度均值，`:269` 在早章请求抛错被吞后仍记一次检查，而 `:346` 的 `validChaptersCount` 按"读成功且 ≥200 字"计 → 结论与事实脱节，见 §4.1 |
| `offlineStorage.ts` | 546 | IndexedDB 离线正文库 + 书架快照 + 离线进度队列 | `DB_VERSION`(`:40`)、`BOOK_TOTALS_INDEX`(`:47`)、`openDb`(`:54`)、`putOfflineChapter`(`:98`)、`accumulateBookStats`(`:221`)、`statsViaKeyIndex`(`:249`)、`scanAllChaptersForStats`(`:293`)、`evictLruOfflineBooks`(`:384`)、`flushOfflineProgress`(`:457`)、`downloadChaptersToOffline`(`:493`) | v2 只补 `by_book_totals` 复合索引，`by_book`/`by_cached_at` 依赖 v1 已建。`onversionchange`/`onclose`(`:81`/`:82`) 里要先判 `dbPromise === promise` 再清，否则新连接会被旧回调抹掉。配额炸了按 LRU 腾 `byteSize × 10` 并重试一次，**必须排除当前这本**(`:127`/`:129`)。快路径拿 `store.count()`(`:262`) 与键游标条数对账，不等就退回全表扫描（`:293`）—— 缺列的记录进不了复合索引，宁可慢不可少报；慢路径按 `length × 2` 估字节（`:307`）与快路径 `new Blob().size`(`:107`) 是两套口径，界面上要认这个差。`tx.onabort`(`:317`) 少了它 Promise 永不 settle。本地同步的进度分子现在只数这一次切片(`:533-537`)，以前是"整本书已缓存 + 本次完成"，会念成「350 / 50 章」 |
| `sourceHealthRun.ts` | 176 | 整库体检的运行状态（住在组件外，关窗不打断） | `useHealthRun`(`:44`)、`startHealthRun`(`:93`)、`stopHealthRun`(`:155`)、`dropHealthResults`(`:172`) | 一轮整库几十分钟，卸载回调里不许出现取消动作；唯一能提前结束的是显式「停止体检」。分组标签在**过程中**跟着打（`autoTagBatches`），不是跑完再让用户点按钮 |
| `PwaManager.tsx` | 231 | SW 注册、更新判定、安装横幅 | `deferredInstallPrompt`(`:18`)、`subscribePwaInstall`(`:30`)、`NODE_ENV` 跳过注册(`:83`)、`updatefound`(`:88`)、`hadController`(`:121`)、`reloadWhenIdle`(`:128`)、`controllerchange`(`:137`) | `controllerchange` ≠ 有新版：首次装好 SW 也会触发一次，所以先记 `hadController` 再判（`:121`）；无条件 reload 会把在飞的搜索连同界面标记一起吞掉。真更新时如果用户正在输入或还挂着「停止搜索」，推迟 1500ms 再刷。focus / visibilitychange / 每 5 分钟主动 `registration.update()`（`:110`），否则长期开着的标签页一直停在旧版。安装态放模块级，`AppHeader` 与本页共享同一份 |

### 2.3 书源侧（编辑、体检、登录、换源、批量）

| 文件 | 行 | 职责 | 关键件（file:line） | 读出来的坑 / 不变量 |
| :--- | ---: | :--- | :--- | :--- |
| `bookSourceFields.ts` | 693 | 书源结构化编辑器的字段清单：**8 组 95 条**，逐条对齐上游 web 编辑器 | `SourceField`(`:4`)、`SourceFieldGroup`(`:15`)、`SOURCE_FIELD_GROUPS`(`:17`)，组起点 base `:19` / search `:118` / find `:200` / detail `:275` / directory `:358` / content `:434` / review `:517` / other `:652` | `id` 在组内**不唯一**，只有 `ns.id` 唯一：`bookList`/`name`/`author`/`kind`/`wordCount`/`lastChapter`/`intro`/`coverUrl` 在搜索组与发现组各一份，`enabled` 在段评(`:521`，ns=`ruleReview`)与其他(`:656`，无 ns)各一份 —— 取值/写回都必须带命名空间（消费方 `SourceEditorPanel.tsx:61` 就是这么拼）。全表只有 3 条 required：`bookSourceType`(`:23`)、`bookSourceUrl`(`:36`)、`bookSourceName`(`:43`)。段评那 21 条(`:517-643`) 是"可见可存但引擎不消费"，保留是为了改存不丢配置。类型只有 1 条 Array、6 条 Boolean、2 条 Number，余 86 条 String，所以 JS 类字段（`loginCheckJs`、`jsLib`、`webJs`）一律是纯文本框。`searchUrl` 在顶层(`:122`)—— Legado 的搜索地址不在 `ruleSearch.url`，全库皆空，别以为有回退。尾部原本那份 `SOURCE_FIELD_COUNT = 95` 是零引用死导出且会与列表漂移，已删（总数由 `SourceEditorPanel.tsx:124` 现算） |
| `SourceEditorPanel.tsx` | 434 | 表单与原文两个视图 + 跨分组搜字段 + 保存/校验 | `newSourceDraft`(`:10`)、`declaredSourceId`(`:31`)、`SourceFieldRow`(`:61`)、`TOTAL_FIELDS`(`:124`)、`SourceEditor`(`:143`) | 主键是**去掉 `#`/`##` 注解后的域名**，改了域名保存就是**新增一条**（界面上必须先警告，`:31` 与服务端 `normalizeSourceId` 同口径）。读响应可能乱序落地：先点 A 再点 B，A 的 JSON 后到会拿 A 的规则覆盖 B —— 用 `cancelled` 兜住并在切源时重置。校验送的是**当前编辑内容**而不是书源 id，否则校验的是上一次落库的旧版本 |
| `SourceHealthModal.tsx` | 527 | 体检结果面板：六档 tab、按结论打标签、只允许对"确认可用性有问题"的那批动手 | `HEALTH_LABELS`(`:22`)、`DEAD_STATES`(`:28`)、`SourceHealthModal`(`:37`)、`AUTO_CHECK_LIMIT`(`:140`) | `empty`/`blocked`/`needs_login`/`needs_webview`/`explore_only`/`no_search` 都**不算坏**：把它们一起圈进「一键停用/删除」就是上一轮把整库 4,874 个源停成 2 个的那种事故。打开弹窗不再无条件自动开跑（`AUTO_CHECK_LIMIT`）—— 用户只是想看上次的结论，不该被迫发起几十分钟的外呼。勾「连停用的一起体检」只改范围、不发起扫描，发起动作归那颗写着数量的按钮 |
| `SourceLoginModal.tsx` | 865 | 书源登录总入口：**5 种**拿凭据的方式分段呈现，并把库里实际存了什么 Cookie 摊开可核对 | `hasFillableControl`(`:16`)、`cookieHint`(`:28`)、`externalStored`(`:70`)、`refreshExternal`(`:78`)、`userPickedRef`(`:76`)、`loadLoginUi`(`:138`)、`bookmarkletCode`(`:193`)、`handleAction`(`:203`)、`renderControl`(`:376`) | 五种方式：填表（`saveSourceLoginInfo` → `executeSourceLoginAction('login(true)')`）、内置浏览器（只开窗，凭据由服务端代理侧入库）、真浏览器 + 抓取（`externalLoginStart`/`Capture`/`Stop`/`Status`）、粘贴 Cookie（`saveSourceCookie`）、书签同步（目标站点自己 POST `/login-cookie`，应用侧不发请求）。①自动推荐只能生效一次（`:76` + `:163`），否则用户手选后被每次渲染重算的 `recommended` 顶回去；②凭据罐按**注册域**归桶，不能拿完整主机名精确取键，否则对着已有凭据的域说"还没有 Cookie"；③轮询回包没有 `stored`，若把它并进 `external` 会在 2.5 秒内把抓取结果冲空 —— 所以单独一个 state（`:70`）；④脚本 `startBrowserAwait` 触发的 action 登录后必须以 `browserCompleted=true` **重跑同一条**，且重跑时 `allowBuiltInBrowser=false`，否则 `r.body` 恒空、再弹一次浏览器；⑤loginUi 的 flex 排版按 `layout_flexBasisPercent`（≥0.9 整行、0.4-0.6 半行）读，toggle 只认 `'true'/'1'` 字符串。书签代码原本不判 `r.ok`：`/login-cookie` 对跨站 Origin 回 403 **且带能 parse 的 JSON 错误体**，于是"被拒绝也报成功" → 已修并由 `source-login.test.ts` 钉住 |
| `SourceWebViewModal.tsx` | 415 | 内置登录浏览器（网页版 WebView）：服务端整站反代到本服务路径下再塞进 iframe | `LoginTarget`(`:22`)、`WebviewDiagnostics`(`:30`)、`SourceWebViewModal`(`:48`)、`refreshLoginStatus`(`:164`)、`pageSrc`(`:201`)、`persistentBlocked`(`:256`)、`noFormAtAll`(`:258`)、`statusPill`(`:261`) | sandbox **严禁 `allow-same-origin`**（被代理页面的 JS 就碰不到宿主 DOM 与会话），代理端点用一次性令牌而不是管理会话 Cookie；目标站 `Set-Cookie` 由服务端吸收进书源 Cookie jar。书源 JS 生成的自包含页面动辄数万字符，直接拼进 iframe 会撞 Ktor 请求行 8192 上限 → 先 POST 上传、前端只引短 key（`:inlineKey` 那条分支）。「登录控件点不到」要连续 ≥2 次诊断都命中才告警（同意弹层一闪即过是瞬态），「没有表单」要已经看过 ≥4 份诊断仍为 0 才成立（SPA 首屏没挂载会误判）。抓到凭据 ≠ 登录成功：`credential` 档如实说"未验证"，不自动关窗 |
| `SourceSwitchModal.tsx` | 416 | 阅读器里「换源」：全源流式检索同一本书，逐个预取目录并定位到当前章 | `normalizeTitle`(`:35`)、`matchBestChapter`(`:42`)、`SourceSwitchModal`(`:74`) | 书名按**清洗后**比较（相等或任一方包含另一方，且都 ≥2 字符）：源站常带《》或尾随副标题，全等会把同名结果整批滤掉、列表变成空的。章节定位三级：原文精确 → 归一化精确 → 包含关系，都对不上就退回章节号 —— 换源后"第 37 章"往往不是同一章。同一候选的目录拉取用 `sourceId\0bookUrl` 去重，避免流式封包重复触发 |
| `SourceGroupModal.tsx` | 120 | 批量给选中书源设/清分组 | props(`:6`)、`handleSubmit`(`:23`)、单选(`:57`) | `null` 是"清空分组"的唯一信号，但提交键已被禁用条件挡掉空名 → `:29` 那条 `\|\| null` 分支实为不可达（§4）。失败与否交调用方决定：`main.tsx` 里那个包装吞异常并 toast，所以写库失败时**照样关窗**（§4）。`busy` 期间连取消键一起禁用，防止写操作在飞时丢焦点 |
| `SourceShareModal.tsx` | 133 | 把一个或多个书源的原始存储导出为 JSON / `legado://` 深链 | `currentOrigin`(`:6`)、`picked`(`:31`)、导出 effect(`:36`)、`shareLink`(`:54`)、`runCatchingParse`(`:127`) | `currentOrigin()` 是为 `renderToStaticMarkup` 兜的（Node 下没有 `location`）。`legado://import/{path}?src=` 的 `src` 必须手机可达（服务默认只绑回环），所以主路是剪贴板、深链是次路。每条存储**单独** parse，坏的那条跳过并报数；单源发包体是对象、多源是数组。原先单源且那条非法时会把 `JSON.stringify(null)` 得到的字符串 `"null"` 当分享内容 —— 复制/下载按钮照样能点，已改成没内容就不给按 |
| `SourceSubscriptionPanel.tsx` | 157 | 书源订阅（远程书源 JSON 直链）：增删、启停、单条与全部同步 | `SourceSubscriptionPanel`(`:15`)、`items`(`:19`)、`load`(`:25`)、`add`(`:31`)、`updateAll`(`:54`)、`remove`(`:73`) | 它是**书源**的一条来源，不是「订阅」页的东西：同步进来的直接写书源表，所以界面是 `SourcesPage` 里开出的一档（`subsOpen`），收起即回到编辑器。失败原文经 `describeSyncError` 翻成一行结论；`busy` 期间整排动作一起禁用，避免同步在飞时改 `enabled` |
| `SourceDebugModal.tsx` | 128 | 分阶段调试台（SSE）：结构 → 搜索 → 详情 → 目录 → 正文，每步给实际地址、规则原文、取到什么、为什么失败 | `STAGES`(`:13`)、卸载收流(`:31`)、`start`(`:35`)、`useEscapeClose`(`:65`) | EventSource 断线会**自动重连**，等于把整条链路重跑一遍，所以 `onerror` 必须显式 `close()`；回调用 `streamRef.current === stream` 比身份，防旧流的回调踩新流。阶段名与服务端 `SourceDebugger.kt` 是两处各写一份的字面串（靠字符串对齐，改一边就红）。Esc 原本挂了两遍（手写 keydown + `useEscapeClose`），一次按键关两层且不参与让位约定 → 已收成一份 |

### 2.4 规则、发现、订阅与备份

| 文件 | 行 | 职责 | 关键件（file:line） | 读出来的坑 / 不变量 |
| :--- | ---: | :--- | :--- | :--- |
| `ReplaceRulesModal.tsx` | 720 | 替换净化规则的双入口弹窗：列表 + 筛选 + 编辑 + 导入导出 + 实时试算 | `loadRules`(`:44`)、`filteredRules`(`:70`)、`handleToggle`(`:94`)、`toggleAllRules`(`:105`)、`handleSaveRule`(`:129`)、`handleImport`(`:153`)、`handleExport`(`:178`)、`handleRunTest`(`:190`)、`openAddModal`(`:211`)、`useEscapeClose`(`:234`) | `:232` 把一条 React 纪律写在代码里：这个 hook **必须**在 `:241` 的 `if (!isOpen) return null` 之前无条件调用，挪到早退之后就是"关→开"时 hook 数量变化（React #300）；因此 `:235` 还得在回调里自判 `isOpen`。批量启停的作用域是**当前筛选可见集**而不是全表(`:104`/`:106`)。空 scope 视为"也对本书生效"(`:77`)，所以「本书专用」页签里混着全局规则是设计而非 bug。早退不清 state(`:241`)，关掉再开仍保留筛选词与正在编辑的那条。新建默认 `isRegex:true / scopeContent:true / scopeTitle:false / timeoutMillisecond:3000`(`:217-224`)，3000 与服务端沙箱超时同值。导出的是**未筛选全表**(`:179`) |
| `TocRulesModal.tsx` | 285 | TXT 分章规则清单：下一本默认按哪条切 + 哪几条参与"自动"打分 + 自建规则增删改 | `pickable`(`:50`)、`rows`(`:51`)、`toggle`(`:52`)、`saveDraft`(`:68`)、`removeRule`(`:92`) | 口径在 `:44-48` 定死并且不许回退：**手动可选只看 `!broken`(`:50`)，`enable` 只决定自动候选池**。两者曾经共用一个旗标，于是随包 26 条里 12 条在界面上根本不存在（用户 2026-10-03「txt目录规则没有做好」）。`:126` 给未启用的项在 label 后补「（不参与自动）」而不是隐藏它。`rows` 排除 `builtIn` 与 `auto`(`:51`)，所以 `:173` 那句「内置逐行匹配」兜底文案走不到（§4）。删除以服务端 `result.removed` 为准(`:97`)，不靠前端猜 removable；「恢复随包」只在 `rules.overridden` 时出现(`:262`) |
| `RssPanel.tsx` | 402 | 订阅页 RSS 半边：源列表 → 栏目 → 文章 → 正文浮层 | `onlyReadable`(`:30`)、`loaded`(`:42`)、`load`(`:45`)、`RssArticles`(`:221`)、`RssReader`(`:348`) | `loaded` 在 `finally` 置位，空态 gated 在 `sources.length === 0 && loaded && !notice`(`:173`) —— 负载下先闪一张"还没有订阅源"曾经是最刺眼的假话（本机有 178 条）。默认只列有 `ruleArticles` 的源(`:30`)，且**不删数据**。`:52` 注释说"搜索交服务端"而 `:46` 调的是不带 `q` 的 `api.rssSources()`，实际过滤发生在客户端 —— 防抖只是重取全表（§4）。`loadMore` 一次失败就 `setHasMore(false)`(`:290`)，「下一页」永久收起，与 ExplorePage 那条"失败留着可重试"的口径相反（§4） |
| `ExplorePage.tsx` | 269 | 发现页：选源 → 分栏 → 书籍网格 + `{{page}}` 翻页 | `sourcesFailed`(`:19`)、`status`(`:24`)、`labelledTabs`(`:41`)、`loadMore`(`:135`) | 「没取到」与「取到但为空」分开写(`:18`、`:199`、`:206`)。发现栏为空有**两种**原因：非 http 地址直说无法判断(`:108`)，http 则先查凭据再给「需要登录 / 站点没内容」(`:112`)。翻页失败**不**收起按钮，只留一句可重试(`:160`)。分栏 45s、书籍 25s 超时并 `controller.abort()`(`:68`/`:94`) |
| `BackupPage.tsx` | 229 | 备份页：选 zip 即恢复 + 报告"承接了哪些、原样收下了哪些" | `RESTORED_SECTIONS`(`:19`)、`KEPT_SECTIONS`(`:28`)、`reportImportSummary`(`:36`)、`applyKept`(`:100`) | 全零才说"没有可导入内容"并附跳过项(`:42`)；`cookiesNote` 单独一句、不混进失败桶(`:52`)；`errors` 必须露出来(`:57`)。`keptFailed` 是独立旗标(`:68`)，空态卡只在 `kept.length > 0` 才画(`:207`)，取失败给"再取一次"(`:201`)。备份密码不是前置条件：默认折叠(`:155`)，只有包内**确有**加密凭据才自动展开(`:91`)。TXT 分章规则走服务端接口(`:101`)，不写本地设置 |
| `RssPage.tsx` | 24 | 「订阅」这一页的骨架：页头 + `RssPanel`，除此之外不装别的 | `RssPage`(`:12`) | 这一页只有 RSS（要**读**的源）。书源订阅以前与它同页两个页签，各挂一条计数，就为分清"我这一条到底在哪张"——现在两件事按数据模型分家，计数徽标与页签样式一起删了 |
| `syncErrors.ts` / `Notice.tsx` / `EmptyGuide.tsx` | 89/27/36 | 报错翻译 + 一行反馈 + 可点的空态 | `describeSyncError`、`looksLikeFailure`(`:78`)、`Notice`(`:10`) | Notice 只在 `looksLikeFailure` 时才转人话并把原文收进 `<details>`(`:13-24`)，`headline === raw` 时不重复画；空态的去处一律是按钮(`:21`)，不是一句"暂无数据" |

### 2.5 阅读器（`ReaderScreen.tsx` 2,982 行：算术全在 §2.1 的纯函数里，这里只做 DOM 与编排）

| 块 | 关键件（file:line） | 读出来的坑 / 不变量 |
| :--- | :--- | :--- |
| 正文加载与缓存命中 | `preloadedContentRef`(`:456`)、`applyContent`(`:1499`)、`useLayoutEffect`(`:1383` 起)、`syncCacheStatus`(`:550`)、`handleCacheRange`(`:1356`)、`handleSyncToLocal`(`:1385`)、`handleCancelCache`(`:1423`) | 用 `useLayoutEffect` 而不是 `useEffect`：预载（下一章常常已经在手）命中时正文在**绘制之前**就换好了，否则每章都先闪一帧骨架屏。预载 Map 超 12 章丢最旧。缓存数取"服务端与 IndexedDB 的并集较大值"(`:635`)，两边各自落后是常态。 |
| 续接窗口（滚动流） | `flowTail`(`:266`)、`pendingKeepRef`(`:268`)、`flowAdvanceRef`(`:270`)、`flowKey`(`:272`)、`flowHead`(`:290`)、`pendingPrependRef`(`:294`)、`prependPreviousChapter`(`:1833`) | `content` 与 `loadedChapterUrl` 成对描述"屏幕上挂的是哪一章"，靠这对不变量判过渡（`isStaleContent`(`:664`)），所以切章时**刻意不清** `content`(`:308`)—— 那个目的已由 `ttsParagraphs`(`:819`) 承担，视觉侧跟着清就是"章节之间白闪"。回翻接上一章必须带"落在末尾"的定位，且必须等排版完成。 |
| 分页几何 | `pageIndex`(`:378`)、`pageCount`(`:379`)、`pageFillers`(`:381`)、`columnWidth`(`:382`)、`stride`(`:383`)、`measurePagination`(`:1644`)、`pageAlignedRef`(`:302`)、`measuredStartsRef`(`:299`)、`goNextPage`(`:1813`)、`goPrevPage`(`:1855`) | 每章栏数**不能**用 `getBoundingClientRect().width`：跨栏的 section 只报两栏宽，首行缩进会把一栏数成两栏 —— 必须 `Range.getClientRects()` 按 stride 分桶。挪窗口的闸门读的是量出来的起始栏(`:446`)，不对齐就不挪，否则"同一栏读两遍"。`setPageFillers` 只在数组真变了才换引用，防自激重量。**测量 effect 的依赖里必须含 `flowHead/flowTail/pageFillers`** —— 内容变宽而视口没变时 ResizeObserver 一次都不回调，多出来的列会被 `overflow:hidden` 裁在视口外（AGENTS 那条「分页/测量」）。 |
| 切章与定位 | `changeChapter`(`:1251`)、`targetInitialPageRef`(`:461`)、`handleSwitchSource`(`:1433`) | 卷头 `isVolume` 无正文地址，要沿方向跳到最近的真实章；越界给「已是第一章/最后一章」而不是静默。`'auto'` 必须落成"分页模式回到第 1 页"，否则从目录跳一章只有三页的书会停在旧页码上。触底滚轮跨章带 1.2s 冷却，且窗口里已挂着下一章时不再翻章。**换源（`:1321`）这轮补上了停朗读与清窗口**：原来只 `clear()` 预载，旧书的续接章节会挂在新 `currentBook` 下面，而朗读管线因 chunks 变空直接 `return` —— 悬浮条停在播放态却不出声。 |
| TTS 联动 | `playTtsChunk`(`:963`)、`getInitialTtsChunkIndex`(`:1047`)、`toggleTts`(`:1113`)、`stopAllEngines`(`:896`)、`stopTts`(`:901`) | 只在 `mode !== 'continue'` 时 `stopAllEngines`：连播跨章不能中断管线。5 分片前瞻 + 距章末 5 句内预载下一章。开启朗读时以**视口内第一个完整可见段落**为起始分片（`:922` 返回 title chunk 时是 `-1` 口径，与 `TtsPlayerBar` 同一份）。段落点击选播严格守卫 `if (!ttsActive) return`。 |
| 手势与点击分区 | `runTapAction`(`:2214`)、`readingRect`(`:2249`)、`onPointerUp`(`:2295`)、`onWheelPaginate`(`:2355`) | 只认 `event.button === 0`：右键关掉上下文菜单之后页面已经跟着翻页了（用户 2026-10-04 的事故）。点击分区按正文矩形算而不是整窗，固定目录时侧栏那一段不算。滚轮的 `deltaMode` 三种口径必须换算，否则触控板翻不动。 |
| 进度上报 | `persist`(`:869`) | 滚动 effect 1.2s 节流 + 页面隐藏时 + 卸载 + 切章 + 返回书架各写一次；离线时写进队列，`online` 后静默 flush（`offlineStorage.ts:457`）。 |
| 目录列表 | `VirtualChapterList`(`:112`)、窗口与居中定位引 `virtualSlice.ts` | 行 key 必须 `index-url` 拼（服务端不去重同 url）；`TOC_ROW_HEIGHT` 与样式表 `--row-h-list` 必须相等。程序化点一条不在窗口里的行是**对的**（它本来就不在 DOM 里），门禁要先滚再点。 |

### 2.6 阅读器外壳与设置面板（0.7.0 那一轮：MD3 上线为默认 + 三标签「界面」+ 笔记）

| 文件 | 行 | 职责 | 关键件（file:line） | 读出来的坑 / 不变量 |
| :--- | ---: | :--- | :--- | :--- |
| `Md3Chrome.tsx` | 125 | **现行默认**的顶栏 + 底栏（PROPOSAL-020 P1/P2） | `TopAction`(`:28`)、`Md3TopBar`(`:51`)、`Md3BottomBar`(`:73`) | 底栏的进度用 `useSyncExternalStore` 只订阅 `readerProgress.ts`，且 `fraction` 在"报的进度不是这一章"时按 0 显示 —— 换章那一瞬不会闪 100%。range 键直接把百分比映射到章号（`Math.round(pct * max)`），两端都夹住。顶栏那排动作与旧工具栏**同源** `settings.menuItems`。`data-testid="reader-header"` 与 `ReaderHeader` **用同一个名字**：门禁两条分支都命中同一 testid（现在是对的，但要知道两套外壳都在树上）。头部注释原本写"默认走旧界面"（P1 时的状态），0.7.0 已翻成默认 → 本轮订正 |
| `ReaderHeader.tsx` | 61 | 旧（回退档）顶部浮动工具栏 | `ReaderHeader`(`:11`)、`menuButton`(`:27`) | id 清单引 `readerMenu.ts`，但 **aria 文案在这里和 `Md3Chrome.TopAction` 各写一份 switch**：加一个动作要改三处。本轮记进 §4.1，收成一张表是下一步 |
| `ReaderSheet.tsx` | 39 | MD3 底部弹层外壳（「界面」「设置」两处共用） | `ReaderSheet`(`:16`)、`ignoreEscape`(`:14`) | 浮层并档（PROPOSAL-018 W2）的规矩在这儿也守着：外壳 `.dialog-shell`、挡片 `.overlay-backdrop`、关闭键 `.overlay-close`，**只加一个 `.is-sheet`** 把居中改成贴底，不新造几何。挡片本身可点关闭、内容 `stopPropagation`。`useEscapeClose` 现在只在**开着**的那张上接 Esc —— 两张同时挂在树上（`ReaderScreen` 里两个实例），原先都挂监听，按一次关两回；此刻都写同一个 `null` 看不出错，等哪张的关闭变成"还要还回点什么"时就是错关 |
| `TocDrawerHeader.tsx` | 65 | 目录抽屉标题栏：在读哪一章 + 倒序 / 固定 / 笔记 / 关闭 | `TocDrawerHeader`(`:10`) | 标题原来只说"共 N 章"不告诉你在读哪章（用户 2026-10-09），现在章名进标题、CSS 截断 + `title` 给全名。关闭键在固定态**必须**顺带解除固定（抽屉由 `pinned` 类撑着，光 `setActiveDrawer(null)` 关不掉）—— 这是"一个控件兼两职"里**被核实的必需**那一类，该修的是标签要说出按下去会发生什么 |
| `IconButton.tsx` | 9 | 阅读器那一排方形图标键 | `IconButton`(`:7`) | 纯呈现：`aria-label` 取 `label`，`title` 是 `label`（+ `hint`）。门禁与读屏都从这一处拿名字，所以"按钮没有可访问名"这类问题只在调用方传错 label 时才可能出现 |
| `ReaderContentSkeleton.tsx` | 26 | 正文还没取回来时铺在阅读区的骨架屏 | `ReaderContentSkeleton`(`:5`) | 没有任何 props；`aria-label="正在加载正文"` 是门禁等正文的条件之一。宽度是写死的视觉节奏（10 行 + 一个 gap），不代表真实段落数 |
| `ReaderSettingsControls.tsx` | 56 | 「界面」弹层的内容 = 三标签页容器（排版 / 颜色 / 行为） | `TABS`(`:19`)、`ReaderSettingsControls`(`:27`) | 只管"现在显示哪一页"，值全在三个 Tab 与 `readerSettings.ts` 里。`useState<TabId>('typography')` **不持久化** —— 每次开弹层回到「排版」；与"上次停在哪一页"是两件事，当前没人要求，记在 §4.1 |
| `TypographyTab.tsx` | 36 | 字体 / 字号与间距 / 段落与版心 | `TypographyTab`(`:10`) | 首行缩进给**三档**不给滑杆：1.3em 这种中间值在中文排版里没有对应惯例，只会显得没对齐。字号步进引 `fontSizeControl.ts`。「恢复默认设置」刻意保留 `theme` 与 `customSkins`（重置排版不该把用户的皮肤库清空）。hint 里"宽屏 (≥800px)"把 `readerInteractions.ts:83` 那条算式**又抄了一遍文案** —— 改阈值不会报错，只会说假话（§4.1） |
| `ColorTab.tsx` | 45 | 主题网格 + 阅读背景 | `ColorTab`(`:12`) | 内置七套与 `customSkins` 库**一处渲染**（`availableSkins(settings)`），启用哪套 = 点哪块；创建/编辑仍在「我的 → 自定义皮肤」，这里只管选。`value={settings.readerBgColor \|\| '#ffffff'}`：存的是"没设背景色"（空串），色片上显示的是白 —— 用户会以为已经设过（`清除背景` 那颗才是回到"跟随主题"，§4.1 P2） |
| `BehaviorTab.tsx` | 33 | 翻页方式与翻页动画 | `BehaviorTab`(`:11`) | 「翻页动画」那一档只在 `pageMode === 'paginate'` 时出现（连续滚动没有页，用不上）。值域在 `pageTurn.ts`，本页只摆放 |
| `SettingRow.tsx` | 36 | 三个共用行控件 | `SettingRange`(`:9`)、`SettingChoices`(`:14`)、`SettingGroup`(`:28`) | `SettingChoices<T extends string \| number>` 让数字档（缩进 0/1/2 字）与字符串档（对齐、分栏）共用一套观感，键走 `String(option.value)`。`SettingGroup` 的 `hint != null` 才画说明 —— 空串不该占一行 |
| `OtherSettingsPanel.tsx` | 138 | 「设置」弹层：简繁 / 点击区域 / 工具栏 / 本地书目录 / 内容净化 | `OtherSettingsPanel`(`:17`)、`runReparse`(`:43`)、`repickRule`(`:39`)、`ruleLabelOf`(`:41`) | P4 从「行为」页拆出来的**工具/其它**项。三处口径要记住：① 「这一本换哪条」是暂选 `repick`，**绝不写全局** `settings.txtTocRule`，且 `localBook?.name` 一变就清（用户 2026-10-03「只想改这一本」）；② 工具栏清单引 `READER_MENU_ITEMS`，与顶栏渲染同源；③ 规则下拉过滤的是 `!option.broken` —— 手动可选只看用不用得了，`enable` 只决定自动候选池。`onReparseLocal` 的返回值就是失败文案，`null` 才算成功 |
| `NotesPanel.tsx` | 24 | 这本书的全部划线 / 备注，点一条跳到那一章 | `NotesPanel`(`:9`) | 空态说的是"选中正文可以划线、写备注"，不是"暂无数据"（空态要给去处）。`key` 用服务端 `note.id`；`第 N 章` 是 `chapterIndex + 1`，跳过去按标题匹配（见 `bookmarks.ts` 那条三级定位） |
| `NoteToolbar.tsx` | 49 | 选中正文后浮出来的那一张（新建 / 改 / 删） | `NoteDraft`(`:7`)、`NoteToolbar`(`:19`) | `NoteDraft` 同时带 `chapterIndex` **和** `chapterUrl`，另加选区偏移 —— 书签跨书源要靠"标题"而不是号数。`onDismiss(clearSelection)` 那个布尔位分清两种关法：Esc 与「取消」都关浮层，只有「取消」连正文选区一起清。挂在 `reader-main` **之外**，所以它自己的点击不会再触发 `onReaderMouseUp`（否则点一下浮层就把浮层关掉） |
| `MediaBlock.tsx` | 32 | 非文本章节的渲染：音频 / 视频 / 文件下载 | `MediaBlock`(`:7`) | 档位口径是 `shelf/bookType.ts:3` 那一份（1 音频、4 视频、其余当文件），本轮逐条对过 `isMediaType` 与它一致 —— 数字含义两边写反过就会变成"视频给了下载键、音频放视频"。音频放完自动进下一章由**调用方**通过 `onEnded` 决定，组件不碰翻页状态；`mediaSrc` 为空返回 `null`，正文那侧才会去渲染段落 |
| `ReadingLogPage.tsx` | 90 | 阅读记录时间轴（PROPOSAL-019 D） | `formatDuration`(`:12`)、`groupByDay`(`:24`)、`dayLabel`(`:39`)、`ReadingLogPage`(`:48`) | 三个纯函数被 `web/test/ReadingLog.test.ts` 直接测，页面只做聚合展示：记录是「一天 · 一本书」一行、**只增不改**，所以这里不提供编辑/删除。`groupByDay` 只比相邻两行（服务端已按天倒序、天内按秒数倒序），不建 Map 重排是为了保住那个顺序。`import React` 是给 `web/test` 的 `renderToStaticMarkup` 用的（AGENTS 那条：少这行只有测试里抛） |

### 2.7 朗读（两副引擎，一条会话身份）

| 文件 | 行 | 职责 | 关键件（file:line） | 读出来的坑 / 不变量 |
| :--- | ---: | :--- | :--- | :--- |
| `ttsEngine.ts` | 638 | `WebSpeechEngine`（浏览器 `speechSynthesis`）与 `HttpAudioTtsEngine`（服务端 Edge-TTS 会话流 + SSE 进度通道） | `isEffectiveText`(`:17`)、`WebSpeechEngine`(`:44`)、`startWatchdog`(`:101`)、`HttpAudioTtsEngine`(`:161`)、`recoverOrReport`(`:193`)、`drainPlayback`(`:202`)、`prefetch`(`:260`)、`resetSession`(`:294`)、`createChunkRequest`(`:373`) | ① WebSpeech 的 `speak` 无条件先 cancel(`:121`)，且 `stop()` 会把 `onEndCb` 清空(`:124`) —— 否则被 cancel 的那句的 `onend` 仍会推进下一句。② 10 秒 pause/resume 心跳(`:103`)是 Chrome 对无心跳朗读 15 秒静默冻结的绕法。③ 剥标点判有效字符 < 2 就跳过(`:264`/`:291`)：给后端送纯标点会回 0 字节音频，前端 `createObjectURL` 之后就是 416。**这轮把剥除区间里 `\uFF00-\uFFEF` 收窄**：整段当标点会把全角数字/字母（`１２３４５`）判成"没内容"而静默丢句。④ 会话身份只有一处：`mode === 'replace'` **或** `settingsKey` 变了才 `resetSession`(`:294`)，key 直接引 `readerSettings.ts:362 ttsSessionKey`，界面与引擎同源。⑤ 每条异步链都带 `generation` 比对(`:409`-`:420`)，过期会话立刻 `deleteTtsSession`(`:414`) —— 切章/换引擎后旧回调还在推进是历史上"重音"的根因。⑥ 单句用**相对时钟**：每片重取锚点，`now >= anchor + duration - 60` 判完；跨句累积漂移归零，章末尾部静音放宽到 `-600`(`:560`) 且 350ms 无推进才强制完 —— 绝对时钟累加在 40~50 片后被声卡重采样偏差拖死。⑦ `stopped`/`removed` 事件里自家 stop 发的那两种不算错(`:458`/`:476`)。⑧ reset 时 `removeAttribute('src') + load()`(`:618`)，仅 `pause()` 不足以让 `<audio>` 放下旧流。 |
| `TtsSettingsModal.tsx` | 363 | 引擎三选、音色清单、语速/语调、睡眠定时、自定义 HTTP 参数 | `DEFAULT_EDGE_VOICES`(`:22`)、voices 拉取(`:49`)、`handleEngineChange`(`:71`)、`formatTimerRemaining`(`:82`) | 服务端音色为空时**保留**内置 13 条兜底，本地音色靠 `voiceschanged` 异步补 —— 拉不到不等于"没有音色可选"。换引擎顺手改音色（edge→晓晓、webSpeech→第一个 zh 本地音色）：带着上一引擎的 id 出声就是没声音。本地无音色时不摆空 Select，改成一句说明。自定义发音人提示明说"不是微软 id"。倒计时徽标只在 `>0` 时出现，`chapter` 档不显示秒数 |
| `TtsPlayerBar.tsx` | 160 | 朗读悬浮控制条：状态点 + 当前句 + 段/上下一句 + 章跳转 | props(`:7`)、`formatTimerLabel`(`:45`)、`barRef`(`:58`) | `currentParagraphIndex < 0` 说"章节标题"，与 `getInitialTtsChunkIndex` 的 `-1` 同一口径（两处各写一份迟早漂，见 §4）。跨章不由这条做，回调交出去。位置持久化与长按拖拽全在 `ttsBarPosition.ts`，本组件只提供 `barRef` 量尺寸 |
| `TocRulesModal` / `readerSettings` 之外，`replace-rules` 的正文清洗同样作用于朗读 | — | — | — | 净化在 `RuleRunner.content()` 与离线落库前各执行一次，所以朗读拿到的天生是清洗后的文本 —— 前端不需要再剥一遍 |

### 2.8 外壳、浮层与诊断

| 文件 | 行 | 职责 | 关键件（file:line） | 读出来的坑 / 不变量 |
| :--- | ---: | :--- | :--- | :--- |
| `main.tsx` | 3,399 | 应用外壳 **加** 三个一级页面的完整实现（书库/书架/书源），以及详情弹窗与两张书架管理弹窗；「订阅」页与书源订阅不住在这里 —— 见 `pages/RssPage.tsx` 与 `sources/SourceSubscriptionPanel.tsx` | `pageFromHash`(`:76`)、`dialogFromHash`(`:78`)、`SkinStyle`(`:89`)、`pendingSourceFocus`(`:119`)、`SourceChoiceList`(`:151`)、`BookDetailModal`(`:298`)、`runInspection`(`:364`)、`SourcesPage`(`:644`)、`loadGeneration`(`:647`)、`searchInLibrary`(`:667`)、`applySourceOrder`(`:770`)、`importSources`(`:937`)、`HighlightText`(`:1368`)、`LibraryPage`(`:1407`)、`runSearch`(`:1429`)、`BookInfoEditModal`(`:1748`)、`BookManageModal`(`:1943`)、`ShelfPage`(`:2096`)、`itemsLoaded`(`:2112`)、`visibleItems`(`:2390`)、`selectAllBooks`(`:2406`)、`shelfFailedEmpty`(`:2410`)、`App`(`:2982`)、`navigate`(`:3125`)、`settingsSections`(`:44`) | 皮肤类必须**同时**挂 `<html>`：portal 到 body 的浮层取不到 `--surface/--ink` 时是"黑字压深底"（`Select` 的下拉就是这么炸的）。用户 CSS 用 `createElement + textContent` 注入而不是 `dangerouslySetInnerHTML`，id 过 `parseSkinId` 白名单。启动探活每次带 2.5s `AbortController`，前 40 次 1.5s、之后 5s，第 40 次失败也放行；首屏**不等**整份书源清单，加载页仍挂 `ToastContainer`/`PwaManager`。书源列表用 `loadGeneration`(`:647`) 挡"慢的旧响应晚到覆盖新结果"，另加 180ms 防抖。体检只依赖 `choicesKey` **字符串**而不依赖数组身份(`:364` 附近)：按身份会让中止后的体检从零重新联网。书源顺序唯一事实源在服务端，拖完只回填、不写比较器。`#reader` 的状态从 sessionStorage 恢复，但**来路页没存**，所以从书库/发现开书后刷新会退回书架（§4）。这轮改掉的三件都在页面上：① 历史词 chip 以前绕过范围守卫直接发搜（现在与表单同源走 `runSearch`）；② 「全选」以前按整架取键、与筛选不一致（`selectAllBooks`(`:2406`) 现按 `visibleItems`）；③ 空态卡加了 `itemsLoaded`(`:2112`) 与失败档 `shelfFailedEmpty`(`:2410`)，第一帧不再说"书架还是空的" |
| `AppHeader.tsx` | 301 | 顶栏：品牌 + 版本芯片 + 一级导航 + 「我的」浮层菜单 | `APP_THEMES`(`:28`)、外点关闭(`:74-:81`)、`navActive`(`:94`)、导航由 `PRIMARY_PAGES`(`:139`) | 外点判据用 `window` 的 `pointerdown`：门禁里的 `node.click()` **不派发 pointerdown**，于是菜单一直挂着、下一次点「我的」变成反手关掉（AGENTS 门禁①）。导航项、数字键 `1–6`、`Alt+←/→` 循环序三处同源于一张 `shortcuts.ts:86 PRIMARY_PAGES`；手写一排按钮的代价写在 `:129-:135`。`version` 取不到时整档不渲染（取失败 ≠ 没有版本） |
| `Select.tsx` | 289 | 站内下拉：过滤框 + 虚拟窗口 + portal 浮层 | 几何常量(`:19-:35`)、`LIST_MAX_H`(`:27`)、开向计算(`:90-:96`)、关闭监听(`:130-:171`)、`createPortal`(`:226`) | 340/288/34 只有这一份，样式表不再声明；夹视口用 `clientWidth/clientHeight` 而不是 `inner*`（滚动条），算式与右键菜单共用 `overlayGeometry.clampOverlay`。>12 条自动给过滤框，几千条走窗口渲染。关菜单的 scroll 监听要排除菜单内部滚动，并优先挂最近的滚动祖先 |
| `Toast.tsx` / `ContextMenu.tsx` | 108 / 89 | 模块级 store（不是组件状态） | `ToastStore`(`:15`)、`toast`(`:71`)、`publish`(`:15`)、`showContextMenu`(`:18`) | 存模块级所以**弹窗关掉后提示仍在**；`dismiss` 长度没变就不 notify，避免手动关一次触发整棵树重渲染。全 `disabled` 的菜单不派发；菜单挂捕获阶段 `pointerdown`，否则"右键刚出就被自己关"。宽高由样式表定，位置按挂载后**真实矩形**夹（注释点名旧的 `width=210/行=34` 与表内 196/32 互相矛盾） |
| `icons.tsx` / `Logo.tsx` | 111 / 40 | 一份 `IconName` 联合类型 + 路径表 | `IconName`(`:3`)、`paths`(`:55`)、`Icon`(`:109`) | `Icon` 固定 `fill="none" stroke="currentColor"`：只随墨色，任何多色或 emoji 图标进不来。Logo 与 `favicon.svg` 的路径**故意重复**，由 `web/test/BrandLogo.test.ts` 逐条比对 `d=` 钉住 |
| `PageDialog.tsx` / `Notice.tsx` / `EmptyGuide.tsx` / `Cover.tsx` / `ErrorBoundary.tsx` / `ServerPortModal.tsx` / `FirstRunAgreement.tsx` / `ShortcutHelp.tsx` / `SettingsPage.tsx` / `settingsSections.ts` | 28/27/36/67/79/78/55/40/68/116 | 浮层一档的小件 + 「设置」那一张分区表 | `PageDialog`(`:9`)、`CoverFallback`(`:10`)、`DeferredCover`(`:47`)、`boundarySummary`(`:27`)、`STORAGE_KEY`(`:14`)、`SettingsActions`(`:15`)、`buildSettingsSections`(`:26`)、`filterSettingsSections`(`:107`) | 首启协议层 Esc 只关层、**不写同意标记**；`localStorage` 抛错时默认每次都显示。封面 `<46px` 才退回两字紧凑版，外域一律走 `api.coverProxy`，`DeferredCover` 先摆文字占位、`onLoad` 才淡入、失败就让 img 一直透明。ErrorBoundary 界面一句人话、堆栈只进 `console.error`，并承诺"书架/进度没被改动"。分区表在 `settings/` 而不在 `App` 里：一份要给人读的清单长在三千行那个文件中间，改一行文案要在里面翻半天；表里每个 `open*` 都由 `main.tsx` 接回**原来那一份**实现（`SettingsPage.test.ts` 逐个点名），只列这一页点得动的项 —— 阅读排版与朗读的编辑面在阅读器里，搬过来只能放一颗死按钮 |
| `LogsModal.tsx` | 262 | 运行日志：类别/等级筛、合并计数、跟随、导出、清空 | `CATEGORIES`(`:20`)、`load`(`:71`)、`merged`(`:96`) | `load()` 在 state 已是 `ready` 时**不改 state**(`:72`)：换筛选那几百毫秒里旧的 300 行原样挂在 DOM 且没有转圈，"等到页面里有东西再读"的门禁会读到**上一份**数据 —— 可信信号是"那行计数变了"(`:96`)。展开键按 `entry.id` 不按数组下标。这轮删掉了它自挂的一份 `keydown`（与 `useEscapeClose` 并存 → 一次 Esc 关两层） |
| `OfflineCacheModal.tsx` | 190 | 本机 IndexedDB 离线缓存统计与清理 | `offlineStatsView`(`:21`)、`loadStats`(`:46`)、`handleClearAll`(`:77`) | `offlineStatsView` 是纯函数：`failed` 优先于 `loading`，`books === null` 一律算 `failed` 而不是"确实没有"。失败时界面写明"这不代表你没有缓存，也不会删任何东西"；清空键在非 `ready` 时禁用；只读浏览器本地，不碰服务端 |
| `CustomizeModal.tsx` / `AboutPage.tsx` / `ChangelogPage.tsx` | 251 / 144 / 142 | 「自定义」= 只有皮肤（现在是**多套皮肤库**）；「关于」= 版本 + 检查更新 + 许可；日志页 = 解析随包 `CHANGELOG.md` | `CustomizeModal`(`:30`)、`cssLooksLikeRules`(`:53`)、`save`(`:64`)、`remove`(`:91`)、`THIRD_PARTY`(`:17`)、`REFERENCED`(`:35`)、`runCheck`(`:69`)、`parseChangelog`(`:16`) | 自定义皮肤是**叠**在基档上不是替换，所以三道校验各有独立话术（id 清洗后为空 / CSS 空 / 不像完整规则）。`parseSkinId` 白名单在读写两处都用（`:10` 引入，落库与比对各一次）。版本一格取三态：`info?.version ?? (notice ? '没取到' : '载入中…')`。`parseChangelog` 把续行并回上一条，且补空格的条件按**码位**判 CJK —— 注释里点名了 `[ -〿]` 那种把整个 ASCII 圈进区间的错写法 |

### 2.9 `styles.css`（5,843 行）结构盘点

| 块 | 位置 | 内容 |
| :--- | :--- | :--- |
| 安全区与重置 | `:1-:33` | `--safe-*` 与全局 reset |
| 主题令牌 | `:34-:46` | 口径注释在 `:35-:38`：**`--accent` 只描边与文字，实底必须 `--accent-solid` 配 `--on-accent`（成对，对比 ≥4.5）**；七套皮肤逐行 `:40` light / `:41` paper / `:42` dark / `:43` qingzhu / `:44` mulan / `:45` meigui / `:46` shimo，每套同一串 15-16 个变量 + `color-scheme` |
| 单页大区 | `:406` `:417` `:518` `:554` `:589` `:667` `:684` `:824` `:870` `:908` `:937` `:996` `:1064` `:1116` `:1184` `:1233` `:1449` `:1494` `:1634` `:1781` `:2367` `:2559` `:2754` `:2851` `:2996` `:3534` `:3627` `:3713` `:3791` `:4300` `:4398` `:4436` | 约 70 条单行区标题：Login、Source workspace、Search and book details、Library page、Book Detail Modal、Shelf、Bookshelf Grid、Book Manage Modal、Book Info Edit、Reader Workspace、Floating Drawers、Settings Controls、Main Reading Canvas、Reader Loading、Paginated Mode、Desktop Sidebar Pinning、Toast、Source Switch、Cache Controls、Source Login、TTS Settings、内置登录浏览器、Cache Range & Local Sync、PWA Banner、Offline Storage、Detail & Sandbox、Sandbox Box、Mobile Accordion(<768px)、Rules Modals、Group Modal、发现页、书源调试台 |
| `@keyframes` | 21 处命中 = **20 个真声明 + 1 句注释**（`:2369` 那句写的是"dangling `modal-enter`"，该动画名全表 0 声明 0 引用，已修） | 逐个查过：每个声明都至少有一条 `animation:` 引用，**没有死动画**。这条之所以要专门查，是因为"引用一个不存在的 `@keyframes`"不报错，表现是"动画从来没演过"（AGENTS 那条） |
| 媒体查询 | 36 处命中 = **35 条真查询 + 1 句注释**（`:1079` 提的 `@media print`） | 断点分布：`max-width:640` ×12、`720` ×10、`768` ×2（`:3720`/`:4379`）、`min-width:960` ×2（`:1234`/`:1261`）、`prefers-reduced-motion` ×2（`:1114`/`:4589`）、`hover:none` ×2（`:4802`/`:5129`），另有 `min-width:721`(`:465`)、`min-width:1200`(`:5494`)、`max-width:900`(`:4994`)、`max-width:760`(`:4462`)、`max-width:420`(`:1442`) **各只一条** —— 760/900/420 与主流 640/720 不同档，加新断点前先想清楚是不是又长一套 |
| 尺度令牌 | `:4563-:4583`（第二个 `:root`）：`--t-*` 7 档、`--s-*`、`--r-*`、`--row-h/--row-h-list`、`--ctl*`、`--page-max:1240px`、`--gutter`、`--elev-1/2/3`；暗档覆写 `:4584`(dark) 与 `:4590`(shimo)；第三个 `:root` 在 `:5622-:5627`（`--dw-s/m/l`、`--dh-shell`、`--backdrop`） | **`--row-h-list` 定义在 `:4570`（40px），消费者只有 `.reader-chapter-item`(`:989`) 与 `.reader-chapter-volume`(`:990`)，数值必须等于 `readerInteractions.ts:205 TOC_ROW_HEIGHT`** —— 两边各写一份，虚拟窗口的行数是按后者算的，漂了目录就会露白或重叠 |
| 浮层一档 | `.overlay-backdrop` `:5597`（变体 `is-topped:5604`、`is-menu:5606`、`is-flush:5608`、`is-viewer:5610`、`is-agreement:1222`）；`.dialog-shell` `:5612`（几何 `:5615-:5617`，档位 `size-s:5619`/`size-m:5620`/`size-l:5621`，`is-fullscreen:5623`）；`.dialog-head` `:5626-:5631`；`.overlay-close` `:5634`（唯一的窄屏覆写在 `:1364`）；豁免档 `.reader-drawer` `:938-:962` 与 `.tts-floating-bar` `:2158-:2204` | 并档的判据口径是"这条规则**声明了什么**"而不是"类叫什么"（AGENTS 那条）：一条只有单个类名的规则同时写了 `max-height` + `border-radius` + `box-shadow` 就算一套外壳几何，只许 `.dialog-shell` |

**死样式**（做法：从样式表抽全部类名，与 `web/src/**`、`web/test`、`web/index.html`、`web/public`、`tools/` 的 token 集做差集，再对候选逐词反扫；动态拼接的 `theme-swatch-*`/`level-*`/`toast-*`/`tier-*`/`size-*`/`shelf-mode-*`/`is-*` 已排除，否则全是假阳性）。
确认"样式表里声明了而界面不挂"的有：`.login-shell`(`:407`)、`.login-mark`(`:409`)、`.login-ui-empty`、`.login-ui-item-btn-container`（鉴权删除后的残留）、`.app-workspace`(`:418`，窄屏副本 `:1368`)、`.workspace-brand`(`:431`)、`.workspace-themes`(`:472`)、`.workspace-content`(`:477`)、`.workspace-topbar`(`:478`)、`.workspace-scroll`(`:482`)（后四条是已回滚的侧栏外壳）、`.source-list-label`(`:440`)、`.desk-header`(`:519`)、`.search-results`(`:524`)、`.book-preview`(`:531`)、`.library-book-detail`(`:586`)、`.health-idle`(`:663`)、`.source-switcher`(`:675`)、`.cache-action-btn`(`:1681`)、`.source-switch-dialog`(`:1778`)、`.source-webview-cookie-badge`(`:2611`)、`.rss-empty`(`:5045`)、`.rules-toolbar`(`:3329`)、`.rules-content-area`(`:3535`)、`.rules-sandbox-grid`(`:3648`)、`.rule-accordion-item`(`:3715`)、`.mobile-sandbox-section`(`:3716`，窄屏副本 `:3725`-`:3746`)。
**注意两处别当成死代码**：`.login-panel`(`:408`) 由 `SourceLoginModal.tsx` 挂着；`.desk-header` 与 `.search-results` 仍被 `tools/verify/frame-metrics.mjs:78`/`:84` 当选择器用 —— 那是**那条门禁的两个分支永不命中**，属于门禁侧要清的东西（归 AI-1 领地，见 §4.2）。
上面这份清单在合并 `origin/main`（皮肤库那轮，`styles.css` +12 行）之后**重扫过一遍**：类名集合与声明行号都没变（新增的 `custom-skin*` 类都被 `CustomizeModal.tsx` 用着，所以不进清单）；变的是浮层那一档的行号，已同步。

## 3. 关键链路（跨文件，一条链读完就懂整个功能）

> 这一节的每个指针都写成 `` `文件.扩展:行号 符号名` `` —— 那是 `CodeMapFresh.test.ts` 认得到的形状（B 式），
> 它会逐条核"那一行确实写着这个符号"。只写行号不写符号的散文指针没人管，所以这一节先前有两条指错了也没红。

1. **多书源流式搜索**：`main.tsx:1429 runSearch`（范围闸门 + 记历史）→ `lib/searchStore.ts:261 startSearch` → 同文件的空表闸门 → `lib/api.ts:682 streamSearch`（WebSocket）→ `searchFilters.ts:251 mergeStreamedResults` 判重（判重表 `searchStore.ts:190 seenResults` 跨封包常驻）→ `searchStore.ts:247 flushProgress` 250ms 攒批 → `searchStore.ts:519 useSearchStore`（`useSyncExternalStore` 出口）→ `main.tsx:1407 LibraryPage` 三档排序（`searchFilters.ts:158 sortSearchGroups`）。
2. **开一本书**：`ShelfPage`/`LibraryPage` → `main.tsx:3183 openReader` →（目录失败**不伪造章节**）→ `ReaderScreen.tsx:1499 applyContent`（在 `useLayoutEffect` 里先命中预载 `ReaderScreen.tsx:456 preloadedContentRef`，否则走 `lib/api.ts:80 content`）→ 排版（分页与滚动两条分支都在 `ReaderScreen.tsx` 的 return 里）→ `ReaderScreen.tsx:869 persist` 写进度。
3. **正文取不到时的离线回落**：`api.content` 失败 → `offlineStorage` 按 `['loc_book', bookUrl]` 查 IndexedDB → 命中就照常渲染。**副作用**：门禁里 `request.abort()` 会被这条兜住，界面看着正常而其实在读缓存（AGENTS「探针」那条）。
4. **朗读**：`ReaderScreen.tsx:1113 toggleTts` → `ttsEngine.ts:161 HttpAudioTtsEngine`（或 `ttsEngine.ts:44 WebSpeechEngine`）→ `readerSettings.ts:362 ttsSessionKey` 定会话身份 → `api.ts` 的 `/api/tts/stream` + SSE 进度通道 → `ttsEngine.ts:101 startWatchdog` 心跳、单句相对时钟与 600ms 尾静音都在同一个类里 → `TtsPlayerBar` 显示 → 段落高亮由 `ReaderScreen.tsx` 的 `currentChunkIndex` 驱动。
5. **书源登录五路**：`SourceLoginModal.tsx:203 handleAction` →（表单）`api.ts:433 saveSourceLoginInfo` + `api.ts:438 executeSourceLoginAction`；（内置浏览器）`SourceWebViewModal` → `WebViewProxy` 服务端反代并吸收 `Set-Cookie`；（真浏览器）`api.ts:447 externalLoginStart` → `ExternalBrowserLogin.kt`；（粘贴）`api.ts:435 saveSourceCookie` → `Routes.kt` 的 `/login-cookie`；（书签）目标站点自己 POST 同一个端点，Origin 由 `allowCookieSyncOrigin` 判。
6. **整库体检**：`SourceHealthModal.tsx:140 AUTO_CHECK_LIMIT` 决定要不要自动开跑 → `sourceHealthRun.ts:93 startHealthRun` 分批 → `api.ts:375 healthCheckSources` → 服务端 `source/SourceHealth.kt` 的 `probe` 在**发请求之前**把"没配搜索"定档 → `sourceGrouping.ts:70 autoTagBatches` 过程中打标签 → `main.tsx` 的批量端点落库（`SourcesPage` 那一段）。
7. **备份**：`BackupPage.tsx:36 reportImportSummary` ← `api.ts:634 importBackupFile` ← `BackupImporter.kt`（纯内存按需读 zip + 炸弹上限）→ `KEPT_SECTIONS` 那批个性化条目走 `backupPreferences.ts:49 mapReadStyle` / `backupPreferences.ts:121 mapTtsEngine`。
8. **换源**：阅读器「换源」→ `SourceSwitchModal.tsx:42 matchBestChapter`（流式找同名 + 三级定位）→ `ReaderScreen.tsx:1433 handleSwitchSource`（这轮起会停朗读、清续接窗口、换容器 key）→ `api.ts:564 switchBookshelfSource` 落库 → `sourceInspector.ts:384 inspectAllSourcesConcurrently` 给出"这个源到底能不能读"的分数。

## 4. 读后记 · 只记录、没动的（每条都要能追溯到一次真实的事实）

### 4.1 前端侧（AI-2 领地，按优先级排着，下一轮从这里拿）

| P | 位置 | 事实 | 界面上的后果 |
| :--- | :--- | :--- | :--- |
| P1 | `searchStore.ts:428 chooseSource` | 全程不判 `openGroupGen`（对比 `openGroup` 的 `:405`/`:412`/`:420`），而 `startSearch` 在 `:297-299` 已把 `openBook/choices` 清空 | 新一轮搜索发出后，上一次换源的响应晚到，会把**上一轮的 `openBook` 写回来** —— 阅读器重新打开旧书，没有任何报错 |
| P2 | `sourceInspector.ts:269-294` | 后段正文**取失败**就 `vipHit = true` 并把 0 塞进长度数组（随后拉低均值）；另 `:269` 在早章请求抛错被吞后仍把 `totalSampleChecked` 记 1，而 `:346` 的 `validChaptersCount` 按"读成功且 ≥200 字"计 —— 同一个"检查过"两套口径 | 结论写「疑似 VIP 截断」，而事实是"没读到"：从没发生过付费判定 |
| P2 | `ReaderScreen.tsx:1251 changeChapter` | 依赖里只有 `currentBook.chapters.length`，函数体读 `chapters[nextIndex]`；`:838 playTtsChunk` 体内调 `changeChapter`（`:851` 附近）却不在它的依赖里 | 闭包陈旧风险，正常路径看不出来；要改得连判据一起，单独一轮 |
| P2 | `ReaderScreen.tsx:504`/`:505` | 两个 `useEscapeClose` 都没传 `blockedBy`（`useEscapeClose.ts:12` 支持），且 `:505` 的闭包引用 `:682` 才声明的 `setLightboxSrc`，靠"渲染期不调用"躲过 TDZ | 一次 Esc 同时关掉图片预览与离线朗读确认层；顺序一改就炸 |
| P2 | §2.9 那几行的**裸行号**（单页大区 / 媒体查询 / 浮层一档 / 死样式清单） | `CodeMapFresh` 对不带符号的裸行号只核"还在不在文件范围内"，核不了内容，所以样式表长回去之后这一段一直没人重扫：实测 `.overlay-backdrop` 现在在 `:5618`，文档写 `:5597`（差 21），`--row-h-list` 那一段本轮已按内容改正。「订阅」拆页那一轮又删掉 14 行（`:488`、`:5065-5069`、`:5213-5221`），未改的几条从此再多偏 1–15 行 | 照着文档的数字去翻样式表会翻到别处；只有带符号的指针（A/B 式）真的被门禁盯着，裸行号全靠人 |
| P2 | `main.tsx` 重复实现 | 启停两份（模块级 `flipSource`(`:120`) 与书源页批量段那组处理函数）、删除两份且**端点不同**（`batchSources('delete')` vs `api.remove`）、Esc 两份（`BookDetailModal` 自挂 keydown vs `useEscapeClose`） | 两份必然漂；换源/删源的行为在不同入口下不完全一致 |
| P2 | `main.tsx` 的 `selectedBooks` 键 vs `previousStateRef` 键 | 同一身份两套分隔符：批量选择用 `::`，缓存态与拖拽排序用 `\u0000` | `offline-pwa` 那条"分组键不许用 `::`"的判据管不到书架侧；书名里含 `::` 时批量选择会撞键 |
| P2 | `main.tsx` 的 `importSources` 失败分支 | `imported/updated` 全零而 `skipped > 0` 时 `toast.error`，而同一处 notice 写的是「导入完成：…跳过 N 个」 | "跳过"被报成失败；用户会以为导入坏了 |
| P2 | `main.tsx` 里 `App` 的 `readerReturnPage` 初值 | sessionStorage 只存 `{book, index}`，来路页没存 | 从书库/发现开书后刷新，退出阅读器回**书架** |
| P2 | `main.tsx` 的 `pendingSourceFocus`(`:119` 声明，消费在 `SourcesPage` 挂载的 effect) | `pendingSourceFocus` 只在挂载时消费且无时效 | 写入后一直没进书源页的话，下次进书源页会被一个**旧目标**填进筛选框 |
| P2 | `main.tsx` 里 `App` 的 reader 渲染分支 | `#reader` 深链在没有 reader 时条件不成立，落到默认分支渲染书库 | 地址栏写着 `#reader` 而页面是书库 |
| P2 | `main.tsx` 里发现页开 `BookDetailModal` 的那处调用 | 发现页详情弹窗只传 1 条 choice（可用书源列表要 `> 1` 才渲染），`onChooseSource` 是空函数，但体检仍联网跑 | 跑了一圈网络，结论没有出口 |
| P2 | `SourceGroupModal.tsx` 的 `handleSubmit` + `main.tsx` 那个批量分组包装 | 弹窗只有 try/finally，异常由调用方吞掉并 toast | 写库失败**照样关窗**，用户看到"改了又变回去" |
| P2 | `TocRulesModal.tsx:93`/`:143`/`:268` | 「随包 26 条」写死在三句文案里，真实条数由服务端给（`rules.total`，`:141`） | 规则表增删后界面数字与事实脱钩 |
| P2 | `TocRulesModal.tsx` 的下拉 label(`:126`) vs 开关(`:164`/`:188`) | 同一件 `enable`：下拉用真值判断（undefined ⇒ 标「不参与自动」），开关用 `!== false`（undefined ⇒ 视为启用） | 当下不可达（缺 `enable` 的只有 `auto`/`builtin` 两项，而 checkbox 只走 `rows`），但两套口径迟早咬人 |
| P2 | `sources/SourceLoginModal.tsx` 的凭据说明段(`:607-:612`) | 那段"下面列的是这本书源会带出去的凭据，删掉也会影响那些书源"只在 `jar.count === 0` 时渲染，而明细块（`:616`）的条件正是 `count > 0` | 文案指向一个按构造必不存在的列表 |
| P2 | `sources/SourceLoginModal.tsx` 的自动推荐 vs 真浏览器那一段 | 自动推荐只在 form/browser/cookie 三者里选，`external` 永不被推荐；而 `:693`/`:705` 自陈内置浏览器对风控站点"实测 forms:0 fields:0" | 最可能对上的那条路，界面上不主动指 —— 要不要纳入推荐需要拍板 |
| P2 | `SourceSwitchModal.tsx:35` / `TtsPlayerBar.tsx:72` / `ReaderScreen.tsx:955` | 「`-1` = 章节标题」与"标题归一化"这两套口径各写两份 | 迟早漂；归一化规则该收进一处（书签那条已有先例） |
| P2 | `styles.css` 死样式 | 清单见 §2.9 末段 | 不影响功能，但每次改外壳都要先在那堆残留里辨认"现行的是哪几条" |
| P1 | `lib/api.ts:38 BookNote` 与 `api.ts:508 notes(sourceId, bookUrl)` | 一条笔记的身份是 **`sourceId + bookUrl`**，定位靠 `chapterUrl` + `chapterIndex`，**没有书名 / 作者 / 章标题**。而「换源」正是这个项目的主路径（`SourceSwitchModal` → `handleSwitchSource` 会换成新的 `sourceId` 与新的 `bookUrl`） | 换了书源，之前在同一本书上划的线**整批看不见**（不是错乱，是查不到：`GET /api/notes?sourceId=…&bookUrl=…` 用新的一对去查）。根 `AGENTS.md` 的「书签/跨书源」那条描述的正是这个需求，而那条写的是**已删除的旧书签功能**（§4.2 第 1 条）—— 现在这套笔记没有继承那个设计。要做跨源，身份只能是「书名 + 作者」，章坐标只能是章标题（三级匹配那套已有先例），需要服务端加字段：**API-REQUEST 见 `COORDINATION-ai2.md`** |
| P2 | `ReaderScreen.tsx:322` 的 `const [uiV2] = useState(…)` | **没有 setter、界面上也没有入口**：旧那套（`ReaderHeader` + 右侧设置抽屉，`:2652`）只能靠 `?ui=legacy` 或把 localStorage `reader-ui-v2` 置 `0` 才走得到。两个渲染分支各养一份工具栏（另见下一条） | 回退档只对知道钥匙的人开放；而"两套外壳都在树上"意味着每改一次顶栏都要改两处。要么在「设置」里给一颗能切的开关，要么按"不保留兼容层"把旧档删掉 —— 这是产品决定，不擅自做 |
| P2 | `readerMenu.ts:10` 的 `label` vs `ReaderHeader.tsx:27 menuButton` vs `Md3Chrome.tsx:28 TopAction` | id 清单同源，**aria 文案却是两份 switch 各写一份**（`readerMenu` 那份「全屏」只给设置列表用，两处渲染写的是「全屏阅读 / 退出全屏」） | 加一个动作要改三处：漏了 `readerMenu` 的值域=勾不到；漏了任一渲染=设置里能勾、顶栏不出现，且不报错 |
| P2 | `ReaderSettingsControls.tsx:34` | 当前标签页是组件内 `useState`，**不持久化** | 每次开「界面」弹层都回到「排版」；用户上次停在「颜色」这件事没地方记（要不要记是产品决定） |
| P2 | `ColorTab.tsx:38` | `<input type="color">` 的 `value={settings.readerBgColor \|\| '#ffffff'}` —— 存的空串意思是"不设背景色"，显示出来是"白" | "没设"与"设了白"在界面上长得一样，只能靠旁边那颗「清除背景」才知道有这回事 |
| P2 | `TypographyTab.tsx:32` | hint 文案写死「宽屏 (≥800px)」，同一条算式在 `readerInteractions.ts:83` | 改阈值时**不会有任何东西变红**，只会让说明变成假话（与「随包 26 条」那类同形） |
| P2 | 排版数值的边界写了 **2~3 份**：`readerSettings.ts:399`/`:400`/`:401`/`:403`/`:324`（读回时夹）、`lib/backupPreferences.ts:81`/`:86`/`:96`（折算备份时夹）、`settingsPanel/TypographyTab.tsx:21-29`（滑杆的 `min`/`max`） | 字号那一档本轮已收成 `fontSizeControl.ts` 一份，剩下五档（行距 1.45–2.4、字距 -.25–1.5、段距 .7–2、边距 20–120、版心 560–1400）仍是三处各写。三处口径现在**碰巧一致**，改一处就出现"拖到最大、重开被夹小"或"备份映射把界面上进得去的值夹出去" | 收成一张 `READER_RANGES` 表（读回 / 折算 / 滑杆三处都引它），并把 `FontSizeControl.test.ts` 那条扫描推广成"边界除这张表外不许出现字面量"。做法与字号那档完全同形，但一次动三份文件 + 判据，单独开一轮做，不塞进本轮的"找回丢掉的东西"里 |

### 4.2 归 AI-1（`server/`、`tools/` 领地，已按规程写进 [`docs/dual-ai/COORDINATION-ai2.md`](dual-ai/COORDINATION-ai2.md)）

| P | 位置 | 事实 | 建议 |
| :--- | :--- | :--- | :--- |
| P1 | 根 `AGENTS.md` 的「书签/跨书源」那条 + 「界面/分配 · 一级导航」那条 | 「[书签/跨书源]」整条描述的是**一套已经不存在的功能**：`web/src` 里没有任何书签模块，`AppHeader.tsx:252` 明写「书签功能已在 0.6.12 整体删掉」；而那条讲的 `Database.bookKeyOf` 与前端那份 `bookMarkKey`（据说在 `web/src` 的 `bookmarks.ts` 里）实测 `grep -rn bookKeyOf server/src web/src` **零命中**。同族第二处：那条「一级导航」写「『我的』只留 书签 / 关于 / 全屏 / 自定义」，现在菜单实际只剩 自定义(`AppHeader.tsx:206`) / 关于 / 全屏 | 部落知识条目比代码更容易过期，而且它会被人当作事实引用（本轮就是照着它去找 `bookKeyOf`）。要么删掉这两条、要么改成"书签已于 0.6.12 移除，跨书源身份若重做，键与归一化只能有一份" |
| P2 | `http/Routes.kt:967-968` | 注释说「这里是 queryParameters：`call.parameters["q"]` 读的是路径参数，永远为 null」，而 `:969` 实际写的就是 `call.request.queryParameters["q"]`；实测 `GET /api/rss/tabs?sourceUrl=…feed` 回 200、`DELETE /api/rss/sources?sourceUrl=…` 回 204、`?q=探针` 过滤出 1/1/0 —— 筛选一直是生效的 | 注释是错的，删掉或改成正确说明。文档里一句错话比没有这句话更坏（AGENTS 那条「引用不存在的文件」同族） |
| P2 | `http/Routes.kt:323` | `failedCount = results.count { !it.ok }` 把 `explore_only`/`no_search`（一个请求都没发）与"真连不上"加成一个数 | 前端已经不用它（`sourceGrouping.ts:91-92`、`sourceHealthRun.ts:137` 自己按 `tierCounts` 数），但契约面还留着；要么删字段，要么改成按档发 |
| P2 | `tools/verify/frame-metrics.mjs:78`/`:84` | 两个分支按 `.desk-header` / `.search-results` 取样，而这两个类在界面里已经没有消费者 | 门禁分支永不命中（量到 0 会被读成"密度不对"），删分支或换选择器 |
| P2 | `source/SourceDebugger.kt:46`/`:65`/`:92`/`:118`/`:144` ↔ `web/src/sources/SourceDebugModal.tsx:13` | 阶段名与服务端是两处各写一份的字面串，靠字符串对齐 | 由 `/api/sources/{id}/debug` 把阶段清单下发，前端不再硬写 |

## 5. 读后记 · 这一轮当场改掉的（都带判据）

| # | 位置 | 问题 | 改法 | 判据 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `reader/TapZoneEditor.tsx` 两条把手 + `reader/tapZones.ts` 的 `removeCut` | 双击删虚线写成 `cuts.filter((_, item) => item !== index)` —— 回调第二个参数是**值**不是下标，删不动且无报错；横竖两条把手都中了（竖的上一轮已修，这条是通读时读出来的） | 抽 `removeCut(cuts, index)`，两条把手都改它 | `TapZones.test.ts` 按下标删 + `tap-zone-editor.test.ts` 钉两条把手都不许再出现按值比的 filter |
| 2 | `reader/ReaderScreen.tsx` 的 `offlineStorage` 导入块 | `putOfflineChapter` 死导入（全文只此一处） | 删 | `tsc -b` |
| 3 | `reader/ReaderScreen.tsx` 的 `handleSwitchSource` | 换源只清了预载：不停朗读、不清续接窗口、不换容器 key、不置 loading —— 旧书的续接章节挂在新 `currentBook` 下，而朗读 chunks 变空后直接 `return`，**悬浮条停在播放态却不出声** | 补 `stopTts()` + 清 `flowTail/flowHead` + 复位 `flowAdvanceRef/pendingKeepRef/pendingPrependRef` + 换 `flowKey` | `ReaderFlow.test.ts` 未覆盖（要真浏览器演），已在 §4 记下补门禁 |
| 4 | `lib/offlineStorage.ts` 的 `downloadChaptersToOffline` 收尾 | 本地同步进度分子写成"整本书已缓存 + 本次完成"，分母是这次切片 —— 已缓存 300 章时同步 50 章会念成「350 / 50 章」（进度条因 `Math.min` 反而看不出来） | 分子改成 `chapters.length - total + completed` | `offline-pwa.test.ts`「本地同步进度：分子只能数这一次切片」 |
| 5 | `lib/searchStore.ts` 的 `startSearch` + `main.tsx` 的 `runSearch` | 服务端把空 `sourceIds` 当"不限制"（`data/Database.kt:383` 的 `takeIf { it.isNotEmpty() }`），而历史词 chip 绕过提交按钮的闸门直接发搜 —— "只搜这一组、组里零个启用源"变成搜全库 | store 侧空表一次都不发；chip 与表单同源走 `runSearch`（守卫 + 记历史只有一份） | `search-store-lifecycle.test.ts`「范围是空表时一次请求都不发，非空时照常发」（含反向对照） |
| 6 | `sources/SourceShareModal.tsx` 的导出 effect | 单源分享且那条存储非法 JSON 时，把 `JSON.stringify(null)` 得到的字符串 `"null"` 当分享内容 —— 复制/下载按钮照样能点，与同一句"已跳过"自相矛盾 | 没内容就不给 payload（按钮自然禁用） | 记入 §4.1（弹窗内容要真浏览器演，暂不单开判据） |
| 7 | `sources/SourceLoginModal.tsx` 的 `bookmarkletCode` | `.then(r => r.json()).then(() => alert('已把…同步进青阅'))` 不判 `r.ok`；`/login-cookie` 对不属于该书源域的 Origin 回 403 **并带能 parse 的 JSON 体** → 被拒绝也报成功 | 先取文本再判 `ok`，失败时把服务端 `message` 念出来 | `source-login.test.ts`「书签代码必须先判响应状态」 |
| 8 | `reader/ttsEngine.ts` 与 `reader/ttsTextProcessor.ts` 的剥除区间 | 剥标点的区间写作 `\uFF00-\uFFEF`，把**全角数字/字母**也算标点：`１２３４５` 这类分片被判成"没东西可播"而静默跳过 | 收窄成四个标点子段；两处口径钉成同一串 | `tts.test.ts` 两条（行为 + 两处同源反扫） |
| 9 | `components/LogsModal.tsx` 与 `sources/SourceDebugModal.tsx` | 同一组件各挂两份 Esc（手写 `keydown` + `useEscapeClose`）：一次按键触发两次关闭，且手写那份不参与"一次只关最上面一层" | 各收成一份 `useEscapeClose`（调试台的收流移到卸载清理） | `UiContract.test.ts` 的浮层一档判据 |
| 10 | `sources/SourceDebugModal.tsx`、`sources/SourceGroupModal.tsx`、`sources/SourceWebViewModal.tsx`、`reader/TtsSettingsModal.tsx` | 四份文件各有一处**裸 `\r`** 当行分隔（JS 认它是行结束，所以运行与 `tsc` 都不报错），但任何按行处理的工具都会把两条 `import` 读成一条 | 裸 `\r` → `\n` | `node` 数 `\r(?!\n)` 归零；`CodeMapFresh.test.ts` 的行数按 `\n` 计，漂了就红 |
| 11 | `sources/bookSourceFields.ts` 尾部 | `SOURCE_FIELD_COUNT = 95` 零引用，且与列表两份真相 | 删（总数由 `SourceEditorPanel.tsx:124` 现算） | `tsc -b` |
| 12 | `sources/sourceInspector.ts` 的别名导出 | `createInitialInspections` 只是 `getInitialOrStoredInspections` 的别名，产品侧零调用（只有测试在用） | 删别名，测试改指真实现 | `source-inspector-concurrent.test.ts` |
| 13 | `main.tsx` 的 `itemsLoaded`/`shelfFailedEmpty`/`selectAllBooks`/卡底那格百分比 | ① 书架第一帧就说「书架还是空的」（`items` 初值 `[]` + 异步 `load`），而同文件分组那栏已经分了"还没到 / 取失败 / 确实没有"，自相矛盾；② 「全选」按整架取键而列表按 `visibleItems` 渲染，title 却写着"全选当前页"；③ 一张卡两个百分比（hover 层 `+1`、meta 层不加） | 加 `itemsLoaded` 与失败档 `shelfFailedEmpty`；`selectAllBooks` 改按可见列；meta 与 hover 同口径 | `ShelfState.test.ts` 四条（每条带反向对照） |
| 14 | `api.ts:94` | `statusCategory` 注释枚举缺 `explore_only`/`no_search`，而这两类正是"没发过请求"那批；只读 `api.ts` 的人会以为它们算坏源 | 注释补齐并写明"不是连不上"，另标注 `failedCount` 的口径 | — |
| 15 | 本文件 | 通读文档自己没有防漂移机制 | `CodeMapFresh.test.ts`：钉"文档里写的行数 == 磁盘行数"、"文档点的文件必须存在"、"`web/src` 每份文件都被覆盖" | 已注册进 `run-all.ts` |
| 16 | `reader/fontSizeControl.ts` 的"唯一口径" + `readerSettings.ts:397` + `lib/backupPreferences.ts:62` | 注释名义上写"只有这里一个出处"，实际读回 localStorage 与折算备份 dp 时**又各抄了一遍 `15, 28`** —— 改边界仍要改三处，且没有任何东西会红。更糟的是 `FontSizeControl.test.ts` 的表头从 P1 起就写着"钉的就是只有一个出处"，而它一条也没扫过 | 两处都改成引 `READER_FONT_SIZE_MIN/MAX`（备份那处直接用 `clampFontSize`），注释补写这两个下游 | `FontSizeControl.test.ts`「字号边界除 fontSizeControl.ts 之外不许再出现字面量」，含三种历史写法反扫 + 行距 `1.45, 2.4` 的误报对照 |
| 17 | `reader/Md3Chrome.tsx` 头部注释 | 「与旧 `ReaderHeader` 并列、由 `reader-ui-v2` 开关切换（**默认走旧界面**）」是 PROPOSAL-020 P1 当时的状态；0.7.0 已把 MD3 上线为默认（判据是 `!== '0'`），照着注释读的人会以为要开开关才用得上 | 注释改成"这是默认，旧那套是回退档"，并写清两个回退入口 | `ReadThroughFixes.test.ts`「MD3 外壳的注释不许把\"默认\"写回旧界面」+ 同条钉住 `localStorage.getItem('reader-ui-v2') !== '0'` 这个判据本身 |
| 18 | `reader/ReaderSheet.tsx` 的 Esc | 「界面」「设置」是**两个同时挂在树上的实例**（`ReaderScreen.tsx:2638`/`:2641`），`useEscapeClose(onClose)` 与 `open` 无关 → 按一次 Esc 触发两次关闭。此刻两处都写同一个 `null` 看不出症状，等哪张的关闭变成"还要还回点什么"时就是错关 | 只在 `open` 时接（`useEscapeClose(open ? onClose : ignoreEscape)`） | `ReadThroughFixes.test.ts` 一条：正向钉新写法、反向对照旧写法、并断"两张同时挂着"这个前提本身（`<ReaderSheet ` 恰好 2 处）—— 前提没了这条判据的意义就变了，要跟着重写 |
| 19 | `reader/TocDrawerHeader.tsx:56` 与 `reader/ReaderScreen.tsx:208` 的注释 | 注释用**裸行号**指代别的文件（「核了 `:1917` 的 className」「`RuleRunner.kt:1389`」）。`ReaderScreen` 在 0.7.0 长了 148 行、`RuleRunner.kt` 拆包后也漂了 —— 两句现在都指向不相干的一段 | 改成按名字指代（`reader-drawer-left` 那条 className、`RuleRunner.kt` 的 `chapters()`） | `ReadThroughFixes.test.ts`「源码注释里不许写跨文件的裸行号」：递归扫 `web/src` 的注释行，违规样本两种各有反扫自证（把两种违规与三条合规样本各喂一遍那两个正则） |
| 20 | 本文件的**行号指针** | 325 处 `symbol`(`:N`) 里 **120 处（37%）指错**：0.7.0 重做阅读器让 `ReaderScreen` +148 行、`main.tsx` +37、`api.ts` +21…，表格「行数」那一列有判据而指针没有，于是文档看起来"像是对的"，照着跳过去找到的是别的东西 | 一次性脚本（不入库）按符号声明行重抄 121 处（A 式）+ 10 处（B 式散文带文件名），选点先按"像不像声明"分档、同档取离原行号最近 —— 全按"第一次出现"会把引用使用点的指针挪到毫不相干的声明行上 | `CodeMapFresh.test.ts` 三条新判据：A/B 式逐条核"那一行写着这个符号"、C 式（裸行号段）核范围，加"指错与越界都必须被逮住"的反向对照；`checked >= 500` 防空判 |
| 21 | 本文件的**章节标题总量** | 标题里那几个"总数"全过期：ReaderScreen 写着 2,791（实际 2,939）、styles.css 写着 5,674（实际 5,846）、服务端 36 份写总行 14,346（实际 14,593）、web/src 写 69 份 26,854 行（实际 91 份 28,592）。表格列有判据，**标题里没有** —— 而标题是人先看的那一个数 | 数字全部按磁盘实量重写 | `CodeMapFresh.test.ts`「章节标题里写的总量与磁盘一致」，认两种写法（反引号文件名 + N 行 / 反引号目录 + N 份 M 行），解析不到就判红 |
| 22 | `web/test/CustomizeSkin.test.ts` 那条"每个 `*.test.ts` 都必须在 run-all.ts 里注册" | 这条判据自己**是瞎的**：用 `fs.readdirSync(dir)` 只扫一层，而 `web/src` 早在 C 档就拆成六个子目录 —— 谁把测试放进 `web/test/<组>/`，它既不在枚举里、`run-all.ts` 的 `'./X.test.ts'` 形式也配不上，于是"注册判据"本身变成假绿（AGENTS「非递归的扫描会静默变瞎」那条的同形） | 改成递归枚举 + 按相对路径核注册；另加一条**数量相等**断言（注册条数 == 磁盘份数，重复注册或引了不存在的文件也会红）；反向对照：从 runner 文本里删掉一条真注册必须报红 | 该条自身（含 子目录里那种 `reader/…` 相对路径写法不误报）；实测当前 65 份 / 65 条注册，无遗漏 |
| 23 | `web/tsconfig.json` 的 `include` 只有 `["src"]` | **`web/test/**` 从来没被类型核过**（本地 `check` 与 `build-jar.yml` 里那条都是 `tsc -b`）。第一次拿一份带 `allowImportingTsExtensions` 的配置去核，量出 **16 处真漂移**，全是"判据在断一个产品里已经不存在的形状"：`putOfflineChapter` 被喂第 6 个参数（产品签名 5 个，多出来的静默丢掉）、离线进度夹具写 `chapterTitle`/`readProgress` 而接口是 `chapterUrl`/`scrollPosition`、`setFilters` 喂 `minChapters` 并断言它原样回来（store 整对象存，所以"过"得毫无意义）、`SearchGroup` 从 `searchStore` 导入其实导出在 `searchFilters`、`ToastListener`/`ToastMessage` 根本没导出且从未使用、`sortMode:'relevance'` 不是 `SortMode` 的档、`ShelfDragOrder` 的夹具缺 `cachedChapters` 等必填项 | 逐条按现行契约改判据（不是改产品）；再加 `web/tsconfig.test.json` + `npm --prefix web run check:test` 这条命令；`readdirSync(..., { recursive: true })` 八处补 `encoding: 'utf8'` 去掉类型噪声 | `check:test` 现在 0 错；**没并进 `check`**（CI 跑的是 `check`，并进去等于让 npm 依赖一动就可能红在探针上），要并先在协作日志里说一声 |
| 24 | `web/test/HeaderMenu.test.ts` 两条空判 | `'Theme change handling'` 自己定义 `onSettingsChange`、自己调用、再断言"刚赋的值等于我赋的那个"；`'Logout confirmation safety'` 自己写一个 `confirmLogout` 再断言它调了 `onLogout` —— 两条都不碰 `AppHeader`，因此**不可能失败**；后者测的还是已经删掉的鉴权 | 删（真覆盖在 `CustomizeSkin.test.ts` 与 `tools/verify/portal-theme-check.mjs`，"鉴权已删"那条由同文件的静态渲染用例钉着） | 套件 537 → 535；`web/AGENTS.md` 潜规则第 12 条 |
| 25 | `web/test/run-all.ts` 的整份形态 | 上一条把注册判据改成"递归扫 + 数量相等"之后，剩下的病其实是**清单本身**：65 行手写 import，少抄一行就是"存在但从未运行"，而这是本仓库出过三次的同一条（`HeaderMenu`、`LocalBookImport`、0.7.0 那次连代码带判据被 rebase 丢掉）。判据能事后逮住，逮不住"这一轮没人跑判据" | 入口改成**扫目录**：规则单列成纯函数 `web/test/discover.ts`（递归 + 按路径排序 + 把 `\\` 归一成 `/` —— Windows 的递归 `readdir` 给的是反斜杠，不归一就没法 import 子目录那份），`run-all.ts` 只做"逐份 `await import`"，并且**少于 60 份就 `exit 1`** —— 过滤器写错最坏的表现是"全绿而什么都没跑"，宁可拒绝通过。判据跟着换职责：拿一个独立的朴素递归走查当参照物比对，再用临时目录做反向对照（子目录那份必须被看见、非 `.test.ts` 不许收进来） | 排序加载后 65 份 / **535 条全绿**（与清单时代逐条对得上，没暴露顺序耦合）；现场演过"扔进一份新测试、不改任何清单就被跑到"：66 份 / 536 条，探针随后删掉；`CustomizeSkin.test.ts` 那条在两种注入下各红过一次（漏子目录、把非判据文件收进来） |

| 26 | 门面文档的**路径引用**（本轮规整） | 全仓扫了一遍引用：`docs/compatibility.md` 里三处还写着 C 档之前的旧平铺位置（sourceImport / sourceGrouping 挂在 `web/src` 的 lib 那层，实际在 sources 下）与一个用省略号缩写的服务端路径；本文件另有八处把**仓库外的 `tmp/` 一次性脚本**当依据引用 —— `.gitignore` 第 10 行排除 `/tmp`，本机 `test -e` 是绿的、克隆仓库的人拿不到（AGENTS 那条 gitignore 形态的悬空引用同形）。反倒 30 条 markdown 链接全对：断的都是写在反引号里的裸路径，因为**没有任何东西会为它红** | 路径改成现状；`tmp/` 那八处换成"一次性脚本，不入库"并指明可重跑的是哪条判据；新增判据把这件事钉住 | `web/test/DocPaths.test.ts`：逐条核反引号里带目录的路径能在 `git ls-files` 里落到（`../` 按文档自己的目录算、短路径按后缀唯一匹配、标「上游」那行放行、`tmp/` 一律判红）；反向对照三种写法各逮一条，合规写法不误报 |

## 5.1 这一轮是怎么验的（数字，不是形容词）

### 2026-10-14 · 把 0.7.0 丢掉的那轮重新落地

- `npm --prefix web run check`（`tsc -b`）干净；`npx tsx web/test/run-all.ts` **537 条全绿**（本轮新增 12 条：`ReadThroughFixes.test.ts` 11 条 + `CodeMapFresh.test.ts` 的三条指针/总量判据，减去上一轮那两条的合并）。
- **判据自身再体检**（用户追问"run-all 还有没有漏的测试项"之后）：注册面 65 份 / 65 条**没有遗漏**，但查的过程里量出三件事，
  最后一件改变了入口本身的形态 ——
  ① 那条"每个测试都要注册"的判据自己只扫一层目录；先改成递归 + 数量相等 + 反向对照；
  ② `web/test/**` **从来没被类型核过**（`web/tsconfig.json` 的 `include` 只有 `["src"]`，本地 `check` 与 `build-jar.yml` 都是 `tsc -b`），
     第一次核量出 **16 处**"判据在断产品里已经不存在的形状"（第 6 个参数、`chapterTitle`/`minChapters`/`relevance` 这些没有的字段、
     从错的模块导 `SearchGroup`、两个从未导出的 `Toast*` 类型），逐条按现行契约改判据（产品一行没动），
     另开 `npm --prefix web run check:test`（现在 0 错，**没并进 CI 那条 `check`**，理由见 §5 第 23 条）；
  ③ 清单式注册真正的病不是"判据扫了几层"，而是**少抄一行只是少跑、不会红** —— 所以 `run-all.ts` 改成扫目录
     （规则单列在 `web/test/discover.ts`），判据跟着改核"扫描规则本身"（朴素递归走查当参照物 + 临时目录反扫），
     `run-all.ts` 还带一个"少于 60 份就 `exit 1`"的闸门。
  另删两条不可能失败的自证用例。末了数字：**65 份 / 535 条全绿**（原 537，减掉的两条是空判），
  并现场演过"扔进一份新测试、不改任何清单就被跑到"（66 份 / 536 条）。详见 §5 第 22–25 条。
- **先承认失效方式**：`2fd86de` 那 15 处 `web/` 修复与两条防腐烂判据**没进 `main`**（0.7.0 那条线 rebase 时只取走了文档提交）。症状不是报错，是"已经修好的东西又坏回去而套件全绿" —— 这正是这两条判据存在的理由，所以本轮第一件事是让它们先红一遍再改回来。
- 重新落地的动作由两个幂等的一次性脚本重放（不入库）：第二次跑时已应用的条目报 NO-MATCH，所以"跑了两遍"不会把代码改坏。**踩到的坑记一条**：为了回滚一次注入而 `git checkout -- web/src/main.tsx`，把没提交的书架三件（`itemsLoaded` / `selectAllBooks` 按可见列 / meta 百分比）一起冲掉了 —— 脏文件上不许用 `checkout`，改用"重放脚本"。
- 新增/恢复的判据逐条带反向对照：
  - `FontSizeControl.test.ts`「字号边界除 fontSizeControl.ts 之外不许再出现字面量」：三种历史写法（`clampNumber(…, 15, 28, …)`、`clamp(…, 15, 28)`、`Math.min(28, Math.max(15, …)`）都反扫到，行距的 `1.45, 2.4` 不误报。
  - `ReadThroughFixes.test.ts`「底部弹层只在开着的时候接 Esc」：正向钉新写法，反向对照 `useEscapeClose(onClose)`，并且**断言前提本身**（`<ReaderSheet ` 在 `ReaderScreen` 里恰好 2 处）—— 前提哪天没了，这条的意义就变了，要跟着重写而不是默默恒真。
  - 同文件「源码注释里不许写跨文件的裸行号」：递归扫 `web/src` 的注释行；那两个反扫样本里对两种违规情形（`RuleRunner.kt:1389`、`核了 :1917`）与三条合规样本各演一遍，确认既逮得住也不误报。
  - `CodeMapFresh.test.ts`「每一处行号指针都指到写着那个符号的那一行」：`checked >= 500` 防空判（现在 644 处），反向对照用一份假文档喂 `:9999` 与 `:300-:400` 两类越界，必须各报一条；再用**真声明行**写一条同格式的指针，必须不报（证明红是因为指错而不是正则瞎）。
- 文档这一侧的数字全部由脚本重抄，不手抄：改「行数」列的一次动了 35 行，改指针的一次动了 131 处；重抄与核对都只是一次性脚本（写在仓库外的 `tmp/` 下，`.gitignore` 把 `/tmp` 整目录排除，所以**这里不留它们的文件名** —— 照着找不到东西）。**能重跑的只有判据**：`npx tsx web/test/CodeMapFresh.test.ts`，它核的就是同一批事实（行数、指针、总量、覆盖率）。
  **指针选点规矩值得记**：先按"像不像声明"分档（注释行垫底），同档取离原行号**最近**的一行。第一版按"第一次出现"改，把 `status`(`:23`)（一个 `const [status, setStatus] = useState` 的解构声明）挪到了 273 行的一处无关提及上 —— 脚本能改数字，但语义要人核，所以才留下 `[只提到]`/`注释` 这两档标记供逐条过目。
- **没做的事**：本轮没起浏览器门禁（`tools/verify/*` 要 jar 与同源实例，而 `:server:fatJar` 在 AI-2 权限外）。所以 §5 第 17–19 条是**注释与结构层**的修复，界面行为没变；第 16/18 两条有判据，第 17/19 两条是判据钉住的写法约定。真正需要实机演的还是那几条老面孔（换源后朗读态、书架首帧），照旧等 AI-1 重打 jar 之后按验收手册走一遍。

### 2026-10-11 · 通读那轮（原文照录）

- `npm --prefix web run check`（`tsc -b`）干净；`npx tsx web/test/run-all.ts` **466 / 466 绿**（本轮 +14 条）。
- 六处注入逐条验证"违规时它会红"：`TapZoneEditor`（改回 `map.y.filter((_, item) …)`）、`main.tsx`（`selectAllBooks` 改回按整架取键）、
  `searchStore.ts`（摘掉空范围闸门）、`offlineStorage.ts`（进度分子改回整本书）、`SourceLoginModal.tsx`（书签代码改回不判 `r.ok`）、
  `ttsTextProcessor.ts`（剥除区间改回整段 `\uFF00-\uFFEF`）——**五红 + 一处 needle 没递进去**（shell 把 `\\u` 吞成了真字符），
  后者另写一次性脚本重演（不入库），结果同样是红；还原后逐条复绿。
- 真浏览器演了书架那一组（一次性探针，不入库；跑在刚构建的 `web/dist` 上）：把 `/api/bookshelf` 按住时屏上是
  「正在读书架…」，**不是**「书架还是空的」；放开后 5 张卡到手，其中 3 张两处都画百分比、数值全部一致。
- **演不了的那半如实说**：「全选」漏选/多选只有做批量写操作才暴露，而换端口的静态壳发写会撞同源闸门 403
  （本机既有安全边界，不改）。所以这条由 `ShelfState.test.ts` 的结构判据钉住，浏览器侧只演了"可见的都选中"这半（0 张时它自己声明是空判）。
- 判据自己被自己逮到一次真漂移：`api.ts` 加了 5 行注释后文档还写着 653 行 —— `CodeMapFresh.test.ts` 当场报红，这就是它存在的理由。
- **产物仍未更新**：`./gradlew :server:fatJar` 被我这边的权限分类器挡下（`server/` 不在 AI-2 权限内，
  见 `docs/dual-ai/README.md` 的发版队列），所以本轮界面改动还没落到 1234 那个 jar；发版与版本号照旧等 AI-1。
- **接住 C 档那轮（`main` 上的 `e982890`）**：文件都挪了目录，所以本文的引用全部重核过 ——
  12 处服务端行号（`data/Database.kt:382-:383`、`http/Routes.kt:323`/`:969`、`source/SourceHealth.kt:58`、
  `http/Guard.kt:28`/`:40`、`source/SourceDebugger.kt:46` 起、`model/Models.kt:673`/`:680`）重 grep 过，
  正文里 33 处"只为指出在哪儿"的行号改成符号锚点（行号会随无关改动漂，符号名不会）；
  我这 6 份判据里按路径读源码的 4 处（`tts.test.ts`、`source-login.test.ts`、`tap-zone-editor.test.ts`、`CodeMapFresh.test.ts`）
  全部改成新布局，`CodeMapFresh` 顺带升级成递归枚举 + 目录前缀反扫（写错目录也红，反扫验过）。
  合并冲突 8 处，其中 4 处正是那批裸 `\r` 行断裂：移动后的文件带着旧写法回来，解法是"取新路径 + 去掉裸 `\r`"，两条信息都没丢。

## 6. 服务端读照（`server/src/main/kotlin/io/legado/server`，37 份 14,833 行，已按职责拆成 12 个子包）

> **领地声明**：`server/` 归 AI-1。0.7.0~0.7.3 这几轮**一行代码都没动**；0.7.4 动了四条代取书源资源的链路
> （`http/ProxyHeaders.kt`、`cache/CoverCache.kt`、`http/Routes.kt` 的媒体流与封面、`rules/RuleRunner.kt` 的媒体地址嗅探），
> 理由与回滚命令记在 `docs/dual-ai/COORDINATION-ai2.md`。这一节的作用是：让前端知道每一侧的对面是什么形状，
> 以及把我能用命令复现的事实交出去（见 §4.2 与同一份协作账）。
> 读法与前端不同：两份并行读码 + 我只逐条**实测**了我准备发表的那部分（curl / grep / 读文件），
> 没实测到的不写在这里 —— 所以这一节是"照录 + 口径"，不是服务端注释的替代品。

| 文件 | 行 | 它管什么 | 与前端对得上之处 |
| :--- | ---: | :--- | :--- |
| `http/ProxyHeaders.kt` | 33 | 代取书源资源（封面 / 正文配图 / 音视频流）该带哪些请求头，**一处定死** | 浏览器的 `<img>` / `<audio>` / `<video>` 带不上自定义头，这三条路全靠服务端代取。Cookie 按**每一跳的落地域名**现取（同一个 `Database.getCookieForUrl`，与文本链路同源），Referer 走完重定向链。以前三条代理路一条都不带 Cookie ⇒ 「书源登录成功、目录正文读得出、图和音频流还是 403」。判据 `ProxyHeadersTest.kt`（端到端演不了：SSRF 闸门拒回环地址，本地假上游连不上） |
| `Routes.kt` | 2,386 | 全部 HTTP/WS 端点；`route("/api")` 下再分 `/sources/{id}`、`/tts`、`/rss`、`/res`、`/replace-rules`、`/external-login`、`/browser` | 前端 `api.ts` 的端点表逐条对得上；`/api/rss/tabs`、`DELETE /api/rss/sources` 实测 200/204 且 `?q=` 过滤生效（§4.2 第 2 条说的是那句错注释，不是功能） |
| `data/Database.kt` | 2,302 | SQLite（WAL）：`source`、`book_shelf`、`book_group`、`reading_progress`、`book_toc_cache`、`book_content_cache`、`cover_cache`、`source_subscription`、`rss_source`、`source_login_state`、`cookie`、`replace_rule`、`log_db`/`log_entry` | `listSearchSourceRecords`(`:408-:409`) 对空表取 `takeIf { it.isNotEmpty() }` ⇒ **空 = 不限制**，这就是前端 `searchStore.ts:268` 那道闸门的由来；体检那条不在这张表上按 id 逐个查（`source/SourceHealth.kt` 的 `probe` 收的是 `(id, name, rawJson, …)`，记录由调用侧一次取回） |
| `RuleRunner.kt` | 1,542 | 书源规则执行（Jsoup + JsonPath + `@js:` 替换） | 体检分档、搜索、目录、正文都走它；替换净化在 `content()` 与离线落库前各执行一次，所以朗读天生拿到清洗后的正文；`content()` 末尾还会**嗅一次正文**（`sniffMediaUrl`：整段就一行、以 http(s) 开头且后缀是音视频格式时把它当媒体地址回传）——社区里 `bookSourceType` 填错的音视频源据此能播 |
| `JsSandbox.kt` | 840 | Rhino 沙箱 | 顶级 `return` 要包装、`JavaImporter` 必须是空替身（AGENTS 那两条），否则整批书源报错 |
| `WebViewProxy.kt` | 815 | 内置登录浏览器的整站反代 + 一次性令牌 + `Set-Cookie` 吸收 | `SourceWebViewModal` 的 iframe 能不开 `allow-same-origin` 全靠这一侧 |
| `Models.kt` | 846 | 全部 `@Serializable` 请求/响应体 | `Map<String, Any>` 在这侧会直接 500，所以响应体都是具名 data class；`SourceHealthCheckItem` 在 `model/Models.kt:673`、`statusCategory` 在 `:680` |
| `LocalBookParser.kt` | 602 | TXT/EPUB 解析、分章、`loc_book` 虚拟书源入库 | 前端 `api.importLocalBooks:528` 把分章规则走 query 而不是 multipart 字段（字段到达顺序靠不住） |
| `EdgeTtsService.kt` | 472 | Edge-TTS 合成与会话流 | 有效字符 < 2 直接回 0 字节不请求上游 —— 与前端 `ttsEngine.ts:17` 那三道防线是同一件事的两半 |
| `TxtTocRule.kt` | 417 | 随包 26 条分章规则 + 自建 + 覆盖 | `candidates`（启用 ∩ 可编译）与 `selectable`（能不能手动选）是两个旗标；id `-100` 是内置逐行匹配，`rule` 为空是设计 |
| `TtsSessionService.kt` | 411 | 会话级连续音频流（`MutableSharedFlow` 广播） | 探针 + 主流两次连接必须都活着，所以不是单消费者 Channel |
| `BackupImporter.kt` / `LegacyBackup.kt` / `BackupStore.kt` | 306/268/95 | 备份收包（纯内存按需读 zip、炸弹上限、`KEEP_NAMES` 合法包） | `BackupPage.tsx` 那两套桶（承接到本机 vs 原样收下）与它一一对应 |
| `SourceHealth.kt` | 134 | 体检分档；**读到顶层 `searchUrl` 为空就地定档，一次网络都不发** | `:56` 的 `explore_only`/`no_search` 就是前端「未配搜索」那一档 |
| `http/Guard.kt` | 86 | 同源闸门：比对的是 `ServerIdentity`(`:28`)，由 `Application.kt:71` 在启动时写入，Origin 的**主机与端口**都要等于服务自己的绑定身份才算同源（`isSameOriginIdentity`(`:59`)）；无 `Origin` 头放行 | 前端因此没有任何令牌注入；换端口的静态壳演不了写流程（403），这是门禁里踩过的坑 |
| `SourceDebugger.kt` | 170 | 分阶段调试的 SSE 事件（阶段名字面串在 `:41`/`:60`/`:87`/`:113`/`:139`） | 与 `SourceDebugModal.tsx:13` 的 `STAGES` 是两处各写一份（§4.2 第 5 条） |
| `ExternalBrowserLogin.kt` | 224 | 真浏览器登录（拉起、抓取、状态） | `SourceLoginModal` 的 external 分段与 2.5s 轮询对着它 |
| `DesktopLauncher.kt` / `StaticWeb.kt` / `AppConfig.kt` / `ServerConfig.kt` | 247/71/59/49 | 桌面封装、静态资源托管、配置与默认端口 | `ServerPortModal` 只写 `port.txt` 并如实说"重启后生效" |
| 其余 | — | `LogService.kt`(227)、`RuleValue.kt`(446)、`RuleSplit.kt`(222)、`ContentProcessor.kt`(184)、`CoverCache.kt`(214)、`LooseJson.kt`(169)、`SourceCodec.kt`(145)、`UpdateCheck.kt`(140)、`NetworkSecurity.kt`(82)、`SubscriptionService.kt`(124)、`BookCacheService.kt`(184)、`ContentPipeline.kt`(37)、`JsGuard.kt`(40)、`BuildInfo.kt`(18)、`Application.kt`(162) | `normalizeSourceId`（`SourceCodec.kt`）与前端 `bookSourceFields`/`SourceEditorPanel.tsx:31 declaredSourceId` 同口径：主键是剥掉 `#`/`##` 注解的域名 |

**一条读码纪律记在这里**：这一节的每个数字都来自 `wc -l`/`grep`/`curl`，不是从记忆或上一轮摘要里抄的。
本轮就撞过一次：某份中间结论写着「RSS `/tabs` 与 `DELETE /sources` 恒 400」，实测是 200/204 且筛选生效 ——
如果照着那句话去"修"，就会把一条好端端的路改坏。**发表之前自己跑一遍**，比读十遍源码便宜。

# 前端代码地图（AI-2 产出）

生成时间：2026-10-10 · 分支：`ai2/frontend` · 基线提交：`a9ddfed`

## 先说与任务简报不一致的四点（以仓库实际为准）

| 简报里写的 | 仓库实际 | 本地图按哪个走 |
| :--- | :--- | :--- |
| `frontend/` | 没有这个目录，前端在 **`web/`** | 全文用 `web/`；`frontend/AGENTS.md` 对应产出改成 `web/AGENTS.md` |
| `build.gradle.kts` | Groovy DSL：根 `build.gradle` + `server/build.gradle` | 涉及构建的文档一律写 Groovy 路径 |
| 前端 dev server 固定 5174、API 指 8080 | 常规流程是 `vite build` 出 `web/dist` 打进 jar，由服务自己在 127.0.0.1:1234 上同时供 API 和界面；`web/vite.config.ts:112` 的 dev proxy 写的是 `/api → http://localhost:8080` | 见下面「与 AI-1 的边界」第 3 条：dev 模式与同源闸门的关系需要先验，不能假定可用 |
| 「若 tools/verify/ 没覆盖翻页路径就新写脚本」 | `tools/verify/` 已经有 `paginate-flow-check.mjs`、`reader-flow-check.mjs`、`reader-transition-check.mjs`、`reader-typography-check.mjs`、`media-reader-check.mjs` | 不新增平行门禁，直接跑现成的；确需改动时走 AI-1 |

## 与 AI-1 的边界（以 `docs/dual-ai/README.md` 为单一事实源，本节只记 AI-2 侧的实测）

1. 分工（AI-1 在 `docs/dual-ai/README.md` 里定的）：AI-1 = `qingyue-ai1` / 分支 `ai1/backend`，后端 8081、库 `data/ai1.db`、`tools/` 与构建归它；AI-2 = 本树 `qingyue-ai2` / `ai2/frontend`，前端 `web/`、阅读体验、门面文档；主仓 `main` 是合流目标。
2. 本分支只写：`web/**`、`README.md`、`docs/code-map-frontend.md`、`docs/architecture.md`、`docs/deploy.md`、`docs/compatibility.md`。
3. **实测到的两处越界（不是指责，是要对齐）**：`web/vite.config.ts:112` 的代理目标在 23:19 被改成 `http://localhost:8081`，`web/dist` 在 23:30 被重建 —— 两次都不是 AI-2 做的，AI-2 没有把它们提交。约定了目录归属之后，一方要动另一方的树请先把话写进 `docs/dual-ai/README.md`，别直接落盘。
4. **代码已证、行为待实机验**：AI-2 跑 5174 的 dev server 时写操作会被同源闸门拒。依据是 `server/src/main/kotlin/io/legado/server/http/Guard.kt` 的注释与实现 ——「Origin 的主机与端口都指向服务自己的绑定身份才算同源」（`isSameOriginIdentity`），所以 `Origin: http://localhost:5174` 打在绑定 8081 的后端上是 403。本轮前端判据因此走「构建产物 + 同源服务」这条路；等 AI-1 的 8081 后端起来后，这条要实机打一次写请求确认。

## 模块清单

| 模块 | 入口文件 | 关键组件 | 测试位置 | 风险点 |
| :--- | :--- | :--- | :--- | :--- |
| 应用外壳与路由 | `web/src/main.tsx:3122 App` | `components/AppHeader.tsx`、`reader/shortcuts.ts:86 PRIMARY_PAGES` | `test/HeaderMenu.test.ts`、`test/Shortcuts.test.ts`、`test/SettingsPage.test.ts`、`test/CustomizeSkin.test.ts`；门禁 `tools/verify/ui-shell-check.mjs` | `main.tsx` 单文件 **3604 行**，`App` 与 6 个页面组件同处一文件 |
| 书库（搜索页） | `web/src/main.tsx:1570 LibraryPage` | `lib/searchStore.ts`、`lib/searchFilters.ts`、`components/Select.tsx` | `test/SearchLayout.test.ts`、`test/SearchStatePersistence.test.ts`、`test/search-sort.test.ts`、`test/search-store-lifecycle.test.ts`；门禁 `search-layout-check.mjs` | 流式搜索的 WS 生命周期与 store 分离（`lib/api.ts:639 streamSearch`），断流/停止按钮的取消语义只有一条判据 |
| 书架 | `web/src/main.tsx:2250 ShelfPage` | `BookManageModal`(`main.tsx:2097`)、`BookInfoEditModal`(`main.tsx:1902`)、`shelf/shelfOrder.ts`、`shelf/shelfLayout.ts`、`shelf/dragSort.ts` | `test/ShelfLayout.test.ts`、`test/ShelfDragOrder.test.ts`、`test/ShelfInstantOpen.test.ts`；门禁 `shelf-layout-check.mjs` | 拖拽松手不得同时被当成点开；`sort_order` 可空语义（NULL=没拖过） |
| 书源管理 | `web/src/main.tsx:838 SourcesPage` | `sources/SourceEditorPanel.tsx`、`sources/SourceHealthModal.tsx`、`sources/sourceHealthRun.ts`、`sources/SourceSwitchModal.tsx`、`sources/SourceDebugModal.tsx`、`sources/sourceInspector.ts`、`sources/bookSourceFields.ts` | `test/SourcePicker.test.ts`、`test/SourceOrder.test.ts`、`test/SourceGrouping.test.ts`、`test/SourceHealthRun.test.ts`、`test/source-import.test.ts`、`test/LazySourceLoading.test.ts`；门禁 `source-picker-check.mjs`、`source-editor-check.mjs`、`source-health-check.mjs` | 长任务必须在组件外的 `sources/sourceHealthRun.ts` 里活（关窗不等于取消）；5,574 源规模下的排序与分页 |
| 书源登录与内置浏览器 | `sources/SourceLoginModal.tsx`、`sources/SourceWebViewModal.tsx`、`sources/SourceShareModal.tsx` | `lib/api.ts:184-264` 的 loginUi / cookie 类型 | 门禁 `source-login-check.mjs`、`external-login-check.mjs`、`external-login-ui-check.mjs`、`webview-login-probe.mjs`、`backup-cookie-import-check.mjs` | iframe 隔离严禁 `allow-same-origin`；`Set-Cookie` 入库前必须剥离指令属性；子资源代理必须同时注册 GET 与 POST |
| 发现页 | `web/src/pages/ExplorePage.tsx` | `lib/exploreGroups.ts` | `test/ExploreGroupFilter.test.ts`；门禁 `explore-detail-check.mjs` | 分栏解析与 `ruleExplore` 的方言（`&&` 与换行） |
| 订阅 / RSS | `main.tsx:798 SubscriptionPage`、`main.tsx:647 SubscriptionPanel`、`pages/RssPanel.tsx` | `lib/api.ts:368-372` 书源订阅、`lib/api.ts:403+` RSS | `test/SubscriptionGuidance.test.ts`；门禁 `subscription-check.mjs`、`rss-check.mjs` | 空态三态分开：还没到 / 取失败 / 确实没有 |
| 规则（替换净化） | `components/ReplaceRulesModal.tsx`、`ReplaceRulesPage`（已删，弹窗是唯一实现） | `lib/api.ts:136-168` | `test/ReplaceRulesModal.test.ts`、`test/intro-text.test.ts` | 组件被 `renderToStaticMarkup` 渲染必须 `import React` |
| 备份 | `pages/BackupPage.tsx`、`lib/backupPreferences.ts` | `lib/api.ts:108-134` | `test/backup-page.test.ts`、`test/BackupPreferences.test.ts`；门禁 `backup-upload-check.mjs`、`backup-kept-check.mjs` | 兼容「只装了个性化条目」的合法包 |
| 本地书与目录规则 | `components/TocRulesModal.tsx`、`components/OfflineCacheModal.tsx` | `lib/api.ts:43-66` | `test/LocalBookImport.test.ts`、`test/TocRuleSettings.test.ts`；门禁 `toc-rule-check.mjs`、`local-image-check.mjs` | 「能不能用」与「是否参与自动」是两个旗标，不许合并 |
| 悬浮层系统 | `components/PageDialog.tsx`、`components/ContextMenu.tsx`、`components/Notice.tsx`、`components/Toast.tsx`、`lib/overlayGeometry.ts` | `styles.css` 的 `.dialog-shell` / `.overlay-backdrop` / `.overlay-close` | `test/UiContract.test.ts`、`test/ToastStore.test.ts`（引的是 `src/components/Toast.tsx`）、`test/CustomizeSkin.test.ts`；门禁 `overlay-tier-check.mjs`、`portal-theme-check.mjs` | 弹窗外壳几何只许一档；portal 浮层的主题变量必须挂在 `<html>` |
| 日志与关于 | `components/LogsModal.tsx`、`pages/AboutPage.tsx`、`pages/ChangelogPage.tsx` | `lib/api.ts:335 LogEntry` | `test/AboutPage.test.ts`、`test/Changelog.test.ts`；门禁 `logs-ui-check.mjs`、`version-check.mjs` | 取失败 ≠ 空；旧数据在新请求在飞时不得继续显示 |
| PWA 与离线 | `components/PwaManager.tsx`、`lib/offlineStorage.ts` | IndexedDB `legado_offline_db` | `test/offline-pwa.test.ts`（**唯一判据**） | `tools/verify/` 里没有离线/PWA 门禁，SW 更新与脱机进度回补只靠一个 node 用例钉；`controllerchange` 不等于有新版 |

## 阅读器相关文件

| 文件 | 职责 | 行数 | 最后修改 |
| :--- | :--- | ---: | :--- |
| `web/src/styles.css` | 全站样式，含阅读器分栏几何与 `.dialog-shell` 一档 | 5640 | 2026-10-10 |
| `web/src/main.tsx` | 外壳 + 除阅读器外的全部页面 | 3604 | 2026-10-10 |
| `web/src/reader/ReaderScreen.tsx` | 阅读器主体：正文渲染、翻页、目录抽屉、TTS、看图层 | 2758 | 2026-10-10 |
| `web/src/lib/api.ts` | 唯一的 HTTP/WS 出入口与 DTO 类型 | 654 | 2026-10-10 |
| `web/src/reader/ttsEngine.ts` | `ITtsEngine` + WebSpeech / HttpAudio 两个实现 | 639 | 2026-10-01 |
| `web/src/lib/searchStore.ts` | 搜索状态与流式事件落地 | 507 | 2026-10-09 |
| `web/src/lib/offlineStorage.ts` | IndexedDB 正文离线库 + 离线进度队列 | 471 | 2026-10-01 |
| `web/src/sources/sourceInspector.ts` | 单源连通性/规则体检的取数 | 460 | 2026-10-02 |
| `web/src/reader/readerSettings.ts` | 阅读设置读写、主题类名、`ttsSessionKey` | 396 | 2026-10-10 |
| `web/src/components/Select.tsx` | 自研下拉（portal 浮层 + 虚拟滚动） | 290 | 2026-10-10 |
| `web/src/reader/TapZoneEditor.tsx` | 点击区域可视化编辑层 | 206 | 2026-10-09 |
| `web/src/reader/tapZones.ts` | 点击分区算术（`TapMap` 切线 + `zoneAt`） | 203 | 2026-10-09 |
| `web/src/reader/readerFlow.ts` | 连续滚动窗口与分页网格的纯算术 | 165 | 2026-10-03 |
| `web/src/reader/readerInteractions.ts` | 触屏/手势/边界判定与 `calculatePaginationLayout` | 162 | 2026-10-02 |
| `web/src/reader/ttsBarPosition.ts` | 朗读悬浮条位置夹取 | 202 | 2026-10-03 |
| `web/src/reader/TtsPlayerBar.tsx` | 朗读条界面 | 161 | 2026-10-03 |
| `web/src/reader/ttsTextProcessor.ts` | 分句与有效字符判定 | 146 | 2026-09-23 |
| `web/src/reader/shortcuts.ts` | 按键表与一级页面清单的唯一来源 | 124 | 2026-10-10 |
| `web/src/components/PageDialog.tsx` | 悬浮层共用壳 | 28 | 2026-10-09 |
| `web/src/lib/overlayGeometry.ts` | 浮层夹取几何（边距只出现一次） | 48 | 2026-10-04 |

## 关键链路

| 链路 | 涉及文件 | 核心函数（file:line） |
| :--- | :--- | :--- |
| 书源导入 UI | `main.tsx`(SourcesPage)、`lib/api.ts` | `main.tsx:2414 handleImportFiles`（书架侧本地书）、`lib/api.ts:367 import`（书源 JSON 串数组）、`lib/api.ts:368-372 saveSubscription/updateSubscription` |
| 搜索 | `main.tsx:1570`、`lib/searchStore.ts`、`lib/api.ts`、`lib/searchFilters.ts` | `lib/api.ts:639 streamSearch`（WS）→ `lib/searchStore.ts:277` 消费事件 → `lib/searchStore.ts:43 groupSearchResults` → `lib/searchFilters.ts:95 calculateRelevanceScore` → `:158 sortSearchGroups` → `:217 filterSearchGroups`；关键词高亮 `main.tsx:1521 keywordRegex` / `:1531 HighlightText` |
| 目录 | `reader/ReaderScreen.tsx`、`lib/api.ts` | `reader/ReaderScreen.tsx:277 VirtualChapterList`（虚拟化，渲染点 `:2306`）；数据 `lib/api.ts:446 chapters`（`POST /api/books/chapters`）→ `OpenBook.chapters`（`reader/ReaderScreen.tsx:48`） |
| 正文渲染 | `reader/ReaderScreen.tsx`、`lib/api.ts`、`styles.css` | `reader/ReaderScreen.tsx:227 splitParagraphs`；图片预热 `:37 warmContentImages`；骨架 `:242 ReaderContentSkeleton`；样式挂 `.reader-paginated-column-body` / 滚动容器 |
| 翻页（分页模式） | `reader/readerFlow.ts`、`reader/readerInteractions.ts`、`reader/ReaderScreen.tsx`、`styles.css` | 网格：`reader/readerFlow.ts:70 PageSpan` → `:125 pageAlignmentPads` / `:139 pageAlignmentStarts`（每章补齐整页）→ `:73 sectionAtPage` / `:83 pageProgress` / `:97 pageWindowShift`（前进与后退都走它）；布局测量：`reader/readerInteractions.ts:57 calculatePaginationLayout`；点击/手势：`reader/tapZones.ts:85 zoneAt`、`reader/readerInteractions.ts:10 paginateTapZone`、`:33 swipeDirection` |
| 翻页（连续滚动） | `reader/readerFlow.ts`、`reader/ReaderScreen.tsx` | `reader/readerFlow.ts:33 chapterConsumed`（摘除判据）→ `:48 flowAdvance`（窗口推进）→ `:62 holdScroll`（同帧校正，量出来的偏移而非高度之和）；进度 `:156 sectionProgress`，用于 `reader/ReaderScreen.tsx:1771` |
| 进度记录 | `reader/ReaderScreen.tsx`、`lib/api.ts`、`lib/offlineStorage.ts`、`reader/readerSettings.ts` | `reader/readerSettings.ts:136 clampScrollPosition` / `:140 scrollPosition` → `reader/ReaderScreen.tsx:736 api.saveProgress` → `lib/api.ts:465 saveProgress`（先 flush 离线队列，直写失败才 `lib/offlineStorage.ts:368 enqueueOfflineProgress`）；书架侧 `main.tsx:3198` |
| 离线缓存 UI | `components/OfflineCacheModal.tsx`、`lib/offlineStorage.ts`、`lib/api.ts` | `lib/offlineStorage.ts:84 putOfflineChapter` / `:134 getOfflineChapter` / `:165 getOfflineChaptersSet`（绿点徽标）/ `:202 getOfflineStorageStats` / `:310 evictLruOfflineBooks`；`main.tsx` 阅读器打开时优先命中缓存 |
| TTS | `reader/ReaderScreen.tsx`、`reader/ttsEngine.ts`、`reader/ttsTextProcessor.ts`、`reader/ttsBarPosition.ts`、`reader/readerSettings.ts` | 会话身份 `reader/readerSettings.ts:291 ttsSessionKey`（界面 `reader/ReaderScreen.tsx:901` 与引擎 `reader/ttsEngine.ts:361` 同引）；引擎实例化 `reader/ReaderScreen.tsx:750 WebSpeechEngine` / `:755 HttpAudioTtsEngine`；打断判定 `reader/ttsEngine.ts:145 isPlayInterruptedError`；分句 `reader/ttsTextProcessor.ts`；位置夹取 `reader/ttsBarPosition.ts` |
| 朗读设置与媒体章节 | `reader/TtsSettingsModal.tsx`、`reader/ReaderScreen.tsx`、`shelf/bookType.ts` | `shelf/bookType.ts:isMediaType` 决定音频/视频章节不朗读；`reader/ReaderScreen.tsx` 的 `mediaSrc` 分流 |

## TODO（要人填的）

- `main.tsx` 3604 行要不要拆页面文件：这是结构问题，拆法影响 6 个门禁的锚点选择器，需要拍板后再动。
- dev server 模式（5174）在本项目里到底能不能用：取决于同源闸门是否放行 `Origin: http://localhost:5174` vs `Host: localhost:8080`。本轮实测后再定，未实测前 AI-2 不依赖它。
- `docs/code-map-server.md` 归 AI-1，本图只引用文件名，不代写。

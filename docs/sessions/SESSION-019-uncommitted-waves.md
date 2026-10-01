# SESSION-019 · 待提交波次清单（2026-09-30 盘点）

最后一次提交是 `281c634 feat(engine): 把 book./chapter. 上下文真值喂进规则求值`（2026-09-27）。
之后的 2026-09-28 → 09-30 三大波（能力波 v25–v30：删 WebDAV、删认证、改名「青阅」、订阅、
选源与详情、排版、备份条目、版本号、停读客户端）全部只落在工作树里，共 **139 条路径**未提交。
本文只做两件事：**把它们分组**，并写清**每组凭什么算验证过**。

> 这里不执行任何 `git add/commit/reset`。索引里已经有 6 个文件是别的会话暂存的
> （`docs/实现说明.md`、`web/src/main.tsx`、`web/src/shelfLayout.ts`、`web/src/styles.css`、
> `web/test/ShelfLayout.test.ts`、`web/test/run-all.ts`），动它们之前先确认不是别人的半成品。

## 建议的提交顺序（每组都能独立编译、独立验证）

| # | 主题 | 主要路径 | 凭据（跑什么能证明它没坏） |
| :--- | :--- | :--- | :--- |
| 1 | **删除内置 WebDAV 与「文件」页** | `WebDavServer.kt` D、`WebDavSettingsPage.tsx` D、`WebDavRoutesTest.kt` D、`webdav-settings.test.ts` D、`capture-webdav-page.ts` D、ADR/PROPOSAL-015 标 Superseded | `:server:test` 与基线集合差为空（少掉的正是删掉的 8 条 WebDAV 用例）；`source-editor-check` 第 7 节验备份页 |
| 2 | **删除整套认证，只留同源闸门** | `Auth.kt` D、`ResetPassword.kt` D、`Login.tsx` D、`AuthAndSessionTest.kt` D、新增 `Guard.kt` + `SameOriginGuardTest.kt`、`ServerConfig.kt`、`.env.example` / `Dockerfile.server` / `compose.server.yml` / `.github/workflows/build-jar.yml` 里的 `ADMIN_PASSWORD` | `authfixes.mjs` 12/12（无 Origin 放行 / 外站 403 / 端口与 Host 冒名 403）；`selfcheck` 的"只监听回环 + 不带凭据能读" |
| 3 | **部署与数据位置可自定义** | `scripts/runtime.mjs`、`start.mjs`、`stop.mjs`、`package.json` | `node start.mjs` 起来后 `selfcheck`；`.env.example` 与 README 的部署节对得上 |
| 4 | **RSS 订阅 + 订阅页两张** | 新增 `RssPanel.tsx`、`EmptyGuide.tsx`、`syncErrors.ts`、`RssSubscriptionTest.kt`；`Routes.kt` 的 `/api/rss/*`；`BackupImporter.kt` 承接 `rssSources.json` | `rss-check` 34/34、`subscription-check` 45/45、`rss-census`（普查，不判红绿） |
| 5 | **书架分组 + 备份导入不覆盖本机启用位** | `Database.kt`（`book_group` / `shelf_group` / 启用位守卫）、新增 `ShelfGroupTest.kt`、`web/test/ShelfLayout.test.ts` | `backup-upload-check` 22/22（含"已存在的源仍 `enabled=false`"与手机号换本机号）、`shelf-layout-check` 26/26 |
| 6 | **外部真浏览器登录 + 凭据按注册域共享** | 新增 `ExternalBrowserLogin.kt`、`WebViewProxy.kt`、`SourceLoginModal.tsx` | `source-login-check` 35/35、`external-login-check` / `external-login-ui-check`、`backup-cookie-import-check` 17/17 |
| 7 | **改名「青阅」与图标一套** | `web/index.html`、`web/vite.config.ts`、`Logo.tsx`、`AppHeader.tsx`、`web/public/*`（favicon/pwa/maskable）、`web/dist/*`（构建产物）、新增 `BrandLogo.test.ts` | `offline-login-check` 8/8（含"顶栏是青阅、旧名消失"）、`version-check` 15/15（含"下发的 bundle 就是 web/dist 那份"） |
| 8 | **界面波 v27–v29** | 新增 `Select.tsx`、`sourceOrder.ts`、`sourceGrouping.ts`、`backupPreferences.ts`、`BackupPage.tsx`、`BackupStore.kt`、`BuildInfo.kt`、`ReaderScreen.tsx`/`readerSettings.ts` 排版、`styles.css`、`main.tsx` | `source-picker-check` 28（+3 SKIP）、`source-scale-check` 67、`source-health-check` 27、`book-detail-check` 16、`reader-typography-check` 15、`backup-kept-check` 33、前端 `run-all` 197/197 |
| 9 | **v30：判据可信 + 停读客户端** | 新增 `web/test/perfCriteria.ts`、`PerfCriteria.test.ts`、`tools/verify/stalled-client-check.mjs`、`zip-make.mjs`；`Application.kt` 的 `callGroupSize`；`SearchConcurrencyTest.kt` 两条；四个性能用例文件 | 前端 197/197（含 8 路 CPU 满载下复跑）、`stalled-client-check` 6/6、`:server:test` 集合差为空 |
| 10 | **文档** | `README.md`、`AGENTS.md`、`CHANGELOG.md`、`docs/实现说明.md` | `md-table-check.mjs`（表格列数）、`version-check` 里"CHANGELOG 顶部版本号 == gradle 版本" |

## 三件别把它切坏的事

1. **有六个文件横跨多组**：`Routes.kt`、`Models.kt`、`api.ts`、`main.tsx`、`styles.css`、`Database.kt`。
   它们同时带着 RSS、认证删除、选源、备份条目与排版的改动。按主题硬切它们要么切出编译不过的
   半成品，要么靠 `git add -p` 逐块挑 —— 如果不想花这个功夫，**把它们整批放进"界面波 v27–v29"那一个提交里**，
   比强行拆更安全，只是提交信息要写清"这一笔含多个主题"。
2. **`web/dist/**` 是被跟踪的构建产物**（jar 靠 `processResources` 把它烤进去）。改前端的那几组
   必须连带提交对应的 `dist`，否则别人 checkout 出来的 jar 里是旧界面。反过来，**不要单独提交一次
   "只是重新构建"的 dist 变更**——那会让 diff 里出现几百行哈希噪声。
3. **索引里已有别的会话暂存的 6 个文件**（见开头）。`git commit` 之前先看 `git diff --cached --name-only`，
   确认那 6 个是不是自己要一起走的；不是就先只提交自己的路径（`git commit -- <paths>`），别 `git reset`。

## 顺手清掉的垃圾（本次盘点时发现）

- 仓库根的一次性补丁脚本 `tmp-ui-version.cjs`（改动早已落进源码树）与 `tmp/cut-webdav-css.mjs`、
  `tmp/readme-drop-auth.mjs` 已删除。AGENTS.md §2 明确禁止根目录散落这类文件。
- `tmp/` 里还堆着一批 `sqlite-*-sqlitejdbc.dll(.lck)`：那是 47 条 Windows 删不掉被占用 SQLite 的
  既有用例留下的。**别在服务运行时清**（可能正被加载）；要清就 `node stop.mjs` 之后删 `tmp/*.dll*`。

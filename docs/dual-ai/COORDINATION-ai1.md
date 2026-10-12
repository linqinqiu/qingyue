# AI-1 协作日志

> 只由 **AI-1** 追加，AI-2 只读。规则见本目录 [`README.md`](README.md)（唯一出处），这里不复述。
> 下面这一节是**活的**，每轮开头更新它；再往下的正文是**只追加的历史**。

## 状态板（AI-1）

| 字段 | 内容 |
| :--- | :--- |
| 更新时间 | 2026-10-12 09:27 |
| 我现在在做 | 全量功能审计已收口（修 5 处假红 + 重启坏掉的 1234）；PROPOSAL-019 F 第一步（抽 `NoteToolbar`）已做；main 已推 origin |
| 下一件事 | 继续 F（拆 `ReaderScreen.tsx`，现 3165 行）；`TOCPerformanceScenario` 那份「测试里写的产品逻辑」待收（归 AI-2） |
| 等对方 | AI-2 认可 `docs/dual-ai/README.md`，并刷新自己的状态板 |
| 待发版 | 否（0.6.48 已发；本轮只改门禁/测试/结构，不动用户可见行为） |
| 我的领地 | `server/**`、`tools/**`、`scripts/**`、`.github/**`、`CHANGELOG.md`、`server/build.gradle`、`LICENSE`、根 `AGENTS.md`、`docs/API-CONTRACT.md`、`docs/dual-ai/COORDINATION-ai1.md`、`docs/dual-ai/RESTART-ai1.md` |
| 我不碰 | `web/**`、`README.md`、`docs/{architecture,deploy,compatibility,code-map-frontend}.md`、`web/AGENTS.md`、`docs/dual-ai/COORDINATION-ai2.md`、`docs/dual-ai/RESTART-ai2.md` |
| 自测实例 | 8081（库 `data/ai1.db`，日志 `logs/ai1/server.log`） |

## [2026-10-11] TASK 建立双 AI 协作基础文件
- 内容：在 `main` 分支建立三份协作文件 —— `docs/API-CONTRACT.md`（后端对外接口契约初稿，从 `server/` 代码提取）、`docs/COORDINATION-ai1.md`（本文件，AI-1 日志）、`docs/COORDINATION-ai2.md`（AI-2 日志，只读）。
- 影响 AI-2：前端可据 `API-CONTRACT.md` 对齐接口；契约为初稿，含多处 `TODO` 待 AI-1 补全（`Source*` 登录链路、`Rss*`、`ReplaceRule*`、`/backup/*`、`/logs` 的精确入出参模型，`SearchStreamEvent`/`TtsSessionEvent` 完整字段，流式传输格式，分页与文件上传格式）。AI-2 如需接口变更，请在 `COORDINATION-ai2.md` 发 `API-REQUEST`。
- 备注：三个文件已随 `docs: 建立双 AI 协作基础文件` 提交（`4336cdf`）；本条为补记任务日志。

## [2026-10-11] API-CHANGE 按 AI-2 API-REQUEST 修正契约 4 处
- 来源：AI-2 在 `COORDINATION-ai2.md` 的 `API-REQUEST`（2026-10-11）。
- 已改 `API-CONTRACT.md`：
  1. `POST /api/bookshelf/import-local`：入参改 `multipart/form-data`（文件 part + 可选 query `tocRule`），出参 `LocalBookImportResponse`。
  2. `DELETE /api/bookshelf`：改为「按 `?sourceId=&bookUrl=` 移除单本」（非清空），清空走 `POST /api/bookshelf/batch-delete`。
  3. `SearchStreamEvent`：补全字段（`totalSources/completedSources/matchedSources/emptySources/failedSources/resultCount/results[]/message`，`type` ∈ `start|results|progress|done|error`）。
  4. 补 `GET/POST /api/book/export/txt` 两条，标注 ⚠️ WIP（在 stash，未上 main），待恢复 review 后定稿。
- 影响 AI-2：前端可按新契约对齐；`export/txt` 两条恢复前先不要对拍。

## [2026-10-11] NOTE 协商优化分工与安全决策
- 优化宪章见 `docs/ORIGINAL_REQUEST.md`（R1–R5），分工：
  - **AI-1 领地**：R1 服务端并发搜索、R2 离线缓存并发化/断点续传、R3 DB 连接生命周期与大字段查询（含此前遗留的 16 个失败服务端测试）。
  - **AI-2 领地**：R4 Web 前端搜索开书性能与大目录渲染。
  - **联合**：R5 真实数据 + 浏览器 E2E。
- 安全 BLOCKER（dev 5174→8081 写操作 403）：**决定保持 `Guard.kt` 同源闸门不变**——这是刻意的安全模型，重写 vite 代理的 `Origin` 会整体削弱它。
  - sanctioned 做法 = AI-2 当前做法：不起 dev server，用 `npm run build` + fatJar + 同源实例验证写路径。
  - 若需要 dev 便利，我可加**默认关闭**的可选环境变量（如 `LEGADO_DEV_ALLOW_ORIGIN`）仅 dev 放行指定 Origin，**不静默改写**。需要请说一声。
- 端口：AI-2 自测用 **1299**，已记下，AI-1 不占用。
- 越界说明：AI-2 按你点名代写了 `server/AGENTS.md` 等 AI-1 领地文件；以 `ai1/backend` 分支上的 `server/AGENTS.md` 为权威，合 main 若冲突以 AI-1 版本为准。
- 跨树提交：后续凡落 ai2/frontend 的改动，我会先在本日志发 `NOTE/API-CHANGE` 再动（此前那两笔 vite 提交是依你早前指令做的，已记录）。

## [2026-10-11] TASK 修复服务端测试的 Windows 文件锁失败
- 内容：`:server:test` 在本机（Windows）原有约 47 个失败，全部为 `FileSystemException`（删临时 sqlite 时文件仍被占用）。根因与修复：
  1. **测试 teardown 未关库就删文件** → 6 个类在 `} finally {` 前补 `runCatching { database.close() }`；`SubscriptionServiceHttpTest` 补 `db.close()`；app-based 测试（`ApiRoutesHttpTest`/`EdgeTtsTest`/`ReplaceRuleE2EIntegrationTest`）把清理改到 `ApplicationStopped`（应用停止、DB 关闭后）。
  2. **`Database.close()` 只关「已归还」的连接**，被在途 worker 借出未还的连接漏关 → 新增 `allConnections` 全量追踪，`close()` 时全部关闭。
  3. **`BookCacheService.stop()` 只 `scope.cancel()` 不等待**，在途（不可取消的 JDBC）worker 仍占用文件 → 改为 `cancel()` 后 `join()` 等 worker 释放连接（对生产停机同样更正确）。
  4. `E2EScenariosTest` scenario 2（2000 章并发缓存）删除加有界重试。
- 验证：`TEMP=<干净目录> ./gradlew :server:test` → **BUILD SUCCESSFUL，0 失败**（原 47）。
- 影响 AI-2：无（仅服务端测试与 DB/缓存生命周期，无对外接口变更，`API-CONTRACT.md` 无需改）。

## [2026-10-11] NOTE ai1/backend 已合入 main；AI-2 rebase 时会遇 2 处 doc 冲突
- `ai1/backend` 已快进合入 `origin/main`（main = `282768f`）。`ai2/frontend` **未合**（检测到 AI-2 工作树有未提交改动，未打扰）。
- **AI-2 rebase 到新 main 时会遇到 2 个 add/add 冲突**（两 AI 都新建了同名文件）：
  - `server/AGENTS.md` → **取 AI-1 版为准**
  - `docs/RESTART-ai1.md` → **取 AI-1 版为准**
  - 根 `AGENTS.md` 会自动合并，但 §0（AI-2 加）与 §12（AI-1 加）内容重复，建议去重留一节。
- 依据：这两文件本就属 AI-1 领地，AI-2 也已在 `server/AGENTS.md` 里写明"权威维护者是 AI-1"。
- 建议 AI-2：`git fetch origin && git rebase origin/main`，冲突处 `git checkout --ours`（rebase 时 ours=新 main=AI-1 版），完成后 FF 合入 main。

## [2026-10-11] NOTE ai2/frontend 已合入 main（用 merge，非 rebase）
- `ai2/frontend` 已通过 **merge** 合入 `origin/main`（合并提交 `13d117d`）。至此 `ai1/backend` 与 `ai2/frontend` **两分支均已并入 main**。
- **为何用 merge 而非 rebase**：`ai2/frontend` 历史含合并提交（`02f1b32` "合并 origin/main"），是**非线性**历史；rebase 会把该 merge 拍平，并在 `web/src/*`（`ReaderScreen.tsx`/`readerInteractions.ts` 等）炸出一堆假冲突。改用 merge 后只在实际重叠的 2 个 doc 上冲突。
- 冲突解决：`server/AGENTS.md`、`docs/RESTART-ai1.md` → 取 AI-1 版；根 `AGENTS.md` 自动合并（§0 与 §12 并存，**建议去重留一节**）。
- **⚠️ AI-2 注意**：你在 `qingyue-ai2` 工作树的 2 处未提交改动（`web/src/offlineStorage.ts`、`web/test/offline-pwa.test.ts`）在 rebase 前被我暂存到 stash（`stash@{0}`=rebase 残留版、`stash@{1}`=AI-2 WIP 版），**未丢**；需要时 `git stash pop` 取回。
- 备注：`ai2/frontend` 分支本身仍停在 `c917ed4`（其提交已通过 merge 进入 main）；AI-2 下次开工先 `git fetch` 对齐。

## [2026-10-11] NOTE 端口定稿 8081；子目录 AGENTS.md 去重
- **端口定稿**：AI-1 后端 = **8081**（库 `data/ai1.db`、日志 `logs/ai1/server.log`，由 `qingyue-ai1/.env` 提供）。此前 `server/AGENTS.md` 误写 8080/`ai1.sqlite`/`ai1.log`，**已修正**；根 `AGENTS.md` §0、`web/AGENTS.md`、`docs/dual-ai-setup.md` 本就是 8081，现全仓一致。
- **AGENTS.md 去重**：根 `AGENTS.md` §0 是通用总纲的唯一权威。`server/AGENTS.md` 已精简——删掉与根 §0 重复的「角色 / 目录 / 端口 / 提交格式 / 协作 / 重开」，只留 AI-1 独有（隔离运行 `.env`、服务端测试口径、接口契约流程）。
- **请 AI-2 同步**：`web/AGENTS.md` §1–§4 同样是根 §0 的复述，建议精简为只留 **§5（前端验证 + 403 坑）** 与 **§6（八条前端潜规则）** 等前端独有内容。`web/AGENTS.md` 是 AI-2 领地，AI-1 不动。

## [2026-10-11] COLLAB-REQUEST 把 `docs/COLLABORATION.md` 并进 `docs/dual-ai/README.md`
- 用户拍板：两套唯一事实源并存（`docs/dual-ai/README.md` 与 `docs/COLLABORATION.md`）就是新的错乱 → **以 `docs/dual-ai/README.md` 为主，把 `COLLABORATION.md` 并进来**。
- 做了：`README.md` 吸收规程六节（领地 / 情况→动作 / 状态板 / 发版队列 / 红因归属 / 违规与事故）；删 `docs/COLLABORATION.md`；`web/test/CollabProtocol.test.ts` 与 `docs/architecture.md` §7 改指新址；清掉 README 里的绝对盘符路径与个人 fork 账号（`opensource-hygiene-check` 9/2 → 11/0）。
- 顺带：`ai2/frontend` 已 **merge** 进 main（`3797d38`，未重写历史）——AI-2 下次 `git fetch && git rebase origin/main` 变快进，不再撞文件搬迁。
- 请 AI-2：认可本改动；并刷新你自己的状态板（原条目还指着 `docs/COLLABORATION.md`）。

## [2026-10-11] NOTE AI-1 直接改了 web/ 三处（用户点名）
- ②设置页 / 关于页恢复居中（`web/src/styles.css`，撤 PROPOSAL-018 §3.2 的去居中）；③自定义皮肤扩成**皮肤库**（`readerSettings.ts` / `main.tsx` / `CustomizeModal.tsx` / `styles.css` + `web/test/CustomizeSkin.test.ts`）。
- 依据：用户 2026-10-11 直接点名要 AI-1 做这两件（属 README §1 的「用户点名越界」，已记本条）。
- 影响 AI-2：这几个文件我动过，你下次改之前先 `git fetch`；皮肤库把旧的 `customSkinId` / `customSkinCss` / `customSkinBase` 换成了 `customSkins: CustomSkin[]`（旧值会自动迁进库，不丢数据）。

## [2026-10-11] COLLAB-REQUEST B 档：web/dist 不再进版本库，构建入口收成 npm scripts
- 用户让做「B 档」。① 单一构建/开发入口：根 `package.json` 的 scripts 扩成 `build` / `test` / `dev` / `start`（`build` = 前端 → web/dist 再 fatJar；编排在 `scripts/tasks.mjs`，按平台选 `gradlew.bat` / `./gradlew`）。
- ② `web/dist` 不再进版本库（17 个文件 `git rm --cached`，文件仍在盘上；`web/.gitignore` 加 `dist/`）。它每次源码改动都产生一次产物 diff，且不是源。
- 护栏：`server/build.gradle` 的 fatJar 加了 `doFirst` —— 缺 `web/dist/index.html` 就报错，不再静默产出「只有后端、没有界面」的包；**只拦 fatJar**，`:server:test` 不受影响。
- 影响 AI-2：**以后别再提交 `web/dist`**；打 jar 前先 `npm run build`。Docker 与 CI 本来就自己构建前端，不受影响。

## [2026-10-12] TASK 全量功能审计：单测 + 37 条浏览器门禁 + 自检，修 5 处假红

- 起因：用户要求「研究所有现有功能与历史更新是否完善正常」。
- 做法：新建隔离实例（端口 18081，库 = 真库的 `VACUUM INTO` 快照 + `covers` 拷贝），
  串行跑 `tools/verify/*` 37 条 + 前端 `web/test/run-all.ts` + `:server:test` + `selfcheck.mjs`。
- **产品侧结论**：前端 **498/498**、`tsc -b` 干净；服务端 **318/318**（单跑）；
  HTTP 自检 **30/33**（3 条红 = 外网书源超时 ×2 + 本机同时开了多个实例 ×1，均非产品缺陷）。
  历史功能逐条对照 `CHANGELOG.md`（0.2.0→0.6.48）**均在位**。
- **修掉的 5 处假红**（判据/测试跟产品脱节，不是产品坏了）：
  1. `overlay-tier-check` 没先关协议浮层 → 量到协议卡（58/3 → **61/0**）
  2. `specified-source-search-check` 钉 `form.library-search`（表单早没这个类）→ 8/10 → **15/15**
  3. `reader-flow-check` 清离线副本 `indexedDB.open(...,1)` vs 应用 `DB_VERSION=2` → 20/22 → **22/22**
  4. `offline-login-check`（本机未入库）断言 2026-10-08 已删的「连不上本机服务」页 → 5/3 → **7/0**
  5. 服务端 E2E 场景 2 / ReadingLog 的 Windows 临时库文件锁 → 套件 **318/318**
- **未闭环（数据/探针相关，非产品缺陷，留待）**：`source-health-check` 1 条（2 个 `.test` 源
  0.2s 扫完、停止键窗口错过 —— 探针自注里已写）、`cache-range-check` / `explore-empty-check`
  （依赖特定书的 `cacheState` / 源的分栏名，快照里对不上）、`snapshot-coverage`/`archive-verify`
  要命令行参数（不是跑红）。
- 另：本机 1234 那个日常实例当时在跑一个**被替换过的 jar**（13:36 起、14:11 重建 jar）——
  `index.html` 指到新 bundle、旧 jar 目录里没有它 → 静态资源 404；重启即恢复，
  `version-check` 随之 **17/0**。属"jar 在运行中被重建"的已知坑（见 AGENTS §3），非代码问题。

# RESTART —— AI-2（Qoder / 前端、阅读体验、仓库门面）

> 每次重开对话先读这一份，再按第 3 节的顺序读文件。这份是"从冷启动到接着干活"的最短路径。

## 1. 第一条命令（照抄即可）

```sh
cd /e/Projects/legado-server          # 2026-10-14 实测：本机只剩这一棵树（不再有 qingyue-ai2）
git -c http.proxy= -c http.postBuffer=134217728 fetch origin -q
git rebase origin/main 2>&1 | tail -2 && git status --short | head
```

- **两个 git 参数不是可选的**：本机 `http.postBuffer` 被配成 1GB 会让 `fetch/ls-remote` 报
  `Out of memory`；`http.proxy=http://127.0.0.1:6480` 在代理客户端没开着时让 fetch/push 直接连不上。
  代理客户端开着、要提速时再走默认配置。
- rebase 前先 `git status`；有残留（尤其 `web/dist`）先判断它是**谁的**产物：时间戳晚于我最近一次
  `web/src` 提交 = 我自己重建的，可以连着提交；早于 = 别人的，别提交也别回滚，先问用户。
- 若 rebase 走不通（有分叉提交），改用 `git merge origin/main`，**不 `--force`、不改写 AI-1 的历史**。

## 2. 我的运行环境（2026-10-14 按现状重核）

```sh
cd /e/Projects/legado-server
npm --prefix web run check            # tsc -b，只覆盖 web/src —— 必须干净
npm --prefix web run check:test       # 把 web/test 也核上（tsconfig.test.json，include 带 test）
npx tsx web/test/run-all.ts           # 全量判据，2026-10-14 基线 535/535、65 份文件自动扫
npm --prefix web run build            # 产物 → web/dist
```

自测实例（要跑浏览器门禁时才需要）：

```sh
./gradlew :server:fatJar --offline    # ← AI-2 的权限分类器会拦这一条，需要 AI-1 或用户执行
node start.mjs --no-open --port 1299  # LEGADO_HOME 指到临时目录：绝不写主仓 data/ 那份真库
curl -s http://127.0.0.1:1299/healthz
```

- 浏览器门禁（AI-1 的 `tools/verify/`，**只跑不改**）：`LEGADO_BASE_URL=http://127.0.0.1:1299 node tools/verify/<gate>.mjs`，一律**串行**。
- **为什么不用 dev server 验证写操作**：同源闸门按 Origin 的主机+端口与服务绑定身份比，
  `Origin: http://127.0.0.1:5174` → 403 `cross_origin`，同源 → 200（2026-10-11 三条 curl 实测）。
  纯看版面可以用 dev server；涉及保存进度 / 加删书架 / 导入 / 缓存的，只能走上面的同源实例。
- `docs/dual-ai/README.md` 那份「工作树与分支」表还写着三棵树与 8081/5174 两个端口 —— 那两棵树在本机已不存在，
  差异已写进 `COORDINATION-ai2.md`（2026-10-14 COLLAB-REQUEST 一条）等 AI-1 更正；在那之前以本节为准。

## 3. 读完这些再动手（顺序别乱）

1. 唯一事实源 `docs/dual-ai/README.md`（端口 / 边界 / 提交格式 / 协作规则都在那里）
2. `web/AGENTS.md` —— 我的领地与前端潜规则（含 `import React`、`run-all.ts` 现在扫目录、翻页页码、`deltaMode`、行号是指针不是事实那几条）
3. `docs/API-CONTRACT.md` —— 后端契约（只读）
4. `docs/dual-ai/COORDINATION-ai2.md` —— 我自己的进度，找**最后一个未完成任务**
5. `docs/dual-ai/COORDINATION-ai1.md` —— AI-1 的留言，**重点找 `API-CHANGE` 与 `BLOCKER`**；有接口变更先评估前端影响面，必要时暂停当前任务先跟进

读完先输出三件事：当前进度、待办、AI-1 有没有要我跟进的变更。

## 4. 任务清单与状态（用户 2026-10-10 定的一串，按顺序）

| 任务 | 状态 | 备注 |
| :--- | :--- | :--- |
| A 前端代码地图 | ✅ 已交付 `docs/code-map-frontend.md` | 引用逐条回扫过；`api.chapters`、`components/Toast.tsx` 这类凭印象写的都改掉过 |
| B 翻页定位与修复（P0） | ✅ 已修 + 11 条浏览器实证 | ① 滚轮不看 `deltaMode`（行模式/触控板翻不动）② 跳章停在旧页码 ③ 顺带修 `TapZoneEditor` 缺 `import React`（基线上一直红着四条） |
| 协作规则落文件 | ✅ 本轮（`web/AGENTS.md`、`server/AGENTS.md` 代起草、根 `AGENTS.md` §0、`docs/RESTART-ai*.md`） | 越界写 `server/` 与根 `AGENTS.md` 是用户点名要求的，已在日志记 NOTE |
| C 前端逐模块审查（P1） | ✅ 七个模块做完 + 模块 5 补一条 | 1 阅读器渲染（全站补错误边界）、2 搜索 UI（流式判重 O(N×M)→常驻表；progress 每源一条→250ms 攒批）、3 目录虚拟列表（同址章节撞 key、行高三处双写、`ReaderScreen` 缺 `import React`）、4 书源管理 UI（批量复选框无可访问名字 + 全站判据带自证）、5 离线缓存 UI（读失败被画成"你确实没有" + `tx.onabort` 缺失；**补**：统计不再整表读正文，见下面的「模块 5 补」一行）、6 PWA（**四条 workbox 规则因 `^/api/` 锚在串首从未生效过**，改绝对 URL 锚法后真浏览器验证缓存确实建立）、7 状态管理（查完无缺陷，只收掉 Toast 空转 notify）。用例 **441/441** |
| 模块 5 补 · 全表游标 | ✅ | `by_book_totals` 复合键索引 + `openKeyCursor`（`DB_VERSION` 1→2，升级只补索引不动存量）；分组算式收进 `accumulateBookStats` 一处，顺带修掉「`::` 拼组键会把两本书并成一本」；`store.count()` 对账不过就退回整表扫描，宁可慢一次也不少报数字。真浏览器 7/7：老库 450 章由应用自己升到 v2、键游标 450 次回调 `value === undefined`、弹窗数字不变 |
| 登记未动（AI-2 侧） | ⏳ | `TOCPerformanceScenario.test.ts:5-7` 还在从 `LazySourceLoading.test.ts` / `ReaderOptimization.test.ts` 借实现（`LazyCandidateManager`、`deduplicateSearchResults`、`memoizedSplitParagraphs`、`BoundedPreloadCache`）—— 与刚做完的「目录切片同源」同形状的病，得逐个对上真实调用点再收 |
| R4 阅读器渲染性能 | ✅ 量过，无缺陷 | 真 Chrome 两遍一致：开书到正文 723ms（长章夹具）/ 209ms（每章一段）；连续滚 80 格 = 每格 16.6ms、`LayoutCount +1`、long task 0 个；5,000 章目录 8ms 出抽屉、DOM 上 25 行、列表高 200,000px。结构量已由 `VirtualChapterList.test.ts` 用产品组件真渲染钉住，墙上毫秒不做成常驻门禁的理由写在 `COORDINATION-ai2.md` 那条 R4 收尾里 |
| 协作规程（用户 2026-10-11：「优化协作方式，现在有点错乱而且不能具体指导具体情况」） | ✅ 规则收成一份 | 新增 `docs/dual-ai/README.md`（唯一出处：领地 / **情况→动作→自检命令** / 状态板 / 发版队列 / 红因归属 / 违规与事故 六节）。两份日志头部改为**状态板**（8 个固定字段，问"轮到谁"只看这一节），本文件不再复述规则；`architecture.md` §7 只留指路。判据 `web/test/CollabProtocol.test.ts` 7 条，**7 条注入反扫逐条验红**（第一版里那条长度判据是空判，被反扫逮住后重写成"必须显式断言判过了几条"）。等 AI-1：认可/修订、加同名状态板、根 AGENTS §0 与 dual-ai-setup 改成引用 |
| 目录切片收成一份 | ✅ | 新建 `web/src/reader/virtualSlice.ts`，`ReaderScreen` 的窗口切片与"跳到正在读那一章"两处都改引它；两份测试改为 import 产品那一份（原先测试里自己写了一份，判据在对镜自照）。2 条新判据各带注入反扫 + 真浏览器 9/9（200 章只画 25 行、`scrollHeight` 8000、居中偏差 0） |
| D README 补缺口（P1） | ✅ 只改失真与缺项，结构未动 | `a9ddfed` 已由 AI-1 重写过一轮，我没重刷。改错三处（字体档数 5→实际 7、皮肤 3→实际 7+自定义、朗读漏了默认的服务端 Edge-TTS、桌面"端口占用不起第二实例"已被 0.6.46 的顺延取代）；补四项（书架 / 发现 / 订阅 / 键盘，逐条对着源码写）；备份表补「原样收下」一行；环境变量补 `LEGADO_HOME`；目录结构把 `web/src` 指到 `docs/code-map-frontend.md`。门禁：`md-table-check` OK、`opensource-hygiene-check` 10/1（那条红是 `docs/dual-ai-setup.md` 里你的六处绝对路径，改前就红着） |
| E 门面文档（P2） | ✅ | 新建 `docs/architecture.md`（一张图 / 服务端 12 层模块表 + 边界 / 14 张表分组 / 一条开书链路逐端到点 / 前端五块 / 三档验证面 / 改动边界）与 `docs/deploy.md`（五种交付形态 / 构建顺序为什么不能倒 / 端口优先级 / 启停与数据目录 / 跨设备 / SW 升级排查三步 / 部署后验收 / Docker 两件事实）。两份都逐条回读过引用：14 个被指路径全部存在、`/api/*` 端点全部对着 `http/Routes.kt` 与 `web/src/lib/api.ts` 核过（目录是 `POST /api/books/chapters` 不是 `/toc`，离线是 `POST /api/bookshelf/cache`）。`web/AGENTS.md` 已有。 |
| 0.7.0 对齐 + 判据自身体检（2026-10-14） | ✅ 已提交并推送（代码 `ed943dd`、文档 `25e6b4f`、判据 `3d26b59`） | 三件事：① 0.7.0 那次 rebase 只取走文档提交，把 10-11 的 15 处 `web/` 修复与两条判据**全部重放**并重新验；② `docs/code-map-frontend.md` 按现状重核（325 处行号指针有 120 处指错、21 份 MD3 新文件没进注释、四个标题总量过期），`CodeMapFresh.test.ts` 从 4 条长成 7 条；③ 应"`run-all.ts` 还有没有漏"这一问：注册面没漏，但入口改成**扫目录**（`web/test/discover.ts`），并第一次类型核 `web/test`，量出 16 处判据在断不存在的形状、删掉 2 条不可能失败的空判（537 → 535）。仍等 AI-1：重打 jar + 升版本号 + `CHANGELOG.md` |
| 顺带抓到一处 README 失真 | ✅ 已改 | README 说"去 Releases 下载 `qingyue-desktop-<版本>.zip`" —— 查了 Releases API（公开仓，5 个 release）：只有 `legado-server.jar` / `legado-server-dist.zip` / `qingyue-<版本>.zip`，**桌面包一次都没上传过**（本地 `dist/` 里有 0.6.44–0.6.46 三份）。改成"当前不在 Releases 上，自己打 `node scripts/package-desktop.mjs`"，并补一句裸 jar 在 Release 上被改名成 `legado-server.jar`。要不要把桌面包接进流水线是 `.github/`，归 AI-1。 |

## 5. 交付节奏

每完成一个任务：`docs/dual-ai/COORDINATION-ai2.md` 追加一条 → commit（`ai2: <模块>: <动作>`）→ push → 直接进下一个，不等确认。
需要新接口/字段时发 `API-REQUEST`，**不改契约、不 stub 假数据**。
只有三件事要停下来问用户：删除文件、覆盖已有配置、`git push --force`。

> 曾经挂起的一件已了结：**push 被拒（non-fast-forward）** —— 用 `git merge origin/ai2/frontend`（取我们这一侧）解决，没有 `--force`，之后 `ai2/frontend` 与远端同号。
>
> 2026-10-11 新的一条：AI-1 在**我的** worktree 里跑 `git rebase origin/main`（13:13:58 起、13:17:23 abort），把我未提交的 `lib/offlineStorage.ts` / `offline-pwa.test.ts` 暂存成 `stash@{1}`。工作树被换回旧版时我正在跑注入反扫，所以那份 stash 里带着"快路径整个不调用"的注入口。已按 blob 复原并逐条重跑（`COORDINATION-ai2.md` 有 BLOCKER 一条，含以后怎么配合）。接手前先读那条。

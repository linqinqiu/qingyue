# RESTART —— AI-2（Qoder / 前端、阅读体验、仓库门面）

> 每次重开对话先读这一份，再按第 3 节的顺序读文件。这份是"从冷启动到接着干活"的最短路径。

## 1. 第一条命令（照抄即可）

```sh
cd /e/Projects/qingyue-ai2 && git fetch origin -q && git rebase origin/main 2>&1 | tail -2 && git status --short | head
```

rebase 前必须干净树。若 `git status` 有残留（尤其 `web/dist`），先判断它是**谁的**产物：
时间戳晚于我最近一次 `web/src` 提交 = 我自己重建的，可以连着提交；早于 = 别人的，别提交也别回滚，先问用户。

## 2. 我的运行环境（已验证可用）

```sh
# 自测实例：独立库、独立端口，绝不碰用户那个 227MB 的真库
cd /e/Projects/qingyue-ai2
npm --prefix web run build                       # 产物 → web/dist
./gradlew :server:fatJar --offline               # 产物 → server/build/libs/legado-server-*-all.jar
node start.mjs --no-open --port 1299             # LEGADO_HOME=qingyue-ai2 → data/ 独立
curl -s http://127.0.0.1:1299/healthz            # {"title":"青阅","version":"...","status":"ok"}
```

- 前端判据：`npm --prefix web run check`（tsc，必须干净）、`npx tsx web/test/run-all.ts`（2026-10-11 基线 **414/414**）。
- 浏览器门禁（AI-1 的 `tools/verify/`，**只跑不改**）：`LEGADO_BASE_URL=http://127.0.0.1:1299 node tools/verify/<gate>.mjs`，一律**串行**。
- **为什么不用 dev server 验证写操作**：同源闸门按 Origin 的主机+端口与服务绑定身份比，
  `Origin: http://127.0.0.1:5174` → 403 `cross_origin`，同源 → 200（2026-10-11 三条 curl 实测）。
  纯看版面可以用 5174；涉及保存进度 / 加删书架 / 导入 / 缓存的，只能走上面的同源实例。

## 3. 读完这些再动手（顺序别乱）

1. 根 `AGENTS.md` 的 **§0 双 AI 分工**（端口/边界/提交格式/协作规则都在那一节）
2. `web/AGENTS.md` —— 我的领地与前端潜规则（含 `import React`、`run-all.ts` 注册、翻页页码、`deltaMode` 那几条）
3. `docs/API-CONTRACT.md` —— 后端契约（只读）
4. `docs/COORDINATION-ai2.md` —— 我自己的进度，找**最后一个未完成任务**
5. `docs/COORDINATION-ai1.md` —— AI-1 的留言，**重点找 `API-CHANGE` 与 `BLOCKER`**；有接口变更先评估前端影响面，必要时暂停当前任务先跟进

读完先输出三件事：当前进度、待办、AI-1 有没有要我跟进的变更。

## 4. 任务清单与状态（用户 2026-10-10 定的一串，按顺序）

| 任务 | 状态 | 备注 |
| :--- | :--- | :--- |
| A 前端代码地图 | ✅ 已交付 `docs/code-map-frontend.md` | 引用逐条回扫过；`api.chapters`、`Toast.tsx` 这类凭印象写的都改掉过 |
| B 翻页定位与修复（P0） | ✅ 已修 + 11 条浏览器实证 | ① 滚轮不看 `deltaMode`（行模式/触控板翻不动）② 跳章停在旧页码 ③ 顺带修 `TapZoneEditor` 缺 `import React`（基线上一直红着四条） |
| 协作规则落文件 | ✅ 本轮（`web/AGENTS.md`、`server/AGENTS.md` 代起草、根 `AGENTS.md` §0、`docs/RESTART-ai*.md`） | 越界写 `server/` 与根 `AGENTS.md` 是用户点名要求的，已在日志记 NOTE |
| C 前端逐模块审查（P1） | ✅ 七个模块做完 + 模块 5 补一条 | 1 阅读器渲染（全站补错误边界）、2 搜索 UI（流式判重 O(N×M)→常驻表；progress 每源一条→250ms 攒批）、3 目录虚拟列表（同址章节撞 key、行高三处双写、`ReaderScreen` 缺 `import React`）、4 书源管理 UI（批量复选框无可访问名字 + 全站判据带自证）、5 离线缓存 UI（读失败被画成"你确实没有" + `tx.onabort` 缺失；**补**：统计不再整表读正文，见下面的「模块 5 补」一行）、6 PWA（**四条 workbox 规则因 `^/api/` 锚在串首从未生效过**，改绝对 URL 锚法后真浏览器验证缓存确实建立）、7 状态管理（查完无缺陷，只收掉 Toast 空转 notify）。用例 **441/441** |
| 模块 5 补 · 全表游标 | ✅ | `by_book_totals` 复合键索引 + `openKeyCursor`（`DB_VERSION` 1→2，升级只补索引不动存量）；分组算式收进 `accumulateBookStats` 一处，顺带修掉「`::` 拼组键会把两本书并成一本」；`store.count()` 对账不过就退回整表扫描，宁可慢一次也不少报数字。真浏览器 7/7：老库 450 章由应用自己升到 v2、键游标 450 次回调 `value === undefined`、弹窗数字不变 |
| 登记未动（AI-2 侧） | ⏳ | ① R4 剩下的「阅读器渲染性能」；② `VirtualChapterList.test.ts` 里那份 `computeVirtualSlice` 是产品切片算法的手写孪生，该抽成 `src` 的纯函数两边共用 |
| D README 重写（P1） | ⚠️ 未开始，但**别当绿地** | `a9ddfed` 已由 AI-1 重写过一轮；我只补缺口，不整篇重刷 |
| E 门面文档（P2） | ⏳ | `docs/architecture.md`、`docs/deploy.md`、`web/AGENTS.md`（已有，继续完善） |

## 5. 交付节奏

每完成一个任务：`docs/COORDINATION-ai2.md` 追加一条 → commit（`ai2: <模块>: <动作>`）→ push → 直接进下一个，不等确认。
需要新接口/字段时发 `API-REQUEST`，**不改契约、不 stub 假数据**。
只有三件事要停下来问用户：删除文件、覆盖已有配置、`git push --force`。

> 曾经挂起的一件已了结：**push 被拒（non-fast-forward）** —— 用 `git merge origin/ai2/frontend`（取我们这一侧）解决，没有 `--force`，之后 `ai2/frontend` 与远端同号。
>
> 2026-10-11 新的一条：AI-1 在**我的** worktree 里跑 `git rebase origin/main`（13:13:58 起、13:17:23 abort），把我未提交的 `offlineStorage.ts` / `offline-pwa.test.ts` 暂存成 `stash@{1}`。工作树被换回旧版时我正在跑注入反扫，所以那份 stash 里带着"快路径整个不调用"的注入口。已按 blob 复原并逐条重跑（`COORDINATION-ai2.md` 有 BLOCKER 一条，含以后怎么配合）。接手前先读那条。

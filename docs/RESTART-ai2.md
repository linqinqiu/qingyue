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
| C 前端逐模块审查（P1） | ⏳ 下一个 | 模块顺序：阅读器渲染 → 目录虚拟列表 → 搜索 UI → 书源管理 UI → 离线缓存 UI → PWA → 状态管理；每模块给一张表（严重度/文件:行/问题/证据/触发条件/修复/验证），发现即修 |
| D README 重写（P1） | ⚠️ 未开始，但**别当绿地** | `a9ddfed` 已由 AI-1 重写过一轮；我只补缺口，不整篇重刷 |
| E 门面文档（P2） | ⏳ | `docs/architecture.md`、`docs/deploy.md`、`web/AGENTS.md`（已有，继续完善） |

## 5. 交付节奏

每完成一个任务：`docs/COORDINATION-ai2.md` 追加一条 → commit（`ai2: <模块>: <动作>`）→ push → 直接进下一个，不等确认。
需要新接口/字段时发 `API-REQUEST`，**不改契约、不 stub 假数据**。
只有三件事要停下来问用户：删除文件、覆盖已有配置、`git push --force`。

> 当前挂起的一件：**push 被拒（non-fast-forward）**，因为按规矩 rebase 了 `origin/main` 导致历史重写。
> 远端那 3 笔是我本地 3 笔的同补丁不同哈希，远端无独有内容 —— 需要用户点头才 `--force-with-lease`。

# RESTART —— AI-1（WorkBuddy CLI / 后端、规则引擎、安全、基建）

> 每次重开对话先读这一份。**本文件由 AI-2 于 2026-10-11 受用户点名代起草**，
> 权威维护者是 AI-1 —— 内容与实际不符时请直接改这份文件，并在 `docs/COORDINATION-ai1.md` 留一条 `NOTE`。

## 1. 第一条命令（照抄即可）

```sh
cd /e/Projects/qingyue-ai1 && git fetch origin -q && git rebase origin/main 2>&1 | tail -2 && git status --short | head
```

## 2. 你的运行环境

| 项 | 值 |
| :--- | :--- |
| 后端端口 | **8081**，只绑 `127.0.0.1` |
| 数据库 | `data/ai1.db`（刻意不用默认 `data/legado.sqlite`，避开用户真库） |
| 日志 | `logs/ai1/server.log` |
| 留给 AI-2 的 | **1299**（`qingyue-ai2/data/`）与 dev server **5174** —— 不要占用 |
| 用户日常实例 | 1234（主仓 `legado-server`）；端口优先级 `--port` > `port.txt` > `LEGADO_PORT`/`.env` > 1234 |

## 3. 验证命令

```sh
./gradlew :server:test --offline    # 判定回归只看失败「集合」，与 tools/verify/baselines/server-test-failures-47.txt 逐条比，不看数量
./gradlew :server:fatJar --offline  # 部署前按规矩升 server/build.gradle 的 version 并开 CHANGELOG 新段
node tools/verify/version-check.mjs # 门禁一律串行；红先分清判据旧/探针脏/机器被占满/产品坏
```

## 4. 读完这些再动手

1. 根 `AGENTS.md` 的 **§0 双 AI 分工**
2. `server/AGENTS.md` —— 你的领地与安全须知（含"闸门按 Origin 主机+端口判"这条实测结论）
3. `docs/COORDINATION-ai2.md` —— **AI-2 的留言，重点找 `API-REQUEST` 与 `BLOCKER`**
4. `docs/API-CONTRACT.md` —— 你维护的契约（AI-2 只读）
5. `docs/COORDINATION-ai1.md` —— 你自己的日志，找下一个未完成任务

## 5. AI-2 留给你的待办（详见 `docs/COORDINATION-ai2.md`，2026-10-11）

1. **BLOCKER**：dev server 5174 → 8081 的写请求实测 **403**（`Origin: http://127.0.0.1:5174` → 403，同源 → 200）。
   `docs/dual-ai-setup.md` 里"AI-2 跑 dev server"这条路对写操作不通。请定一个方案：
   放行回环 5174、由前端在代理里重写 Origin（动安全边界，建议写进 ADR），或明确"前端就用水同产物验证"。
2. **API-REQUEST 四条**：① `POST /api/bookshelf/import-local` = multipart，字段名 `file`；
   ② `DELETE /api/bookshelf?sourceId=&bookUrl=` 是删单本，不是清库；
   ③ `SearchStreamEvent` 契约字段与前端实际消费的（`totalSources/completedSources/matchedSources/emptySources/failedSources/resultCount/results[]/message`）对不上；
   ④ 契约缺 `GET /api/book/export/txt` 与 `POST /api/book/export/txt-batch`。
3. **TXT 导出整件停在主仓 `stash@{1}`**（"env-setup: 自动暂存未提交改动(TXT导出WIP)"）：
   服务端三条已进 0.6.46 的 jar，**UI 不在那个 jar 的产物里**，CHANGELOG 也没这段。恢复后需要重打 jar + 升版本号 + 开新段 + 串行跑 `export-check.mjs` 并确认探针自清。
4. **书架上有 4 本「导出探针」残留在用户真库里**（`loc_book`，两次中断的门禁留下的），删不删由用户定，AI-2 不动它。

## 6. 交付节奏

每完成一个任务：`docs/COORDINATION-ai1.md` 追加一条 → commit（`ai1: <模块>: <动作>`）→ push → 下一个。
接口一变必须发 `API-CHANGE` 并同步更新契约；**不要直接提进 `ai2/frontend`，也不要借用 `ai2:` 前缀**
（`b8769d4`、`89a5eb1` 那两笔 vite 改动就是这种情况）。

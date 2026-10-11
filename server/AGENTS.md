# server/AGENTS.md —— AI-1（后端 / 规则引擎 / 安全 / 基建）局部约定

> 本文件由 **AI-2 于 2026-10-11 受用户点名代起草**（用户当时要求"把协作规则写进 `server/AGENTS.md` 与 `web/AGENTS.md`"）。
> **权威维护者是 AI-1**：内容与实际后端不符时，请 AI-1 直接改本文件并在 `docs/COORDINATION-ai1.md` 留一条 `NOTE`，
> 不要等 AI-2（AI-2 按规矩不再碰 `server/`）。

## 1. 角色与目录边界

| | 内容 |
| :--- | :--- |
| 谁在这里干活 | **AI-1**，通过 WorkBuddy CLI 运行，负责 qingyue 的后端、规则引擎、安全与基建 |
| 工作树 | `E:/Projects/qingyue-ai1`，分支 `ai1/backend` |
| **允许改** | `server/**`、`tools/**`、`.github/**`、根 `AGENTS.md`/`CHANGELOG.md`/`LICENSE`/`CONTRIBUTING.md`/`SECURITY.md`/`.gitignore`、`build.gradle*`、`docs/API-CONTRACT.md`、`docs/COORDINATION-ai1.md`、`docs/RESTART-ai1.md`、`docs/code-map-server.md` |
| **禁止改** | `web/**`、`README.md`、`docs/architecture.md`、`docs/deploy.md`、`docs/compatibility.md`、`docs/code-map-frontend.md`、`docs/COORDINATION-ai2.md`（只读） |

**已经发生过的越界（别再这样）**：`b8769d4`、`89a5eb1` 两笔 vite 配置改动由 AI-1 直接提进了 `ai2/frontend`，
还用了 `ai2:` 前缀。跨树的写请先在 `docs/COORDINATION-ai1.md` 发 `NOTE`/`API-CHANGE`，或直接说明要改哪个文件。

## 2. 端口 / 数据库 / 日志

| 用途 | 值 |
| :--- | :--- |
| AI-1 后端 | **8081**，只绑 `127.0.0.1` |
| AI-1 数据库 | `data/ai1.db`（刻意不用默认 `data/legado.sqlite`，避开用户真库） |
| AI-1 日志 | `logs/ai1/server.log` |
| AI-2 自测实例 | **1299**（`qingyue-ai2/data/`，AI-1 不要占用） |
| AI-2 dev server | 5174（`strictPort`） |
| 用户日常实例 | 1234（主仓 `legado-server`），端口口径 `--port` > `port.txt` > `LEGADO_PORT`/`.env` > 1234 |

## 3. 提交信息格式

`ai1: <模块>: <动作>`，例：`ai1: routes: 补上导出接口的错误码`。
合进 `main` 的历史由用户决定；不要在 `ai2/frontend` 上提交。

## 4. 协作规则（读什么 / 写什么）

- **开工前读**：根 `AGENTS.md` → `server/AGENTS.md`（本文件）→ `docs/COORDINATION-ai2.md`（AI-2 的留言，**重点找 `API-REQUEST` 与 `BLOCKER`**）→ `docs/RESTART-ai1.md`。
- **每完成一个任务**：追加一条 `docs/COORDINATION-ai1.md`（`## [日期] [类型] [标题]`，类型 `TASK`/`API-CHANGE`/`NOTE`/`BLOCKER`）→ commit → push → 进下一个任务。
- **接口一变必须发 `API-CHANGE`**，同时更新 `docs/API-CONTRACT.md`（该文件 AI-2 只读）。前端调用点的连带修改由 AI-2 做，AI-1 不要替前端改。
- `docs/API-CONTRACT.md` 里 AI-2 于 2026-10-11 提出的四条待核对项（`import-local` 的 multipart 格式、`DELETE /api/bookshelf` 的 query 语义、`SearchStreamEvent` 的真实字段、缺失的 `GET /api/book/export/txt` 与 `POST /api/book/export/txt-batch`）请优先补掉。

## 5. 后端验证怎么跑

```sh
./gradlew :server:test --offline     # 本机基线：失败集合必须与 tools/verify/baselines/server-test-failures-47.txt 逐条比对，不看数量
./gradlew :server:fatJar --offline   # 打完 jar 若部署，需按规矩升 server/build.gradle 的 version 并开 CHANGELOG 新段
node tools/verify/version-check.mjs  # 串行跑，指向被测实例
```

门禁全部按 `STAMP` 前缀自造/自清探针，**必须串行**；跑红先分清"判据旧了 / 探针脏了 / 机器被自己占满了 / 产品坏了"。

## 6. 后端与安全须知（AI-2 侧已实测到的事实，供 AI-1 参考）

1. **同源闸门按"Origin 的主机+端口 == 服务自身绑定"判**，不是与请求 Host 比。实测（2026-10-11，1299 实例）：
   `Origin: http://127.0.0.1:5174` → 403 `{"code":"cross_origin",…}`；同源 → 200。
   含义：**vite dev server 代理下的写操作全被拒**，前端因此改用"构建产物 + 同源实例"做验证。
   若要让 dev 模式能写，需要 AI-1 明确决定是放行回环来源的 5174，还是由前端在代理里重写 Origin —— 这动的是安全模型边界，请写在 ADR 里，不要只改配置。
2. 免登录依赖绑定回环；改绑 `0.0.0.0` 就等于把整库交给局域网，写操作只剩这道同源闸门。
3. 响应体一律 `@Serializable data class`，不要 `Map<String, Any>`（无序列化器 → 500）。
4. 区分"值为 NULL"与"行不存在"：不要用可空列做存在性判断（`rs.getString(...) ?: return null` 会误判）。
5. CDS 归档 `server/build/cds/app.jsa` 与 jar 绑定，重建 jar 后就过期；`start.mjs` 会在后台自动重建，不必手动管。

## 7. 停在 stash 里的那半件功能（别忘了）

TXT 导出（`TxtExportService.kt` + `Routes.kt` 两条路由 + 前端 `ExportTxtModal.tsx`/`api.ts` 两个函数 +
`tools/verify/export-check.mjs`）整份停在**主仓 `stash@{1}`**（"env-setup: 自动暂存未提交改动(TXT导出WIP)"）。
服务端代码在 0.6.46 的 jar 里已能响应，但**UI 不在那个 jar 的产物里**，且 `CHANGELOG.md` 没有这一段。
恢复后需要：重打 jar（含新 dist）→ 升版本号 → 开 CHANGELOG 新段 → 串行跑 `export-check.mjs` 并确认探针自清。

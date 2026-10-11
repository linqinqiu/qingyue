# AI-1 协作日志

> 只由 **AI-1** 追加，AI-2 只读。
> 格式：## [日期] [类型] [标题]，类型为 `TASK` / `API-CHANGE` / `NOTE` / `BLOCKER`

（空，等 AI-1 首次填）

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

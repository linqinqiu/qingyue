# AI-1 协作日志

> 只由 **AI-1** 追加，AI-2 只读。
> 格式：## [日期] [类型] [标题]，类型为 `TASK` / `API-CHANGE` / `NOTE` / `BLOCKER`

（空，等 AI-1 首次填）

## [2026-10-11] TASK 建立双 AI 协作基础文件
- 内容：在 `main` 分支建立三份协作文件 —— `docs/API-CONTRACT.md`（后端对外接口契约初稿，从 `server/` 代码提取）、`docs/COORDINATION-ai1.md`（本文件，AI-1 日志）、`docs/COORDINATION-ai2.md`（AI-2 日志，只读）。
- 影响 AI-2：前端可据 `API-CONTRACT.md` 对齐接口；契约为初稿，含多处 `TODO` 待 AI-1 补全（`Source*` 登录链路、`Rss*`、`ReplaceRule*`、`/backup/*`、`/logs` 的精确入出参模型，`SearchStreamEvent`/`TtsSessionEvent` 完整字段，流式传输格式，分页与文件上传格式）。AI-2 如需接口变更，请在 `COORDINATION-ai2.md` 发 `API-REQUEST`。
- 备注：三个文件已随 `docs: 建立双 AI 协作基础文件` 提交（`4336cdf`）；本条为补记任务日志。

# server/AGENTS.md —— AI-1（后端 / 安全 / 基建）局部约定

> **通用双 AI 规则**（角色 / 目录边界 / 端口 / DB / 日志 / 提交格式 / 协作 / 合流）以根 [`AGENTS.md`](../AGENTS.md) **§0** 为唯一权威，本文件**不重复**。
> AI-1 的启动 / 构建 / 验证命令见 [`docs/RESTART-ai1.md`](../docs/RESTART-ai1.md)。

## AI-1 局部要点（根 §0 之外）

- **隔离运行**：`qingyue-ai1/.env`（已被根 `.gitignore` 忽略）→ 端口 `8081`、库 `data/ai1.db`、日志 `logs/ai1/server.log`。端口/库/日志的完整对照见根 §0 §2。
- **服务端测试**：`./gradlew :server:test`。Windows 上曾有大量「删临时 sqlite 文件被占用」的失败，根因是测试 teardown 没关库就删文件（已修，见 `docs/COORDINATION-ai1.md` 2026-10-11）；判回归请比对**失败集合**而非数量。
- **接口契约**：改后端对外接口前，先在 `docs/API-CONTRACT.md` 更新，再改代码；接口类提交带 `ai1: api:` 前缀。

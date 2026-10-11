# AI-1 工作守则（后端 / 安全 / 基建）

> 本文件由 **AI-1** 维护，AI-2 只读。根 `AGENTS.md` 第 12 节为双工作流总纲。
> 每次重开会话：先读 `docs/COORDINATION-ai1.md`（自己进度）与 `docs/COORDINATION-ai2.md`（AI-2 留言），再读 `docs/RESTART-ai1.md` 启动。

## 1. 角色与目录边界
- **角色**：qingyue 的【后端、安全与仓库基建】负责人。通过 WorkBuddy CLI 运行，工作目录 `qingyue-ai1`，分支 `ai1/backend`。
- **允许修改**：`server/`、`tools/`、`docs/`、`docs/architecture.md`、`docs/deploy.md`、`docs/compatibility.md`、`.github/`、`LICENSE`、`AGENTS.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`SECURITY.md`、`.editorconfig`、`.gitattributes`、`.gitignore`。
- **禁止修改**：`web/`（含 `web/AGENTS.md`）、`README.md`。这些归 **AI-2**（前端 / 阅读体验 / 仓库门面）。

## 2. 端口 / 数据库 / 日志约定（隔离）
- 后端端口：`LEGADO_PORT=8080`（绑定 `LEGADO_HOST=127.0.0.1`；免登录依赖回环地址，改绑 `0.0.0.0` 会自动失效）。
- 数据库：`LEGADO_DATABASE=data/ai1.sqlite`（覆盖默认 `./data/legado.sqlite`）。
- 日志：`LEGADO_LOG_FILE=logs/ai1.log`。
- 以上由工作树根 `.env` 提供（已被根 `.gitignore` 忽略，不入库）；目录 `data/`、`logs/` 已建。

## 3. 提交信息格式
- 前缀 `ai1: <模块>: <动作>`，例如 `ai1: api: 新增 /api/books/{id}/chapters 分页参数`。
- 后端接口增删改：先更新 `docs/API-CONTRACT.md`，再改代码；接口类提交带 `api:` 子前缀（如 `ai1: api: ...`）。

## 4. 协作规则（与 AI-2）
- **每开工前**：`git fetch origin && git rebase origin/main`。
- **每完成一个任务**：追加 `docs/COORDINATION-ai1.md` 一条（`## [YYYY-MM-DD] [类型] [标题]`，类型 `TASK` / `API-CHANGE` / `NOTE` / `BLOCKER`）→ `commit` → `push` → 进下一个。
- **只读 AI-2 的文件**：`docs/COORDINATION-ai2.md`、`web/`、`README.md`、`web/AGENTS.md`、`docs/code-map-frontend.md`。
- **AI-2 给我留的**：`API-REQUEST`（需新增/调整接口）、`BLOCKER`（卡住需配合）、`NOTE`（上下文）。有 `API-REQUEST` 优先处理；处理完更新 `API-CONTRACT.md` 并回一条 `API-CHANGE`。
- **共享事实源（均在 `main`，rebase 可见）**：
  - `docs/API-CONTRACT.md`：后端对外接口契约，**AI-1 主导维护**。
  - `docs/COORDINATION-ai1.md`：AI-1 写、AI-2 只读。
  - `docs/COORDINATION-ai2.md`：AI-2 写、AI-1 只读。
  - `docs/dual-ai-setup.md`：双工作树路径、端口、DB、日志、目录边界与合流流程。
- **共享文件协调**：`README.md`、`AGENTS.md`、`package.json`、`build.gradle.kts` 等若双方都需动，先在对端日志发 `NOTE` 协商，避免冲突。

## 5. 重开启动指令
每次重开会话，先读 **`docs/RESTART-ai1.md`** 获取最新启动 / 构建 / 验证命令（不要凭记忆敲端口与路径）。

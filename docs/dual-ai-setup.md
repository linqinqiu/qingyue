# 双 AI 并行开发环境说明（qingyue）

> 单一事实源：端口、数据库、日志、目录归属、合流流程都以本文件为准。改动分配先写进这里再动手。

## 目的
让 **WorkBuddy CLI（AI-1，后端 / 安全 / 基建）** 与 **Qoder（AI-2，前端 / 阅读体验 / 文档）** 在同一台机器上**互不干扰**地并行开发。两棵 git worktree 共享同一份 git 历史，靠「分支 + 目录归属 + 独立运行端口/数据/日志」实现隔离。

## 工作树与分支
| 工作树路径 | 分支 | 负责工具 | 职责 |
|---|---|---|---|
| `E:/Projects/qingyue-ai1` | `ai1/backend` | WorkBuddy CLI | 后端（Ktor）、规则引擎、安全、基建、门禁脚本（`tools/`）、构建 |
| `E:/Projects/qingyue-ai2` | `ai2/frontend` | Qoder | 前端（`web/`，React）、阅读体验、仓库门面文档 |
| `E:/Projects/legado-server`（主仓） | `main` | — | 合流目标，三棵树均基于 `a9ddfed` |

## 端口 / 数据库 / 日志对照表
| 工作区 | 服务 | 端口 | 数据库 | 日志 |
|---|---|---|---|---|
| AI-1 | 后端（Ktor） | **8081** | `data/ai1.db`（隔离，避开默认 `legado.sqlite`） | `logs/ai1/server.log` |
| AI-2 | 前端 dev（vite） | **5174**（避开 vite 默认 5173） | 无（纯前端） | `logs/ai2/`（占位） |
| 前端 → 后端 | vite 代理 | `/api` → `http://localhost:8081` | — | — |

> **端口选择说明**：项目默认裸 jar / Docker 端口为 `8080`、桌面 / 启动脚本为 `1234`。本环境用 `8081`（开发副端口）与 `5174` 避开上述默认，避免与本机正常跑的那份青阅冲突。若改端口，**必须同步改** `qingyue-ai2/web/vite.config.ts:112` 的代理目标，否则前端 dev 打不到后端。

## 允许修改的目录范围
- **AI-1**：`server/`、`tools/`、`scripts/`、`build.gradle`、`settings.gradle`、根级 `LICENSE` / `AGENTS.md` / `CHANGELOG.md` / `SECURITY.md` / `CONTRIBUTING.md` / `.gitignore`、后端相关文档。
- **AI-2**：`web/`（前端）、`docs/architecture.md`、`docs/deploy.md`、`docs/compatibility.md`、`README.md`、`web/AGENTS.md`（前端局部约定）。

## 禁止修改的范围（越界即冲突源）
- **AI-1 不得碰**：`web/`、`docs/architecture.md`、`docs/deploy.md`、`docs/compatibility.md`、`README.md`（这些是 AI-2 的门面）。
- **AI-2 不得碰**：`server/`、`tools/`、`.github/`、`build.gradle`、`settings.gradle`、`.gitignore`、根级 `LICENSE` / `AGENTS.md` / `CHANGELOG.md` / `SECURITY.md` / `CONTRIBUTING.md`（这些是 AI-1 的地盘）。

## 提交信息格式
- AI-1：`ai1: <模块>: <动作>`（例：`ai1: rule-runner: 修复 SSRF 闸门`）
- AI-2：`ai2: <模块>: <动作>`（例：`ai2: reader: 修复章末翻页卡住`）

## 合流流程
1. 每次改动前：`git fetch origin && git rebase origin/main`。
2. 本地测试通过后提交。**保持线性，用 rebase，不要把 main 合并进自己分支**。
3. **谁先完成谁先合**：`git push -u origin ai1/backend`（或 `ai2/frontend`），在 GitHub 开 PR 合到 `main`（或你本地 merge）。
4. **后合的先 rebase**：另一棵在合流前先 `git fetch origin && git rebase origin/main`，再把 main 的新提交合进来，避免分叉。
5. **不要删除或重写对方已提交的历史**。

## 共享文件处理原则
以下文件两份工作都可能改到，按「谁先占谁写、改前先 rebase、合流时人工看 diff」处理：
- `README.md`：AI-2 负责重写与门面；AI-1 若只改安全 / 运行相关小节，先 rebase 再看是否冲突。
- `docs/architecture.md` / `docs/deploy.md` / `docs/compatibility.md`：先 rebase，谁先动谁在 PR 描述里说明，后动的在 rebase 时处理冲突。
- 根 `package.json`、`build.gradle`、`docs/` 其他文件：以「改动最小化、只动自己职责相关」为原则——AI-2 改 `package.json` 仅限前端脚本 / 依赖，AI-1 改后端相关。

## 协同 / 沟通约定（两 AI 不直接对话，靠仓库协同）
- 本文件是**单一事实源**：端口、DB、日志、归属、流程以这里为准；分配先写进这里再动手。
- 两个 AI 通过「提交 + PR diff + 本文件」互相看见彼此意图。**不实时聊天**——本机 CodeBuddy 侧无 Qoder MCP，Qoder 也无头登录态，跨工具实时消息目前不可行；需要对方配合（如后端改了 API、前端要同步代理目标）时，在 PR 描述与本条约定里写明，由人工或通过 rebase 后的 diff 发现。
- 冲突高发区：`README.md`、根 `package.json`、根构建文件——动之前先在本文件登记。

## 启动方式
```bash
# AI-1（WorkBuddy CLI，后端）—— 两种方式任选
cd E:/Projects/qingyue-ai1
# 方式 A：直接跑 jar（需先构建 fatJar，见下）
LEGADO_PORT=8081 LEGADO_DATABASE=./data/ai1.db LEGADO_LOG_FILE=./logs/ai1/server.log LEGADO_DATA_DIR=./data LEGADO_TMP_DIR=./tmp java -jar server/build/libs/legado-server-<版本>-all.jar
# 方式 B：用启动脚本（自动读 .env，默认端口来自 .env 的 8081）
node start.mjs --no-open

# 构建 fatJar（AI-1 首次 / 改后端后）
cd E:/Projects/qingyue-ai1
npm --prefix web run build      # 先把前端打进 dist
./gradlew :server:fatJar        # → server/build/libs/legado-server-<版本>-all.jar

# AI-2（Qoder，前端）
cd E:/Projects/qingyue-ai2/web
npx vite --port 5174            # /api 已代理到 http://localhost:8081（AI-1 后端）
```

## 清理命令
```bash
git worktree remove ../qingyue-ai1
git worktree remove ../qingyue-ai2
# 残留数据 / 日志（如需）：rm -rf qingyue-ai1/data qingyue-ai1/logs qingyue-ai2/logs
```

## 提交前自检
```bash
cd E:/Projects/qingyue-ai1 && bash ../legado-server/tools/check-worktree.sh
cd E:/Projects/qingyue-ai2 && bash ../legado-server/tools/check-worktree.sh
```
（脚本仅本地用，不接入 CI；有越界或配置不符约定时非零退出。注意：工作树在 `E:/Projects/qingyue-ai1`，到主仓 `E:/Projects/legado-server` 只需 `../legado-server/`，不是 `../../`。）

## 遗留项
- 主仓未提交改动已被自动 stash：`git -C E:/Projects/legado-server stash list` 可见 `stash@{0}`（含之前「继续优化」的 TXT 导出 WIP）。恢复：`git -C E:/Projects/legado-server stash pop`。
- `.env`（含端口 / DB / 日志）被 `.gitignore` 忽略，不会入库；如需团队共享隔离配置，请另外约定。
- `qingyue-ai2/web/vite.config.ts` 的代理目标已改为 `8081`（隔离必需），这是该工作树的预期改动，由 AI-2 随其提交带走。

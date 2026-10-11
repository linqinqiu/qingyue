# 双 AI 并行开发环境（qingyue）—— 唯一事实源

> **本文件是唯一事实源**：工作树、分支、端口、数据库、日志、目录归属、提交格式、协作规则、合流流程、启动方式，全以这里为准。
> 根 `AGENTS.md` §0 只放指针；`server/AGENTS.md` / `web/AGENTS.md` 只放各自**局部**约定，不重复本文件。
> **改动分配先写进这里再动手。**

## 目的

让 **WorkBuddy CLI（AI-1，后端 / 安全 / 基建）** 与 **Qoder（AI-2，前端 / 阅读体验 / 仓库门面）** 在同一台机器上**互不干扰**地并行开发。三棵 git worktree 共享同一份 git 历史，靠「分支 + 目录归属 + 独立运行端口/数据/日志」实现隔离。

## 工作树与分支

| 工作树路径 | 分支 | 工具 | 职责 | 局部约定 |
|---|---|---|---|---|
| `E:/Projects/qingyue-ai1` | `ai1/backend` | WorkBuddy CLI | 后端（Ktor）、规则引擎、安全、基建、`tools/`、构建、契约 | `server/AGENTS.md` |
| `E:/Projects/qingyue-ai2` | `ai2/frontend` | Qoder | 前端（`web/`，React）、阅读体验、仓库门面文档 | `web/AGENTS.md` |
| `E:/Projects/legado-server`（主仓） | `main` | — | 合流目标（远端 `github.com/linqinqiu/qingyue`） | 根 `AGENTS.md` |

> 本项目目录名是 `web/`（**不是** `frontend/`），构建文件是 Groovy（`server/build.gradle`，没有 `build.gradle.kts`）。

## 端口 / 数据库 / 日志

| 工作区 | 服务 | 端口 | 数据库 | 日志 |
|---|---|---|---|---|
| AI-1 | 后端（Ktor） | **8081** | `data/ai1.db`（隔离，避开默认 `legado.sqlite`） | `logs/ai1/server.log` |
| AI-2 | 前端 dev（vite） | **5174**（避开 vite 默认 5173，`strictPort`） | 无（纯前端） | `logs/ai2/`（占位） |
| AI-2 | 自测实例 | **1299** | `qingyue-ai2/data/legado.sqlite` | `qingyue-ai2/server.log` |
| 用户日常实例 | 主仓默认 | 1234 | 主仓 `data/`（227MB 真库，谁都不许把探针写进去） | — |

- **端口优先级**：`--port` > `port.txt` > `LEGADO_PORT`/`.env` > 1234。项目默认裸 jar / Docker 为 `8080`，启动脚本为 `1234`；本环境用 `8081`/`5174` 避开，避免与本机正常跑的那份青阅冲突。
- 改端口**必须同步改** `qingyue-ai2/web/vite.config.ts` 的代理目标（`/api` → `http://127.0.0.1:8081`），否则前端 dev 打不到后端。

## 目录归属（谁写什么）

- **AI-1 领地**：`server/`、`tools/`、`scripts/`、`.github/`、根 `AGENTS.md`/`CHANGELOG.md`/`LICENSE`/`CONTRIBUTING.md`/`SECURITY.md`/`.gitignore`/`build.gradle*`、`docs/API-CONTRACT.md`、`docs/dual-ai/COORDINATION-ai1.md`。
- **AI-2 领地**：`web/`、`README.md`、`docs/architecture.md`、`docs/deploy.md`、`docs/compatibility.md`、`docs/code-map-frontend.md`、`web/AGENTS.md`、`docs/dual-ai/COORDINATION-ai2.md`。
- **越界**：只有在用户点名时才可越界，且必须在自己的协作日志里记一条 `NOTE`。

## 提交信息格式

- AI-1：`ai1: <模块>: <动作>`（例：`ai1: rule-runner: 修复 SSRF 闸门`）
- AI-2：`ai2: <模块>: <动作>`（例：`ai2: reader: 修复章末翻页卡住`）
- 一次提交只做一件事；跨树改动不得借用对方前缀。

## 协作规则（读什么 / 写什么）

- **开工前**：`git fetch origin && git rebase origin/main` → 读根 `AGENTS.md` → 自己的 `server/AGENTS.md` 或 `web/AGENTS.md` → `docs/API-CONTRACT.md` → **对方的** `docs/dual-ai/COORDINATION-ai*.md`（重点 `API-CHANGE`/`API-REQUEST`/`BLOCKER`）→ 自己的日志。
- **每完成一个任务**：追加自己那份日志（`## [日期] [类型] [标题]`，类型 `TASK`/`API-CHANGE`/`API-REQUEST`/`NOTE`/`BLOCKER`）→ commit → push → 进下一个。
- **契约**：由 AI-1 单方面维护，AI-2 只读；要变更就在自己的日志发 `API-REQUEST`，**不改契约、不写 stub 假数据蒙混**。

## 每次重开的启动指令

AI-1 读 `docs/dual-ai/RESTART-ai1.md`，AI-2 读 `docs/dual-ai/RESTART-ai2.md`。两份文件里写「第一条命令做什么、先读哪些文件、当前进行中的任务与它的验证口径」。

## 合流流程

1. 每次改动前：`git fetch origin && git rebase origin/main`。
2. 本地测试通过后提交。**保持线性用 rebase，不要把 `main` 合并进自己分支**。
3. **谁先完成谁先合 `main`**；后合的先 `git fetch && rebase origin/main`。
4. **历史里含 merge 提交的分支用 merge 合，别硬 rebase** —— rebase 会把 merge 拍平，并在无关文件上炸出假冲突（2026-10-11 实测：`ai2/frontend` 的 `web/src/*` 假冲突就是这么来的）。
5. **不要删除或重写对方已提交的历史**。
6. 共享文件（`README.md`、`AGENTS.md`、`package.json`、`build.gradle*`）双方都要动时，先在对端日志发 `NOTE` 协商。

## 两条已实测的硬事实

1. **同源闸门决定写验证方式**：`Guard.kt` 的 `isSameOriginIdentity` 按 **Origin 的主机+端口 vs 服务自身绑定** 判身份，因此 dev server 5174 代理下的写请求一律 403 `cross_origin` —— 前端写验证走「`npm run build` + fatJar + 同源实例」，只用眼睛看渲染的（版面、纯读态）才可用 dev server。
2. **门禁必须串行**：`tools/verify/` 的门禁全部按 `STAMP` 自造/自清探针且**必须串行**；跑红先分清「判据旧了、探针脏了、机器被自己占满了，还是产品坏了」。

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

- `.env`（含端口 / DB / 日志）被 `.gitignore` 忽略，不会入库；如需团队共享隔离配置，请另外约定。
- `qingyue-ai2/web/vite.config.ts` 的代理目标已改为 `8081`（隔离必需），这是该工作树的预期改动。

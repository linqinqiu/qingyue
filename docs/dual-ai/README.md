# 双 AI 并行开发：环境 + 协作规程（唯一事实源）

> **本文件是唯一事实源**：工作树 / 分支 / 端口 / 数据库 / 日志 / 领地 / 协作规则 / 合流 / 发版 / 启动方式，全以这里为准。
> 根 `AGENTS.md` §0 只放指针；`server/AGENTS.md` / `web/AGENTS.md` 只放各自**局部**约定，不复述本文件。
> 两份日志（`COORDINATION-ai1.md` / `COORDINATION-ai2.md`）的**第一节是状态板**，正文只追加不改写。
> 判据：`web/test/CollabProtocol.test.ts`（钉本文件的结构与日志格式；红的时候改的是结构，不是判据）。

## 0. 环境

### 工作树与分支

| 工作树路径 | 分支 | 工具 | 职责 | 局部约定 |
|---|---|---|---|---|
| `qingyue-ai1`（AI-1 工作树） | `ai1/backend` | WorkBuddy CLI（AI-1） | 后端（Ktor）、规则引擎、安全、基建、`tools/`、构建、契约 | `server/AGENTS.md` |
| `qingyue-ai2`（AI-2 工作树） | `ai2/frontend` | Qoder（AI-2） | 前端（`web/`，React）、阅读体验、仓库门面文档 | `web/AGENTS.md` |
| 主仓（本仓库，与两棵工作树同级） | `main` | — | 合流目标（远端 `origin`） | 根 `AGENTS.md` |

> 本项目目录名是 `web/`（**不是** `frontend/`），构建文件是 Groovy（`server/build.gradle`，没有 `build.gradle.kts`）。

### 端口 / 数据库 / 日志

| 工作区 | 服务 | 端口 | 数据库 | 日志 |
|---|---|---|---|---|
| AI-1 | 后端（Ktor） | **8081** | `data/ai1.db`（隔离，避开默认 `legado.sqlite`） | `logs/ai1/server.log` |
| AI-2 | 前端 dev（vite） | **5174**（避开 vite 默认 5173，`strictPort`） | 无（纯前端） | `logs/ai2/`（占位） |
| AI-2 | 自测实例 | **1299** | `qingyue-ai2/data/legado.sqlite` | `qingyue-ai2/server.log` |
| 用户日常实例 | 主仓默认 | 1234 | 主仓 `data/`（227MB 真库，谁都不许把探针写进去） | — |

- **端口优先级**：`--port` > `port.txt` > `LEGADO_PORT`/`.env` > 1234。项目默认裸 jar / Docker 为 `8080`，启动脚本为 `1234`；本环境用 `8081`/`5174` 避开，避免与本机正常跑的那份青阅冲突。
- 改端口**必须同步改** `qingyue-ai2/web/vite.config.ts` 的代理目标（`/api` → `http://127.0.0.1:8081`），否则前端 dev 打不到后端。

### 提交信息格式

- AI-1：`ai1: <模块>: <动作>`（例：`ai1: rule-runner: 修复 SSRF 闸门`）
- AI-2：`ai2: <模块>: <动作>`（例：`ai2: reader: 修复章末翻页卡住`）
- 一次提交只做一件事；跨树改动不得借用对方前缀。

### 启动方式

```bash
# AI-1（WorkBuddy CLI，后端）
cd <AI-1 工作树根>
node start.mjs --no-open                 # 自动读 .env（端口 8081）
# 或直跑 jar（需先构建 fatJar，见下）
LEGADO_PORT=8081 LEGADO_DATABASE=./data/ai1.db LEGADO_LOG_FILE=./logs/ai1/server.log LEGADO_DATA_DIR=./data LEGADO_TMP_DIR=./tmp java -jar server/build/libs/legado-server-<版本>-all.jar

# 构建 fatJar（AI-1 首次 / 改后端后）
npm --prefix web run build      # 先把前端打进 dist
./gradlew :server:fatJar        # → server/build/libs/legado-server-<版本>-all.jar

# AI-2（Qoder，前端）
cd <AI-2 工作树根>/web
npx vite --port 5174            # /api 已代理到 http://localhost:8081（AI-1 后端）
```

### 合流流程

1. 每次改动前：`git fetch origin`，判能不能 rebase；**能则 rebase，不能则 merge**，都不许 force。
2. 本地测试通过后提交。**不要把 `main` 合并进自己分支**（历史里已含 merge 提交的分支除外，见第 4 条）。
3. **谁先完成谁先合 `main`**；后合的先同步 `origin/main`。
4. **历史里含 merge 提交的分支用 merge 合，别硬 rebase** —— rebase 会把 merge 拍平，并在无关文件上炸出假冲突（2026-10-11 实测：`ai2/frontend` 的 `web/src/*` 假冲突就是这么来的）。
5. **不要删除或重写对方已提交的历史**；不许 `--force`、不许 `reset --hard`。
6. 共享文件（`README.md`、`AGENTS.md`、`package.json`、`build.gradle*`）双方都要动时，先在对端日志发 `NOTE` 协商。

### 两条已实测的硬事实

1. **同源闸门决定写验证方式**：`Guard.kt` 的 `isSameOriginIdentity` 按 **Origin 的主机+端口 vs 服务自身绑定** 判身份，因此 dev server 5174 代理下的写请求一律 403 `cross_origin` —— 写验证走「`npm run build` + fatJar + 同源实例」，只用眼睛看渲染的（版面、纯读态）才可用 dev server。
2. **门禁必须串行**：`tools/verify/` 的门禁全部按 `STAMP` 自造/自清探针且**必须串行**；跑红先分清「判据旧了 / 探针脏了 / 机器被自己占满了 / 产品坏了」。

### 提交前自检

```bash
cd <AI-1 工作树根> && bash ../legado-server/tools/check-worktree.sh
cd <AI-2 工作树根> && bash ../legado-server/tools/check-worktree.sh
```

### 清理命令

```bash
git worktree remove ../qingyue-ai1
git worktree remove ../qingyue-ai2
# 残留数据 / 日志（如需）：rm -rf qingyue-ai1/data qingyue-ai1/logs qingyue-ai2/logs
```

### 遗留项

- `.env`（含端口 / DB / 日志）被 `.gitignore` 忽略，不会入库；如需团队共享隔离配置，请另外约定。
- `qingyue-ai2/web/vite.config.ts` 的代理目标已改为 `8081`（隔离必需），这是该工作树的预期改动。

## 1. 领地（改之前就看清）

| 面 | 归谁 | 对方要动怎么办 |
| :--- | :--- | :--- |
| `web/**`（前端源码、测试、`web/dist`）、`README.md`、`docs/architecture.md`、`docs/deploy.md`、`docs/compatibility.md`、`docs/code-map-frontend.md`、`web/AGENTS.md`、`docs/dual-ai/COORDINATION-ai2.md`、`docs/dual-ai/RESTART-ai2.md` | **AI-2** | AI-1 直接改不用打招呼的只有两处：修 AI-2 明显写错的事实、以及部署产物；改了要在自己日志写一行 |
| `server/**`、`tools/**`、`scripts/**`、`.github/**`、`Dockerfile*`、`compose*`、`computenest/**`、`CHANGELOG.md`、`server/build.gradle`（版本号）、`LICENSE`、根 `AGENTS.md`、`docs/API-CONTRACT.md`、`docs/dual-ai/COORDINATION-ai1.md`、`docs/dual-ai/RESTART-ai1.md`、`docs/ORIGINAL_REQUEST.md` | **AI-1** | AI-2 一律走 `API-REQUEST` / `COLLAB-REQUEST`，不自己改、不 stub 假数据蒙混 |
| `extensions/**`、`docs/sessions/**`、`docs/acceptance/**`、`docs/decisions/**`、`docs/proposals/**` | 谁写的谁维护 | 追加不改写别人的段落 |

**一条硬线：不在对方的工作树里做任何跨分支动作**（`rebase` / `merge` / `reset` / `checkout` / `stash`）。
自己的分支自己推；要合对方进 main，合**已经推到远端的那个分支**，别去动对方的工作目录 ——
工作树只有一份文件系统，你 rebase 的时候被换掉的是别人**正在编辑的那几个文件**（2026-10-11 真出过事）。

## 2. 情况 → 动作（这是这份文件的全部目的）

| 情况 | 动作 | 自检命令 |
| :--- | :--- | :--- |
| 我要开始改自己领地的东西 | **不用打招呼**，直接做；做完写日志 + 提交 + 推送 | `git status --short` 提交前只应出现自己领地的路径 |
| 我需要对方领地里的一个新接口 / 字段 / 脚本改动 | 在**自己**的 COORDINATION 文件发 `API-REQUEST`（接口）或 `COLLAB-REQUEST`（别的），写清用途与返回形状；**不等回复不动对方文件，也不 stub** | `grep -n "^## \[" docs/dual-ai/COORDINATION-ai2.md \| tail -3` |
| 对方 24 小时没回，而我被挡住了 | 把条目类型改成 `BLOCKER` 并在状态板「等谁」那一行标出来；用户是唯一仲裁 | 状态板 |
| 我要提交 | 先 `git fetch`，判一下能不能 rebase；**能则 rebase，不能则 merge**，都不许 force | `git merge-base --is-ancestor origin/ai2/frontend origin/main` |
| push 被拒（non-fast-forward） | 说明我 rebase 重写了远端已有的提交。**不许 `--force`、不许 `reset --hard`**；用 `git merge origin/<我的分支>` 把原提交接回来（冲突取内容更全的那侧），再快进推 | `git log --oneline -1 origin/ai2/frontend` |
| 我改了界面（`web/dist` 变了） | 推完之后在日志写「待发版」；**版本号 / `CHANGELOG.md` / 重打 jar 归 AI-1**，别自己升号 | `node tools/verify/version-check.mjs` |
| 我要验界面里的**写**动作 | 必须 `npm run build` → `:server:fatJar` → 自己那个隔离实例（AI-2 用 1299）跑真包。**换端口的静态壳不行**：同源闸门比 Origin 的 host **和 port**，写一律 403 | 网络日志里没有 403 |
| 门禁红着，我不确定是谁的锅 | 按第 5 节的四条顺序判：判据旧了 / 探针脏了 / 机器被自己占满了 / 产品坏了。**四条都实测过才许说"产品坏了"** | 见 `AGENTS.md` §3 |
| 门禁红在**对方**写的探针上 | 红因写进行里退回对方，不替对方改 `tools/**`（那是我读的文件） | 日志一行 |
| 我要读对方的契约（`API-CONTRACT.md`）发现与实际行为不符 | 不改契约；发 `API-REQUEST`，把「契约写的 / 实测的」两条并列贴出来 | 日志一行 |
| 我要删文件 / 覆盖已有配置 / force push | **停下来问用户**（这三件是只有人能点头的动作） | — |

## 3. 状态板（活的那一节，每轮开头更新）

两份日志（`COORDINATION-ai1.md` / `COORDINATION-ai2.md`）**第一节必须是状态板**，正文才是只追加的历史。
字段固定这些（少了就红）：`更新时间`、`我现在在做`、`下一件事`、`等对方`、`待发版`、`我的领地`、`我不碰`、`自测实例`。

- 问「现在轮到谁做什么」只看这一块表，不用读正文几百行。
- 正文**只追加不改写**；写错了就追加一条订正，别回去改历史（历史是证据）。
- 一条 `## [日期] 类型 标题` 的类型只能是：`TASK` / `API-REQUEST` / `API-CHANGE` / `COLLAB-REQUEST` / `NOTE` / `BLOCKER` / `RELEASE`。
- **一条一个主题，正文 ≤ 12 行**。机制叙述、逐条实测数字、长表格放文档（`docs/` 或 commit message），日志里给一行结论 + 指路。
  这一条治的是"日志写成日记，规则埋在正文里"（2026-10-11 就是这么失控的）。
- `BLOCKER` 必须在状态板「等对方」那一行出现，否则它会被读过去。

## 4. 发版队列（界面改动的最后一公里）

谁都不许悄悄改产物。规矩是**一条队列 + 一次交接**：

1. 改动方把功能提交并推送到自己分支，日志写 `待发版：是（一句改了什么）`。
2. AI-1 看到有货就：升 `server/build.gradle` 的 `version`（语义化：新能力 minor、纯修复 patch）→ 写 `CHANGELOG.md` 新段 →
   `npm --prefix web run build` **在前**、`./gradlew :server:fatJar` **在后**（顺序倒了会把旧 bundle 烤进 jar，
   `version-check` / `ui-shell` 三条会齐红）→ 重打 CDS（`node tools/make-cds.mjs`，或让 `start.mjs` 自动后台重建）。
3. 跑 `node tools/verify/version-check.mjs` 通过后，把状态板「待发版」改成 `否（已发 x.y.z）`，并把 main 上合并了谁什么都写一行。

用户的判断依据永远是**跑着的那个 jar**，不是源码 —— 源码推上去而产物没跟上，等于没交付。

## 5. 红因归属（四条都实测过才许下结论）

1. **判据旧了**：界面换了措辞、类名、路径而事实没变 → 改判据的口径（改成判**行为**，不判字面量）。
2. **探针脏了**：上一轮崩在中途留下残留数据 / 残留 chrome 进程 / 抢同一个 profile 或端口 → 先清残留、改串行，再重跑。
3. **机器被自己占满了**：带墙上毫秒的判据**一律单跑**；并行跑必然互扰。
4. **产品坏了**：前三条排掉才算。红的时候写清"我用什么把前三条排掉的"。

## 6. 违规与事故

- 发现在对方工作树里动过 git（工作树被回滚、未提交的活被暂存走）：**先别继续写文件**。按 `git reflog` + `git stash list`
  把现场与 blob 抓进自己 `tmp/` 留底，只写回工作树（**不动对方的索引**），核对内容后重跑判据，然后在**自己**日志发 `BLOCKER`，
  把规矩补进本文件第 1 节 —— 事故要变成规则，不要变成互相指责。
- 注 / 反扫 / 注入式判据（把产品改坏看判据红不红）**必须在同一条命令里还原并 grep 回读**。留一份被改坏的源码在盘上，
  下一个动 git 的人会把它当成真实现场暂存或提交走。
- 本文件也可以被任何一方改，但改动要落在自己日志里一行 `COLLAB-REQUEST`，写明"改了哪一节、为什么"；
  对方不认可就在自己日志一行 `NOTE` 反对 —— 反对不成则照新规矩办，不许两边各写一份规则。

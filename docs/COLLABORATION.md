# 双 AI 协作规程（唯一规则来源）

> 这一份是**规则的唯一出处**。别的文件（`AGENTS.md` §0、`dual-ai-setup.md`、`ORIGINAL_REQUEST.md`、
> 两份 `RESTART-*.md`）只许**引用**它，不许复述 —— 复述就是下一次错乱的来源。
> 它要回答的只有一件事：**遇到具体情况，谁该做什么，用什么命令自检。**
>
> 判据：`web/test/CollabProtocol.test.ts`（钉本文件的小节齐全、AI-2 状态板字段齐全、日志条目格式合规）。
> 改了这份文件的结构而判据没跟着改，套件会红。

## 1. 领地（改之前就看清）

| 面 | 归谁 | 对方要动怎么办 |
| :--- | :--- | :--- |
| `web/**`（前端源码、测试、`web/dist`）、`README.md`、`docs/architecture.md`、`docs/deploy.md`、`docs/compatibility.md`、`docs/code-map-frontend.md`、`web/AGENTS.md`、`docs/COLLABORATION.md`、`docs/COORDINATION-ai2.md`、`docs/RESTART-ai2.md` | **AI-2** | AI-1 直接改不用打招呼的只有两处：修 AI-2 明显写错的事实、以及部署产物；改了要在自己日志写一行 |
| `server/**`、`tools/**`、`scripts/**`、`.github/**`、`Dockerfile*`、`compose*`、`computenest/**`、`CHANGELOG.md`、`server/build.gradle`（版本号）、`LICENSE`、根 `AGENTS.md`、`docs/API-CONTRACT.md`、`docs/COORDINATION-ai1.md`、`docs/dual-ai-setup.md`、`docs/RESTART-ai1.md`、`docs/ORIGINAL_REQUEST.md` | **AI-1** | AI-2 一律走 `API-REQUEST` / `COLLAB-REQUEST`，不自己改、不 stub 假数据蒙混 |
| `extensions/**`、`docs/sessions/**`、`docs/acceptance/**`、`docs/decisions/**`、`docs/proposals/**` | 谁写的谁维护 | 追加不改写别人的段落 |

**一条硬线：不在对方的工作树里做任何跨分支动作**（`rebase` / `merge` / `reset` / `checkout` / `stash`）。
自己的分支自己推；要合对方进 main，合**已经推到远端的那个分支**，别去动对方的工作目录 ——
工作树只有一份文件系统，你 rebase 的时候被换掉的是别人**正在编辑的那几个文件**（2026-10-11 真出过事）。

## 2. 情况 → 动作（这是这份文件的全部目的）

| 情况 | 动作 | 自检命令 |
| :--- | :--- | :--- |
| 我要开始改自己领地的东西 | **不用打招呼**，直接做；做完写日志 + 提交 + 推送 | `git status --short` 提交前只应出现自己领地的路径 |
| 我需要对方领地里的一个新接口 / 字段 / 脚本改动 | 在**自己**的 COORDINATION 文件发 `API-REQUEST`（接口）或 `COLLAB-REQUEST`（别的），写清用途与返回形状；**不等回复不动对方文件，也不 stub** | `grep -n "^## \[" docs/COORDINATION-ai2.md \| tail -3` |
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

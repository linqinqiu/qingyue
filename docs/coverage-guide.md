# 覆盖率怎么看、怎么补

> 一条命令出总报告：`npm run coverage`

## 1. 一条命令

```bash
npm run coverage              # 跑前后端测试 + 生成总报告
npm run coverage:report-only  # 不跑测试，只用现有数据重出报告
```

产物（`coverage-report/`，已 gitignore）：

| 文件 | 用途 |
|---|---|
| `index.html` | 总报告，浏览器打开 |
| `summary.md` | 一句话摘要，可直接贴 PR |
| `summary.json` | 机器可读（CI 用） |

## 2. 当前数据（2026-10-21）

**整体行覆盖 68.9%**（14762 / 21418 行）

| | 行 | 分支 | 函数 |
|---|---:|---:|---:|
| 后端（JaCoCo） | 64.9% | 39.4% | — |
| 前端（c8） | 73.06% | 81.08% | 67.17% |

### 后端最该补的包

| 包 | 行覆盖 | 为什么低 |
|---|---:|---|
| `subscription` | 30.2% | 订阅更新是网络任务，测试里只覆盖了纯逻辑 |
| `io.legado.server`（根） | 33.3% | `Application.kt` / `DesktopLauncher.kt` 启动装配难单测 |
| `http` | 43.5% | 路由层大量 handler 只在 E2E 里跑，单测没覆盖 |
| `tts` | 49.2% | Edge-TTS 要真实 WebSocket 连接 |
| `source` | 53.4% | `WebViewProxy` / `ExternalBrowserLogin` 要真浏览器 |

### 后端最该补的 15 个类

```
  0%    DesktopLauncherKt              （桌面启动器，E2E 才跑得到）
  0%    ai.AgentCatalog                （28 行，纯读 JSON，最容易补）
  7%    source.ExternalBrowserLogin    （114 行，要真浏览器）
  7.7%  ai.OpenAiCompatibleProvider    （65 行，外呼 HTTP，可 mock）
 25.3%  source.SourceDebugger
 27.1%  subscription.SubscriptionService
 31.4%  ops.UpdateCheck
 31.5%  source.WebViewProxy           （197 行，最大的未覆盖块）
 31.7%  tts.EdgeTtsService
```

### 前端最该补的目录

| 目录 | 行覆盖 | 说明 |
|---|---:|---|
| `src/settings` | 32% | `settingsSections.ts` 的 `33-134` 行整段没覆盖 |
| `src/components` | 42.5% | 大组件（`SourceSwitchModal` 17.8%） |
| `src/sources` | 64.9% | `SourceSwitchModal` 拖累 |
| `src/pages` | 66.6% | 页面级组件 |
| `src/lib` | 84% | 工具函数，覆盖较好 |
| `src/reader` | 86.8% | 阅读器内核，覆盖最好 |

## 3. 建议的补充顺序

按「**补了收益最大 / 成本最低**」排，不是按百分比排：

### 第一优先：纯逻辑、易测、没覆盖

| 目标 | 行数 | 为什么先做 |
|---|---:|---|
| `ai.AgentCatalog` | 28 | 纯读 JSON + 校验，一个单测就能到 90%+ |
| `settingsSections.ts` 的 33-134 行 | ~100 | 纯函数（`buildSettingsSections` / `filterSettingsSections`），已有部分测试，补全成本低 |
| `ops.UpdateCheck` | 70 | 外呼可 mock，逻辑分支多 |

### 第二优先：要 mock 但值得

| 目标 | 行数 | 怎么做 |
|---|---:|---|
| `ai.OpenAiCompatibleProvider` | 65 | mock `HttpClient`，覆盖 2xx / 非 2xx / 超时 / 解析失败四条 |
| `subscription.SubscriptionService` | 59 | mock 抓取，覆盖成功 / 失败 / 内容未变三种 |
| `backup.BackupStore` | 47 | 纯文件读写，用临时目录 |

### 第三优先：成本高，先记着

| 目标 | 行数 | 难点 |
|---|---:|---|
| `source.WebViewProxy` | 197 | 要真浏览器 / 反代会话 |
| `source.ExternalBrowserLogin` | 114 | 要拉起本机 Chrome |
| `tts.EdgeTtsService` | 240 | 要真实 Edge-TTS WebSocket |
| `DesktopLauncherKt` | 177 | 桌面启动路径，E2E 覆盖 |

这几块**不要硬写单测**——它们的价值靠 `tools/verify/` 的真浏览器门禁覆盖
（`external-login-check`、`reader-flow-check` 等）。单测硬 mock 只会测到 mock 本身。

## 4. 为什么不设覆盖率门禁

**故意的。** 三个理由：

1. **一上来就卡数字只会逼人写凑数测试** —— 测 getter、测常量、测"能 new 出来"，
   覆盖率上去了，缺陷检出率没变。
2. **本项目的主要保障不是覆盖率，是判据测试**：649 条前端判据 + 472 条后端测试 +
   78 个真浏览器门禁。它们验的是**行为与不变量**（端点契约、依赖方向、界面文案、
   开书链路），不是"这行被执行过"。
3. **高覆盖率的地方不代表没问题**。`rules` 83% 覆盖，但书源方言的坑是靠
   `RuleRunnerTest` 一条条钉出来的，不是靠覆盖率发现的。

所以：**先看清楚哪里没覆盖，再决定要不要卡、卡在哪**。等第一/第二优先补完，
行覆盖到 ~75% 时再考虑对**新增代码**设门禁（`c8 --check-coverage` 只对 diff 生效），
比全仓卡阈值有用得多。

## 5. CI 里怎么跑

`.github/workflows/coverage.yml`：

- push to main / PR / 手动触发；
- 后端 `:server:testCoverageReport`（**ignoreFailures**，已知失败基线不挡报告）；
- 前端 `npm run test:coverage`；
- 合并成总报告，摘要贴进 Job Summary，HTML 作为 artifact 上传（保留 30 天）。

**不阻塞合并**：没有任何 `--check-coverage` 或阈值判断。

## 6. 两个技术细节（踩过的坑）

### 6.1 后端为什么单独一个 `testCoverageReport` 任务

`jacocoTestReport` 依赖 `test`，而本机 `test` 有一条**已知的、环境相关的**失败
（`E2EScenariosTest` scenario 2，在 `tools/verify/baselines/server-test-failures-47.txt` 里）。
那条一红，`test` 任务失败，**覆盖率报告整个生成不出来** ——
而覆盖率恰恰是最该在有失败时看的。

所以复制了一份 test 任务，唯一区别是 `ignoreFailures = true`：
测试照跑、执行数据照记，任务不中断，报告能正常出。

```bash
./gradlew :server:testCoverageReport
# 产物：server/build/reports/jacoco/testCoverage/html/index.html
```

### 6.2 为什么过滤掉 JaCoCo 里的 lambda 类

JaCoCo 会把 Kotlin 的匿名类列成独立类，名字长这样：

```
io.legado.server.tts.EdgeTtsService.synthesize.listener.new WebSocket.Listener() {...}
```

它们没有独立名字、也没法单独写测试。实测前 15 名里 11 个是这种 ——
列在"最该补"里只会把真正该补的类挤下去。所以汇总脚本过滤掉含 `.new ` 的类。

### 6.3 Windows 上跑子进程

`gradlew.bat` 与 `npm.cmd` **必须**经 shell 才能启动（直接 spawn 报 EINVAL / ENOENT），
但 `shell: true` + 参数数组会触发 Node 的 DEP0190。所以脚本按平台分两条路：
Windows 用 `execSync` 跑拼好的整串命令，其他平台用 `execFileSync`。
命令都是脚本里写死的，没有注入面。

# 贡献指南

先说清楚这个项目要什么、不要什么：它是一个**自托管的书源阅读服务**，只做规则执行与界面，
**不内置任何书源或内容**。参考交互可以，代码必须自己写 —— 尤其是
[hectorqin/reader](https://github.com/hectorqin/reader)（AGPL-3.0）的代码**不得引入本仓库**，
理由见 [README 的「与参照项目的关系」](README.md#与参照项目的关系)。

## 环境要求

| | 版本 | 说明 |
| --- | --- | --- |
| JDK | **17+** | `server/build.gradle` 的 toolchain 锁 17；CI 用 Temurin 21 也能编 |
| Node | **20+**（CI 用 22，见 `.nvmrc`） | 只构建 / 跑前端时需要 |
| Gradle | 用仓库自带的 `./gradlew` | 不用另装 |

桌面版与整合包 jar 自带精简运行时，**不要求装 Java**。

## 本地开发

```bash
npm --prefix web install     # 前端依赖

npm run dev                  # 只起前端 dev server（热重载，不含后端）
npm test                     # 全部用例：前端 node:test + 后端 JUnit
npm run check                # 前端类型检查（tsc）
npm run build                # 前端 → web/dist，再 :server:fatJar（把 web/dist 烤进 jar）

node start.mjs               # 起服务并自动开浏览器（默认 127.0.0.1:1234）
node stop.mjs                # 停掉本项目在端口上的那个 java 进程
```

`npm run dev` 只是前端 dev server，**不含后端**。要连着真后端调，就先 `npm run build` 出 jar，
再 `node start.mjs`。改完后端后必须重新 `npm run build`，否则跑的还是旧 jar。

## 提交前

- `npm run check` 与 `npm test` 都要过。
- 改动了框架层（`plugin/` 容器、端点计数、AI 接入注册表）还要先跑后端守门：
  `./gradlew :server:verifyFramework`（钉死"框架不夹带内容 + 139/19/8 端点契约"）。
  PR 合并前由 CI 的 `contract.yml` 自动跑这道，但本地先红比等 CI 红更省事。
- 改了服务端就打一次 `npm run build`，确认 fatJar 能出。
- 版本号只有一个来源（`server/build.gradle` 的 `version`）。**发版前**升一档，并在
  `CHANGELOG.md` 顶部补一条（日期写发版那天，不是动手那天）；一天里无论改了几次只占一个版本号。
  `tools/verify/version-check.mjs` 会判五处是否同号（gradle / jar 清单 / `/healthz` / 顶栏 / CHANGELOG）。
- 改行为的，补 / 改用例。这个仓库的判据口径是"能离线跑、能红能绿"，不是"页面上看着有字" ——
  具体怎么写见 [`AGENTS.md`](AGENTS.md)；前端判据的写法看 `web/test/` 下现成的用例
  （框架纪律那几条的判据清单见 [`docs/plugin-framework.md`](docs/plugin-framework.md) §6「验证」）。

## 分支与 PR

- 从 `main` 切一个描述性的分支（如 `fix/toc-rule-fallback`），**别直接推 `main`**。
- 一个 PR 只做一件事；不要顺手改无关文件（重构请单独开一个 PR）。
- 行为变了就写清别人怎么复现 / 复跑；界面改动附截图或录屏。
- 模板见 [`.github/pull_request_template.md`](.github/pull_request_template.md)。

## 提交信息

沿用 `<type>(<scope>): <中文说明>`，例如：

```
fix(reader): 平移分页跨章时页码落点差半栏
feat(about): 「检查更新」默认查本项目仓库并区分滚动构建
```

类型用 `fix` / `feat` / `refactor` / `docs` / `chore` / `test` 之一。

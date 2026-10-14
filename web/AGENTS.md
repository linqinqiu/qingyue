# web/AGENTS.md —— AI-2（前端 / 阅读体验 / 仓库门面）局部约定

> 这份文件只由 **AI-2** 维护，只写「在 `web/` 里干活必须知道的事」。
> 角色 / 目录边界 / 端口 / DB / 日志 / 提交格式 / 协作规则 / 合流流程 —— 见唯一事实源 [`docs/dual-ai/README.md`](../docs/dual-ai/README.md)（根 `AGENTS.md` §0 有指针），本文件不重复。
> 我的重开指令见 [`docs/dual-ai/RESTART-ai2.md`](../docs/dual-ai/RESTART-ai2.md)。

## 前端验证怎么跑（含一个已实测的坑）

```sh
npm --prefix web run check          # tsc -b，必须干净
npx tsx web/test/run-all.ts         # 全量用例，2026-10-14 基线 537/537
```

浏览器级判据在 `tools/verify/`（AI-1 的领地，AI-2 只跑不改），必须**串行**跑，
并指向同源实例：`LEGADO_BASE_URL=http://127.0.0.1:1299 node tools/verify/<gate>.mjs`。

> **2026-10-14 更正环境**：`docs/dual-ai/README.md` 里那三棵树（`qingyue-ai1` / `qingyue-ai2` / 主仓）在本机已经合成一棵 —— `git worktree list` 只剩 `E:/Projects/legado-server [main]`，AI-2 直接在 `main` 上以 `ai2:` 前缀提交。所以上面那条 1299 现在的意思是**在主仓起一个隔离实例**（`LEGADO_HOME` 指到一个临时目录，别用主仓 `data/` 那份真库），不再是"ai2 工作树里的实例"。端口那套（8081 / 5174）随两棵树一起失去落点，要用就在主仓自选空闲端口。

**实测过的坑（2026-10-11）**：`vite` dev server 代理到别的端口这条路，**所有写请求都会 403**。
`Guard.kt` 的 `isSameOriginIdentity` 把 Origin 的主机**和端口**都与服务自身绑定身份比：
`Origin: http://127.0.0.1:5174` → 403 `cross_origin`，同源 → 200。
所以涉及写（保存进度、加删书架、导入、缓存）的验证一律走
`npm --prefix web run build` → `./gradlew :server:fatJar --offline` → 起那个同源实例。
只用眼睛看渲染的（版面、纯读态）才可以用 dev server。

## 前端潜规则（改 `web/` 前先看这几条，都是从红过门禁的坑里来的）

1. **组件被 `web/test/*.test.ts` 用 `renderToStaticMarkup` 渲染的，必须 `import React`** —— Vite 构建走 automatic runtime，只有测试走 classic JSX。少这行时页面和构建都正常，只有套件红（`TapZoneEditor.tsx` 就这么漏过，基线上一直红着四条）。
2. **新加 `web/test/*.test.ts` 必须在 `web/test/run-all.ts` 里 import 一行** —— runner 不扫目录，没注册等于没跑。
3. **翻页模式的页码是"相对当前窗口"的**：换锚点（跳章）必须重算落点，同一个锚点内重量才允许原地不动。算术在 `web/src/reader/readerFlow.ts`（`resolveMeasuredPage`），别在组件里写第四份判法。
4. **滚轮增量必须先按 `deltaMode` 归一化成像素再累计**（`readerInteractions.wheelPixels` / `paginateWheelStep`）—— 直接拿 `event.deltaY` 和固定阈值比，行模式与触控板都翻不动。
5. **主题变量必须挂在 `<html>` 上**：portal 到 `document.body` 的浮层（`Select` / 菜单 / 抽屉）在只有 `.app-shell.theme-*` 时一个变量都取不到。
6. **"还没到 / 取失败了 / 确实没有"是三件事**，空态只能由第三件触发（要 `loaded` 标志，`finally` 里置位）。
7. **列表项的点击若走 `dragSort`（卡片带 `onPointerDown`）**，探针里 `node.click()` 不派发 pointerdown，要点空白；真测量用 `page.mouse.click(x,y)`。
8. 按钮一律显式 `type="button"`；界面文案不许出现 emoji/装饰字形，也不写"解释界面自己"的句子。
9. **注释与文档里的行号是"指针"，不是事实**：跨文件引用只写符号名 / 类名，不写 `xxx.ts:1917` 这种裸行号 —— 文件一加长它就指向别处，而且没有任何东西会红（本轮在 `TocDrawerHeader.tsx` 与 `ReaderScreen.tsx` 各逮到一条，判据是 `ReadThroughFixes.test.ts`「源码注释里不许写跨文件的裸行号」）。文档 `docs/code-map-frontend.md` 里的行号由 `CodeMapFresh.test.ts` 逐条核"那一行确实写着这个符号"，改了源码就重跑它，别手抄。
10. **"只有一个出处"这句话必须被扫出来**：`fontSizeControl.ts` 表头写着唯一口径，而 `readerSettings.ts` 与 `lib/backupPreferences.ts` 各又抄了一遍 `15, 28`，套件全绿三周。判据在 `FontSizeControl.test.ts`——写这类"收成一份"的注释时，同一条里就要带一条扫描。
11. **同一棵树上挂两个同类浮层，Esc / 外点这类全局监听必须按"开着的那一个"过滤**：`ReaderSheet` 两张同时挂着时，`useEscapeClose(onClose)` 让一次按键触发两次关闭。这类"此刻看不出症状的重叠"要按判据钉前提（`<ReaderSheet ` 恰好两处），别只钉结果。

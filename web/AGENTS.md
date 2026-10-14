# web/AGENTS.md —— AI-2（前端 / 阅读体验 / 仓库门面）局部约定

> 这份文件只由 **AI-2** 维护，只写「在 `web/` 里干活必须知道的事」。
> 角色 / 目录边界 / 端口 / DB / 日志 / 提交格式 / 协作规则 / 合流流程 —— 见唯一事实源 [`docs/dual-ai/README.md`](../docs/dual-ai/README.md)（根 `AGENTS.md` §0 有指针），本文件不重复。
> 我的重开指令见 [`docs/dual-ai/RESTART-ai2.md`](../docs/dual-ai/RESTART-ai2.md)。

## 前端验证怎么跑（含一个已实测的坑）

```sh
npm --prefix web run check          # tsc -b，只覆盖 web/src（tsconfig 的 include 就写这一个目录）
npm --prefix web run check:test     # 把 web/test 也一起核（要 allowImportingTsExtensions，测试里 import 带 .ts 是 tsx 的用法）
npx tsx web/test/run-all.ts         # 全量用例，2026-10-14 基线 535/535
```

**为什么单开 `check:test`**：`check` 从来不看 `web/test/**`，所以判据文件里的类型漂移没有任何东西管。
第一次拿去核，量出 **16 处真漂移**（2026-10-14）：判据在断一个产品里已经不存在的字段与参数 ——
`putOfflineChapter` 被喂了第 6 个参数（产品签名只有 5 个，多那个静默丢掉）、离线进度队列的夹具用了
`chapterTitle` / `readProgress` 两个界面上没有的键、`setFilters` 喂 `minChapters` 并断言它原样回来
（store 是整对象存的，所以"过"了，测的是自己塞进去的野字段）、`SearchGroup` 从 `searchStore` 导入而它
其实导出在 `searchFilters`。还有一条 CI 上的取舍：**没把 `check:test` 并进 `check`**，因为
`build-jar.yml` 跑的就是 `npm --prefix web run check`，把测试树并进那条 CI 意味着 npm 依赖一动就可能红在
探针上而不是产品上 —— 要并的话先在 AI-1 日志里说一声。

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
2. **新加 `web/test/**.test.ts` 不用改任何清单** —— `run-all.ts` 现在**扫目录**（规则在 `web/test/discover.ts`：递归、按路径排序、`import` 说明符统一成 `/`）。先前它是手抄的 65 行 import，这条链上出过三次"文件在、名字像测试、跑起来一片绿，其实一条都没执行"。扫描规则本身由 `CustomizeSkin.test.ts`「run-all.ts 的扫描规则覆盖 web/test 下每一份 *.test.ts」钉住：拿一个独立的朴素递归走查当参照物比对，并用临时目录做反向对照（子目录那份必须被看见、非 `.test.ts` 不许收）；`run-all.ts` 自己还有个"少于 60 份就退出"的闸门，防止过滤器写错表现成"全绿但什么都没跑"。
3. **翻页模式的页码是"相对当前窗口"的**：换锚点（跳章）必须重算落点，同一个锚点内重量才允许原地不动。算术在 `web/src/reader/readerFlow.ts`（`resolveMeasuredPage`），别在组件里写第四份判法。
4. **滚轮增量必须先按 `deltaMode` 归一化成像素再累计**（`readerInteractions.wheelPixels` / `paginateWheelStep`）—— 直接拿 `event.deltaY` 和固定阈值比，行模式与触控板都翻不动。
5. **主题变量必须挂在 `<html>` 上**：portal 到 `document.body` 的浮层（`Select` / 菜单 / 抽屉）在只有 `.app-shell.theme-*` 时一个变量都取不到。
6. **"还没到 / 取失败了 / 确实没有"是三件事**，空态只能由第三件触发（要 `loaded` 标志，`finally` 里置位）。
7. **列表项的点击若走 `dragSort`（卡片带 `onPointerDown`）**，探针里 `node.click()` 不派发 pointerdown，要点空白；真测量用 `page.mouse.click(x,y)`。
8. 按钮一律显式 `type="button"`；界面文案不许出现 emoji/装饰字形，也不写"解释界面自己"的句子。
9. **注释与文档里的行号是"指针"，不是事实**：跨文件引用只写符号名 / 类名，不写 `xxx.ts:1917` 这种裸行号 —— 文件一加长它就指向别处，而且没有任何东西会红（本轮在 `TocDrawerHeader.tsx` 与 `ReaderScreen.tsx` 各逮到一条，判据是 `ReadThroughFixes.test.ts`「源码注释里不许写跨文件的裸行号」）。文档 `docs/code-map-frontend.md` 里的行号由 `CodeMapFresh.test.ts` 逐条核"那一行确实写着这个符号"，改了源码就重跑它，别手抄。
10. **"只有一个出处"这句话必须被扫出来**：`fontSizeControl.ts` 表头写着唯一口径，而 `readerSettings.ts` 与 `lib/backupPreferences.ts` 各又抄了一遍 `15, 28`，套件全绿三周。判据在 `FontSizeControl.test.ts`——写这类"收成一份"的注释时，同一条里就要带一条扫描。
11. **同一棵树上挂两个同类浮层，Esc / 外点这类全局监听必须按"开着的那一个"过滤**：`ReaderSheet` 两张同时挂着时，`useEscapeClose(onClose)` 让一次按键触发两次关闭。这类"此刻看不出症状的重叠"要按判据钉前提（`<ReaderSheet ` 恰好两处），别只钉结果。
12. **判据不许测自己**：`HeaderMenu.test.ts` 里原本挂着两条 —— 一条"自己定义一个回调、自己调用、再断言刚赋的值"，一条自己写了个 `confirmLogout` 再断言它调了 `onLogout`，两条都不碰 `AppHeader`，也因此**都不可能失败**；后者测的还是已经删掉的鉴权。已删（537 → 535）。写任何一条判据之前先问一句：**产品改了它会红吗**。

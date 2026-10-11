# web/AGENTS.md —— AI-2（前端 / 阅读体验 / 仓库门面）局部约定

> 这份文件只由 **AI-2** 维护，只写「在 `web/` 里干活必须知道的事」。
> 角色 / 目录边界 / 端口 / DB / 日志 / 提交格式 / 协作规则 / 合流流程 —— 见唯一事实源 [`docs/dual-ai/README.md`](../docs/dual-ai/README.md)（根 `AGENTS.md` §0 有指针），本文件不重复。
> 我的重开指令见 [`docs/dual-ai/RESTART-ai2.md`](../docs/dual-ai/RESTART-ai2.md)。

## 前端验证怎么跑（含一个已实测的坑）

```sh
npm --prefix web run check          # tsc -b，必须干净
npx tsx web/test/run-all.ts         # 全量用例，2026-10-11 基线 414/414
```

浏览器级判据在 `tools/verify/`（AI-1 的领地，AI-2 只跑不改），必须**串行**跑，
并指向同源实例：`LEGADO_BASE_URL=http://127.0.0.1:1299 node tools/verify/<gate>.mjs`。

**实测过的坑（2026-10-11）**：`vite` dev server（5174）+ 代理到 8081 这条路，**所有写请求都会 403**。
`Guard.kt` 的 `isSameOriginIdentity` 把 Origin 的主机**和端口**都与服务自身绑定身份比：
`Origin: http://127.0.0.1:5174` → 403 `cross_origin`，同源 → 200。
所以涉及写（保存进度、加删书架、导入、缓存）的验证一律走
`npm --prefix web run build` → `./gradlew :server:fatJar --offline` → 起 1299 同源实例。
只用眼睛看渲染的（版面、纯读态）才可以用 dev server。

## 前端潜规则（改 `web/` 前先看这几条，都是从红过门禁的坑里来的）

1. **组件被 `web/test/*.test.ts` 用 `renderToStaticMarkup` 渲染的，必须 `import React`** —— Vite 构建走 automatic runtime，只有测试走 classic JSX。少这行时页面和构建都正常，只有套件红（`TapZoneEditor.tsx` 就这么漏过，基线上一直红着四条）。
2. **新加 `web/test/*.test.ts` 必须在 `web/test/run-all.ts` 里 import 一行** —— runner 不扫目录，没注册等于没跑。
3. **翻页模式的页码是"相对当前窗口"的**：换锚点（跳章）必须重算落点，同一个锚点内重量才允许原地不动。算术在 `web/src/readerFlow.ts`（`resolveMeasuredPage`），别在组件里写第四份判法。
4. **滚轮增量必须先按 `deltaMode` 归一化成像素再累计**（`readerInteractions.wheelPixels` / `paginateWheelStep`）—— 直接拿 `event.deltaY` 和固定阈值比，行模式与触控板都翻不动。
5. **主题变量必须挂在 `<html>` 上**：portal 到 `document.body` 的浮层（`Select` / 菜单 / 抽屉）在只有 `.app-shell.theme-*` 时一个变量都取不到。
6. **"还没到 / 取失败了 / 确实没有"是三件事**，空态只能由第三件触发（要 `loaded` 标志，`finally` 里置位）。
7. **列表项的点击若走 `dragSort`（卡片带 `onPointerDown`）**，探针里 `node.click()` 不派发 pointerdown，要点空白；真测量用 `page.mouse.click(x,y)`。
8. 按钮一律显式 `type="button"`；界面文案不许出现 emoji/装饰字形，也不写"解释界面自己"的句子。

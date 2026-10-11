# Repository Guidelines & Constitutional Conventions

## 0. 双 AI 分工

> 本仓库由两个 AI 并行开发：**AI-1**（后端 / 安全 / 基建，WorkBuddy CLI）与 **AI-2**（前端 / 阅读体验 / 门面文档，Qoder）。
>
> **唯一事实源**：[`docs/dual-ai/README.md`](docs/dual-ai/README.md) —— 工作树 / 分支 / 端口 / DB / 日志 / 目录归属 / 提交格式 / 协作规则 / 合流流程 / 启动方式，全部以它为准。本节只放指针，不重复。
> 每次重开：AI-1 读 [`docs/dual-ai/RESTART-ai1.md`](docs/dual-ai/RESTART-ai1.md)，AI-2 读 [`docs/dual-ai/RESTART-ai2.md`](docs/dual-ai/RESTART-ai2.md)。
> 局部约定：AI-1 见 [`server/AGENTS.md`](server/AGENTS.md)，AI-2 见 [`web/AGENTS.md`](web/AGENTS.md)。

本项目目录名是 `web/`（不是 `frontend/`），构建文件是 Groovy（`server/build.gradle`，没有 `build.gradle.kts`）。

## 1. Project Core Mission & Objective

> **核心项目定位**：将 **Legado（开源阅读 Android 平台应用）** 完整迁移与重构为可在标准服务器与 Docker 容器中独立运行的高性能**无头后端（Ktor + Kotlin JVM + SQLite）**与现代化**Web 客户端（React 19 + TypeScript + Vite）**。

### 关键迁移与设计原则
1. **彻底解耦 Android 平台依赖**：严禁在 `server/` 或 `web/` 模块中引入 Android Framework 原生组件（如 Activity、Context、Room、Android WebView、Android UI 等），必须使用跨平台的纯 JVM 技术栈与标准 Web API 替代。
2. **服务端无头（Headless）化架构**：服务端作为独立的中心服务，承载书源规则解析与执行沙箱（Rhino JS + Jsoup + JsonPath）、多书源并发搜索、离线书籍与封面缓存、订阅同步、
3. **深度兼容书源生态**：完全复用并兼容 Legado 现有丰富的书源协议与规则定义，确保现有网络书源可在服务端正确、安全且高效地解析。
4. **现代化 Web 阅读体验**：Web 端作为跨平台终端，提供大章节目录虚拟化、单书源直连秒开、离线缓存进度同步及沉浸式阅读器交互。

---

## 2. 仓库边界与文档驱动规范 (Repository Boundary & Cleanliness)

本项目严格执行**文档驱动开发（Doc-Driven Development）**与工程整洁度控制：

- **严禁随地大小便**：严禁在项目根目录或业务源码目录中散落 `PLAN.md`, `NOTES.md`, `TODO.md`, `temp/`, `plan/` 等临时或未受管文档。
- **文档统一收敛机制**：
  - 需求与功能提案 (PRD) 归入 [`docs/proposals/`](docs/proposals/)
  - 架构决策记录 (ADR) 归入 [`docs/decisions/`](docs/decisions/)
  - 原始推演、历史排错与工作记忆归入 [`docs/sessions/`](docs/sessions/)
  - 用户实操验收手册与验证清单归入 [`docs/acceptance/`](docs/acceptance/)
- **工程复杂度惩罚**：严禁为了单一补丁随意增加无意义的抽象层、胶水层或重复工具类。优先采用满足当前需求的最简、最直接解法。

---

## 3. 最短验证命令集 (Shortest Verification Commands)

AI 在修改代码后，必须优先执行本节定义的最短、最精准命令自测：

```sh
# --- 1. 前端类型检查与自动化测试套件 ---
npm --prefix web run check
npx tsx web/test/run-all.ts

# --- 2. 服务端本地 JVM 单元测试 ---
./gradlew :server:test

# --- 3. 前后端综合一键验证 ---
npm --prefix web run check && npx tsx web/test/run-all.ts && ./gradlew :server:test

# --- 4. 本地 Docker 容器构建与热更新验证 (用户常用测试基准) ---
docker build -f Dockerfile.server -t test-legado-server:latest .
docker stop test-legado 2>/dev/null || true
docker rm -f test-legado 2>/dev/null || true
docker run -d --name test-legado -p 8080:8080 \
- **[部署/HTTP] 服务不设身份，绑定地址就是唯一的门**：默认只绑 `127.0.0.1`；把 `LEGADO_HOST` 改成 `0.0.0.0` 等于把整个库交给局域网，写操作只剩同源闸门挡着，跨站页面进不来但同网段设备能直接读写。
  -v $(pwd)/.data:/data test-legado-server:latest
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/index.html
```

> **门禁跑红先问"是判据旧了、探针脏了、机器被自己占满了，还是产品坏了"**，四条都实测过：
> ① **门禁之间会互相删探针**（都往同一个 1234 实例与同一个 SQLite 按 `STAMP` 前缀导入/清扫），并行跑必然互扰 → 判据串行复跑；
> ② **崩溃在收尾之前的那一次会留下探针**，下一次跑就被"库里不许有残留"判红（本轮 `source-login-check` 的 34/35
>    就是我自己的两次中断留下的 6 条 `probe-*.example`，清掉之后 35/35）→ 探针清理要能兜住历史残留，跑红先看残留是谁的戳；
> ③ **界面门禁的红有两类，都不是产品**：
>    (a) **全新 Chrome profile 的第一次网络导航在这台机器上要 30~50 秒**（`about:blank` 38ms、同一 profile 第二次 46ms），
>        于是 `Navigation timeout of 30000 ms exceeded` 与"页面是空的"轮番假红。解法已落地：
>        `tools/verify/env.mjs` 的 `gateProfile()` 复用 profile，但每次 launch 前删掉
>        `Service Worker / Cache / Code Cache / Local Storage / Session Storage / blob_storage`
>        —— **要清的是 SW 与缓存，不是整个 profile**；带 `.lock` 防互抢；`--disable-service-worker` 反而更慢，别用。
>    (b) **超时被打断的 puppeteer 会留下 chrome.exe**（一次 launch 4~10 个进程），8GB 的机器攒十几个就把
>        后面的门禁全拖成 `Execution context was destroyed`。数进程时**只数带门禁临时 profile 的那些**
>        （`CommandLine -like '*legado-*profile*'`），用户自己的 Chrome 命令行里是 `...\User Data`，别碰。
>    本轮 `rss-check` 在 25~29 条之间飘，我先归因成"SW 换执行上下文"（错），又归因成"残留进程"（只有一半对），
>    真凶是 (a)。**结论：症状是超时/上下文销毁/首屏空时，先看 harness 与机器再猜产品；
>    门禁里靠固定 `sleep()` 读界面必然偶发假红，要等条件**（`waitForFunction(有行 || 明确空态)`）。
> ④ 判据措辞会过期：`source-editor-check` 里"备份密码折叠"那条只认「填备份密码」这个字符串，
>    界面把话换成「需要解开包里的登录凭据？」之后它红了，而用户在意的事实没变 → 改成三段**行为**判据
>    （默认无密码框 + 有提到凭据的开关 + 点开确实出现密码框）。
> ⑤ **探针在界面上找"自己那一行"必须用本轮 STAMP，不能用常量前缀**（2026-10-01 `subscription-check` 的
>    「订阅可以停用」假红）：上一轮崩在中途没跑收尾，库里留下一条 `probe-sub-list-<旧戳>` 且已被点成「已停用」，
>    这一轮 `find(node => text.includes('probe-sub-list'))` 先捞到的是**别人的行**，于是读出 `已停用 → 已启用`
>    这种自相矛盾的详情。两处一起修：runner 启动时先清扫所有 `probe-*` 残留再取基线，界面查找改用
>    `window.__SUB_TOKEN`（含本轮 STAMP）。同类的还有 `opensource-hygiene-check` —— 它扫"WebDAV 残留"时
>    会扫到**断言"没有 WebDAV"的那份测试文本**，那要进 exempt，不是把测试删掉。
> ⑥ 反过来也要敢认产品红：同一轮里「结论里说清了原因」那条红是真的 —— 服务端把 JDK 的
>    `Connection reset` 原样写进 `lastError`，前端 `describeSyncError` 没有这一档签名，界面上糊的是英文。
>    已补「连不上：连接被对方中途断开」一档（含 Windows 那句"远程主机强迫关闭了一个现有的连接"），
>    判据在 `web/test/SubscriptionGuidance.test.ts`。

> **Windows 本机执行注意（详见 [`docs/sessions/SESSION-HIST-008`](docs/sessions/SESSION-HIST-008-windows-environment-and-verification-baseline.md)）**：
> - 编译与测试走**当前 `JAVA_HOME`**（本机实测是 `E:\Apps\DevTools\Eclipse Adoptium\jdk-17.0.19.10-hotspot`；早期归档里写的 Corretto 21 已经不是现状）。JDK 17+ 就够，`gradlew` 加 `--offline` 走本地缓存最稳；
> - `./gradlew :server:test` 在本机**长期固定 47 个失败**（2026-10-01 实测；测试删不掉被占用的 SQLite，macOS 不暴露）。**判定回归必须与基线的「失败集合」逐条比对，禁止只看失败数量** —— 本轮就是靠"基线 47、跑出 53"这 6 条增量抓到一个让整条本地书导入死掉的正则笔误（基线在库内 `tools/verify/baselines/server-test-failures-47.txt`，**不是** gitignore 的 `out/` —— 参照物一旦不进版本库，"逐条比对"就不可验证）；
> - 前端依赖缺失时先 `npm --prefix web install --ignore-scripts`（esbuild 的 postinstall 会被拦截），再跑 `check` / `tsx test/run-all.ts`；

---

## 4. 完成度状态阶梯 (Completion States)

AI 与人类协作时必须明确当前达到的完成度阶梯，严禁混淆概念：
1. `[Modified 本地改动]`：代码已编写完成，但尚未执行测试。
2. `[Tested 单测/检查通过]`：已通过本地最短单测（`gradlew :server:test`）与静态类型检查（`npm run check` / `tsx run-all.ts`）。
3. `[Deployed 容器/服务联调完成]`：已部署/更新至本地 Docker 容器并启动，且日志与接口无报错。
4. `[Accepted 用户签字确认]`：用户已根据验收手册实操验证并明确回复“验收通过/LGTM”。
5. `[Pushed 提交与推送]`：代码已提交至 Git 并推送到远端仓库。

---

## 5. 部落知识库与历史踩坑 (Tribal Knowledge)

基于历史会话全量扫描提炼的架构潜规则与避坑指南：

- **[书源解析/兼容] `bookSourceUrl` 允许任意非空唯一字符串**：Legado 书源生态中部分聚合或定制书源（如 `大灰狼融合VIP5.0`）使用自定义中文或标识作为 `bookSourceUrl`，服务端严禁粗暴强制要求 `http(s)://`；同时前端与服务端导入均需兼容 UTF-8 BOM 编码及 `{ data: [...] }` / `{ sources: [...] }` / `{ bookSources: [...] }` 等外层包装结构。
- **[SQL/Kotlin] 严禁使用可空列做存在性 Elvis 判断**：在 JDBC / SQLite 结果集提取中，务必区分“字段值为 NULL”与“数据行不存在”。例如 `SELECT cover_key FROM book_shelf`，若书籍无封面则字段为 `NULL`，直接 `rs.getString(...) ?: return null` 会误判书籍不存在。
- **[前端/Form] 按钮显式声明 `type="button"`**：表单内的所有辅助操作按钮（如停止搜索、清空、排序切换）必须显式标注 `type="button"`，否则点击会触发 HTML 表单默认 `submit` 事件导致搜索意外重启。
- **[翻页/排版] 跨章逆向翻页定位守卫**：从章节开头回翻到上一章时，必须携带 `targetPosition = 'bottom'` 标记，且必须在 DOM/分栏异步排版完成后再执行末尾定位，严禁在未完成排版前盲目计算滚动高度。
- **[性能] 缓存优先直出与流式防抖**：进入阅读器时优先命中本地 `BookCacheService` 离线缓存分片，避免等待全量远程 TOC；流式搜索推送高频数据时前端需保持批量节流合并渲染。
- **[凭据/序列化] 万能 Cookie 解析与强类型 DTO**：服务端 CookieJar 存库前必须通过 `parseCookieString` 统一归一化为 `k1=v1; k2=v2` 格式，杜绝存入原始 JSON 数组脏数据；Ktor 路由响应严禁使用非多态的 `Map<String, Any>`，必须使用 `@Serializable data class`。
- **[TTS/朗读] Edge-TTS 协议与 Chrome 假死守卫**：Edge-TTS WebSocket 通信中 SSML 必须严格做 XML 特殊字符转义（`&`, `<`, `>`, `"`, `'`），并且 WebSocket 通信块必须加 `try-catch(abort)` 彻底规避超时句柄悬挂；浏览器端 `SpeechSynthesis` 在无心跳朗读超过 15 秒时会被 Chrome 自动静默冻结，前端必须保持定时短暂停与恢复的看门狗循环。
- **[TTS/朗读] Edge-TTS WebSocket 握手版本必须与 Chromium 同步更新**：Edge-TTS 连接头中 `Sec-MS-GEC-Version`（如 `1-143.0.3650.75`）与 `User-Agent` 中的 Chrome 版本号必须保持一致；同时须携带随机 `Cookie: muid=<16字节大写hex>` 头，否则 WebSocket 握手被微软服务端拒绝导致合成静默失败（返回 0 字节音频）。版本信息参考 `edge-tts` Python 包的 `constants.py`。
- **[TTS/朗读] 孤立标点切片导致 ERR_REQUEST_RANGE_NOT_SATISFIABLE 的三层防御**：TTS 分句正则可能将中文对话引号 `"` 切为孤立碎片，发送空/纯标点文本至 Edge-TTS 会返回 0 字节音频，前端 `URL.createObjectURL(0字节blob)` 后浏览器发出 Range 请求，得到 HTTP 416 崩溃。**必须在三处同时加守卫**：① `splitSentences` 过滤去标点后有效字符 `< 2` 的碎片；② `HttpAudioTtsEngine.speak/prefetch` 调用 `isEffectiveText()` 判断，无效时 `setTimeout(onEnd,0)` 跳过；③ 服务端 `EdgeTtsService.synthesize` 检测去标点后有效字符 `< 2` 直接返回 `ByteArray(0)` 不请求上游。
- **[TTS/朗读] 跨章连播状态与正文加载竞态守卫**：切章（`changeChapter`）时必须同步将 `loadedChapterUrl` 置空并清除旧 `content`，连播 `useEffect` 必须严格校验 `loadedChapterUrl === chapter?.url` 且使用 `playTtsChunkRef.current` 调用最新闭包，杜绝切章瞬间误读上一章旧正文；正文段落点击选播严格守卫 `if (!ttsActive) return`，防止普通阅读点选误触发朗读。
- **[TTS/朗读] 单句相对时钟锚定（Anchor Resync）、600ms 尾部静音看门狗与 5 分片前瞻**：原绝对时钟累加（`audioCursorMs`）在播放约 2 分钟（40~50 分片）后，由于 MP3 Priming/Padding 样本与声卡重采样微小物理偏差累积超过 180ms 触发静音死锁；章节末尾 Edge-TTS 音频常包含 300~500ms 尾部静音帧，播放器在最后一两句易在距时长 300~400ms 处停止推进。解决方案：① 服务端 `chunk_end` 显式下发单分片 `durationMs`；② 前端切句时动态锚定 `anchorMs = audio.currentTime * 1000`，单句相对判定 `nowMs >= anchorMs + durationMs - 60`，跨句累积漂移彻底归零；③ 配备停滞看门狗（Stall Watchdog），放宽窗口至 `nowMs >= anchorMs + durationMs - 600`，停滞 > 350ms 强制推进 `onEnd`，杜绝章末短分片尾部静音卡死；④ `ReaderScreen` 前瞻缓冲扩大至 5 分片（`lookahead <= 5`），并在距离章末 5 句内提前预载下一章正文，避免断流卡顿；⑤ 监听 `<audio>` 的 `stalled` 事件与 `waiting` 状态，并在非暂停停滞 > 500ms 时自动调用 `.play()` 唤醒底层解码管道。
- **[TTS/朗读] HTML5 audio.play() 暂停打断与 AbortError 守卫**：浏览器原生规范中，当调用 `audio.pause()`、重置 `src` 或切章重置时，正在 pending 的 `audio.play()` Promise 会被浏览器自动 reject 抛出 DOMException (`AbortError: The play() request was interrupted by a call to pause(). https://goo.gl/LdLk22`)。这属于用户主动暂停或切流，必须在 `HttpAudioTtsEngine`（play catch、reportError、isPaused 状态跟踪）与 `ReaderScreen`（onError 回调）中多层静默拦截 `AbortError` 与 interrupted 关键词，严禁向用户弹窗报错。
- **[TTS/朗读] 开启朗读时视口首个完整可见段落智能对齐**：当用户在阅读中途点击开启 TTS 朗读时，阅读器会基于当前排版视图模式（滚动模式避开顶部 56px 导航栏、翻页模式限定分栏视口内）精准计算视口内第一个完整可见的段落（或章节标题 `<h1>`），并以此为朗读起始分片，避免每次开启都跳回章首或历史断点的突兀体验。
- **[TTS/朗读] 长音频流首帧 144 字节静音垫底与 X-Accel-Buffering: no 反代防缓冲**：连续音频流与 SSE 进度通道必须显式声明 `X-Accel-Buffering: no` 与 `Cache-Control: no-cache, no-transform` 穿透 Nginx 缓冲；服务端在客户端建立音频流连接瞬间先下发 144 字节合规 LAME MP3 静音帧（Silence Preamble），使浏览器 `<audio>` 秒入就绪态并即刻激活系统控制中心（MediaSession）。
- **[TTS/流式广播] 多连接探针与会话生命周期解耦**：浏览器 HTML5 `<audio>` 建立流式连接时常先发起探针（Probe）请求探测 MIME/Range，紧接着发起正式播放流。服务端朗读音频广播流严禁使用单消费者 `Channel` 或单连接原子互斥锁（否则第二次连接抛 `IllegalStateException("音频流已连接")` 触发 HTTP 500）；必须采用 `MutableSharedFlow(replay = 16)` 广播管道，且单连接断开（CancellationException）严禁误触发 `close("audio_disconnected")` 销毁全局会话，确保探针与主播放流平滑流转。
- **[反向代理/沙箱] Iframe 隔离严禁开启 `allow-same-origin`**：反向代理第三方不可信 Web 页面时，iframe 必须禁用 `allow-same-origin`，将其置于 opaque origin（`null`）下，杜绝被代理页面的恶意 JS 触碰宿主 DOM 与会话。
- **[沙箱/安全] `JavaImporter` 必须采用安全空替身模式**：Legado 书源中大量 `jsLib` 工具库使用 `with (JavaImporter(...))` 组织代码。沙箱严禁开启真实 Java 反射（防止 RCE 漏洞），必须返回 `importClass`/`importPackage` 均为 no-op 的安全空替身，既规避 `ReferenceError` 崩溃，又确保纯沙箱环境安全。
- **[Cookie 管理] Set-Cookie 存库前必须剥离指令属性**：上游响应中的 `Path=/; HttpOnly; SameSite=Lax; Max-Age=3600` 等指令属性若直接整串入库，会导致后续作为客户端请求头 `Cookie:` 发送时将属性一并带出引发上游 400 报错。
- **[HTTP 规范/Ktor] 巨型 Data URL 必须转由服务端托管避免请求行超限**：书源 JS 生成的自包含 Base64 网页动辄数万字符，直接拼入 iframe URL 会触发 Ktor 8192 字符上限报 400，必须先通过 POST 上传服务端内存托管，前端仅引用短 key。
- **[CI/构建] Gradle Wrapper 必须保持官方 distributions 下载源**：`gradle-wrapper.properties` 中的 `distributionUrl` 若配置为国内镜像（如腾讯云 `mirrors.cloud.tencent.com`），在 GitHub Actions 等海外 Runner 环境中会出现网络超时（Connection timed out）导致 CI崩溃，必须始终保持官方 `https://services.gradle.org/distributions/` 地址。
- **[替换规则/沙箱] Rhino JS 沙箱顶级 return 包装与反爬反义词对调字典**：Legado 生态中的 `@js:` 替换规则普遍使用 `return map[result] || result` 组织代码。Rhino 沙箱在顶层执行 `return` 时会抛 `return not in function` 语法错误，沙箱必须检测并在必要时将代码包装进 `(function(){ ... })()` 匿名闭包执行；同时替换净化必须在 `RuleRunner.content()` 与 `BookCacheService` 离线下载落库前执行，避免脏文本污染持久化缓存，同时使后续 TTS 朗读自动获得清洗后的正文。
- **[交互/导航] 核心系统能力一级导航呈现与阅读器抽屉收敛**：全局核心管理能力（书源、订阅、替换净化规则）必须在一级导航栏设立独立入口；而在沉浸式阅读器中，顶栏严格保持极简（目录、换源、设置、朗读），辅助净化规则统一收敛进「阅读设置」抽屉，杜绝顶栏拥挤。
- **[交互/连续滚动] 跨章"顶窗口"的两条几何纪律**：① 摘掉顶部那几节的**同一帧**必须校正滚动位置，且校正量要用"新锚点量出来的实际屏幕偏移"算，不能按被摘掉那几节的 `offsetHeight` 之和算 —— 节与节之间的分隔线带 `padding-top`，一节变成首节时这条内边距就没了，按高度算每跨一章往上蹿一次（实测 42px，肉眼可见但不报错）。所以每一节的 `padding-top` 与上边框必须**一致**（首节的那条边框是透明的）。② 摘除的判据必须是"这一节的底边已经越过视口顶部再多留一点"，不是"到视口顶部的 35%"：后者意味着还有 280px 的字在屏幕上就被摘掉，用户正在读的那几行凭空消失，而且新锚点再也摆不回原位（文档上方没东西了，滚动位置被夹到 0），两头都跳。
- **[测试/浏览器] 拦请求 ≠ 拿不到：探针必须先清掉站内的离线副本**。`api.content` 失败会回落到 IndexedDB 的离线正文库（`legado_offline_db` / `chapters`，按 `['loc_book', bookUrl]` 建了 `by_book` 索引），于是 `request.abort()` 全部被缓存兜住：界面看起来"正常"，判据却在空转。同类盲区：`page.evaluate` 里按引用记住一个 DOM 节点跨不过 React 的重建，逐帧量画面位移要用**该节点的文本前缀**每帧重新找。
- **[本地书/目录规则] 「自动选规则」会把文件开头那一章吞成前言**：随包上游规则里有一条 `\n` 起头的「目录(去空白)」，第一行的标题前面没有换行 → 永远命不中，五章的书切出四章加一个整章大的「前言」。上游打分只比命中条数、"多不出两条就不换规则"，几百章的书没事，小书正好踩中。修法是在 `suggest` 里排除"开头那一行本身就是一条标题却被漏掉"的规则（用内置那条标题正则判定，不用间隔比例猜），**但用户手动指定的规则照旧生效** —— 那是选择，不是猜测。
- **[快捷键/判据] 按键表与处理器必须同源，且"输入区"判定要按真实 DOM 试**：`web/src/shortcuts.ts` 一份表同时喂"按了做什么"和界面上那张「快捷键」，两边各写一份必然漂（界面写着 `T`、代码里那个 case 早删了 —— 没有运行时报错）。两条实测教训：① 把整个 `button` 当"正在输入"，于是**点过一次目录条目之后焦点留在按钮上，所有字母快捷键失灵**，只让 `空格/回车` 归按钮才对；② `Ctrl+F` 只找 `placeholder` 含"搜索"的输入框，而这个应用的措辞是「输入书名或作者」「筛选书源」，**那条快捷键从来没生效过**。判据用真鼠标 + 真键盘（程序化 `.click()` 不把焦点放上去，反向对照会变空判）。
- **[UI/图层] "封面染了一块绿"要先量元素，别读源码猜色值**：同一句抱怨（2026-10-02「封面下面或左下角有一片绿，有点有，有点没有」）我改了两次才对 —— 第一次认定是占位封面的 `--accent-soft` 斜渐变，改完截图里绿块还在。真凶是网格卡底部那条阅读进度：轨道 18% 墨色铺满封面下沿、填充挂着 `min-width: 5px`，于是刚开读的卡左下角顶出一枚绿方块，读到章末的是一条通长绿带，`completed` 的书整条不画 —— **数据差异被图层画成了脏点**。规矩：判 UI 图层问题用 `getComputedStyle` + `getBoundingClientRect` 当场量（`shelf-layout-check.mjs` 那三条就是这么写的：色值从 `:root` 现读、不写死绿的 RGB；任何 >0 却 <8px 的填充直接判红 —— 阈值后来从 2% 提到 8%（`GRID_READ_TRACK_MIN_PERCENT`），因为 2% 在 150px 的卡上正好就是三像素的绿点，按 2% 判等于放它过去），而不是改完 CSS 就宣布好了。
- **[书签/跨书源] 同一本书的"身份"只能是书名 + 作者，章节坐标只能是标题**：`sourceId + bookUrl` 在换源时两个都变，用它当书签的键就等于"换源即丢书签"（用户 2026-10-02 明确要"支持在同书不同书源中使用"）。但章节号也不能当坐标 —— 同一本书两个源的第 37 章往往不是同一章，所以每条书签要**同时存 `chapterIndex` 与 `chapterTitle`**，跳转先按标题精确匹配、再按包含关系松匹配、两边都对不上就直说对不上（宁可跳不了，也不能跳到错的地方）。归一化只有一条规则：trim + 压内部空白 + 忽略大小写，前后端各写一份迟早漂（`Database.bookKeyOf` 与 `bookmarks.ts:bookMarkKey`，前端那份有用例对着服务端形状判）。同类坑：整章书签天生没有原文（`paragraphFrom = -1`），"原文和批注都空就拒收"那条校验必须放过它 —— 实测时就是被这条挡住，点了「收藏整章」静默 400 少存一条。
- **[长任务/生命周期] 几十分钟的任务不能活在弹窗组件里**：书源体检原来的形状是"组件里一个 for 循环 + `cancelledRef`，卸载时置位"，于是关窗、切页、开另一个对话框任何一下都把整轮扫描静默作废，用户看到的现象是"每次都得重头跑"。修法是把运行状态搬进模块级 store（`sourceHealthRun.ts`），组件退化成订阅者，**只留一个显式中止的入口**（「停止体检」），并把"收起"这个动作的可访问名字改成说清它不停止。判据也跟着换：生命周期没法喂数据演，就钉源码结构（卸载回调里不许出现取消、`cancelledRef.current =` 不许还有赋值），能演的那半（哪些源该在过程中被分组、什么情况下不重复写）抽成纯函数照常测。
- **[CSS/别名覆盖] 旧别名声明在后面会静默顶掉现代属性，只有浏览器知道**：`.reader-paginated-column-body h1` 写了 `break-before: column; page-break-before: always;` —— 后者是 `break-before: page` 的旧别名，`page` 对分栏流无效，于是章根本不换栏，三章连成一片流，section 矩形互相重叠，按"两节左边缘之差 / 步长"算的每章页数全错（footer 报 7/7 而窗口实际 15 页宽，多出来的被 `overflow: hidden` 裁在视口外）。**同一句"横板还是跳转"我改了三次，前两次都在改 JS（顶窗口、页码补偿、ResizeObserver 依赖），根因是一行 CSS。** 两条纪律：① 用户重复报同一个症状时，先量现象（计算样式 / 矩形 / 逐帧节点身份 / footer 报的页数 vs `scrollWidth/视口`），别接着改上次那个方向；② 判据要读**计算值**，`grep` 源码里的 `break-before: column` 会给你一片绿而浏览器跑的是 `page`。配套反向对照：把属性改回 `page` 必须变红，否则这条就是空判。
- **[门禁夹具] 造数据要先确认它不会被被测系统自己改写**：翻页门禁第一版合成书的段落写成「第1章第14段。」，内置分章规则照着行首 `第N章` 把它切成 **137 章**、每章一栏 —— 于是"跨章连续性""窗口章数 ≥2"全在演空戏还看起来像通过了（窗口确实 3 章，因为一章就一栏）。判据通过时的必查项：夹具的**结构量**（章数、每章页数、总页数）是不是真按设计成立，门禁里把它显式断出来（`这一路真的跨了章（至少 2 次），否则后面的连续性判据是空判`）。
- **[一个旗标兼两职] "能不能用" 与 "要不要参与自动" 混成一个 `enable`，功能就等于没做**（用户 2026-10-03：「txt目录规则没有做好」+「元素功能过多，分配不当」）。随包 26 条分章规则默认启用 12 条，而 `/api/books/toc-rules` 的 options 直接发 `candidates`（启用 ∩ 可编译）—— 于是另外 12 条（「数字(纯数字标题)」「大写数字(纯数字标题)」「目录(古典、轻小说备用)」这类，恰好是纯数字标题/章回体要用的那几条）**在界面上根本不存在**，而解析层 `byId` 走的是全表、一直支持它们。界面上也没有任何启用开关，所以连"绕过去"的路都没有。修法是把两件事拆开：**手动可选只看用不用得了（`selectable`/`compiles`），`enable` 只决定自动打分的候选池（`candidates` 不变）**，另加 `POST /api/books/toc-rules/toggle` 与一张规则清单（名字 + 正则原文 + 示例 + 开关）。教训形态：一个布尔字段被两个语义复用 = 分配错误，症状不是"报错"而是"选项凭空少一半"。同族坑还有：随包表里 id `-100` 是"内置逐行匹配"，它 `rule` 为空是设计如此，用 `compile()==null` 判它就把一条内置项标成「正则编译不出来」——**"没有正则"和"正则坏了"也不能共用一个旗标**。
- **[界面/分配] 设置要长在它服务的那个动作旁边，不是一个词能装下就放一起**（用户 2026-10-03：「元素功能过多，分配不当」，追问后点名两处：「『自定义』弹窗成了杂物间」「顶栏『我的』菜单堆太多」）。分章规则原来住在「自定义」里和皮肤同屏 —— 归类依据是"这都算设置"这种词面上的相似，而用户的检索时机是**准备导一本书**，那时他在书架上，不在「自定义」里。现在的分法：① 「下一本用哪条 + 哪几条参与自动」= 书架「导入本地」旁边一颗「分章规则」，弹窗里还直接给「按这条导入本地书」把动作接上；② 「这一本用的哪条 + 重切」= 阅读设置抽屉，**只作用手上这本**（`repick` 暂选，绝不写 `settings.txtTocRule`）；③ 「自定义」只剩皮肤。第二条同族的错：**抽屉里那颗选择器当初写的就是全局默认**，于是"想改这一本"顺手改了下一本 —— 与上一条「一个旗标兼两职」是同一个形状的病（一个控件兼两个职务），只是这次兼的是"这本"与"下一本"。菜单瘦身的判法不是"条数少了几颗"，而是**每条都要问：它服务的动作在哪儿发生，入口就该在那儿**；「更新日志」本来就有顶栏版本芯片这条路，菜单里那条就是纯重复，删；「快捷键」的表在阅读器里按 `?` 最顺手，全局菜单里那条收进「关于」。钉法见 `web/test/TocRuleSettings.test.ts` + `AboutPage.test.ts` + `ui-shell-check.mjs` ⑤（判"「自定义」里真的看不见"，不只判代码里删了）。
- **[判据/口径] 「没发过请求」的源不能叫「连不上」：档位口径要与事实同源**（用户 2026-10-03：「书源的体检当前出了问题」）。实测：库里 5,574 个源有 652 个顶层 `searchUrl` 是空（`ruleSearch.url` 全库皆空 —— Legado 的搜索地址就在顶层，别以为有回退），以前让 `runner.search()` 抛「未配置 searchUrl」，`classify()` 落到 else → `broken`「规则失效」→ 计入 `stats.dead`「连不上」→ 被「一键停用 / 一键删除」圈走。12% 的库被一句从没发生的事判死。修法：**能在发请求之前判掉的，就别去发请求**（`SourceHealth.probe` 在读到 searchUrl 为空时直接定档，一次网络都不发），新增 `explore_only` / `no_search` 两态 → 前端单独一档「未配搜索」，不进 `BAD`、不自动打标签。同族的口径错误还有 `failedCount = !ok`：它把"没配搜索"和"真连不上"加成一个数，完成提示因此永远夸大灾情 —— 客户端改按 `tierCounts` 自己数。教训形态：**每个"失败"计数都要能追溯到一次真实的事实；没有发生过的事不能进失败桶**。
- **[界面/分配] 「设置」页只做路由，不做第二套实现**（用户 2026-10-03 拍板「设置页收纳，原处只留快捷入口」）。`SettingsPage` 没有 `useState`、不读 localStorage、不碰 `api`：每行是"它管什么 + 就近入口在哪儿 + 一个跳到原处动作的按钮"。收纳之后「我的」菜单从 7 条回到 4 条，但四条功能一条没少（`ui-shell-check` ② 逐条点一遍：设置页开得出运行日志弹窗才算"换了分类"而不是"删了功能"）。跨页开弹窗用**信号计数**（`tocRulesSignal` +1，ShelfPage 里 `useEffect` 收到才开），不在两处各存一份弹窗状态；`0` 表示"还没人点过"，所以刷新页面不会凭空弹窗。
- **[界面/分配] 一级目的地待在一级导航，而且只列一次**（用户 2026-10-04：「优化一下主导航栏，不行把设置里面，折叠里面的拿出了，本来是主页的样式，主页的框架」，追问定调「旧界面 `/` 的顶栏」+「移出设置，留在导航」）。上一轮把「运行日志」「更新日志」收进「设置」之后，暴露的是反向的错：**目的地页被当成偏好项折叠**（规则 / 备份 / 设置 三个一级页面都只能从「设置」页里点进去）。现在的分法：顶栏 8 项 书库/书架/书源/发现/订阅/规则/备份/设置，「我的」只留 书签 / 关于 / 全屏 / 自定义 + 三档皮肤。钉法是**一张表三处用** —— `shortcuts.ts` 的 `PRIMARY_PAGES` 同时喂顶栏、数字键 `1`–`8`、`Alt+←/→` 循环序（改之前这三处三份清单，其中两份把 发现/书源 排成相反顺序，加一页要改三处且必然漏一处）；`ui-shell-check` ① 判"整串相等"而不是数条数（只数条目的话，拿「书签」换「设置」也能凑够数）；② 判菜单里不许再出现 设置/规则/备份 —— **同一个目的地留两条路，迟早一条改了另一条忘改**。`web/test/Shortcuts.test.ts` 判"键表与顶栏同源"，`SettingsPage.test.ts` 判"收放之后功能一条没少"。版面：顶栏高度固定，所以 `frame-metrics --frozen` 量到书库那一页**零漂移**（窄屏横向滚动，不折行、不压窄按钮）。
- **[发版/记录] 部署前先升版本号并开一个新的更新日志段**：这一项被用户抓到过（2026-10-02：「更新日志你也没有记录更新啊，版本号你也没自主增加」）。规矩是：`server/build.gradle` 的 `version` 是唯一来源，**一轮改动要部署（`fatJar`）之前**就按语义化版本升一档（新能力 minor、纯修复 patch），并把这一轮的条目写成对应的 `## [x.y.z] - YYYY-MM-DD` 段 —— 段里的日期是**发版那天**，不是功能立项那天，跨天的活儿整段归到部署日。**一天里无论部署几次只占一个版本号**（用户 2026-10-11：「版本号太碎」——一天里 0.6.41→0.6.46 一路小步递增像流水账；`CHANGELOG.md` 已按天并成一条条）。理由很实际：用户评价的是"跑着的那个 jar"，界面里看到的又是随包 `meta/changelog.md`，源码改了而产物号没动，用户读到的仍是上一版。`tools/verify/version-check.mjs` 会判"gradle / 清单 / `/healthz` / 顶栏 / 日志顶部"五处同号，`web/test/Changelog.test.ts` 判"日志顶部 == 当前版本"。**★ CDS 归档**（`server/build/cds/app.jsa`，`tools/make-cds.mjs` 生成）跟这一份 jar 绑定 —— 重建 jar 后就过期。**过期不用手动管**：`start.mjs` 会照常启动（这次没享受到那几秒），并在**后台**用另一个空闲端口重建归档（`--cds-dump` 那次跳过订阅/缓存等写活儿，免得和正在跑的服务抢库），下次启动就快。冷启动实测 ~8.3s → ~5.3s；要手动重建就 `node tools/make-cds.mjs`。
- **[备份/兼容] "只装了个性化条目的包"也是合法备份**：备份识别原来只认书源/替换规则/书架三类，手机上只勾「TXT 分章规则」「搜索历史」导出的包会被整包拒收（400），而这类包恰恰是用户想同步偏好的那条路。现在包里有任一 `KEEP_NAMES` 条目即视为合法备份，错误文案同时列出"找过哪些、实际有什么"。
- **[Kotlin/序列化] `ArrayList(n)` 造出来是空表**：`applyBackup` 第一版写 `val merged = ArrayList<TxtTocRule>(current.size + incoming.size)`，于是"匹配到的那条"根本没位置可改 —— 计数照样报 `flipped=1`，文件里却只有新收的那一条，**启用改动静默丢失**。要副本就 `ArrayList(current)`。同类教训还有一条：`call.respond(mapOf(...))` 在 Ktor 这边直接 500（`Map<String, Any>` 没有序列化器），响应体一律用 `@Serializable data class`。
- **[分页/测量] 内容变宽而视口没变时，ResizeObserver 一次都不会回调**：分页模式的总页量自 `body.scrollWidth`，测量挂在一个"只观察 viewport"的 ResizeObserver 上。续接窗口挂上第二、第三章之后，窗口宽了、视口没变 → 不回调 → `pageCount` 停在"只有锚点那一章"的页数上，多出来的那些列被 `overflow:hidden` 裁掉：内容在 DOM 里但用户**永远翻不进去**（界面上看不出任何异常，也没有报错）。规则：测量结果依赖什么，effect 的依赖里就要有什么（`flowTail`），别指望观察器替你想到。同类：同一件事的两套坐标不能混用 —— 量页区间用 `getBoundingClientRect()` 之差（会被 track 的 translate 一起抵消），朗读跳页原来用 `offsetLeft`，混用就偏一整页。
- **[测试/门禁夹具] 判据动手前先确认"这本书这一章还有没有下一章"**：`reader-transition-check` 挑的是书架上第一本"已缓存全本"的书，而它上次跑到这里时被读到了**最后一章** —— 页脚「下一章」按设计是禁用的，于是"点它该换章"红在夹具上而不是产品上。现在进门先把进度写到中间那一章（结尾仍原样写回），并把点击的返回值写进判据详情，免得下次又只能看到"标题没变"三个字。
- **[PWA/离线缓存] 渐进式离线缓存与脱机阅读架构**：① Service Worker 缓存静态资源与应用壳，排除 `/api/tts/stream` 等实时长音频流；② 正文离线支持按「后50章/后100章/全本/自定义」4 并发切片下载，IndexedDB 存储纯净文本；③ 脱机断网期间阅读进度写入本地队列，网络恢复（`online` 事件）时静默 Flush 同步；④ 目录列表对已离线章节实时打绿点徽标（`●`）；⑤ 全面适配 `safe-area-inset-*` 与 `overscroll-behavior: none`，消除 iOS 橡皮筋下拉与刘海遮挡。
- **[门禁/浏览器] 三种"红的不是产品"的红：合成点击不派发 pointerdown、旧数据会冒充新数据、性能判据怕并发**（2026-10-04 一轮里三条全撞到）。① `page.evaluate` 里的 `node.click()` 只派发 `click`，**不派发 `pointerdown`** —— 而 `AppHeader` 的「我的」菜单靠 `pointerdown` 判"点到外面了"才关。于是门禁里上一段开着的菜单一直挂着，下一次点「我的」变成"反手关掉"，`ui-shell-check` ③ 红在 `Waiting for selector .about-page failed` 上；同一套按钮在真鼠标下先收到 pointerdown、菜单先关，路径是通的。解法是把"开菜单 + 点某一项"收进一个 `openUserMenu()`：先点挡片（它的处理器就是 `click`）收残留，再按条件等，不用固定 sleep 猜。② `LogsModal.load()` 在 state 已经是 `ready` 时**不改 state**（`current === 'ready' ? 'ready' : 'loading'`），换筛选条件的那几百毫秒里旧的 300 行原样挂在 DOM 上、连个转圈标记都没有 —— "等到页面里有东西再读"会立刻返回并读到**上一份**数据（`logs-ui-check` 因此轮流红在 ②/④/⑤：一次读到 300 行混合类别、一次把空态读成"没有空态"）。可信的落定信号是"那行计数文本和点之前不一样了"（`readCount` + `waitRepaint`）；首挂载可以直接等"有东西"，因为那时 DOM 里没有旧数据。③ `assertScalesLinearly` 这类判据量的是墙上毫秒，我拿截图脚本和 `npm test` 并行跑，5,000→20,000 章过滤就被推成 22.9×（同一条判据单跑 498ms、并行 2,815ms 红）—— **带墙上时间的门禁一律单跑**。三条共同的形状：判据红了先问"探针读的是哪一刻的屏幕"，再问产品。
- **[GitHub/贡献者] Force Push 历史孤立对象导致首页 Contributors 残留**：早期导入或 Force Push 覆盖分支后，GitHub 后端 Git 裸仓库仍残留旧 Commit 悬挂对象，导致仓库首页侧边栏聚合了历史 70+ 位幽灵贡献者，而 Insights 图表仅遍历有效 HEAD 正常显示。通过将远程默认分支切换为 `main`（`gh api repos/:owner/:repo/branches/master/rename -f new_name=main`）并更新本地跟踪与 CI 触发分支，可强制 GitHub 后台重构索引并清除悬挂贡献者。
- **[PWA/更新] 自托管升级后「界面还是旧版」= Service Worker 预缓存，必须双向兜底**：`registerType: 'prompt'` 下新 SW 会停在 waiting 态，而旧的 precache 会继续把 `navigateFallback` 的 `index.html` 与旧 bundle 返回给浏览器——用户会表现为「新增的导航入口/页面完全不存在」，即使服务端已经返回了新的资源（可用 `curl` 抓 `/` 观察 `assets/index-*.js` 哈希与 bundle 内容自证）。三层兜底：① `PwaManager` 必须在**登录页也挂载**（否则未登录用户永远看不到更新提示）；② 注册成功后立即判定 `reg.waiting && navigator.serviceWorker.controller` 并弹出更新提示（覆盖「上次错过提示」的历史遗留 SW）；③ 页面 `focus` / `visibilitychange` 与每 5 分钟主动 `registration.update()`，避免长期打开的标签页停留在旧版本。排障时让用户用 DevTools → Application → Service Workers → 注销 + 清站点数据，或直接用无痕窗口/换端口验证。
- **[测试/Puppeteer] tsx + `page.evaluate` 内禁止声明局部函数**：`tsx`（esbuild keepNames）会把被求值函数内的箭头函数/函数声明包成 `__name(...)`，而 `__name` 只存在于 Node 侧，导致浏览器内抛 `ReferenceError: __name is not defined`。`page.evaluate` / `$$eval` 的回调里严禁 `const fn = () => ...` 这类局部函数声明，应改为在 Node 侧多次调用 `$$eval`/`$eval` 组合结果。
- **[前端/无头渲染] 组件渲染期严禁直接取 `location`**：`replace-rules`、备份页等在 `web/test` 中以 `renderToStaticMarkup` 做静态渲染断言，组件内若直接读 `location.origin` 会在 Node 环境抛错；必须封装 `currentOrigin()`（`typeof location === 'undefined'` 时返回空串）后再使用。
- **[测试/Windows] 服务端 52 个既有失败的真实根因：判定回归必须比「失败集合」而不是数量**：`./gradlew :server:test` 在本机长期固定 52 个失败，异常均为 `FileSystemException: *.sqlite: 另一个程序正在使用此文件`。根因是这些测试**从不调用 `database.close()`** 就在 `finally` 里删 SQLite（WAL 还有 `-wal`/`-shm`），Windows 不允许删除被占用文件，而 macOS 的 POSIX 语义允许，故原始开发环境永不暴露。**判定自己是否引入回归的唯一正确姿势**：起干净基线 worktree 跑同一套测试并逐条比对失败集合（历史实测：基线 154 用例/52 失败 vs 带新功能 160~162 用例/同样 52 失败且集合完全一致 ⇒ 零回归）。详见 [`SESSION-HIST-008`](docs/sessions/SESSION-HIST-008-windows-environment-and-verification-baseline.md)。
- **[插件/契约] 跨端契约必须用「真实模块导出面」验证，不能只靠文档一致**：插件宿主读 `loaded.activate`（具名导出），而契约文档与示例写的是 `export default function activate(sdk)`（默认导出挂在 `loaded.default`）→ 表现为「web.js 未导出 activate 函数」。定位手法是用 node **真实 import 被服务端托管的模块**打印导出面。同类问题：SDK 的 `settings` 是**顶层成员**（与 `api` 平级），`sdk.api` 只有 `get/post/put/del/plugin/pluginRaw`，示例里写 `api.settings.get()` 必然 `undefined.get`。
- **[插件/健壮性] 清单解析必须兼容 UTF-8 BOM，接口返回体必须带 charset**：Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，使 `plugin.json` 开头多出 `\uFEFF` 导致清单解析失败、全部插件被卸载（重载接口返回 `{"reloaded":0}`）；仓库侧要既修文件也修解析器（与 Legado 书源导入的 BOM 兼容同源）。另外返回 `application/json` 时若省略 `charset=utf-8`，Windows PowerShell 会按 Latin-1 解码让中文变成乱码。
- **[文档/分支] 插件分支的文档编号与 master 撞号，合并前必须重编号**：`feat/plugin-system` 分支上的 `PROPOSAL-011-plugin-system-and-extension-points.md`、`ADR-011-plugin-runtime-dual-js-jar-and-trust-model.md`、`SESSION-012-plugin-system-implementation.md` 与 master 上已占用的 011/012（替换规则引擎、替换规则一级页面）冲突，合并时须整体顺延（015+），否则索引自相矛盾。历史细节见 [`SESSION-HIST-007`](docs/sessions/SESSION-HIST-007-plugin-system-and-api-doc.md)。
- **[本地书籍/虚拟书源] `loc_book` 虚拟书源与解析入库一体化**：本地上传的电子书（TXT/EPUB）使用标准 `sourceId = "loc_book"` 与 `local://<book_id>` 路径，解析后目录与正文直接写入 `book_toc_cache` 与 `book_content_cache`，使阅读器与 Edge-TTS 能够无差别透明调用，杜绝针对本地书籍另起炉灶建立平行阅读接口；TXT 编码按 BOM -> UTF-8 Strict -> GB18030 Strict 梯度探测，无明确章节时按固定字数自然换行降级切分。
- **[备份导入] Zip 纯内存流式按需读取与 Zip 炸弹防护**：导入备份包时严禁解压落盘，必须使用 `ZipFile` 按需匹配目标文件名流式读取入内存，并设定单条目（64MB）与整包（256MB）解压体积上限，同时彻底规避 Zip-Slip 与 Zip 炸弹。
- **[数据迁移/书架] 书架 `origin` 必须经 `normalizeSourceId` 归一化**：Legado App 的书架记录常携带带有 `##注解` 的书源 URL，落库前必须调用 `SourceCodec.normalizeSourceId` 剥离注解以与 `book_source` 主键对齐，杜绝书籍悬空。
- **[数据迁移/进度] 跨端阅读进度写入必须带 `excluded.updated_at >= reading_progress.updated_at` 防回退守卫**：导入备份进度时严禁无条件覆盖，必须以更新时间戳为守卫防止旧备份冲掉新进度；同时 Android 的字符偏移量 `durChapterPos` 不得强塞入服务端的百分比 `scroll_position`。
- **[正则/类初始化] Kotlin `object` 里一条写坏的 Regex 会让整条功能变成"每次调用都失败"**：`private val CHAPTER_TITLE_REGEX = Regex("…")` 这类顶层正则在 Kotlin 里**编译期不校验**，括号多一个只会在第一次触碰这个 object 时抛 `ExceptionInInitializerError`，此后该类所有调用全是 `NoClassDefFoundError`。表现不是"分章不准"这种可猜的症状，而是**整个本地书导入功能死掉**，且死因藏在栈的第一次触发点。两条防线：① 任何 `object`/`companion` 里的顶层正则必须有直接跑到的用例（`LocalBookParserTest`）；② 判回归必须与基线**比失败集合**，本轮就是靠"基线 47 → 现在 53"这 6 条增量定位到的（详见 §3 与 SESSION-HIST-008）。
- **[前端/设置项] 改设置必须同时回答"谁还在用旧设置"**：朗读引擎/音色/语速在播放中被换掉时，旧引擎的**分片 onEnd 回调链还在推进 `currentChunkIndex`**，新引擎接着出声 → 用户看到的是"重音、都启动"。凡是"一个后台产线 + 用户可中途改配置"的地方（TTS 流、缓存下载、搜索流），设置面变化都要有对应的停旧动作：把"什么算同一场会话"收成**一处判据**（`ttsSessionKey`），界面与引擎都引它，别留两套同义不同名的 key。
- **[阅读器/切章] 视觉与朗读对"旧正文"的处理必须分开**：切章时 `setContent('')` 的原始目的是防朗读读进上一章剩下的段落（见本节的跨章竞态那条），一并清掉视觉的代价是"每章先白闪一下"。正确形状：朗读管线吃 `ttsParagraphs`（当前章没到位就给空数组），视觉侧留着旧正文并标「正在载入：新章名」；且正文加载要走 `useLayoutEffect`，否则预载已到手的下一章也要被换成骨架屏闪一帧（passive effect 在浏览器绘制之后才跑）。
- **[前端/主题] `createPortal(…, document.body)` 的浮层必须让主题变量挂在 `<html>` 上**：主题类只挂在应用外壳（`.app-shell.theme-*`）时，portal 到 body 的下拉/菜单**一个变量都解析不到** —— `background: var(--surface)` 变透明、`color: var(--ink)` 退成纯黑。浅色模式下只是描边发虚（所以能藏很久），夜间模式直接"黑字压在深色页上"，用户报的就是这个（「指定源搜索还没做好，你看看在夜读模式下」）。规则：主题同时 `classList` 到 `document.documentElement`，别假设"浮层也在外壳里"—— 浮层之所以要 portal，正是因为外壳有滚动容器与边框会裁掉它。判据：`tools/verify/portal-theme-check.mjs`（三套皮肤 × 两个 portal 面 + **反向对照**：摘掉 `<html>` 上的主题类必须立刻变透明，否则前面几条是恒真）。
- **[PWA/更新] `autoUpdate` 的 `controllerchange` 不等于"有新版本"**：`registerType: 'autoUpdate'` 会 `skipWaiting + clientsClaim`，于是**第一次访问**装好 SW 也会触发一次 `controllerchange`；那里无条件 `location.reload()` 的表现就是"用户刚点搜索/刚翻页，页面自己刷了一下，操作被吞掉"（本轮「指定源搜索没做好」的第二半：修复前点提交后 `window` 上的标记连同请求消失、0 条结果；修复后同一路径 50 条）。只有**页面本来就有 controller**（被旧 SW 控制过）才算真更新；真更新时若用户正在输入或请求在飞（界面上还有「停止搜索」按钮）推迟到空闲再刷。排查手法：刷新前在 `window` 上打个标记，看标记有没有在点击之后凭空没了。
- **[文档/引用] 文档里指向一个不存在的文件比不引用更坏**：本轮清理掉"见工作区导出的 `RSS死源只读清单.md`"这句 —— 那个文件从未被写出。凡是"清单见 X"的句子，X 必须要么真实存在，要么改成**可重跑的生成命令**（`rss-census.mjs`、`GET /api/rss/sources` 的 `hasListRule`）。
  **同一坑的第二种形态（2026-10-04）**：文件在**我这台机器上存在**，但被 `.gitignore` 排除 —— 对克隆仓库的人一样是悬空引用，而 `grep`/`test -e` 都查不出来，只有 `git check-ignore -v X` 逮得住。实测两处：`docs/实现说明.md` 写"本地补丁见 `local-patches.diff`"（99 个文件的 2026-09-22 快照，且其中最重要那条 JDK 17 早已进了 `server/build.gradle`），以及 `-I init-mirror.gradle` 指的是一个不入库的脚本。处理：只换依赖解析源、不含本机绝对路径的那个脚本**放出来入库**，并在文件头写清"为什么 / 怎么用 / 什么时候能删"（照 workbuddy-switch 给 `[patch.crates-io]` 写注释的那股劲）；历史快照继续不入库，但不许在文档里当现行依据，改成"现行差异以提交历史为准"。所以写完"见 X"之后，除了 `test -e X`，还要问一句 `git check-ignore -v X`。
- **[工具/DSH] 历史会话挖掘（`/doc-init` 专用）**：DSH 会话记录位于 `%APPDATA%\dsh-desktop\harness\sessions\<工作区slug>\<session-id>\session.jsonl.zstd`，格式为**多帧 zstd**（一帧一条 JSONL）：`zstdDecompressSync` 只能解出第一帧（会话头），必须按魔数 `28 B5 2F FD` + 帧头/块头扫描帧边界后逐帧解压（Node 流式 zstd 解压器不支持拼接帧，会报 `Unknown frame descriptor`）；**切勿把会话内容交给 PowerShell 管道格式化（会 OOM）**，应让 Node 脚本写报告文件后再读。记录类型：`user/message`（`data.content[].text`）、`assistant/message`（`data.message.content[]`，内含 `tool-call` 项）、`tool/call`（`data.name` + `data.arguments` JSON 字符串）、`tool/result`、`todo/write`（`data.todos` 直接揭示工作范围）、`session/title`。
- **[前端/框架] 「界面难看」是框架问题，判据要能量出来**：这一轮的病灶不是配色，是版面 —— 每页一行
  「小标 + 34px 衬线大标题 + 一句说明书」、内容锁在 `min(1240px,100%)` 居中列、四个功能藏在顶栏一个 ☰ 里。
  别用形容词讨论，用 `tools/verify/frame-metrics.mjs`：它只统计**真正画了东西的叶子节点**（容器往往撑满整屏，
  量容器等于量白），输出两侧死白 / 底部死白 / 第一行内容起始 / 内容实占宽 / 控件中位高度 / 网格列数 / 卡片宽高。
  三条踩过的量法错误：① 按容器矩形量 → 死白恒为 0；② 把 245px 的封面卡算进"按钮中位高度" → 书库"密度"变成在量封面；
  ③ 把新外壳（侧栏 9 个 34px 入口）算进每一页的控件样本 → 每页都"密度漂移"。现在只量 ≤60px 的内容控件，
  并排除 `.page-bar/.app-rail/.rail-tabs/.app-page-header`。**改版前后各出一份 JSON、`--compare` 逐屏比，报告给数字而不是形容词。**
- **[前端/框架] 界面框架 v2（侧栏 + 单行页头条）已整体回滚，别把它改回来**：2026-10-01 这一天用户口径变了三次，
  **最后一次为准** ——「恢复改版前的页面样式」。现状：`AppRail.tsx` / `PageBar.tsx` / `AppRail.test.ts` 已删除，
  `.app-rail` / `.page-bar` / `.app-frame` / `.rail-tabs` 这些选择器在 `styles.css` 里不存在，
  页面回到 `.app-page-header` 顶栏 + 每页 `.page-title`（kicker + 衬线大标题 + 说明句）+ `.library-hero` +
  `min(1240px,100%)` 居中列 + 书源页那块「选择一个书源」空面板。
  钉住这件事的是 `web/test/CustomizeSkin.test.ts`（断言上述文件与选择器**不许存在**）与
  `tools/verify/ui-shell-check.mjs`；`ui-layout-check.mjs` 是两套外壳时代的判据，随侧栏一起作废。
  仍然有效的两条教训：① 默认外壳与入口集合都要钉住，且**切换布局不许少功能**（按能力关键字比，不按 label 文本比 ——
  同一件事在两处叫「离线缓存」与「本地离线缓存管理」）；② 改版要**连部署一起交付**：这一轮真正被用户看到的
  不是"源码改完"而是"跑的那个 jar"，17:51 的包一直服务到晚上，用户评价的一直是旧包。
  判据本身留着有用：`tools/verify/frame-metrics.mjs` 量的仍是"版面被谁占走"，下一次讨论界面时先出数字。
- **[前端/样式] 同一种类名在两套外壳里尺寸不同，就必须写作用域，否则后写的那条全局规则赢**：
  `.theme-swatch` 在顶栏菜单里是 22px 带内描边的色片，侧栏底部想要的是 9px 小点 ——
  直接补一条 `.theme-swatch { width: 9px }` 会按"后来者胜"把顶栏那套也压小（界面没坏，密度被串改，
  而且没人报错）。当时收进 `.rail-theme .theme-swatch` 是对的；侧栏回滚后这条作用域随文件一起删掉了，
  但**规则本身仍然成立**：给"另一种外壳/另一个组件"改尺寸时，先量原处那颗的实际宽度，别写全局。
- **[前端/皮肤] 自定义皮肤是**叠**在内置皮肤上的，不是替换它**：`themeClassNames(settings)` 在选中自定义皮肤时
  返回 `['theme-<基档>', 'theme-<id>']` 两个类（基档由用户在三颗色片里选，存 `customSkinBase`）。
  理由：只写两三条变量（例如只改 `--canvas`）是最常见用法，若根上只有 `.theme-midnight` 一个类，
  `--surface/--ink/--line` 全部落空 → 界面变成"字和底一个颜色"。注入的 `<style>` 追加在 `<head>` 末尾，
  同特异性下后者胜，所以覆盖仍然成立。**判据带反向对照**：摘掉基类后 `--surface` 必须立刻取不到，
  否则"叠加"那几条是恒真的。皮肤 id 走 `parseSkinId` 白名单（只留 `[a-z0-9-_]`，因为它被拼进类名）。
- **[测试/判据] 判据的"禁单"不许有空项，而且每一项都要当场自证一次**：`web/test/CopyStyle.test.ts` 第一版的
  禁字形清单是字面量数组，链路上有五个字形被吞成了 `''`。`BANNED_GLYPHS.find(mark => text.includes(mark))`
  拿到空串返回的是 **falsy** —— 判据既不报错也不拦任何东西，套件连着绿，💡 与 👈 就留在界面上。
  同一份判据的第二处盲区是"JSX 文本必须含中文才算界面文案"，于是 `<button>›</button>` 这种**只有一个字形**
  的图标按钮整块从判据里消失（内置浏览器工具栏那五个就是这么留下的）。
  规则：**清单按码位写、由 `String.fromCodePoint` 组装**（空项根本组装不出来），加一条"清单无空项 / 无重复"的自检，
  再把清单里**每一项**注入样本反扫一遍；写任何一条判据时先问一句"如果违规了，它会红吗"。
- **[解析/jsoup] `Element.text()` 会把所有空白压成单个空格，靠换行分隔的结构会被它抹平**：本地 EPUB 正文里插入的 `![图片](地址)` 占位行，用 `body().text()` 取文本后就并进了前后句子，前端"整行必须是占位"的正则永远匹配不上 —— 表现是"图还是不显示"，而服务端返回的字节、类型、URL 全对。要保留换行用 `wholeText()`，段落归一交给自己的清洗函数。同类坑：任何"我往 DOM 里塞了一个依赖换行的标记"的改动，判据都要断言**它独占一行**，而不是只断言字符串里出现过。
- **[判据/夹具] 门禁自己造的测试数据也要能被真浏览器解码，否则红的是探针不是产品**：手拼十六进制造的一张 1x1 PNG，服务端照常回 `200 image/png` 且字节数一致，浏览器 `naturalWidth` 仍是 0 —— 一条端到端门禁因此刷红。造二进制夹具用公认的那份 base64，别手拼；并且**断言要写清"什么情况下收起/保留"**：路由按设计拒掉的那张（同源 SVG）应该被收起，写成"一张都没收"就是把正确行为判成红。
- **[测试/注册] `web/test/run-all.ts` 是一个一个 `import` 的，不扫目录 —— 没注册的测试等于没跑**：
  本轮发现两份文件存在、名字像测试、套件全绿，其实一条都没执行（`HeaderMenu.test.ts` 被删 AppHeader 时
  顺带从 runner 摘掉；`LocalBookImport.test.ts` 从来没被引过）。已在 `CustomizeSkin.test.ts` 里把
  "test 目录下每个 `*.test.ts` 都必须出现在 run-all.ts"本身做成判据。**新增测试文件必须同时加那一行**。
- **[测试/静态渲染] 组件要被 `renderToStaticMarkup` 渲染，就必须 `import React`**：`web/test` 走的是 classic JSX
  （`React.createElement`），Vite 构建才走 automatic runtime。少这一行时**构建与页面一切正常，只有测试里抛
  `React is not defined`** —— 而"没有被测试渲染过的组件"永远不会暴露。PageBar / Notice 这两处就是靠
  ChangelogPage 的静态渲染才撞出来的，注释也写在这两个文件里防"顺手清理未用导入"。
  **同一坑的第二种形态（2026-10-04 `ShortcutHelp`）**：组件本来好好的，只是给它**新接一个 hook**（`useEscapeClose`，
  内部只用 `useEffect`）就红了 —— 而且**单独跑那个测试文件是绿的，跑整套 `run-all.ts` 才红**（顺序依赖）。
  所以判"是不是假红"不许只单跑一个文件，红的时候先看这行 `import React` 在不在。
- **[工具/行尾] 脚本重写文件会让 `git diff` 报成"整份文件都改了"**：本机 `core.autocrlf=true`，
  工作区里没被编辑工具碰过的文件是 **CRLF**，而 HEAD 存的是 **LF**。用 node 脚本 `readFileSync`+`writeFileSync`
  改这类文件，git 就把每一行都算成改动 —— 实测真实改动 481 行，`--stat` 报 2821 行，看起来像把七个文件重写了。
  两条纪律：① 归因先跑 `git diff --ignore-cr-at-eol --stat`，它给出的才是本次真正动了什么；
  ② 收尾把改过的文件剥回 LF（`s/\r\n/\n/`），与仓库其余部分一致，否则下一个人分不清哪些是内容差异。
  编辑工具直接改的文件天然是 LF，所以混用脚本与工具时这个坑专门会在"用脚本批处理"那一轮冒出来。
- **[前端/空态] 列表没到手之前不许说"你一条都没有"**：`RssPanel` / `SubscriptionPanel` 原来都是
  `items.length === 0 && !notice` 就渲染空态卡，负载下先闪一张"还没有订阅源"，而本机有 178 条。
  与能力波 v27 那条 `api.shelfGroups().catch(() => [])` 是同一个病：**"还没到"、"取失败了"、"确实没有"是三件事**，
  空态只能由第三件触发（加一个 `loaded` 标志，`finally` 里置位）。界面门禁里凡是"固定 sleep 之后读列表"的，
  都会把这一类读成假红 —— 改成 `waitForFunction(有行 || 明确空态)`。
- **[前端/浮层] 并档的判据不许数"类名叫什么"，要数"这条规则声明了什么"**（2026-10-05 W2 把 17 套弹窗外壳并成一档时定下的口径）：`PROPOSAL-018 §5.2` 原文写的是"TSX 里作为弹窗外壳的类名数量 ≤ 3"，照字面判做不到 —— 页面类名（`.logs-modal`、`.book-detail-modal`、`.toc-rules-modal` 那 11 个）必须留在界面上当**门禁锚点**，而 W1 刚踩过"把没有样式的类名当死代码删掉，五条判据当场红在探针上"。所以实现改成：一条**只有单个类名**的规则同时写了 `max-height` + `border-radius` + `box-shadow` 就算"一套外壳几何"，只许 `.dialog-shell`（`.reader-drawer` / `.tts-floating-bar` 豁免：抽屉与悬浮条按 §3.3 保留自己的几何）；遮罩按 `position:fixed` + `inset:0` + 深色底数，只许两条；关闭键按"30×30 + `border:0` + 居中"数，只许 `.overlay-close` 一颗。再加两条 TSX 侧的：每个弹窗挡片必须套一个 `.dialog-shell`（**第 17 套几何就是这么长回来的**）、不许用 inline style 压弹窗宽高。四条各有注入反扫。**同一条规律的第二处**：`[前端/框架]` 那条"判 UI 图层问题要量元素不读源码"是同一个形状 —— 凡是"用名字表达约束"的判据，改名就漏；用**声明了什么**表达约束，改名漏不掉。
- **[前端/浮层] 引用一个不存在的 `@keyframes` 不报错，表现是"动画从来没演过"**：朗读设置弹窗写着 `animation: modal-enter .2s`，而样式表里从来没有 `@keyframes modal-enter` —— 浏览器就当没有动画，点开硬蹦。和类名一样，**动画名是两处各写一份的字符串**（声明处与引用处），所以并档时顺手扫两向：① TSX 挂着而样式表 0 命中的类名（W1 已常驻）；② 样式表里声明了而界面不用的浮层类与动画名（这一轮扫出 `.header-view-dialog` / `.header-view-code` 整个弹窗样式没人用、`menuBackdropFadeIn` 随挡片并档变成孤儿）。判据只写正向的那一半，另一半就会一直烂在那儿。
- **[门禁/选择器] 关闭键的选择器必须带弹窗作用域，裸 `.overlay-close` 会点到上一张没关掉的弹窗那颗**：并档之后全界面只剩一颗关闭键类名，`document.querySelector('.overlay-close')` 取的是 **DOM 里第一个**。实测：`ui-shell-check` ② 那条还去点 `.logs-modal .logs-btn[aria-label="关闭"]`（旧类名），日志弹窗根本没关，于是 ③ 点「快捷键」那张表时 `querySelector('.overlay-close')` 命中的是**日志那颗**，把日志又关了一遍 —— 两个 FAIL、一个根因，而它长得极像"并档把 Esc/关闭键改坏了"。规矩：① 改口要连着改**门禁里那些带属性选择器的复合串**（`grep` 类名只能逮到一半）；② 判"关得掉"之前先断言此刻 DOM 里有几层挡片，红的时候先看残留的是哪一层。

---

## 6. 标准文档体系索引 (Proposals, Decisions & Sessions Index)

### 需求与功能提案 (PRD Proposals)
| 编号 | 标题 / 议题 | 关联文档 | 状态 |
| :--- | :--- | :--- | :--- |
| PROPOSAL-001 | Legado 规则执行引擎无头化迁移与 Ktor 服务端架构 | [`docs/proposals/PROPOSAL-001-headless-rule-engine-and-server-migration.md`](docs/proposals/PROPOSAL-001-headless-rule-engine-and-server-migration.md) | Implemented |
| PROPOSAL-002 | 多书源高并发流式搜索与多维智能排序引擎 | [`docs/proposals/PROPOSAL-002-multi-source-streaming-search-and-smart-ranking.md`](docs/proposals/PROPOSAL-002-multi-source-streaming-search-and-smart-ranking.md) | Implemented |
| PROPOSAL-003 | 整书离线缓存、断点续传与跨书源书架持久化 | [`docs/proposals/PROPOSAL-003-offline-book-caching-and-breakpoint-resume.md`](docs/proposals/PROPOSAL-003-offline-book-caching-and-breakpoint-resume.md) | Implemented |
| PROPOSAL-004 | 现代化 Web 阅读器、超大目录虚拟化与双栏宽屏排版 | [`docs/proposals/PROPOSAL-004-modern-web-reader-and-toc-virtualization.md`](docs/proposals/PROPOSAL-004-modern-web-reader-and-toc-virtualization.md) | Implemented |
| PROPOSAL-005 | 支持书源登录、凭据持久化与动态 LoginUI 交互 | [`docs/proposals/PROPOSAL-005-book-source-login-and-credential-storage.md`](docs/proposals/PROPOSAL-005-book-source-login-and-credential-storage.md) | Implemented |
| PROPOSAL-006 | 现代化 TTS 朗读引擎与沉浸式听书体验 | [`docs/proposals/PROPOSAL-006-tts-engine-and-immersive-reading-experience.md`](docs/proposals/PROPOSAL-006-tts-engine-and-immersive-reading-experience.md) | Implemented |
| PROPOSAL-007 | 服务端会话级连续 TTS 音频流与移动端后台稳定播放 | [`docs/proposals/PROPOSAL-007-server-session-tts-stream-and-mobile-background-playback.md`](docs/proposals/PROPOSAL-007-server-session-tts-stream-and-mobile-background-playback.md) | Implemented |
| PROPOSAL-008 | TTS 连续播放稳定性、相对时钟锚定与缓冲弹性架构 | [`docs/proposals/PROPOSAL-008-tts-continuous-playback-stability-and-drift-compensation.md`](docs/proposals/PROPOSAL-008-tts-continuous-playback-stability-and-drift-compensation.md) | Implemented |
| PROPOSAL-009 | TTS 播放管线穿透、反向代理防缓冲与首帧静音垫底优化 | [`docs/proposals/PROPOSAL-009-tts-stream-buffering-proxy-and-gesture-unlock.md`](docs/proposals/PROPOSAL-009-tts-stream-buffering-proxy-and-gesture-unlock.md) | Accepted |
| PROPOSAL-010 | 替换净化规则引擎与社区规则库导入体系 | [`docs/proposals/PROPOSAL-010-replace-rules-engine-and-community-purification.md`](docs/proposals/PROPOSAL-010-replace-rules-engine-and-community-purification.md) | Accepted |
| PROPOSAL-011 | 替换净化规则升级为一级独立页面与阅读器设置抽屉集成 | [`docs/proposals/PROPOSAL-011-first-class-replace-rules-page-and-reader-settings-integration.md`](docs/proposals/PROPOSAL-011-first-class-replace-rules-page-and-reader-settings-integration.md) | Accepted |
| PROPOSAL-012 | 完整 PWA 渐进式 Web 应用能力、用户自主正文分段离线缓存与沉浸式全屏抽屉适配 | [`docs/proposals/PROPOSAL-012-pwa-capabilities-and-fullscreen-drawer-adaptation.md`](docs/proposals/PROPOSAL-012-pwa-capabilities-and-fullscreen-drawer-adaptation.md) | Accepted |
| PROPOSAL-013 | 移动端全面屏死区安全区深度适配与替换净化规则 UI 体系化重构 | [`docs/proposals/PROPOSAL-013-mobile-safe-area-and-rules-ui-redesign.md`](docs/proposals/PROPOSAL-013-mobile-safe-area-and-rules-ui-redesign.md) | Accepted |
| PROPOSAL-014 | 书源批量整理、分组维护与轻量连通性健康体检体系 | [`docs/proposals/PROPOSAL-014-book-source-batch-management-and-health-check.md`](docs/proposals/PROPOSAL-014-book-source-batch-management-and-health-check.md) | Accepted |
| PROPOSAL-015 | 内置 WebDAV 服务端与数据目录 webdav 存储区（含 Web 端「文件」设置页面）——**已废弃：该服务与页面已于 2026-09-29 删除** | [`docs/proposals/PROPOSAL-015-webdav-storage-server.md`](docs/proposals/PROPOSAL-015-webdav-storage-server.md) | Superseded |
| PROPOSAL-016 | 本地图书导入与无缝阅读（TXT/EPUB 解析、智能分章与书架集成） | [`docs/proposals/PROPOSAL-016-local-book-import-txt-epub.md`](docs/proposals/PROPOSAL-016-local-book-import-txt-epub.md) | Tested |
| PROPOSAL-017 | 桌面化封装 —— 把「青阅」打成一个能双击的 Windows 程序（含"同源闸门决定壳只能开到回环 URL"这条约束） | [`docs/proposals/PROPOSAL-017-desktop-packaging-windows-app.md`](docs/proposals/PROPOSAL-017-desktop-packaging-windows-app.md) | Draft（§6 五件待拍板） |
| PROPOSAL-018 | 框架脉络重整 —— 书库冻结为基准、浮层系统一次定死、九页归成四种版面原型（用户拍板：结构 + 版面一起重做） | [`docs/proposals/PROPOSAL-018-framework-consolidation-and-layout-rework.md`](docs/proposals/PROPOSAL-018-framework-consolidation-and-layout-rework.md) | Draft（§6 三件待拍板；W1 起可开工） |

### 架构决策记录 (ADR)
| 编号 | 决策标题 | 关联文档 | 状态 |
| :--- | :--- | :--- | :--- |
| ADR-001 | 彻底解耦 Android 原生平台，采用 Ktor + Kotlin JVM + Rhino JS 沙箱 | [`docs/decisions/ADR-001-pure-jvm-ktor-and-rhino-sandbox.md`](docs/decisions/ADR-001-pure-jvm-ktor-and-rhino-sandbox.md) | Accepted |
| ADR-002 | SQLite 读写分离、WAL 模式与原子状态计数优化 | [`docs/decisions/ADR-002-sqlite-wal-pooling-and-in-memory-counters.md`](docs/decisions/ADR-002-sqlite-wal-pooling-and-in-memory-counters.md) | Accepted |
| ADR-003 | 开书级联请求消除：单书源秒开 + 候补源懒加载 + TOC 虚拟滚动 | [`docs/decisions/ADR-003-lazy-candidate-loading-and-toc-virtualization.md`](docs/decisions/ADR-003-lazy-candidate-loading-and-toc-virtualization.md) | Accepted |
| ADR-004 | 阅读器跨章反向翻页定位状态机与异步排版守卫 | [`docs/decisions/ADR-004-cross-chapter-navigation-state-machine.md`](docs/decisions/ADR-004-cross-chapter-navigation-state-machine.md) | Accepted |
| ADR-005 | 书源登录鉴权、动态 LoginUI 驱动与凭据状态持久化 | [`docs/decisions/ADR-005-book-source-login-ui-and-session-state.md`](docs/decisions/ADR-005-book-source-login-ui-and-session-state.md) | Accepted |
| ADR-006 | 双模式 TTS 引擎、分片预缓冲与视口高亮联动架构 | [`docs/decisions/ADR-006-dual-tts-engine-and-audio-streaming-architecture.md`](docs/decisions/ADR-006-dual-tts-engine-and-audio-streaming-architecture.md) | Accepted |
| ADR-007 | 服务端会话级连续 MP3 音频流与独立进度事件通道 | [`docs/decisions/ADR-007-session-scoped-continuous-tts-audio-stream.md`](docs/decisions/ADR-007-session-scoped-continuous-tts-audio-stream.md) | Accepted |
| ADR-008 | TTS 单句相对时钟锚定、前瞻扩容与停滞看门狗架构 | [`docs/decisions/ADR-008-tts-relative-clock-and-buffer-resilience.md`](docs/decisions/ADR-008-tts-relative-clock-and-buffer-resilience.md) | Accepted |
| ADR-009 | TTS 音频流首帧静音垫底与反向代理穿透架构 | [`docs/decisions/ADR-009-tts-stream-resilience-and-zero-latency-preamble.md`](docs/decisions/ADR-009-tts-stream-resilience-and-zero-latency-preamble.md) | Accepted |
| ADR-010 | 替换净化执行管道选型、作用域匹配与沙箱安全 | [`docs/decisions/ADR-010-replace-rules-pipeline-and-scope-matching.md`](docs/decisions/ADR-010-replace-rules-pipeline-and-scope-matching.md) | Accepted |
| ADR-011 | 替换规则升级为主导航一级页面与阅读器设置抽屉模块化收敛 | [`docs/decisions/ADR-011-first-class-replace-rules-navigation-and-reader-settings.md`](docs/decisions/ADR-011-first-class-replace-rules-navigation-and-reader-settings.md) | Accepted |
| ADR-012 | 采用 vite-plugin-pwa 构筑双层用户可控离线缓存体系与 Safe-Area 沉浸式安全区适配 | [`docs/decisions/ADR-012-vite-plugin-pwa-workbox-and-safe-area-layout.md`](docs/decisions/ADR-012-vite-plugin-pwa-workbox-and-safe-area-layout.md) | Accepted |
| ADR-013 | 全面屏安全区变量统一继承体系与替换规则设计系统化重构 | [`docs/decisions/ADR-013-safe-area-layout-and-rules-design-system.md`](docs/decisions/ADR-013-safe-area-layout-and-rules-design-system.md) | Accepted |
| ADR-014 | 书源批量事务管道、轻量并发探针与浮动管理状态机 | [`docs/decisions/ADR-014-source-batch-operations-and-lightweight-probe-pipeline.md`](docs/decisions/ADR-014-source-batch-operations-and-lightweight-probe-pipeline.md) | Accepted |
| ADR-015 | 进程内 WebDAV 服务端选型、Basic 鉴权与最小 Class 2 锁实现 —— **已废弃：WebDAV 已删除，恢复改走浏览器直传** | [`docs/decisions/ADR-015-webdav-server-class2-minimal.md`](docs/decisions/ADR-015-webdav-server-class2-minimal.md) | Superseded |
| ADR-016 | 本地图书（TXT/EPUB）解析引擎、虚拟书源与解析入库一体化架构 | [`docs/decisions/ADR-016-local-book-parsing-and-storage-architecture.md`](docs/decisions/ADR-016-local-book-parsing-and-storage-architecture.md) | Accepted |
| ADR-017 | 桌面化：一期 `jlink` 精简运行时 + `jpackage app-image`（零新工具链、不改安全模型），Tauri 窗口壳降为二期且以最小尖峰为准入门槛；Electron 排除 | [`docs/decisions/ADR-017-desktop-jpackage-runtime-bundle.md`](docs/decisions/ADR-017-desktop-jpackage-runtime-bundle.md) | Proposed |

### 工作记忆与历史推演归档 (Sessions Chronicle)

> 全部会话 / 工作记忆归档见 [`docs/sessions/`](docs/sessions/) —— 文件名自解释（形如 `SESSION-*-<主题>.md`），此处不再维护逐条索引。
> 双 AI 并行期的协作流水账见 [`docs/dual-ai/`](docs/dual-ai/)。

## 7. Project Structure & Module Organization

This repository is dedicated to the standalone Legado Server ecosystem: the standalone backend server and the web client.

- **`server/`**: Standalone headless backend server built with Ktor (`io.legado.server`), Kotlin JVM, and SQLite. Handles source parsing and execution (`RuleRunner` with Jsoup, JsonPath, and Rhino JS engine), book and cover caching, source subscription synchronization, and API routing. There is **no authentication layer** — write endpoints are guarded only by the same-origin check in `Guard.kt`.
- **`web/`**: Web reader and management UI (`legado-server-web`) built with React 19, TypeScript, and Vite. Communicates with `server/` APIs to manage sources, search books across sources, debug rules, and read books.

---

## 8. Coding Style & Naming Conventions

- **Kotlin**: Four-space indentation, idiomatic Kotlin constructs. Match nearby code for brace placement, imports, and null handling. Use PascalCase for classes and files (`BookCacheService.kt`), camelCase for functions and properties.
- **TypeScript / React**: Modern functional components with hooks, strict TypeScript types, and organized CSS in `web/src/styles.css`.
- **Security & Reliability**: The server runs without any identity layer (no password, no login page, no session): loopback binding is the access boundary, and state-changing requests are additionally gated by a same-origin check (`Origin` must equal `Host`) so a random web page cannot drive the user's browser to mutate the library. and sandboxed JS evaluation.

---

## 9. Testing Guidelines

- Add or update focused regression tests for any behavior changes (e.g. `RuleRunnerTest.kt`, `DatabaseTest.kt`, `CoverCacheTest.kt`, `BookCacheServiceTest.kt`).
- Prefer deterministic unit tests in `src/test/`.
- Ensure all relevant test suites pass before submitting changes (`./gradlew :server:test`, `npm run check`, `npx tsx web/test/run-all.ts`, etc.).

---

## 10. Commit & Pull Request Guidelines

- Recent commits use concise Chinese imperative summaries or conventional commit format (e.g. `优化翻页交互：从章节开头回翻定位至上一章末尾`, `fix(web): 修复点击停止搜索误触表单提交导致重新发起搜索的问题`).
- Keep commits focused and describe the user-visible change or module scope.
- Never commit passwords, signing credentials, API tokens, or local `.env` secrets.

---

## 11. Engineering Principles

- 不保留向后兼容性。应删除过时的路径，而不是添加兼容层、回退机制或迁移方案。
- 选择能够完全满足当前需求的最简单实现。避免引入臆测性的抽象、配置和间接层。
- 以分层方式逐步构建系统。先实现能够端到端运行的最小版本，再在已有可用产品的基础上逐项增加新能力。绝不要为了尚未完成的复杂设计而牺牲一个可正常运行的产品。
- 保持组件模块化，并清晰分离各项职责（服务端解析、前端交互、数据持久化各司其职）。
- 当成熟且维护良好的库能够降低整体复杂度或提高可靠性时，应优先使用。除非有明确理由，否则不要重复实现常见功能。


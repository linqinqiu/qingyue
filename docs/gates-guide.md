# 门禁（tools/verify）怎么跑、怎么接 CI

> `tools/verify/` 下 **78 个**脚本，都是"现量"判据：开真 Chrome 打开真界面量，
> 不打桩、不看快照。这份文档说清它们的分类、怎么在本地跑、CI 里跑哪些。

## 1. 分类（别一股脑全跑）

| 类别 | 数量 | 特征 | 何时跑 |
|---|---|---|---|
| **冒烟三件套** | 3 | 快、覆盖面大、不依赖具体书源 | 每次 push / PR |
| **真浏览器门禁** | 46 | 需 Chrome + 服务在跑，单个 10~60 秒 | main 推送 / 发版前 |
| **普查类** | 若干 | 只产出数据（`*-census.mjs` / `snapshot*`），不是判据 | 需要数据时手动跑 |
| **诊断类** | 若干 | 排查问题用，无断言 | 出问题时手动跑 |

`78` 个里 **70 个需要服务在跑**、**46 个需要真浏览器**。所以不能全塞进 CI。

## 2. 冒烟三件套（发布红线）

```bash
# 前置：服务在跑
npm start

# 1) 版本号单一来源 + 前端产物一致 + 顶栏版本可读
node tools/verify/version-check.mjs          # 17 项

# 2) 端到端：搜索→详情→目录→正文→净化（会真的联网打书源）
node tools/verify/selfcheck.mjs              # 34 项

# 3) 开源卫生：无个人路径 / 无说谎文档 / 端点不悬空
node tools/verify/opensource-hygiene-check.mjs   # 11 项
```

三个都绿 = 可以发版。

## 3. CI 里跑哪些（`.github/workflows/gates.yml`）

| Job | 触发 | 跑什么 |
|---|---|---|
| `smoke` | push to main / 手动 | 上面三件套 |
| `full` | 手动（`full=true`）/ release | 全部 `*-check.mjs`，串行，跑完汇总 |

**为什么 `selfcheck` 设 `continue-on-error`**：它真的联网打书源站，
CI 出口 IP 常被限流或墙掉。红了不代表产品坏 —— 但**必须看日志**，
因为也可能是产品真坏了。这一条不阻塞合并，但也不该被忽略。

## 4. 本地全量跑

```bash
# 服务必须在跑
for f in tools/verify/*-check.mjs tools/verify/selfcheck.mjs; do
  case "$f" in
    *census*|*snapshot*|*report*) continue ;;
  esac
  echo "──── $f ────"
  node "$f" || echo "FAILED: $f"
done
```

**一律串行**：多个门禁会抢同一个 Chrome profile 与同一个实例的探针数据。

## 5. 环境变量

| 变量 | 用途 |
|---|---|
| `LEGADO_CHROME` | 指定 Chrome 路径（`env.mjs` 会自动探测 Windows/macOS/Linux） |
| `LEGADO_BASE_URL` | 对着隔离实例跑（默认 `http://127.0.0.1:1234`） |
| `LEGADO_VERIFY_OUT` | 截图与产物目录（默认 `tools/verify/out`） |
| `LEGADO_VERIFY_TMP` | 临时目录 |

## 6. 两个修过的判据 bug（2026-10-21）

门禁本身也会错。这两条是真误报，已修：

### 6.1 `selfcheck` 把"没有本地书"判成产品坏了

原判据：`shelf.some(b => b.source_id === 'loc_book')` —— 要求书架上**必须有本地书**。

问题：那取决于用户导没导入过，是**环境状态**不是产品事实。在没有本地书的库上必然红。

改成：只验"自检全程没有增删书架条目"（比较前后条数）。这才是"不碰用户数据"的正确表达。

### 6.2 `opensource-hygiene-check` 看不懂嵌套路由

原逻辑：在 Kotlin 源码里找 `"<路径>"` 字符串字面量。

问题：嵌套路由是**分段**写的 —— `route("agent") { get("/manifest") }`，
源码里根本没有字符串 `"/agent/manifest"`。于是 `/api/agent/manifest` 被误判成"悬空"，
等于**逼着文档不敢写嵌套端点**。

改成：先收集每层 `route(...)` 的段与每条 `get/post/...` 的路径，组合出真实端点再比对。

## 7. 加一个新门禁时

1. 放 `tools/verify/<name>-check.mjs`，命名带 `-check` 后缀才会被 CI 的 full job 收进去；
2. 用 `env.mjs` 的 `ROOT` / `BASE` / `launchOptions()`，**不要硬编码路径或 Chrome 位置**；
3. 输出格式对齐现有的：`PASS/FAIL/NOTE` + 末尾一行汇总 `xxx-check: PASS n / FAIL m`；
4. 退出码：有 FAIL 就 `process.exit(1)`；
5. 需要联网的标 `continue-on-error`，并在注释里写明"红了可能是网络不是产品"。

## 8. 判据的设计原则（从现有脚本读出来的）

- **现量，不打桩**：真开浏览器、真打接口。
- **反向对照**：不只验"对的能过"，还要验"错的会红"（如 `ApiCatalog.test.ts` 里
  "假端点、漏端点、write 说谎都必须被逮住"）。
- **不写死会变的数字**：书源条数、规则条数这类"读库与接口一致"即可，
  写死历史数字等于替用户数据下结论。
- **区分"规则写坏了"与"站点没内容"**：前者报错，后者正常返回空。

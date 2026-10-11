# AI-1 重开启动指令（qingyue-ai1 / 后端）

> 工作目录 `qingyue-ai1`，分支 `ai1/backend`，工具 WorkBuddy CLI。所有命令在 `qingyue-ai1` 根目录下执行。
> 端口 / DB / 日志以唯一事实源 [`docs/dual-ai/README.md`](README.md) 为准。

## 0. 同步
```bash
git fetch origin && git rebase origin/main
```

## 1. 环境（隔离）
工作树根 `.env`（已被根 `.gitignore` 忽略，不入库）：
```
LEGADO_HOST=127.0.0.1
LEGADO_PORT=8081
LEGADO_DATABASE=data/ai1.db
LEGADO_LOG_FILE=logs/ai1/server.log
```
目录已建：`data/`、`logs/ai1/`。

## 2. 构建后端 fatJar（jar 内嵌前端，需先构建前端）
```bash
npm --prefix web run build          # 构建前端到 web/dist
./gradlew :server:fatJar            # 产物 server/build/libs/legado-server-<ver>-all.jar
```

## 3. 启动（读 .env）
```bash
node start.mjs --no-open
# 或直跑 jar：
java -jar server/build/libs/legado-server-*-all.jar
```

## 4. 验证
```bash
curl -s http://127.0.0.1:8081/healthz      # 应返回版本 JSON
curl -s http://127.0.0.1:8081/api/server   # 服务身份
ls -la data/ai1.db logs/ai1/server.log      # 确认库/日志已生成
```

## 5. 单元测试
```bash
./gradlew :server:test
# 注：Windows 上「删临时 sqlite 被占用」的失败已修（2026-10-11）；判回归请比对「失败集合」而非数量。
```

## 6. 停止
```bash
node stop.mjs --port 8081
```

## 7. 开工前必读（协作）
- `docs/dual-ai/README.md`：唯一事实源（工作树 / 端口 / 归属 / 提交 / 合流）
- `docs/dual-ai/COORDINATION-ai1.md`：自己进度
- `docs/dual-ai/COORDINATION-ai2.md`：AI-2 留言（重点 `API-REQUEST` / `BLOCKER`）
- `docs/API-CONTRACT.md`：后端接口契约（AI-1 主导）

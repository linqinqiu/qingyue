import { execFileSync, spawn } from 'node:child_process';
import { existsSync, openSync, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { childEnvironment, ensureDirectories, resolveRuntime } from './scripts/runtime.mjs';

/**
 * 启动青阅：后台拉起服务，等端口真的能连上了再打开浏览器。
 *
 * 命令行（借鉴 workbuddy-switch 的 `serve --port N --no-open`）：
 *   node start.mjs                 # 默认端口（.env / LEGADO_PORT / 1234），起来后自动开浏览器
 *   node start.mjs --port 1235     # 换端口
 *   node start.mjs --no-open       # 只起服务，不开浏览器
 *   node start.mjs --host 0.0.0.0  # 换绑定地址（默认只绑回环）
 * 传进来的值优先于 .env / 环境变量 / 默认值。
 */
function parseArgs(argv) {
  const out = { port: null, host: null, open: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--no-open') out.open = false;
    else if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) out.port = Number(arg.slice('--port='.length));
    else if (arg === '--host') out.host = argv[++i];
    else if (arg.startsWith('--host=')) out.host = arg.slice('--host='.length);
    else if (arg.startsWith('-')) { console.error(`未知参数：${arg}（可用：--port N / --host H / --no-open）`); process.exit(2); }
    // 位置参数（如 `serve`）直接忽略，方便把它当子命令用
  }
  if (out.port !== null && (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535)) {
    console.error(`--port 需要一个 1..65535 的整数，收到「${out.port}」`);
    process.exit(2);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('用法：node start.mjs [--port N] [--host H] [--no-open]');
  console.log('  默认端口来自 .env / LEGADO_PORT，缺省 1234；起来后自动打开浏览器。');
  process.exit(0);
}

const runtime = resolveRuntime();
if (args.port) runtime.port = args.port;
if (args.host) runtime.host = args.host;

const jars = readdirSync(runtime.libs).filter((name) => name.endsWith('-all.jar'));
if (!jars.length) { console.error(`没有 ${runtime.libs}\\*-all.jar，先跑 gradle :app:fatJar`); process.exit(1); }
const jar = jars.sort().pop();
const env = childEnvironment(runtime);
ensureDirectories(runtime);

/** 浏览器地址：绑 0.0.0.0 时用回环地址访问自己。 */
const browseHost = runtime.host === '0.0.0.0' || runtime.host === '::' ? '127.0.0.1' : runtime.host;
const url = `http://${browseHost}:${runtime.port}`;

/** 服务是否已经就绪（/healthz 能答）。端口 listen 不代表能服务：冷启动要十几秒。 */
async function isReady(target) {
  try {
    const res = await fetch(`${target}/healthz`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

/** 等 /healthz 真的能答 —— 起来之前打开浏览器只会看到"正在打开阅读空间…"。 */
async function waitForHealth(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReady(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function openBrowser(target) {
  try {
    if (process.platform === 'win32') spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 打不开就只打印地址，不是致命错误 */ }
}

/** 找一个空闲端口：后台重建 CDS 时用（刚起来的服务占着默认那个）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * CDS 归档过期/缺失时**在后台重建**：这次照常起、只是没享受到那几秒，重建完下次启动就快了。
 * 用另一个端口 + detached，不挡这次启动、也不和刚起来的服务抢端口。
 */
async function rebuildCds() {
  try {
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [path.join(runtime.root, 'tools', 'make-cds.mjs'), '--port', String(port)],
      { cwd: runtime.root, detached: true, stdio: 'ignore' },
    );
    child.unref();
    console.log('CDS 归档已过期 —— 正在后台重建（这次先用不着它，下次启动会更快）');
  } catch (error) {
    console.log(`CDS 归档已过期，后台重建没起来：${error instanceof Error ? error.message : error}`);
  }
}

/** 端口上正在监听的 PID。 */
function pidsOnPort(target) {
  try {
    const lines = execFileSync('netstat', ['-ano'], { encoding: 'utf8' }).split(/\r?\n/)
      .filter((line) => new RegExp(`:${target}\\s`).test(line) && /LISTENING/i.test(line));
    return [...new Set(lines.map((line) => line.trim().split(/\s+/).pop()))];
  } catch { return []; }
}

/**
 * 端口上"跑着本项目 jar、且启动时间早于当前 jar 的 mtime"的 PID —— 也就是需要重启的陈旧实例。
 *
 * 为什么按"进程启动时间 vs jar 的 mtime"而不是直接看 jar 文件：jar 被重建覆盖时，旧进程仍持有
 * 旧内容（Windows 允许覆盖被打开的文件），磁盘上 jar 的 mtime 已经是新的 —— 只看文件看不出陈旧。
 * 只有"进程启动早于 jar 的 mtime"才说明它加载的是重建前的那一份。
 * 拿不到启动时间（非 Windows / PowerShell 不可用）时返回空数组，退化成原来的幂等行为。
 */
function staleRunningPids(target, jarPath) {
  if (process.platform !== 'win32') return [];
  let jarMtime;
  try { jarMtime = statSync(jarPath).mtimeMs; } catch { return []; }
  const portPids = pidsOnPort(target);
  if (!portPids.length) return [];
  let rows;
  try {
    rows = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='java.exe'" | ForEach-Object { $_.ProcessId.ToString() + '|' + ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() + '|' + $_.CommandLine }`,
    ], { encoding: 'utf8' }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch { return []; }
  const stale = [];
  for (const row of rows) {
    const [pid, ms, ...rest] = row.split('|');
    if (!portPids.includes(pid)) continue;
    if (!/legado-.*-all\.jar/.test(rest.join('|'))) continue;
    const start = Number(ms);
    if (Number.isFinite(start) && start > 0 && start < jarMtime) stale.push(pid);
  }
  return stale;
}

// 幂等 + 防陈旧：已经在跑时，若它跑的是比磁盘上这份 jar 更老的构建（jar 重建过、旧进程还占着端口），
// 先停旧再起新；否则只开界面 —— 重复点图标不该报"端口被占"，也不该再起第二个实例。
if (await isReady(url)) {
  const stale = staleRunningPids(runtime.port, path.join(runtime.libs, jar));
  if (!stale.length) {
    console.log(`青阅已在运行 ${url}`);
    if (args.open) openBrowser(url);
    process.exit(0);
  }
  console.log('运行中的实例比当前 jar 更旧（jar 重建过）—— 先停旧实例再起新的');
  for (const pid of stale) {
    try { execFileSync('taskkill', ['/PID', pid, '/F']); console.log(`已停止旧实例 PID ${pid}`); }
    catch (error) { console.log(`停止 PID ${pid} 失败：${error instanceof Error ? error.message : error}`); }
  }
  // 等端口真的空出来（进程退出 + 内核回收需要一点时间），否则下面的探针会误判"端口被占"
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && (await isReady(url))) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

const probe = net.createServer();
probe.once('error', (err) => {
  console.error(`端口 ${runtime.port} 不可用（${err.code}）：可能已有一个青阅在跑 —— 先 node stop.mjs，或换端口 node start.mjs --port ${runtime.port + 1}。`);
  process.exit(1);
});
probe.listen(runtime.port, runtime.host, () => {
  probe.close(async () => {
    const log = openSync(runtime.logFile, 'a');
    const javaBin = process.platform === 'win32' ? 'java.exe' : 'java';
    const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', javaBin) : javaBin;
    const jvmArgs = [
      // JDK 18+ 控制台编码默认跟随系统 ANSI（这里是 GBK），中文日志会乱码 → 显式 UTF-8。
      '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
      // 不指定的话 JVM 临时目录是 C:\Users\<用户>\AppData\Local\Temp，装到哪都会往系统盘写。
      `-Djava.io.tmpdir=${runtime.tmpDir}`,
    ];
    // CDS 类归档（tools/make-cds.mjs 生成）：冷启动实测 ~8.3s → ~5.3s。
    // 归档是跟这一份 jar 绑定的 —— 过期/缺失就不带它（这次慢一点），起完在后台重建给下次用。
    const cdsArchive = path.join(runtime.root, 'app', 'build', 'cds', 'app.jsa');
    const jarPath = path.join(runtime.libs, jar);
    const cdsFresh = existsSync(cdsArchive) && statSync(cdsArchive).mtimeMs >= statSync(jarPath).mtimeMs;
    if (cdsFresh) jvmArgs.push(`-XX:SharedArchiveFile=${cdsArchive}`);
    // detached + unref：服务作为独立进程存活，不随调用方退出而被回收。
    const child = spawn(java, [...jvmArgs, '-jar', path.join(runtime.libs, jar)], {
      env, stdio: ['ignore', log, log], detached: true, windowsHide: true,
    });
    child.unref();
    console.log(`正在启动 ${url}  PID=${child.pid}`);
    console.log(`安装目录 ${runtime.root}`);
    console.log(`数据目录 ${runtime.dataDir}`);
    console.log(`日志     ${runtime.logFile}`);
    console.log(`临时目录 ${runtime.tmpDir}`);

    const ready = await waitForHealth();
    if (!ready) {
      console.error(`等了很久服务 ${url} 还没就绪，看看日志：${runtime.logFile}`);
      process.exit(1);
    }
    console.log(`服务已就绪 ${url}`);
    if (!cdsFresh) void rebuildCds();
    if (args.open) openBrowser(url);
    else console.log('（--no-open：没有打开浏览器）');
  });
});

// 运行时位置解析：start.mjs 与 stop.mjs 共用一份，避免两边端口/路径各写一遍而飘掉。
// 优先级：.env 文件 > 进程环境变量 > 默认值。默认值全部落在安装目录内，一个字节都不写 C 盘。
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 安装目录：脚本自己所在目录，所以整个文件夹可以随意改名/搬盘；LEGADO_HOME 可显式指定。 */
export const installRoot = process.env.LEGADO_HOME
  ?? dirname(dirname(fileURLToPath(import.meta.url)));

export function readEnvFile(root = installRoot) {
  const file = process.env.LEGADO_ENV ?? join(root, '.env');
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8').split(/\r?\n/)
      .map((line) => /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)).filter(Boolean)
      .map((match) => [match[1], match[2].trim().replace(/^['"]|['"]$/g, '')]),
  );
}

/** 安装根下的 `port.txt`：界面上改端口时写的就是它（一行数字）。 */
export function readPortFile(root = installRoot) {
  const file = join(root, 'port.txt');
  if (!existsSync(file)) return null;
  const n = Number(readFileSync(file, 'utf8').trim());
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

export function resolveRuntime() {
  const file = readEnvFile();
  const pick = (name, fallback) => file[name] ?? process.env[name] ?? fallback;
  const root = installRoot;
  const dataDir = pick('LEGADO_DATA_DIR', join(root, 'data'));
  // 端口优先级：命令行 `--port`（start.mjs 自己覆盖）> `port.txt`（界面里改的那个）> `.env` / 环境变量 > 1234。
  // port.txt 排在 .env 前面：它是**使用者在界面上最后改的那一下**，比一份可能早就不记得的 .env 更算数。
  const portFromFile = readPortFile(root);
  const port = portFromFile ?? Number(pick('LEGADO_PORT', '1234'));
  return {
    root,
    libs: join(root, 'server', 'build', 'libs'),
    envFileUsed: process.env.LEGADO_ENV ?? join(root, '.env'),
    host: pick('LEGADO_HOST', '127.0.0.1'),
    port,
    portFromFile,
    dataDir,
    database: pick('LEGADO_DATABASE', join(dataDir, 'legado.sqlite')),
    // 日志与 JVM 临时目录以前一个写死在仓库根、一个默认落到系统临时目录（Windows 上是 C:\Users\<用户>\AppData\Local\Temp），装到哪都会往系统盘写；现在两者都相对安装根、可 env 覆盖。
    logFile: pick('LEGADO_LOG_FILE', join(root, 'server.log')),
    tmpDir: pick('LEGADO_TMP_DIR', join(root, 'tmp')),
    // 免登录：服务端还要求绑定地址本身就是回环，改成 0.0.0.0 会自动失效。
  };
}

export function childEnvironment(runtime) {
  return {
    ...process.env,
    ...readEnvFile(),
    // 服务端靠这个知道"安装根在哪"，界面改端口时才知道该把 port.txt 写到哪。
    LEGADO_HOME: runtime.root,
    LEGADO_HOST: runtime.host,
    LEGADO_PORT: String(runtime.port),
    LEGADO_DATA_DIR: runtime.dataDir,
    LEGADO_DATABASE: runtime.database,
  };
}

export function ensureDirectories(runtime) {
  for (const dir of [runtime.dataDir, runtime.tmpDir, dirname(runtime.logFile)]) {
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

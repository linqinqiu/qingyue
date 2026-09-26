import { execFileSync } from 'node:child_process';
import { resolveRuntime } from './scripts/runtime.mjs';

const { port } = resolveRuntime();
const lines = execFileSync('netstat', ['-ano'], { encoding: 'utf8' }).split(/\r?\n/)
  .filter((line) => new RegExp(`:${port}\\s`).test(line) && /LISTENING/i.test(line));
if (!lines.length) { console.log(`端口 ${port} 上没有在跑的服务`); process.exit(0); }

const pids = [...new Set(lines.map((line) => line.trim().split(/\s+/).pop()))];
for (const pid of pids) {
  // 只认命令行里确实是本项目 jar 的进程：按 PID 盲杀过一次，教训写在这儿。
  const info = execFileSync('powershell', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -First 1 | ForEach-Object { $_.Name + '|' + $_.CommandLine })`,
  ], { encoding: 'utf8' }).trim();
  const [name, cmd = ''] = info.split('|');
  if (!/java\.exe/i.test(name || '') || !/legado-server-.*-all\.jar/.test(cmd)) {
    console.log(`跳过 PID ${pid}：不是本项目的服务进程（${name || '未知'}）`);
    continue;
  }
  execFileSync('taskkill', ['/PID', pid, '/F']);
  console.log(`已停止 PID ${pid}（${name}）`);
}

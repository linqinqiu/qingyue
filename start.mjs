import { spawn } from 'node:child_process';
import { openSync, readdirSync } from 'node:fs';
import net from 'node:net';
import { childEnvironment, ensureDirectories, resolveRuntime } from './scripts/runtime.mjs';

const runtime = resolveRuntime();
if (!runtime.adminPassword) {
  console.error(`缺少 ADMIN_PASSWORD（读的是 ${runtime.envFileUsed}）：它同时是 WebDAV 的 Basic 凭据，不能空。`);
  process.exit(1);
}

const jars = readdirSync(runtime.libs).filter((name) => name.endsWith('-all.jar'));
if (!jars.length) { console.error(`没有 ${runtime.libs}\\*-all.jar，先跑 gradle :server:fatJar`); process.exit(1); }
const jar = jars.sort().pop();

const env = childEnvironment(runtime);
ensureDirectories(runtime);

const probe = net.createServer();
probe.once('error', (err) => {
  console.error(`端口 ${runtime.port} 不可用（${err.code}）：先跑 node stop.mjs。`);
  process.exit(1);
});
probe.listen(runtime.port, runtime.host, () => {
  probe.close(() => {
    const log = openSync(runtime.logFile, 'a');
    const java = process.env.JAVA_HOME ? process.env.JAVA_HOME + '\\bin\\java.exe' : 'java';
    const jvmArgs = [
      // JDK 18+ 控制台编码默认跟随系统 ANSI（这里是 GBK），中文日志会乱码 → 显式 UTF-8。
      '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
      // 不指定的话 JVM 临时目录是 C:\Users\<用户>\AppData\Local\Temp，装到哪都会往系统盘写。
      `-Djava.io.tmpdir=${runtime.tmpDir}`,
    ];
    // detached + unref：服务作为独立进程存活，不随调用方退出而被回收。
    const child = spawn(java, [...jvmArgs, '-jar', `${runtime.libs}\\${jar}`], {
      env, stdio: ['ignore', log, log], detached: true, windowsHide: true,
    });
    child.unref();
    console.log(`已启动 http://${runtime.host}:${runtime.port}  PID=${child.pid}`);
    console.log(`安装目录 ${runtime.root}`);
    console.log(`数据目录 ${runtime.dataDir}`);
    console.log(`日志     ${runtime.logFile}`);
    console.log(`临时目录 ${runtime.tmpDir}`);
  });
});

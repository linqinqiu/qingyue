// 一条命令跑完跨栈的活儿。前端是 npm、后端是 Gradle，中间夹一步"把 web/dist 烤进 jar"，
// 原来靠文档串三步，容易漏、也容易把顺序弄反（先打 jar 会把旧界面烤进去）。
//
// 为什么不直接在 package.json 里写 `./gradlew`：npm 在 Windows 上是用 cmd 跑 scripts 的，
// `./gradlew` 那种写法在 cmd 里不认。所以 gradle 的调用统一收在这里，按平台挑
// `gradlew.bat` / `./gradlew`。
//
// 每条都拼成一整串命令再交给 shell（而不是 `spawnSync(cmd, args, {shell:true})`）：
// 后者会触发 Node 的 DEP0190 —— shell 模式下参数不做转义、只做拼接，容易埋注入。
// 这里的命令全是本文件写死的常量，没有外部输入，但少一条警告总是好的。
//
// 用法（根 package.json 已转成这几条）：
//   npm run build   # 前端 → web/dist，再 :app:fatJar（把 web/dist 烤进 jar）
//   npm test        # 前端用例 + 服务端用例
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const gradle = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

const tasks = {
  // 顺序不能倒：processResources 是在 fatJar 那一步把 web/dist 拷进 jar 的。
  build: [
    ['1/2 前端 → web/dist', 'npm --prefix web run build'],
    ['2/2 后端 fatJar（内嵌 web/dist）', `${gradle} :app:fatJar`],
  ],
  test: [
    ['1/2 前端用例', 'npm --prefix web test'],
    ['2/2 服务端用例', `${gradle} :app:test`],
  ],
};

const name = process.argv[2];
if (!tasks[name]) {
  console.error(`用法：node scripts/tasks.mjs <${Object.keys(tasks).join(' | ')}>`);
  process.exit(2);
}

for (const [label, command] of tasks[name]) {
  console.log(`\n[${name}] ${label}\n[${name}] $ ${command}`);
  const ran = spawnSync(command, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (ran.status !== 0) {
    console.error(`\n[${name}] 失败：${label}（退出码 ${ran.status ?? 'null'}）`);
    process.exit(ran.status ?? 1);
  }
}
console.log(`\n[${name}] 完成`);

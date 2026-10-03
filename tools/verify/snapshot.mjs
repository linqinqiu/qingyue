// 改动前快照：源码树 + 一致的 SQLite 副本 + 当前构建产物指纹，落到仓库外。
// 用法：node tools/verify/snapshot.mjs [备注]
// 保留最近 5 份；数据副本用 VACUUM INTO（只读语义的一致性快照，不改源库一个字节）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

// 仓库根从脚本自己的位置算，快照落点用环境变量覆盖 —— 这两行原来写死成某个人机器上的
// 盘符路径，所以这个脚本一直进不了版本库；它要随仓库分发，就不能含任何人的目录。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEST_ROOT = process.env.LEGADO_SNAPSHOT_DIR ?? path.join(path.dirname(ROOT), 'legado-server_版本备份');
const KEEP = 5;
const SRC_DIRS = ['web/src', 'server/src', 'web/test', 'docs', 'tools/verify'];
const SRC_FILES = ['web/index.html', 'web/vite.config.ts', 'web/package.json', 'start.mjs', 'stop.mjs', 'init-mirror.gradle', 'build.gradle', 'settings.gradle', 'server/build.gradle', 'AGENTS.md', 'local-patches.diff'];
const SKIP_DIR = new Set(['out', 'node_modules', 'dist', '.git']);

const note = process.argv.slice(2).join(' ').trim();
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
const dest = path.join(DEST_ROOT, `${stamp}${note ? '_' + note.replace(/[^\w\u4e00-\u9fa5.-]+/g, '-') : ''}`);
fs.mkdirSync(path.join(dest, 'src'), { recursive: true });

const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
const copied = [];

const copyTree = (rel) => {
  const from = path.join(ROOT, rel);
  if (!fs.existsSync(from)) return;
  const stack = [[from, path.join(dest, 'src', rel)]];
  while (stack.length) {
    const [srcDir, dstDir] = stack.pop();
    fs.mkdirSync(dstDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!SKIP_DIR.has(entry.name)) stack.push([path.join(srcDir, entry.name), path.join(dstDir, entry.name)]); continue; }
      const s = path.join(srcDir, entry.name);
      fs.copyFileSync(s, path.join(dstDir, entry.name));
      copied.push(path.relative(path.join(ROOT, 'src'), path.join(dstDir, entry.name)).replace(/\\/g, '/'));
    }
  }
};
for (const rel of SRC_DIRS) copyTree(rel);
for (const rel of SRC_FILES) {
  const s = path.join(ROOT, rel);
  if (!fs.existsSync(s)) continue;
  const d = path.join(dest, 'src', rel);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(s, d);
  copied.push(rel);
}

const db = path.join(ROOT, 'data/legado.sqlite');
const dbCopy = path.join(dest, 'legado.sqlite');
let dbNote = '';
if (fs.existsSync(db)) {
  fs.rmSync(dbCopy, { force: true });
  const conn = new DatabaseSync(db);
  try { conn.prepare('VACUUM INTO ?').run(dbCopy); } finally { conn.close(); }
  dbNote = `${(fs.statSync(dbCopy).size / 1048576).toFixed(1)} MB（VACUUM INTO 一致性副本）`;
}

const jar = path.join(ROOT, 'server/build/libs/legado-server-0.1.0-all.jar');
const bundleDir = path.join(ROOT, 'web/dist/assets');
const manifest = {
  taken_at: new Date().toISOString(),
  note,
  running_jar_sha256_16: fs.existsSync(jar) ? sha256(jar) : '（无 jar）',
  served_bundles: fs.existsSync(bundleDir) ? fs.readdirSync(bundleDir).filter(f => /^index-.+\.(js|css)$/.test(f)).sort() : [],
  data_copy: dbNote || '（未复制数据库）',
  source_files: copied.length,
  restore: `源码覆盖回 ${ROOT} 对应路径；数据库先 node stop.mjs 再覆盖 data/legado.sqlite 并删除 -wal/-shm，然后 node start.mjs`,
};
fs.writeFileSync(path.join(dest, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));

const all = fs.readdirSync(DEST_ROOT).filter(n => fs.statSync(path.join(DEST_ROOT, n)).isDirectory()).sort();
for (const stale of all.slice(0, Math.max(0, all.length - KEEP))) {
  fs.rmSync(path.join(DEST_ROOT, stale), { recursive: true, force: true });
  console.log('已滚动删除旧快照', stale);
}
console.log('快照完成 →', dest);
console.log(`源码 ${copied.length} 个文件 · 数据库 ${dbNote || '未复制'} · jar ${manifest.running_jar_sha256_16}`);

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「框架目录不许夹带内容」的源码扫描判据。
 *
 * 用户要求："咱们只做框架，不要有任何自己的内容。"
 * 这句话靠人记是记不住的 —— 迟早有人往 lab/ 里塞一个"顺手"的界面。
 * 所以用判据钉住：`web/src/lab/` 只放容器与注册表，具体内容必须在 `web/src/plugins/`。
 *
 * 判的是**依赖方向**（比"有没有某个词"更本质）：
 *   plugins/ 可以 import lab/     ← 内容依赖框架，正常
 *   lab/     不许 import plugins/ ← 框架依赖内容，那就是夹带
 */

const LAB_DIR = path.resolve(import.meta.dirname, '..', 'src', 'lab')
const PLUGINS_DIR = path.resolve(import.meta.dirname, '..', 'src', 'plugins')

function filesIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map(e => path.join(dir, e.name))
}

test('框架目录 lab/ 不许 import 内容目录 plugins/（依赖方向必须是 内容→框架）', () => {
  const offenders: string[] = []
  for (const file of filesIn(LAB_DIR)) {
    const src = fs.readFileSync(file, 'utf8')
    // 匹配 import ... from '../plugins...' 或 './plugins...'
    if (/from\s+['"][^'"]*\/plugins(\/|['"])/.test(src)) {
      offenders.push(path.basename(file))
    }
  }
  assert.deepEqual(offenders, [],
    `lab/ 是框架目录，不许依赖 plugins/（内容目录）。这些文件违反了：${offenders.join(', ')}`)
})

test('内容目录 plugins/ 存在且可被框架侧按清单装载', () => {
  const files = filesIn(PLUGINS_DIR)
  assert.ok(files.length > 0, 'plugins/ 应有插件文件（否则实验室是空的）')
  const indexFile = files.find(f => path.basename(f) === 'index.ts')
  assert.ok(indexFile, 'plugins/ 应有 index.ts 作为装载清单')
})

test('框架容器 Lab.tsx 不含具体业务字样（它只该是容器）', () => {
  const labFile = path.join(LAB_DIR, 'Lab.tsx')
  assert.ok(fs.existsSync(labFile), 'Lab.tsx 应存在')
  const src = fs.readFileSync(labFile, 'utf8')
  // 容器里不该出现具体功能的名字 —— 出现就说明它在夹带内容
  for (const word of ['AiConnections', 'openai', 'api/agent', '书源', '朗读']) {
    assert.ok(!src.includes(word),
      `Lab.tsx 里出现了「${word}」—— 实验室容器不该知道任何具体功能`)
  }
})

test('框架装配点在内容目录 plugins/ 里，且不含硬编码的实验条目', () => {
  // 装配 = "决定装哪些插件"，那是内容侧的决定，所以它属于 plugins/ 而不是 lab/。
  const hostFile = path.join(PLUGINS_DIR, 'labHost.tsx')
  assert.ok(fs.existsSync(hostFile), '装配点应在 plugins/labHost.tsx（内容侧决定装什么）')
  const src = fs.readFileSync(hostFile, 'utf8')
  assert.ok(!/title:\s*['"]/.test(src), '装配点里出现了硬编码的 title —— 条目应来自插件')
  assert.ok(!/description:\s*['"]/.test(src), '装配点里出现了硬编码的 description —— 条目应来自插件')
  // 条目来源：装配点从 index.ts 取，index.ts 向注册表要。两段合起来才是"条目来自插件"，
  // 所以判据看这条链是否完整，而不是钉死在某一个文件里。
  assert.match(src, /getLabEntries\(\)/, '装配点要向清单入口取条目')
  const indexFile = path.join(PLUGINS_DIR, 'index.ts')
  assert.match(fs.readFileSync(indexFile, 'utf8'), /frontendPlugins\.labEntries\(\)/,
    '清单入口要向注册表要条目 —— 不能自己写死')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「框架目录不许夹带内容」的源码扫描判据。
 *
 * 用户要求："咱们只做框架，不要有任何自己的内容。"
 * 这句话靠人记是记不住的 —— 迟早有人往 `lab/` 里塞一个"顺手"的界面。
 * 所以用判据钉住三层：
 *
 *   lab/        容器（不认识插件、功能、扩展）
 *   extensions/ 插件契约与注册表（不认识具体插件/功能）
 *   plugins/    具体插件 + 装载清单 + 装配点
 *   features/   随程序发布的功能条目（如 AI）
 *
 * 判的是**依赖方向**（比"有没有某个词"更本质）：
 *   plugins/、features/ 可以 import lab/ 与 extensions/   ← 内容依赖框架，正常
 *   lab/、extensions/   不许 import plugins/、features/   ← 框架依赖内容，那就是夹带
 */

const SRC = path.resolve(import.meta.dirname, '..', 'src')
const LAB_DIR = path.join(SRC, 'lab')
const EXTENSIONS_DIR = path.join(SRC, 'extensions')
const PLUGINS_DIR = path.join(SRC, 'plugins')
const FEATURES_DIR = path.join(SRC, 'features')

function filesIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map(e => path.join(dir, e.name))
}

function offendersIn(dir: string, pattern: RegExp): string[] {
  const offenders: string[] = []
  for (const file of filesIn(dir)) {
    const src = fs.readFileSync(file, 'utf8')
    if (pattern.test(src)) offenders.push(path.basename(file))
  }
  return offenders
}

test('框架目录 lab/ 只放容器：不许 import 插件/功能/扩展', () => {
  const offenders = offendersIn(LAB_DIR, /from\s+['"][^'"]*\/(plugins|features|extensions)(\/|['"])/)
  assert.deepEqual(offenders, [],
    `lab/ 是容器，不许依赖内容目录。这些文件违反了：${offenders.join(', ')}`)
})

test('扩展契约 extensions/ 不许依赖具体插件或功能', () => {
  const offenders = offendersIn(EXTENSIONS_DIR, /from\s+['"][^'"]*\/(plugins|features)(\/|['"])/)
  assert.deepEqual(offenders, [],
    `extensions/ 只定义契约，不许依赖具体插件/功能。这些文件违反了：${offenders.join(', ')}`)
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

test('框架装配点在内容目录 plugins/ 里，且不含硬编码的条目', () => {
  // 装配 = "决定装哪些条目"，那是内容侧的决定，所以它属于 plugins/ 而不是 lab/。
  const hostFile = path.join(PLUGINS_DIR, 'labHost.tsx')
  assert.ok(fs.existsSync(hostFile), '装配点应在 plugins/labHost.tsx（内容侧决定装什么）')
  const src = fs.readFileSync(hostFile, 'utf8')
  assert.ok(!/title:\s*['"]/.test(src), '装配点里出现了硬编码的 title —— 条目应来自功能或插件')
  assert.ok(!/description:\s*['"]/.test(src), '装配点里出现了硬编码的 description —— 条目应来自功能或插件')
  // 条目来源：实验室自带（features）+ 插件（plugins）。两段合起来才是完整清单。
  assert.match(src, /labOwnedEntries/, '装配点要合并实验室自带的条目')
  assert.match(src, /getPluginLabEntries\(\)/, '装配点要向插件清单入口取条目')
  const indexFile = path.join(PLUGINS_DIR, 'index.ts')
  assert.match(fs.readFileSync(indexFile, 'utf8'), /frontendPlugins\.labEntries\(\)/,
    '插件清单入口要向注册表要条目 —— 不能自己写死')
})

test('实验室自带条目与插件条目是两个类别：features 里不许出现插件契约', () => {
  // features/lab/ 放的是"实验室决定要有的功能"，它们不是插件。
  const labFeatureDir = path.join(FEATURES_DIR, 'lab')
  assert.ok(fs.existsSync(labFeatureDir), 'features/lab/ 应存在（实验室自带的功能）')
  for (const name of fs.readdirSync(labFeatureDir)) {
    if (!name.endsWith('.tsx')) continue
    const src = fs.readFileSync(path.join(labFeatureDir, name), 'utf8')
    assert.ok(!src.includes('FrontendPlugin'), `features/lab/${name} 不该实现插件契约（它是实验室功能）`)
    assert.ok(!src.includes('frontendPlugins.register'), `features/lab/${name} 不该往插件注册表登记`)
  }
})

test('每条实验室条目必须显式声明 origin（lab 或 plugin）', () => {
  // 来源不能靠 badge 文字暗示 —— 那是展示层的东西，靠不住。
  const src = fs.readFileSync(path.join(FEATURES_DIR, 'labEntries.ts'), 'utf8')
  assert.match(src, /labOwnedEntries/, '清单要叫 labOwnedEntries（实验室自带）')
  // 自带的每一条都在 features/lab 或 features/ai 里，且必须写 origin: 'lab'
  for (const dir of [path.join(FEATURES_DIR, 'lab'), path.join(FEATURES_DIR, 'ai')]) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.tsx')) continue
      const body = fs.readFileSync(path.join(dir, name), 'utf8')
      if (!body.includes('LabOwnedEntry')) continue
      assert.match(body, /origin:\s*'lab'/, `${name} 声明了 LabOwnedEntry 却没写 origin: 'lab'`)
    }
  }
})

test('插件贡献的条目由注册表强制打 origin=plugin，插件自己写不算', () => {
  const src = fs.readFileSync(path.join(EXTENSIONS_DIR, 'registry.ts'), 'utf8')
  assert.match(src, /origin:\s*'plugin' as const/,
    '注册表要强制打 origin=plugin —— 否则插件能冒充成实验室自带功能')
  assert.match(src, /Omit<LabEntry, 'origin'>/,
    '插件声明条目的类型要 Omit 掉 origin —— 从类型上就不许它自己声明')
})

test('AI 是实验室功能，不是插件', () => {
  const file = path.join(FEATURES_DIR, 'ai', 'labEntry.tsx')
  assert.ok(fs.existsSync(file), 'features/ai/labEntry.tsx 应存在')
  const src = fs.readFileSync(file, 'utf8')
  assert.ok(!src.includes('FrontendPlugin'), 'AI 条目不该实现插件契约')
  assert.ok(!src.includes('frontendPlugins'), 'AI 条目不该往插件注册表里登记')
  assert.match(src, /origin:\s*'lab'/, 'AI 接入是实验室自带功能')
})

test('内置插件清单为空：产品自带的功能不再冒充插件', () => {
  const src = fs.readFileSync(path.join(PLUGINS_DIR, 'index.ts'), 'utf8')
  assert.match(src, /const BUILTIN_PLUGINS: FrontendPlugin\[\] = \[\]/,
    'BUILTIN_PLUGINS 应为空 —— 7 个主程序功能已归回 features/lab')
  assert.ok(!/from\s+['"][^'"]*features\//.test(src), '插件清单不该 import 实验室功能')
})

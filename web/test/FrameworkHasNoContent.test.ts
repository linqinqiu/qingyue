import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「框架目录不许夹带内容」的源码扫描判据。
 *
 * 用户要求："咱们只做框架，不要有任何自己的内容。"
 * 这句话靠人记是记不住的 —— 迟早有人往 `lab/` 里塞一个"顺手"的界面。
 *
 * ## 四层目录，职责不同
 *
 * ```
 * lab/         容器（不认识插件、功能、扩展）
 * extensions/  插件契约与注册表（不认识具体插件/功能）
 * plugins/     插件装配点与清单（当前不含任何插件内容）
 * features/    产品自带的内容：
 *              ├── modal/   已定型的成熟功能（更新日志/备份/关于/阅读记录/书源体检）
 *              ├── ai/      AI 接入 —— 单独一类
 *              ├── plugins/ 插件查看面板 —— 单独一类
 *              ├── settings/ 产品自带的设置分区
 *              └── labEntries.ts  实验室**待定功能**清单（当前为空）
 * ```
 *
 * ## 判的是依赖方向（比"有没有某个词"更本质）
 *
 * - `plugins/`、`features/` 可以 import `lab/` 与 `extensions/`  ← 内容依赖框架，正常
 * - `lab/`、`extensions/` 不许 import `plugins/`、`features/`    ← 框架依赖内容，那就是夹带
 */

const SRC = path.resolve(import.meta.dirname, '..', 'src')
const LAB_DIR = path.join(SRC, 'lab')
const EXTENSIONS_DIR = path.join(SRC, 'extensions')
const PLUGINS_DIR = path.join(SRC, 'plugins')
const FEATURES_DIR = path.join(SRC, 'features')

function filesIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile())
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
  assert.ok(files.length > 0, 'plugins/ 应有装配点与清单')
  const indexFile = files.find(f => path.basename(f) === 'index.ts')
  assert.ok(indexFile, 'plugins/ 应有 index.ts 作为装载清单')
})

test('框架容器 Lab.tsx 不含具体业务字样（它只该是容器）', () => {
  const labFile = path.join(LAB_DIR, 'Lab.tsx')
  assert.ok(fs.existsSync(labFile), 'Lab.tsx 应存在')
  const src = fs.readFileSync(labFile, 'utf8')
  // 容器里不该出现具体功能的名字 —— 出现就说明它在夹带内容
  for (const word of ['AiConnections', 'openai', 'api/agent', '书源', '朗读', '备份', '更新日志']) {
    assert.ok(!src.includes(word),
      `Lab.tsx 里出现了「${word}」—— 实验室容器不该知道任何具体功能`)
  }
})

test('框架装配点在内容目录 plugins/ 里，且不含硬编码的条目', () => {
  const hostFile = path.join(PLUGINS_DIR, 'labHost.tsx')
  assert.ok(fs.existsSync(hostFile), '装配点应在 plugins/labHost.tsx')
  const src = fs.readFileSync(hostFile, 'utf8')
  assert.ok(!/title:\s*['"]/.test(src), '装配点里出现了硬编码的 title —— 条目应来自清单')
  assert.ok(!/description:\s*['"]/.test(src), '装配点里出现了硬编码的 description —— 条目应来自清单')
  // 条目来源：待定功能（features/labEntries）+ 插件（plugins）。两段合起来才是完整清单。
  assert.match(src, /pendingLabEntries/, '装配点要合并待定功能条目')
  assert.match(src, /getPluginLabEntries\(\)/, '装配点要向插件清单入口取条目')
  const indexFile = path.join(PLUGINS_DIR, 'index.ts')
  assert.match(fs.readFileSync(indexFile, 'utf8'), /frontendPlugins\.labEntries\(\)/,
    '插件清单入口要向注册表要条目 —— 不能自己写死')
})

test('实验室只放待定功能：成熟功能与 AI、插件面板都不许是 LabEntry', () => {
  // 成熟功能（更新日志/备份/关于/阅读记录/书源体检）、AI 接入、插件面板
  // 都已定型或属于别的类别，不该出现在实验室条目清单里。
  for (const sub of ['modal', 'ai', 'plugins', 'settings']) {
    const dir = path.join(FEATURES_DIR, sub)
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.tsx') && !name.endsWith('.ts')) continue
      const src = fs.readFileSync(path.join(dir, name), 'utf8')
      assert.ok(!/LabOwnedEntry|LabEntry/.test(src),
        `features/${sub}/${name} 不该是实验室条目 —— 它已定型，或属于别的类别`)
    }
  }
})

test('实验室清单当前为空，且写明了为什么空', () => {
  const src = fs.readFileSync(path.join(FEATURES_DIR, 'labEntries.ts'), 'utf8')
  assert.match(src, /pendingLabEntries:\s*LabEntry\[\]\s*=\s*\[\]/, '实验室清单应为空数组')
  assert.match(src, /待定/, '要写明实验室只放待定功能')
  assert.match(src, /目前没有任何待定功能/, '要写明当前为空是如实状态')
})

test('AI 接入独立成类：不是实验室条目、不是插件', () => {
  const file = path.join(FEATURES_DIR, 'ai', 'AiModal.tsx')
  assert.ok(fs.existsSync(file), 'features/ai/AiModal.tsx 应存在')
  const src = fs.readFileSync(file, 'utf8')
  assert.ok(!src.includes('FrontendPlugin'), 'AI 不该实现插件契约')
  assert.ok(!src.includes('frontendPlugins'), 'AI 不该往插件注册表登记')
  assert.ok(!src.includes('LabOwnedEntry'), 'AI 不是实验室条目')
})

test('插件独立成类：有独立的查看面板，不占实验室条目位', () => {
  const file = path.join(FEATURES_DIR, 'plugins', 'PluginListPanel.tsx')
  assert.ok(fs.existsSync(file), 'features/plugins/PluginListPanel.tsx 应存在')
  const src = fs.readFileSync(file, 'utf8')
  assert.ok(!src.includes('LabOwnedEntry'), '插件面板不是实验室条目')
})

test('插件贡献的条目由注册表强制打 origin=plugin，插件自己写不算', () => {
  const src = fs.readFileSync(path.join(EXTENSIONS_DIR, 'registry.ts'), 'utf8')
  assert.match(src, /origin:\s*'plugin' as const/,
    '注册表要强制打 origin=plugin —— 否则插件能冒充成实验室条目')
  assert.match(src, /Omit<LabEntry, 'origin'>/,
    '插件声明条目的类型要 Omit 掉 origin —— 从类型上就不许它自己声明')
})

test('内置插件清单为空：产品自带的功能不再冒充插件', () => {
  const src = fs.readFileSync(path.join(PLUGINS_DIR, 'index.ts'), 'utf8')
  assert.match(src, /const BUILTIN_PLUGINS: FrontendPlugin\[\] = \[\]/,
    'BUILTIN_PLUGINS 应为空 —— 产品功能不该叫插件')
  assert.ok(!/from\s+['"][^'"]*features\//.test(src), '插件清单不该 import 产品功能')
})

test('成熟功能各有独立浮层，不再挂在实验室下', () => {
  // 这 5 个是已定型的成熟功能，必须是独立组件（导出 XxxModal），不是 LabEntry。
  const expected: [string, string][] = [
    ['changelogPanel.tsx', 'ChangelogModal'],
    ['backupPanel.tsx', 'BackupModal'],
    ['aboutPanel.tsx', 'AboutModal'],
    ['readingLogPanel.tsx', 'ReadingLogModal'],
    ['sourceHealthPanel.tsx', 'SourceHealthEntryModal'],
  ]
  for (const [file, exportName] of expected) {
    const full = path.join(FEATURES_DIR, 'modal', file)
    assert.ok(fs.existsSync(full), `features/modal/${file} 应存在`)
    const src = fs.readFileSync(full, 'utf8')
    assert.ok(src.includes(`export function ${exportName}`),
      `${file} 应导出 ${exportName}（独立浮层组件）`)
  }
})

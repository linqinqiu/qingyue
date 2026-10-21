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
 * lab/         容器（可悬浮窗口）—— 不认识任何具体功能
 * extensions/  插件契约与注册表 —— 不认识具体插件/功能
 * plugins/     插件（**能独立卸载、不影响核心阅读流程的功能**）
 * features/    产品自带内容：
 *              ├── ai/       AI 接入 —— 单独一类（已定型，不是可卸的扩展）
 *              ├── settings/ 产品自带的设置分区
 *              └── labEntries.ts  实验室**待定功能**清单（当前为空）
 * ```
 *
 * ## 判定标准（用户口径）
 *
 * - **插件** = 能独立卸载而不影响核心阅读流程（书架/搜索/阅读/书源/规则引擎/路由/写门/SSRF）
 * - **实验室** = 准备加入基础框架、但还没定下来的功能
 * - **AI 接入** = 单独一类
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

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function filesIn(dir: string): string[] {
  return walk(dir).filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
}

function offendersIn(dir: string, pattern: RegExp): string[] {
  return filesIn(dir)
    .filter(f => pattern.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.basename(f))
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

test('框架容器 Lab.tsx 不含具体业务字样（它只该是容器）', () => {
  const labFile = path.join(LAB_DIR, 'Lab.tsx')
  assert.ok(fs.existsSync(labFile), 'Lab.tsx 应存在')
  const src = fs.readFileSync(labFile, 'utf8')
  for (const word of ['AiConnections', 'openai', 'api/agent', '书源', '朗读', '备份', '更新日志']) {
    assert.ok(!src.includes(word),
      `Lab.tsx 里出现了「${word}」—— 实验室容器不该知道任何具体功能`)
  }
})

test('框架装配点在 plugins/ 里，且不含硬编码的条目', () => {
  const hostFile = path.join(PLUGINS_DIR, 'LabHost.tsx')
  assert.ok(fs.existsSync(hostFile), '装配点应在 plugins/LabHost.tsx')
  const src = fs.readFileSync(hostFile, 'utf8')
  assert.ok(!/title:\s*['"]/.test(src), '装配点里出现了硬编码的 title —— 条目应来自清单')
  assert.ok(!/description:\s*['"]/.test(src), '装配点里出现了硬编码的 description —— 条目应来自清单')
  assert.match(src, /pendingLabEntries/, '装配点要合并待定功能条目')
  assert.match(src, /getPluginLabEntries\(\)/, '装配点要向插件清单入口取条目')
})

test('插件清单非空，且每个插件都真的导出 FrontendPlugin', () => {
  const src = fs.readFileSync(path.join(PLUGINS_DIR, 'index.ts'), 'utf8')
  // 判定标准写进注释，别让后来人再猜一遍
  assert.match(src, /能独立卸载/, '清单里要写明"能独立卸载 → 插件"这条标准')
  const imported = [...src.matchAll(/import \{ (\w+Plugin) \} from '\.\/([^']+)'/g)]
  assert.ok(imported.length >= 5, `插件清单应至少 5 个，实际 ${imported.length}`)
  for (const [, exportName, relPath] of imported) {
    const full = path.join(PLUGINS_DIR, relPath + '.tsx')
    assert.ok(fs.existsSync(full), `插件文件不存在：plugins/${relPath}.tsx`)
    const body = fs.readFileSync(full, 'utf8')
    assert.ok(body.includes(`export const ${exportName}: FrontendPlugin`),
      `plugins/${relPath}.tsx 应导出 ${exportName}: FrontendPlugin`)
  }
})

test('实验室只放待定功能：AI 与插件都不许是 LabEntry', () => {
  // AI 接入（features/ai）与插件（plugins/）都不是实验室条目。
  for (const dir of [path.join(FEATURES_DIR, 'ai'), path.join(FEATURES_DIR, 'settings')]) {
    for (const f of filesIn(dir)) {
      const src = fs.readFileSync(f, 'utf8')
      assert.ok(!/LabOwnedEntry|LabEntry/.test(src),
        `${path.relative(SRC, f)} 不该是实验室条目 —— 它已定型，或属于别的类别`)
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

test('插件贡献的条目由注册表强制打 origin=plugin，插件自己写不算', () => {
  const src = fs.readFileSync(path.join(EXTENSIONS_DIR, 'registry.ts'), 'utf8')
  assert.match(src, /origin:\s*'plugin' as const/,
    '注册表要强制打 origin=plugin —— 否则插件能冒充成实验室条目')
  assert.match(src, /Omit<LabEntry, 'origin'>/,
    '插件声明条目的类型要 Omit 掉 origin —— 从类型上就不许它自己声明')
})

test('可独立卸载的功能都在 plugins/ 下，不在 features/', () => {
  // 判定标准落地：这 5 个能独立卸载，必须是插件。
  const expected = ['changelog', 'backup', 'about', 'reading-log', 'source-health']
  for (const name of expected) {
    const dir = path.join(PLUGINS_DIR, name)
    assert.ok(fs.existsSync(dir), `plugins/${name}/ 应存在（能独立卸载 → 插件）`)
  }
  // 反向：features/ 下不该再有这些功能的副本
  assert.ok(!fs.existsSync(path.join(FEATURES_DIR, 'modal')),
    'features/modal/ 不该再存在 —— 那些功能已判定为插件')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 前端命名与文件组织判据（对应 `docs/frontend-conventions.md`）。
 *
 * 现状是"大体统一、局部不一致"。这几条把已经在做的事钉住，
 * 防止后来人（或我自己）再引入例外 —— 规范写在文档里没人执行，
 * 三个月后就只剩文档了。
 */

const SRC = path.resolve(import.meta.dirname, '..', 'src')

/** 递归收集 src 下所有 .ts/.tsx。 */
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

const ALL = walk(SRC)
const rel = (f: string) => f.replace(SRC + path.sep, '').replaceAll('\\', '/')

test('导出方式统一：全仓零 export default', () => {
  const offenders = ALL.filter(f => /^\s*export\s+default\b/m.test(fs.readFileSync(f, 'utf8')))
  assert.deepEqual(offenders.map(rel), [],
    '一律用 named export。default 导出改名时 IDE 跟不上，也搜不到使用处')
})

test('含 JSX 的组件文件用 PascalCase（三个例外除外）', () => {
  const EXEMPT = new Set(['main.tsx', 'app/pages.tsx', 'icons.tsx'])
  const offenders: string[] = []
  for (const f of ALL) {
    if (!f.endsWith('.tsx')) continue
    const r = rel(f)
    if (EXEMPT.has(r)) continue
    const base = path.basename(f, '.tsx')
    if (!/^[A-Z]/.test(base)) offenders.push(r)
  }
  assert.deepEqual(offenders, [],
    `这些 .tsx 文件名不是 PascalCase：${offenders.join(', ')}（例外只有 main/pages/icons）`)
})

test('hooks 文件以 use 开头，且导出同名函数', () => {
  const hooks = ALL.filter(f => /(^|\/)use[A-Z][^/]*\.tsx?$/.test(rel(f)))
  assert.ok(hooks.length > 0, '应至少有一个 hook（useEscapeClose / useReaderTts）')
  for (const f of hooks) {
    const base = path.basename(f).replace(/\.tsx?$/, '')
    const src = fs.readFileSync(f, 'utf8')
    assert.ok(src.includes(`export function ${base}`) || src.includes(`export const ${base}`),
      `${rel(f)} 应导出同名函数 ${base}`)
  }
})

test('features/ 下的目录职责与文档一致', () => {
  // 四个目录各自代表一类东西，别混（详见 docs/lab-ai-plugin.md）。
  const expected = ['modal', 'ai', 'plugins', 'settings']
  for (const d of expected) {
    assert.ok(fs.existsSync(path.join(SRC, 'features', d)),
      `features/${d}/ 应存在（四类分家的一部分）`)
  }
})

test('AI 与插件不冒充实验室条目', () => {
  // 这两类已独立，不该再出现 LabEntry（详细边界见 FrameworkHasNoContent.test.ts）。
  for (const d of ['ai', 'plugins', 'modal']) {
    const dir = path.join(SRC, 'features', d)
    if (!fs.existsSync(dir)) continue
    for (const f of walk(dir)) {
      const src = fs.readFileSync(f, 'utf8')
      assert.ok(!/LabOwnedEntry|LabEntry/.test(src),
        `${rel(f)} 不该是实验室条目`)
    }
  }
})

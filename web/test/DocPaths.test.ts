import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 门面文档里的路径引用不许悬空（钉 `README.md` 与 `docs/{architecture,deploy,compatibility,code-map-frontend}.md`、`web/AGENTS.md`）。
 *
 * 为什么要单开一条：`docs/code-map-frontend.md` 这份通读注释里，路径引用有两种写法 —— markdown 链接
 * （断了 GitHub 会显示 404，人看得见）与**反引号里的裸路径**（断了什么都不会发生，只有照着找的人扑空）。
 * 实测抓到两类：① C 档拆目录之后 `web/src/lib/sourceImport.ts` 这种"搬过家"的旧路径；
 * ② 一次性脚本写在仓库外的 `tmp/`（`.gitignore` 排除 `/tmp`）里却被当成依据引用 —— 本机 `test -e` 是绿的，
 * 克隆仓库的人一样拿不到，只有 `git check-ignore` 逮得住（AGENTS 那条同形）。
 *
 * 上游项目的文件（`help/storage/BackupAES.kt` 这类）不算悬空：那种行必须写着「上游」，
 * 语义是"我们照的是谁的实现"，不是"仓库里有这个文件"。
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const DOCS = [
  'README.md',
  'docs/architecture.md',
  'docs/deploy.md',
  'docs/compatibility.md',
  'docs/code-map-frontend.md',
  'web/AGENTS.md',
]

const TRACKED = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).map(p => p.split(path.sep).join('/'))
const TRACKED_SET = new Set(TRACKED)

/** 反引号里、带一个目录层的、看着像仓库文件的路径。 */
const PATH_IN_BACKTICKS = /`([A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@/-]+\.(?:ts|tsx|kt|mjs|cjs|js|css|json|md|png|svg|yml|yaml|gradle|jar))`/g

function resolvePath(candidate: string, baseDir: string): boolean {
  // `docs/deploy.md` 里写 `../README.md` 是对的 —— 先按这份文档自己的目录把它算成仓库根路径。
  if (candidate.includes('..')) {
    const joined = path.posix.normalize(path.posix.join(baseDir, candidate))
    return TRACKED_SET.has(joined)
  }
  if (TRACKED_SET.has(candidate)) return true
  // 文档允许写短路径（`reader/readerFlow.ts`、`data/Database.kt`）：按后缀唯一匹配认一次。
  // **不做 basename 兜底** —— 那正是这条判据要逮的东西：`web/src/lib/sourceImport.ts` 在 C 档之后
  // 应该是断的（文件搬到了 `sources/`），按名字兜底就把它放过去了。
  const bySuffix = TRACKED.filter(t => t.endsWith('/' + candidate))
  return bySuffix.length === 1
}

function auditDocs(doc: string, baseDir = '.'): string[] {
  const problems: string[] = []
  doc.split(/\r?\n/).forEach((line) => {
    // 「上游」那行讲的是别人的仓库，路径本来就不在这里。
    if (line.includes('上游') || line.includes('gedoor')) return
    for (const hit of line.matchAll(PATH_IN_BACKTICKS)) {
      const p = hit[1]
      if (p.startsWith('tmp/') || p.includes('/tmp/')) { problems.push(`仓库外的临时脚本被当成引用：\`${p}\``); continue }
      if (!resolvePath(p, baseDir)) problems.push(`认不出这个路径：\`${p}\``)
    }
  })
  return problems
}

const loaded = DOCS.map(file => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')] as const)

test('门面文档里每一份都在', () => {
  for (const [file] of loaded) assert.ok(fs.existsSync(path.join(ROOT, file)), `缺文件：${file}`)
})

test('反引号里的路径引用都落在仓库里（不悬空、不引仓库外的 tmp 脚本）', () => {
  const report: string[] = []
  let checked = 0
  for (const [file, body] of loaded) {
    const hits = [...body.matchAll(PATH_IN_BACKTICKS)]
    checked += hits.length
    for (const problem of auditDocs(body, path.posix.dirname(file))) report.push(`${file}：${problem}`)
  }
  assert.ok(checked >= 80, `只解析到 ${checked} 处带目录的路径引用 —— 正则没对上，这条在演空戏`)
  assert.deepEqual(report, [], `这些引用在仓库里找不到：\n  ${report.join('\n  ')}`)
})

test('反向对照：搬过家的旧路径、仓库外的脚本、不存在的文件都必须被逮住', () => {
  const fake = [
    '| x | `web/src/lib/sourceImport.ts` 已经搬走 |',      // C 档之后的旧平铺路径（真存在过）
    '探针见 `tmp/whatever-check.mjs`',                          // 仓库外，本机可能有、库里没有
    '`web/src/does/NotExist.ts` 里',                             // 纯粹不存在
  ].join('\n')
  const problems = auditDocs(fake)
  assert.equal(problems.length, 3, `三条都该被逮住，实际 ${problems.length} 条：${problems.join(' / ')}`)

  // 同一条正则对"合规写法"不许误报：短路径按后缀能认，上游那行整行跳过，`../` 按文档自己的目录算。
  const ok = '与上游 `help/storage/BackupAES.kt` 逐字一致；算式在 `reader/readerFlow.ts`；表里写 `Database.kt`；见 `../README.md`'
  assert.deepEqual(auditDocs(ok), [], `合规写法被误报：${auditDocs(ok).join(' / ')}`)
  assert.equal(auditDocs('回根上去：`../Nope.md`').length, 1, '`../` 指到一个不存在的文件时必须报')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 验收手册的时效判据（钉 `docs/acceptance/*.md` 与 `docs/**` 的 markdown 链接）。
 *
 * 为什么单开这条：`tools/verify/opensource-hygiene-check.mjs` 把 `docs/(sessions|acceptance|proposals|decisions)/`
 * 整个当**归档**跳过扫描（它那条「教程式面不许提已删的认证」的 `only` 里就没有 acceptance）。
 * 于是"给已经删掉的功能写的操作步骤"在验收目录里一直活着：实测抓到三份
 * （`ACCEPT-015` 整份教人挂 `/webdav`；`ACCEPT-016` 与 `ACCEPT-TTS-001` 的 `docker run -e ADMIN_PASSWORD=…`
 *  与 `POST /api/auth/login` 取 CSRF；`ACCEPT-007` 写着"登录凭据：管理员密码"而同一份文件后面又说自己不设身份）。
 * 验收手册与归档的区别是**有人会照着敲**，所以它不该享受归档豁免。
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const ACCEPT_DIR = path.join(ROOT, 'docs', 'acceptance')

/**
 * 只认**会被照抄执行的形状**，不认散文里提到 —— 文档有权说明"某变量已随鉴权删除"，
 * 那种句子内不含命令行形状，不会被这里逮住（也避免本轮修完的反扫变成自打）。
 */
const DEAD_SHAPES: Array<[RegExp, string]> = [
  [/(^|\s)-e\s+ADMIN_PASSWORD|ADMIN_PASSWORD\s*=\s*\S/, 'ADMIN_PASSWORD= 这种赋值形状（鉴权已删）'],
  [/LEGADO_SECURE_COOKIES\s*=\s*\S/, 'LEGADO_SECURE_COOKIES= 这种赋值形状（鉴权已删）'],
  [/-b\s+"?legado_session|X-CSRF-Token|csrfToken/, '登录会话 / CSRF 头的用法（本服务不设身份）'],
  [/\/api\/auth\//, '/api/auth/ 端点（登录接口已整体删除）'],
  [/[:\/][\w.-]*\/webdav\b|PROPFIND|rclone config create \S+ webdav/, 'WebDAV 的挂载或动词（该服务 2026-09-29 已删）'],
]

const serverSource = (() => {
  const root = path.join(ROOT, 'server', 'src', 'main', 'kotlin')
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.kt')) out.push(fs.readFileSync(full, 'utf8'))
    }
  }
  walk(root)
  return out.join('\n')
})()

const acceptanceFiles = (): string[] => fs.readdirSync(ACCEPT_DIR, { encoding: 'utf8' })
  .filter(name => name.endsWith('.md'))
  .map(name => path.join('docs', 'acceptance', name))

function auditAcceptanceDoc(body: string): string[] {
  const problems: string[] = []
  body.split(/\r?\n/).forEach((line, at) => {
    // 明确写"已删 / 别再照抄 / 无处可用"的行是在**解释**，不是在教操作。
    if (/已删|删除|移除|不再|无处可用|0 命中|别再|没有这一项/.test(line)) return
    for (const [pattern, why] of DEAD_SHAPES) if (pattern.test(line)) problems.push(`第 ${at + 1} 行：${why}`)
  })
  return problems
}

function missingEndpoints(body: string): string[] {
  const gone: string[] = []
  for (const hit of body.matchAll(/\/api\/[a-z0-9][a-z0-9/-]*/gi)) {
    // `/api/tts/session/2689b25b-…/audio` 这种带实例 id 的，截到模板段再比。
    const tail = hit[0].replace(/^\/api/, '').replace(/\/[0-9a-f]{8}-[0-9a-f-]{20,}/i, '')
    const needle = tail.split('/').filter(Boolean).pop() ?? ''
    if (needle.length < 3) continue
    if (!serverSource.includes(`"${tail}"`) && !serverSource.includes(`/${needle}`) && !serverSource.includes(`"${needle}`)) {
      gone.push(hit[0])
    }
  }
  return [...new Set(gone)]
}

/** 相对链接的形状（markdown 链接里不是 http / mailto / 纯锚点的那一类）。每次新建一个，免得 `g` 的 lastIndex 串味。 */
const linkPattern = () => /\]\((?!https?:|mailto:|#)([^)\s]+)(?:#[^)]*)?\)/g

function brokenLinks(file: string, body: string): string[] {
  const bad: string[] = []
  const dir = path.posix.dirname(file)
  // 先把反引号里的行内代码摘掉：文档经常**举例**写 markdown 语法本身（`![图片](地址)` 这种），
  // 那不是链接，照链接去解就全是假阳性。
  const stripped = body.replace(/`[^`\n]*`/g, '·')
  for (const hit of stripped.matchAll(linkPattern())) {
    const target = hit[1]
    const candidates = [path.posix.normalize(path.posix.join(dir, target))]
    // 只有不以 `.` 开头的才可能是在写"从仓库根算起的路径"；带 `../` 的必须按所在目录算，
    // 否则会被算到仓库外面去（本机仓库同级目录里恰好有什么就该报的它反而放过）。
    if (!target.startsWith('.')) candidates.push(path.posix.normalize(target))
    if (!candidates.some(candidate => fs.existsSync(path.join(ROOT, candidate)))) bad.push(`${target}（试过 ${candidates.join('、')}）`)
  }
  return bad
}

test('验收手册里不许留着"会被照抄执行的已删形状"', () => {
  const files = acceptanceFiles()
  assert.ok(files.length >= 8, `只枚举到 ${files.length} 份验收手册 —— 目录都读不对，这条在演空戏`)
  const report: string[] = []
  for (const file of files) {
    for (const problem of auditAcceptanceDoc(fs.readFileSync(path.join(ROOT, file), 'utf8'))) report.push(`${file} ${problem}`)
  }
  assert.deepEqual(report, [], `这些手册还在教已删的功能：\n  ${report.join('\n  ')}`)
})

test('验收手册写到的每个 /api 端点都必须在服务端路由里真的存在', () => {
  const report: string[] = []
  let seen = 0
  for (const file of acceptanceFiles()) {
    const gone = missingEndpoints(fs.readFileSync(path.join(ROOT, file), 'utf8'))
    seen += 1
    for (const endpoint of gone) report.push(`${file} → ${endpoint}`)
  }
  assert.ok(seen >= 8, '一份都没扫，这条在演空戏')
  assert.deepEqual(report, [], `README 那侧早有同类门禁，验收手册这一侧没有：\n  ${report.join('\n  ')}`)
})

test('docs 树里的 markdown 相对链接必须解析得到（归档件也一样，悬空引用比不引用更坏）', () => {
  const markdown = execFileSync('git', ['ls-files', 'docs'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(name => name.endsWith('.md'))
  const report: string[] = []
  let checked = 0
  for (const file of markdown) {
    const relative = file.split(path.sep).join('/')
    const body = fs.readFileSync(path.join(ROOT, relative), 'utf8')
    for (const bad of brokenLinks(relative, body)) { report.push(`${relative} → ${bad}`); checked++ }
    checked += [...body.matchAll(linkPattern())].length
  }
  assert.ok(checked >= 40, `只解析到 ${checked} 条相对链接 —— 正则没对上，这条在演空戏`)
  assert.deepEqual([...new Set(report)], [], `这些链接指不到文件：\n  ${[...new Set(report)].join('\n  ')}`)
})

test('反向对照：四种已删形状与一条坏链接都必须被逮住', () => {
  const fake = [
    'docker run -d -e ADMIN_PASSWORD=admin123 image',
    'curl -X POST -H "X-CSRF-Token: $T" http://127.0.0.1:8080/api/auth/login',
    'curl -u legado:pw http://127.0.0.1:8080/webdav/books/a.txt',
    'LEGADO_SECURE_COOKIES=false ./gradlew :server:run',
  ].join('\n')
  const caught = auditAcceptanceDoc(fake)
  assert.ok(caught.length >= 4, `四条都该红，实际 ${caught.length} 条：${caught.join(' / ')}`)
  // 同一条判据不许把"解释自己已删"的句子当违规。
  assert.deepEqual(auditAcceptanceDoc('> `ADMIN_PASSWORD` 已随鉴权一起删除，别再往命令里写。'), [],
    '解释性的句子被误判成操作指令')

  assert.deepEqual(brokenLinks('docs/sessions/A.md', '见 [提案](../proposals/NOPE.md)'),
    ['../proposals/NOPE.md（试过 docs/proposals/NOPE.md）'], '坏链接必须报，且不许把带 ../ 的目标当仓库根路径算')
  assert.deepEqual(brokenLinks('docs/sessions/A.md', '真存在的相对链接：[提案](../proposals/PROPOSAL-015-webdav-storage-server.md)'), [],
    '真存在的相对链接被误报')
  // 举例用的 markdown 语法（写在行内代码里）不是链接 —— 这条不放过就会把整堆归档判成一片红。
  assert.deepEqual(brokenLinks('docs/sessions/A.md', '先把它换成 `![图片](地址)` 占位行'), [],
    '行内代码里的 markdown 例子被当成链接误报了')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 文档 freshness 判据（钉 `docs/code-map-frontend.md`）。
 *
 * 通读类文档最坏的失效不是写错，是**悄悄过期**：源码加了行、换了目录、加了新文件，
 * 文档还像是对的。三条判据：
 * ① 表里每一行「文件 | 行数」== 磁盘实际行数（改源码没改文档就红）；
 * ② 文档点到的文件必须真实存在，带目录前缀的还要前缀也对（悬空引用比不引用更坏）；
 * ③ `web/src` 里每一份源文件都必须在文档里出现 —— 漏一份，"全量通读"就不成立。
 *
 * 都带反向对照：解析不到行 / 枚举不到文件时直接判红，否则空正则会让前三条一起变空判。
 * 这条判据本身也栽过一次：它在 0.7.0 那条线上被 rebase 丢了三周，期间 `readerSettings.ts`
 * 与 `api.ts` 各漂了 20 多行而套件一直绿 —— 所以它回来第一件事就是先把文档数字对齐。
 */

const TEST_DIR = import.meta.dirname
const ROOT = path.resolve(TEST_DIR, '../..')
const DOC = path.join(ROOT, 'docs', 'code-map-frontend.md')

/** 与 `wc -l` 同口径：数换行符，末行没有换行符不计。 */
function lineCount(file: string): number {
  return (fs.readFileSync(file, 'utf8').match(/\n/g) ?? []).length
}

/** 递归收一棵树里的源文件：文件名 → 相对仓库根的路径。重名当场判红（按名解析要靠它唯一）。 */
function indexSources(dir: string, extensions: RegExp, label: string): Map<string, string> {
  const map = new Map<string, string>()
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!extensions.test(entry.name)) continue
      const relative = path.relative(ROOT, full).replace(/\\/g, '/')
      const previous = map.get(entry.name)
      assert.equal(previous, undefined, `${label} 里文件名不许重复：${entry.name} 同时在 ${previous ?? ''} 与 ${relative}`)
      map.set(entry.name, relative)
    }
  }
  walk(dir)
  return map
}

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : ''

/** 文档里「文件 | 行数」那一列。允许千位逗号（`3,634`），否则大文件反而逃过核对。 */
const ROW = /^\| `([^`]+\.\w+)` \| ([\d,]+) \|/
const WEB_SRC = indexSources(path.join(ROOT, 'web', 'src'), /\.(ts|tsx|css)$/, 'web/src')
const SERVER_SRC = indexSources(path.join(ROOT, 'server', 'src', 'main', 'kotlin'), /\.kt$/, 'server')
const INDEXED = [...WEB_SRC.values(), ...SERVER_SRC.values()]

/** 表里可以写裸文件名，也可以带一段目录前缀（`data/Database.kt`）；带前缀时按后缀核，顺便核"你写的目录对不对"。 */
function resolve(name: string): string | undefined {
  return WEB_SRC.get(name) ?? SERVER_SRC.get(name)
    ?? (name.includes('/') ? INDEXED.find(value => value.endsWith(name)) : undefined)
}

test('文档在，且 §2/§6 的逐文件表解析得到行', () => {
  assert.ok(fs.existsSync(DOC), `缺文件：${DOC}`)
  const rows = doc.match(new RegExp(ROW.source, 'gm')) ?? []
  assert.ok(rows.length >= 60,
    `解析到的「文件 | 行数」行太少（${rows.length}）—— 要么文档被截断，要么这条正则瞎了`)
})

test('每一行的「行数」都等于磁盘上的实际行数', () => {
  const wrong: string[] = []
  const missing: string[] = []
  let checked = 0
  for (const line of doc.split(/\r?\n/)) {
    const hit = ROW.exec(line)
    if (!hit) continue
    const [, name, statedText] = hit
    const relative = resolve(name)
    if (!relative) { missing.push(name); continue }
    checked += 1
    const actual = lineCount(path.join(ROOT, relative))
    if (actual !== Number(statedText.replace(/,/g, ''))) wrong.push(`${name}（${relative}）：文档写 ${statedText} 行，磁盘 ${actual} 行`)
  }
  assert.deepEqual(missing, [], `文档里点了不存在的路径（悬空引用比不引用更坏）：${missing.join('、')}`)
  assert.deepEqual(wrong, [], `源码改过而文档没跟着改：\n  ${wrong.join('\n  ')}`)
  assert.ok(checked >= 60, `实际核对到的行数太少（${checked}），这条判据没在做事`)
})

test('web/src 里每一份源文件都被这份文档覆盖（不许漏文件）', () => {
  const files = [...WEB_SRC.keys()]
  assert.ok(files.length >= 60, `只枚举到 ${files.length} 份源文件，递归枚举本身可疑`)
  const uncovered = files.filter(name => !doc.includes(`\`${name}\``))
  assert.deepEqual(uncovered, [],
    `这些源文件没在通读注释里出现（漏一份，"全量通读"就不成立）：${uncovered.join('、')}`)
})

test('文档正文里写死的旧平铺路径已经被目录拆分挪走的那些清掉', () => {
  // C 档之后 `web/src/api.ts` 这类引用指向不存在的位置；文档里留着它就是照着错的路径去找文件。
  // 扩展名要 tsx 在 ts 之前、并要求后面不再跟单词字符 —— 否则 `main.tsx` 会被切成 `main.ts`，
  // 于是这条自己造出一个"不存在的旧路径"假阳性（第一版就是这么红的）。
  const stale = [...doc.matchAll(/web\/src\/([A-Za-z0-9._-]+\.(?:tsx|ts|css))(?![\w-])/g)]
    .map(match => match[0])
    .filter(reference => !fs.existsSync(path.join(ROOT, reference)))
  assert.deepEqual([...new Set(stale)], [], `文档里还有指向旧平铺布局的路径：${[...new Set(stale)].join('、')}`)
})

/**
 * 行号指针核对：把一份文档正文里的行号引用逐条落到源文件上验一遍，返回"哪几条指错了"。
 * 抽成纯函数是为了能喂假文档做反向对照 —— 真文档只报"没问题"，证不了它有分辨力。
 */
function auditPointers(text: string, label: string): { checked: number; problems: string[] } {
  const problems: string[] = []
  const bodies = new Map<string, string[]>()
  const bodyOf = (name: string): string[] | null => {
    if (bodies.has(name)) return bodies.get(name) ?? null
    const relative = resolve(name)
    if (!relative) return null
    const body = fs.readFileSync(path.join(ROOT, relative), 'utf8').split(/\r?\n/)
    bodies.set(name, body)
    return body
  }
  const mentioned = (line: string, symbol: string) =>
    new RegExp(`(^|[^\\w])${symbol.replace(/\./g, '\\.')}([^\\w]|$)`).test(line)

  let checked = 0
  let sectionFile: string | null = null
  text.split(/\r?\n/).forEach(row => {
    const isHeading = /^#{2,3} /.test(row)
    if (isHeading) {
      if (/^### 2\./.test(row)) {
        const named = /`([\w.-]+\.(?:tsx?|css|kt))`/.exec(row)
        sectionFile = named ? path.basename(named[1]) : null
      } else sectionFile = null
    }
    // B 式：`file.ts:411 的 xxx`、`main.tsx:3149 App` —— 文件名写在串里，符号跟在行号后面。
    for (const hit of row.matchAll(/`([\w./-]+\.(?:tsx?|css|kt)):(\d+)(?:-(\d+))? ([A-Za-z_][\w.]*)`/g)) {
      const name = path.basename(hit[1])
      const body = bodyOf(name)
      if (!body) { problems.push(`${label}：认不出文件 ${name}`); continue }
      checked += 1
      const from = Number(hit[2]), to = Number(hit[3] ?? hit[2])
      if (from > to || to > body.length) problems.push(`${label}：${name}:${hit[2]}-${to} 越界（文件只有 ${body.length} 行）`)
      else if (!mentioned(body[from - 1], hit[4])) problems.push(`${label}：${name}:${hit[2]} 那一行没写着 ${hit[4]}`)
    }
    if (isHeading || !row.startsWith('|')) return
    const rowFile = /^\| `([^`]+\.\w+)` \|/.exec(row)
    const owner = rowFile ? path.basename(rowFile[1]) : sectionFile
    if (!owner) return
    const body = bodyOf(owner)
    if (!body) { problems.push(`${label}：认不出文件 ${owner}`); return }

    // A 式：`symbol`(`:N`) / `symbol`(`:N-:M`) —— 符号与行号配成对，指错就逮得住。
    for (const hit of row.matchAll(/`([A-Za-z_][\w.]*)`\(`:(\d+)(?:-:(\d+))?`\)/g)) {
      checked += 1
      const line = Number(hit[2])
      if (line < 1 || line > body.length || !mentioned(body[line - 1], hit[1])) {
        problems.push(`${label}：${owner} 的 \`${hit[1]}\`(\`:${line}\`) —— 那一行没写着它（文件 ${body.length} 行）`)
      }
    }
    // C 式：不带符号的裸行号段（`:26-:31`）—— 只能核"还在文件范围内"，越界就是删过代码留下的。
    const withoutAnchored = row.replace(/`[A-Za-z_][\w.]*`\(`:\d+(?:-:\d+)?`\)/g, '')
    for (const hit of withoutAnchored.matchAll(/`:(\d+)(?:-:(\d+))?`/g)) {
      checked += 1
      const from = Number(hit[1]), to = Number(hit[2] ?? hit[1])
      if (from < 1 || from > to || to > body.length) problems.push(`${label}：${owner} 的 \`:${from}-${to}\` 越界（文件 ${body.length} 行）`)
    }
  })
  return { checked, problems }
}

test('每一处行号指针都指到写着那个符号的那一行', () => {
  const { checked, problems } = auditPointers(doc, 'docs/code-map-frontend.md')
  assert.ok(checked >= 500,
    `只核到 ${checked} 处行号指针 —— 解析方式没对上，这条在演空戏（文档里光带符号的引用就 340 多处）`)
  assert.deepEqual(problems, [], `源码改过而文档的行号还指着旧位置：\n  ${problems.join('\n  ')}`)
})

test('反向对照：指错与越界的行号都必须被逮住', () => {
  const fake = '### 2.1 纯算式\n| `readerFlow.ts` | 193 | x | `flowAdvance`(`:9999`)、`:300-:400` | y |\n'
  const { checked, problems } = auditPointers(fake, '反向对照')
  assert.ok(checked >= 2, `反向对照只核到 ${checked} 处，说明扫描本身没跑`)
  assert.ok(problems.length >= 2,
    `应当至少报两条（symbol 越界、裸行号段越界），实际 ${problems.length} 条：${problems.join(' / ')}`)

  // 同一行号若真写着那个符号就不该报 —— 否则上面那些红可能只是正则瞎。
  const flow = fs.readFileSync(path.join(ROOT, WEB_SRC.get('readerFlow.ts')!), 'utf8').split(/\r?\n/)
  const declaredAt = flow.findIndex(line => /^\s*(export\s+)?(const|function)\s+flowAdvance\b/.test(line)) + 1
  assert.ok(declaredAt > 0, 'readerFlow.ts 里找不到 flowAdvance 的声明，这条反扫无从构造')
  const clean = auditPointers(`### 2.1 x\n| \`readerFlow.ts\` | 193 | x | \`flowAdvance\`(\`:${declaredAt}\`) | y |\n`, '干净样本')
  assert.deepEqual(clean.problems, [], `按声明行写的指针被误报：${clean.problems.join(' / ')}`)
})

test('章节标题里写的总量（某文件多少行、服务端多少份）与磁盘一致', () => {
  const problems: string[] = []
  const fileTotals = [...doc.matchAll(/`([\w.-]+\.(?:tsx?|css|kt))`[（ (]*([\d,]+) 行/g)]
  assert.ok(fileTotals.length >= 2, `只解析到 ${fileTotals.length} 处"N 行"式标题总量，这条在演空戏`)
  for (const hit of fileTotals) {
    const relative = resolve(hit[1])
    if (!relative) { problems.push(`认不出文件 ${hit[1]}`); continue }
    const actual = lineCount(path.join(ROOT, relative))
    if (actual !== Number(hit[2].replace(/,/g, ''))) problems.push(`${hit[1]}：标题写 ${hit[2]} 行，磁盘 ${actual} 行`)
  }
  // 整目录总量：反引号里那棵树名与「N 份 M 行」之间只隔一句限定语，按前缀认作用域。
  const treeTotals = [...doc.matchAll(/`(web\/src|server\/main\/kotlin[^`]*|server\/src\/main\/kotlin[^`]*)`[\s\S]{0,60}?(\d+) 份(?:共)? ([\d,]+) 行/g)]
  assert.ok(treeTotals.length >= 2, `只解析到 ${treeTotals.length} 处整目录总量，这条在演空戏`)
  for (const hit of treeTotals) {
    const web = hit[1] === 'web/src'
    const sources = web ? WEB_SRC : SERVER_SRC
    const sum = [...sources.values()].reduce((acc, relative) => acc + lineCount(path.join(ROOT, relative)), 0)
    const scope = web ? 'web/src' : 'server'
    if (Number(hit[2]) !== sources.size) problems.push(`${hit[1]} → ${scope} 份数：文档写 ${hit[2]}，磁盘 ${sources.size}`)
    if (sum !== Number(hit[3].replace(/,/g, ''))) problems.push(`${hit[1]} → ${scope} 总行：文档写 ${hit[3]}，磁盘 ${sum}`)
  }
  assert.deepEqual([...new Set(problems)], [], problems.join('\n  '))
})


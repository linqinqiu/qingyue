import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 这份文档 freshness 判据（`docs/code-map-frontend.md`，AI-2 的全量通读注释）。
 *
 * 通读类文档最坏的失效不是写错，是**悄悄过期**：源码加了行、删了文件、**换了目录**，文档还像是对的。
 * 所以这里钉三件事：
 * ① 表里每一行「文件 | 行数」必须与磁盘上的实际行数一致 —— 改源码没改文档就红；
 * ② 文档点到的文件名必须在树上真实存在（悬空引用比不引用更坏）；
 * ③ `web/src` 里每一份源文件都必须在这份文档里出现 —— 漏一份就等于"通读"是假的。
 *
 * C 档那轮把 `web/src` 拆成 7 个子目录（lib / reader / sources / shelf / components / pages + 根），
 * 所以这里**一律递归枚举**，按文件名解析；文档里继续用裸文件名写引用（改名要跟着一处处换的风险更小）。
 * 三条都自带反向对照：解析不到行 / 枚举不到文件时直接判红，否则空正则会让前面两条一起变空判。
 */

const TEST_DIR = import.meta.dirname
const ROOT = path.resolve(TEST_DIR, '../..')
const DOC = path.join(ROOT, 'docs', 'code-map-frontend.md')

/** 与 `wc -l` 同口径：数换行符，末行没有换行符不计。 */
function lineCount(file: string): number {
  return (fs.readFileSync(file, 'utf8').match(/\n/g) ?? []).length
}

/** 递归收一棵树里的源文件，返回「文件名 → 相对仓库根的路径」。同名文件在两个目录里出现要当场报出来。 */
function indexSources(dir: string, extensions: RegExp): Map<string, string> {
  const map = new Map<string, string>()
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!extensions.test(entry.name)) continue
      const relative = path.relative(ROOT, full).replace(/\\/g, '/')
      const previous = map.get(entry.name)
      assert.equal(previous, undefined, `源文件名不许重复：${entry.name} 同时出现在 ${previous ?? ''} 与 ${relative}`)
      map.set(entry.name, relative)
    }
  }
  walk(dir)
  return map
}

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : ''

/** 文档里「文件 | 行数」那一列。允许千位逗号（`3,634`），否则大文件反而逃过核对。 */
const ROW = /^\| `([^`]+\.\w+)` \| ([\d,]+) \|/

const WEB_SRC = indexSources(path.join(ROOT, 'web', 'src'), /\.(ts|tsx|css)$/)
const SERVER_SRC = indexSources(path.join(ROOT, 'server', 'src', 'main', 'kotlin'), /\.kt$/)

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
    const stated = Number(statedText.replace(/,/g, ''))
    // 文档可以写裸文件名，也可以带一段目录前缀（`data/Database.kt`）。文件名在这两棵树里唯一
    // （上面 indexSources 对重名直接判红），所以带前缀时按后缀比：既核行数，也核"你写的目录对不对"。
    const indexed = [...WEB_SRC.values(), ...SERVER_SRC.values()]
    const relative = WEB_SRC.get(name) ?? SERVER_SRC.get(name)
      ?? (name.includes('/') ? indexed.find(value => value.endsWith(name)) : undefined)
      ?? ['', 'web', 'web/test'].map(dir => path.join(ROOT, dir, name))
        .find(candidate => fs.existsSync(candidate))?.slice(ROOT.length + 1).replace(/\\/g, '/')
    if (!relative) { missing.push(name); continue }
    checked += 1
    const actual = lineCount(path.join(ROOT, relative))
    if (actual !== stated) wrong.push(`${name}（${relative}）：文档写 ${stated} 行，磁盘 ${actual} 行`)
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

test('文档正文里写死的旧平铺路径已经被 C 档挪走的那些清掉', () => {
  // 目录拆分之后，`web/src/api.ts` 这类引用会指向不存在的位置；判据读的是**磁盘**，所以必须当场逮住。
  const stale = [...doc.matchAll(/web\/src\/([A-Za-z0-9._-]+\.(?:ts|tsx|css))/g)]
    .map(match => match[0])
    .filter(reference => !fs.existsSync(path.join(ROOT, reference)))
  assert.deepEqual([...new Set(stale)], [], `文档里还有指向旧平铺布局的路径：${[...new Set(stale)].join('、')}`)
})

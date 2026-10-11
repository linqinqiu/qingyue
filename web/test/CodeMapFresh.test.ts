import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 这份文档 freshness 判据（`docs/code-map-frontend.md`，AI-2 的全量通读注释）。
 *
 * 通读类文档最坏的失效不是写错，是**悄悄过期**：源码加了行、删了文件，文档还像是对的。
 * 所以这里钉两件事：
 * ① 表里每一行「文件 | 行数」必须与磁盘上的实际行数一致 —— 改源码没改文档就红；
 * ② `web/src` 里每一份源文件都必须在这份文档里出现 —— 不许漏文件（漏一份就等于"通读"是假的）。
 *
 * 两条都自带反向对照：解析不到行 / 枚举不到文件时直接判红，否则空正则会让前面两条一起变空判。
 */

const TEST_DIR = import.meta.dirname
const ROOT = path.resolve(TEST_DIR, '../..')
const DOC = path.join(ROOT, 'docs', 'code-map-frontend.md')

/** 与 `wc -l` 同口径：数换行符，末行没有换行符不计。 */
function lineCount(file: string): number {
  return (fs.readFileSync(file, 'utf8').match(/\n/g) ?? []).length
}

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : ''

/** 文档里「文件 | 行数」那一列。允许千位逗号（`3,633`），否则大文件反而逃过核对。 */
const ROW = /^\| `([^`]+\.\w+)` \| ([\d,]+) \|/
const ROW_SRC = new RegExp(ROW.source, 'gm')

test('文档在，且 §2/§6 的逐文件表解析得到行', () => {
  assert.ok(fs.existsSync(DOC), `缺文件：${DOC}`)
  const rows = doc.match(ROW_SRC) ?? []
  assert.ok(rows.length >= 60,
    `解析到的「文件 | 行数」行太少（${rows.length}）—— 要么文档被截断，要么这条正则瞎了`)
})

test('每一行的「行数」都等于磁盘上的实际行数', () => {
  const wrong: string[] = []
  const missing: string[] = []
  let checked = 0
  const dirs = ['web/src', 'web', 'web/test', '', 'server/src/main/kotlin/io/legado/server']
  for (const line of doc.split(/\r?\n/)) {
    const hit = ROW.exec(line)
    if (!hit) continue
    const [, name, statedText] = hit
    const stated = Number(statedText.replace(/,/g, ''))
    const file = dirs.map(dir => path.join(ROOT, dir, name))
      .find(candidate => fs.existsSync(candidate))
    if (!file) { missing.push(name); continue }
    checked += 1
    const actual = lineCount(file)
    if (actual !== stated) wrong.push(`${name}：文档写 ${stated} 行，磁盘 ${actual} 行`)
  }
  assert.deepEqual(missing, [], `文档里点了不存在的路径（悬空引用比不引用更坏）：${missing.join('、')}`)
  assert.deepEqual(wrong, [], `源码改过而文档没跟着改：\n  ${wrong.join('\n  ')}`)
  assert.ok(checked >= 60, `实际核对到的行数太少（${checked}），这条判据没在做事`)
})

test('web/src 里每一份源文件都被这份文档覆盖（不许漏文件）', () => {
  const files = fs.readdirSync(path.join(ROOT, 'web', 'src'))
    .filter(name => /\.(ts|tsx|css)$/.test(name))
  assert.ok(files.length >= 60, `只枚举到 ${files.length} 份源文件，枚举本身可疑`)
  const uncovered = files.filter(name => !doc.includes(`\`${name}\``))
  assert.deepEqual(uncovered, [],
    `这些源文件没在通读注释里出现（漏一份，"全量通读"就不成立）：${uncovered.join('、')}`)
})

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * 默认扫全部会分发的 markdown，而不是写死一份：旧 README 里有两处表格被断句撑坏
 * （一行中文落在表格中间、环境变量表少一列），这份门禁当时只看着 `docs/实现说明.md`，
 * 所以那两份破损一直绿着（2026-10-03 重写 README 时才发现）。
 * 给一个路径参数就只查那一份。
 */
const targets = process.argv[2]
  ? [process.argv[2]]
  : ['README.md', 'CHANGELOG.md', 'docs/architecture.md', 'docs/deploy.md', 'docs/compatibility.md', 'docs/AI-AGENT.md']

const count = row => (row.match(/(?<!\\)\|/g) ?? []).length

const checkFile = target => {
  const file = path.join(ROOT, target)
  if (!fs.existsSync(file)) return [`缺失：${target}（门禁列了它，文件却不在）`]
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  let header = null
  let headerCells = 0
  const bad = []
  lines.forEach((line, index) => {
    const text = line.trim()
    const isRow = text.startsWith('|') && text.endsWith('|') && text.length > 1
    if (!isRow) {
      header = null
      return
    }
    if (header === null) {
      header = index + 1
      headerCells = count(text)
    } else if (count(text) !== headerCells) {
      bad.push(`${target} line ${index + 1}: expected ${headerCells} pipes, got ${count(text)} — ${text.slice(0, 60)}`)
    }
  })
  return bad
}

let failed = 0
for (const target of targets) {
  const bad = checkFile(target)
  failed += bad.length
  for (const row of bad) console.log(row)
  if (bad.length === 0) console.log(`OK ${target}: 所有表格行列数一致`)
}
process.exit(failed === 0 ? 0 : 1)

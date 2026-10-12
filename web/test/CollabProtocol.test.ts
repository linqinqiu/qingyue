/**
 * 协作规程的判据 —— 治的是"规则散在四份文件里、没人能一眼看出轮到谁"。
 *
 * 这些检查全部钉**结构**：结构缺了就红（少一节、少一个状态板字段、领地表两边重叠、
 * 日志头把规则复述了一遍）。它不判文字好不好看。
 * 规程本身在 `docs/dual-ai/README.md`，那份文件是唯一出处；这里红的时候改的是它的结构，不是这条判据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const docs = (...parts: string[]) => path.resolve(import.meta.dirname, '..', '..', ...parts)
const read = (...parts: string[]) => fs.readFileSync(docs(...parts), 'utf8')

const PROTOCOL = read('docs', 'dual-ai', 'README.md')
const MY_LOG = read('docs', 'dual-ai', 'COORDINATION-ai2.md')

/** 规程必须回答的那六件事，少一件就是"不能指导具体情况"。 */
const REQUIRED_SECTIONS = ['领地', '情况', '状态板', '发版', '红因', '违规']

test('规程文件把六件事都单列成一节', () => {
  const headings = PROTOCOL.split('\n').filter(line => line.startsWith('## '))
  assert.ok(headings.length >= 6, `规程只有 ${headings.length} 个二级小节`)
  for (const keyword of REQUIRED_SECTIONS) {
    assert.ok(
      headings.some(h => h.includes(keyword)),
      `规程里缺「${keyword}」这一节 —— 缺的那一类情况就没有可照做的答案`,
    )
  }
})

test('情况表每一行都给得出「动作」与「自检」，且多数行给了能直接跑的命令', () => {
  const section = PROTOCOL.split(/^## /m).find(chunk => chunk.startsWith('2. 情况'))
  assert.ok(section, '规程里没有「2. 情况」这一节')
  const rows = (section as string).split('\n')
    .filter(line => line.startsWith('|'))
    // 去掉表头与分隔行
    .filter(line => !/^\|\s*:?-+/.test(line) && !line.includes('自检命令'))
  assert.ok(rows.length >= 10, `情况表只有 ${rows.length} 行 —— 覆盖不了实际会遇到的情况，等于没有指导`)
  const thin = rows.filter(line => line.split('|').slice(1, -1).some(cell => cell.trim() === ''))
  assert.equal(thin.length, 0, `有 ${thin.length} 行表格有空单元格：\n${thin.slice(0, 2).join('\n')}`)
  // 至少 6 行的自检格给了能贴进终端的东西（反引号里的命令），其余允许写"看状态板"这类去处
  const withCommand = rows.filter(line => /`(git|npm|node|grep|curl|npx)/.test(line))
  assert.ok(withCommand.length >= 6, `只有 ${withCommand.length} 行给了可执行自检 —— 剩下的都是"原则上应该"`)
})

test('领地表两边不许重叠 —— 同一个路径不能两个都声称归自己', () => {
  const territoryRows = PROTOCOL.split('\n').filter(line => line.startsWith('| `') || line.includes('**AI-1**') || line.includes('**AI-2**'))
  const grab = (marker: string) => {
    const row = territoryRows.find(line => line.includes(marker))
    assert.ok(row, `领地表里没有「${marker}」那一行`)
    return [...(row as string).matchAll(/`([^`]+?)`/g)].map(m => m[1].replace(/\/\*\*$/, '').replace(/\*\*$/, ''))
  }
  const mine = grab('**AI-2**')
  const theirs = grab('**AI-1**')
  assert.ok(mine.length >= 6 && theirs.length >= 8, `领地清单被删薄了：AI-2 ${mine.length} 项 / AI-1 ${theirs.length} 项`)
  const clash = mine.filter(item => theirs.includes(item))
  assert.deepEqual(clash, [], `两边都声称归自己的路径：${clash.join(' , ')}`)
  // 反向对照：真重叠时必须逮得住（用同样形状造一条数据，不靠注释自证）
  const naive = ['web/**', 'docs/dual-ai/README.md'].filter(item => ['server/**', 'docs/dual-ai/README.md'].includes(item))
  assert.deepEqual(naive, ['docs/dual-ai/README.md'], '这个重叠检测本身失效了，上面那条就是恒真')
})

test('日志头部只指路，不复述规则（复述就是下一次错乱的来源）', () => {
  const head = MY_LOG.split('\n').slice(0, 6).join('\n')
  assert.match(head, /README\.md/, 'AI-2 日志头部没指回规程')
  assert.doesNotMatch(head, /格式：## \[日期\]|类型为 `TASK`/,
    '日志头部又把类型的清单抄了一遍 —— 规程改了这里不会跟着改，正是"同一个真相写两处"')
})

const BOARD_FIELDS = ['更新时间', '我现在在做', '下一件事', '等对方', '待发版', '我的领地', '我不碰', '自测实例']

test('状态板字段齐全，问「轮到谁」只看这一节', () => {
  const board = MY_LOG.split(/^## /m)[1] ?? ''
  assert.match(board, /状态板/, '日志第一节不是状态板')
  for (const field of BOARD_FIELDS) {
    assert.ok(board.includes(`| ${field} |`), `状态板缺「${field}」这一行`)
  }
  const empty = BOARD_FIELDS.filter(field => {
    const line = board.split('\n').find(l => l.startsWith(`| ${field} |`)) ?? ''
    return line.split('|').slice(1, -1).every(cell => cell.trim() === '')
  })
  assert.deepEqual(empty, [], `状态板有空白字段：${empty.join(' , ')} —— 空着的字段等于没回答`)
})

const ENTRY_TYPES = ['TASK', 'API-REQUEST', 'API-CHANGE', 'COLLAB-REQUEST', 'NOTE', 'BLOCKER', 'RELEASE']
const LENGTH_RULE_CUTOFF = '2026-10-12'

test('日志条目格式合规，长度纪律从生效日起判', () => {
  const headers = MY_LOG.split('\n').filter(line => line.startsWith('## ['))
  assert.ok(headers.length >= 10, `日志条目只剩 ${headers.length} 条`)
  const badShape = headers.filter(line => !new RegExp(`^## \\[\\d{4}-\\d{2}-\\d{2}\\] (${ENTRY_TYPES.join('|')}) \\S`).test(line))
  assert.deepEqual(badShape, [], `条目头不合规：${badShape.slice(0, 3).join(' ⏎ ')}`)

  // 逐条切成 {日期, 正文行数}。日期必须是头那 10 个字符 —— 切片切错了，下面的跳过就全错（我自己就是这么空过去的）
  const entries = headers.map((header, position) => {
    const date = header.slice(4, 14)
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `第 ${position + 1} 条的日期解析不出来：「${date}」`)
    const start = MY_LOG.indexOf(header)
    const next = headers.slice(position + 1).map(l => MY_LOG.indexOf(l)).find(index => index > start) ?? MY_LOG.length
    const body = MY_LOG.slice(start + header.length, next).split('\n')
      .filter(line => line.trim() !== '' && !line.startsWith('|') && !line.startsWith('#'))
    return { date, lines: body.length }
  })

  // 长度纪律只判 cutoff 之后写的条目；老条目是历史，不回头改。跳过多少必须显式断出来，不然这条会演空戏。
  let checked = 0
  let skipped = 0
  const tooLong: string[] = []
  for (const entry of entries) {
    if (entry.date < LENGTH_RULE_CUTOFF) { skipped += 1; continue }
    checked += 1
    if (entry.lines > 12) tooLong.push(`${entry.date} — ${entry.lines} 行`)
  }
  assert.equal(entries.length, headers.length, '条目切分与条目头数量不一致 —— 判据在数错东西')
  assert.equal(skipped + checked, entries.length, `扫过的条目数对不上（跳过 ${skipped} + 判过 ${checked} ≠ 共 ${entries.length}）`)
  assert.ok(skipped >= 10, `只扫到 ${skipped} 条老条目 —— 解析方式没对上，这条判据在演空戏`)
  assert.equal(tooLong.length, 0, `正文超 12 行的条目（表格不计）：${tooLong.join(' · ')}`)
})

/**
 * 协作文档的表格自检：`\|` 是"这一格里的竖线"，不是列边界（规程与日志的表格里大量出现
 * `'a' \| 'b'` 这种取值集合与 grep 模式）。`tools/verify/md-table-check.mjs` 只覆盖
 * README / AGENTS / CHANGELOG / 实现说明，这三份协作文档没人管 —— 少一根竖线在渲染后
 * 只是"某一格变窄"，谁都不报错，但内容已经错位。
 */
const ESCAPED_PIPE = String.fromCharCode(92, 124)
const cellsOf = (line: string) => line.split(ESCAPED_PIPE).join('〈pipe〉').split('|').slice(1, -1)

test('协作文档的表格每行列数一致，且没有空格子', () => {
  const files = ['docs/dual-ai/README.md', 'docs/dual-ai/COORDINATION-ai2.md', 'docs/dual-ai/RESTART-ai2.md',
    // AI-2 自己维护的那几份门面/注释文档一起管：少一根竖线在渲染后只是"某格变窄"，谁都不报错，内容已经错位。
    'docs/compatibility.md', 'docs/code-map-frontend.md', 'docs/architecture.md', 'docs/deploy.md', 'README.md']
  let tables = 0
  const problems: string[] = []
  for (const file of files) {
    let header: number | null = null
    read(file).split(/\r?\n/).forEach((line, index) => {
      if (!line.startsWith('|')) { header = null; return }
      const cells = cellsOf(line)
      const atHeader = header === null
      // 「行标签 × 列」这种矩阵表，表头左上角那一格天生是空的（README 的「环境要求」就是这张）：
      // 只放过**表头行的第一格**，其余一格都不许空 —— 放宽整行就把真正漏填的格子也放过去了。
      const blanks = cells.filter((cell, at) => (atHeader && at === 0) ? false : cell.trim() === '').length
      if (blanks) problems.push(`${file} 第 ${index + 1} 行有 ${blanks} 个空格子`)
      if (atHeader) { header = cells.length; tables += 1; return }
      if (cells.length !== header) problems.push(`${file} 第 ${index + 1} 行 ${cells.length} 列 vs 表头 ${header}`)
    })
  }
  assert.ok(tables >= 6, `只认出 ${tables} 张表格 —— 扫描方式没对上，这条在演空戏`)
  assert.deepEqual(problems, [], problems.slice(0, 5).join(' ; '))
})

test('架构文档的「改动边界」一节指回规程，不自己写一份', () => {
  const arch = read('docs', 'architecture.md')
  const section = arch.split(/^## /m).find(chunk => chunk.startsWith('7.')) ?? ''
  assert.match(section, /README\.md/, 'architecture.md 的改动边界没引用规程')
  assert.ok(section.split('\n').length <= 8, '那一节又开始自己复述分工了 —— 只许留一句指路')
})

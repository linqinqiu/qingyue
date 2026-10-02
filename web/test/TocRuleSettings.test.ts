import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { defaultReaderSettings, parseTocRuleKey, ttsSessionKey } from '../src/readerSettings'

/**
 * 「阅读设置 → 本地书目录」（用户 2026-10-02：「txt目录规则，这个可以放到阅读设置里」）。
 * 端到端那一条在 `tools/verify/toc-rule-check.mjs`（真造一本书、真换规则、量章数差），
 * 这里只钉三件静态就能判的事：脏值回落、别污染朗读会话、面板与导入确实接上了。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('parseTocRuleKey - 只认形状不硬编码清单（合法取值来自服务端，前端抄一份迟早漂移）', () => {
  assert.equal(defaultReaderSettings.txtTocRule, 'auto', '默认让服务端按正文打分选')
  for (const ok of ['auto', 'builtin', '-1', '-24', '7']) {
    assert.equal(parseTocRuleKey(ok), ok, `${ok} 是合法键`)
  }
  assert.equal(parseTocRuleKey('  -8  '), '-8', '两端空白要清掉')
  for (const junk of ['', '   ', 'AUTO', '- 1', 'a;DROP', '-1234567', '1.5', 'auto\n', undefined, null, 42, {}]) {
    assert.equal(parseTocRuleKey(junk), 'auto', `${JSON.stringify(junk)} 该回落到默认而不是原样存进去`)
  }
})

test('目录规则不参与朗读会话身份（换规则不该打断正在读的那一句）', () => {
  const base = { ...defaultReaderSettings }
  const changed = { ...defaultReaderSettings, txtTocRule: '-12' }
  assert.equal(ttsSessionKey(base), ttsSessionKey(changed),
    'txtTocRule 进了 ttsSessionKey 的话，改目录规则会把正在播的朗读打断')
})

test('这一组不只在读本地书时才出现（用户：「txt目录规则你也没有做啊」）', () => {
  const reader = read('../src/ReaderScreen.tsx')
  assert.ok(!reader.includes('!!localBook && (tocRuleOptions'), '整组的门槛不许是"正在读本地书"')
  assert.ok(reader.includes('{(tocRuleOptions?.length ?? 0) > 0 && ('), '只看规则清单取到没有，与是不是本地书无关')
  assert.match(reader, /\{!!localBook && onReparseLocal/, '"重切"这个动作仍然只对着正在读的那本本地书')
  // 不打开任何书也要能设默认值：自定义弹窗里有一份
  const customize = read('../src/CustomizeModal.tsx')
  assert.match(customize, /本地书分章规则/, '「自定义」里有这一组')
  assert.match(customize, /api\.tocRules\(\)/, '它自己去服务端取规则清单')
  assert.match(customize, /txtTocRule/, '写的就是同一个设置项，不是又造一份状态')
  // 备份里那份要真的能套用到服务端规则表（不是只"收下"）
  const backup = read('../src/BackupPage.tsx')
  assert.match(backup, /api\.applyTocRulesFromBackup\(\)/, '备份页对这条有真的套用动作')
  assert.match(backup, /TXT 分章规则/, '「这个包会恢复什么」清单里说得出它能套用')
  const store = read('../../server/src/main/kotlin/io/legado/server/BackupStore.kt')
  assert.match(store, /APPLYABLE_NAMES = listOf\([^)]*"txtTocRule\.json"/, '服务端也把这条标成可套用（界面上的按钮按它出现）')
})

test('设置面板与导入都接上了（不只是一个能改的 localStorage 值）', () => {
  const reader = read('../src/ReaderScreen.tsx')
  assert.match(reader, /setting-label">本地书目录/, '面板里有这一组')
  assert.match(reader, /ariaLabel="TXT 目录规则"/, '用的是站内 Select，不是原生 select')
  assert.match(reader, /按这条规则重新识别目录/, '有"重切"这个动作，不是选了不生效')
  assert.match(reader, /api\.reparseLocalBook/, '重切真的打到服务端')
  assert.match(reader, /setShelfTocRule\(item\?\.tocRule/, '面板显示的是这本书**实际**用的规则，不是设置框里高亮的那条')
  const main = read('../src/main.tsx')
  assert.match(main, /api\.importLocalBooks\(list, loadReaderSettings\(\)\.txtTocRule\)/, '导入时带上当前选择')
})

/**
 * 「txt目录规则没有做好」（用户 2026-10-03）。根因不是规则不够，是一个旗标兼了两件事：
 * 选择清单只发"启用的"那 12 条，于是另外 12 条（章回体「第N回」这类都在里面）
 * 既看不见也选不了，而界面上根本没有启用开关。
 */
test('手动可选 与 参与自动打分 是两件事，界面和服务端都按两件事做', () => {
  const routes = read('../../server/src/main/kotlin/io/legado/server/Routes.kt')
  assert.match(routes, /TocRules\.all\.map/, '清单发的是全表，不再是 candidates')
  assert.doesNotMatch(routes, /options = listOf\([\s\S]{0,220}\+ TocRules\.candidates\.map/,
    'candidates 只能用于自动打分，拿它当选择清单就是把 12 条规则藏起来')
  assert.match(routes, /post\("\/books\/toc-rules\/toggle"\)/, '有开关这条规则的入口')
  const model = read('../../server/src/main/kotlin/io/legado/server/TxtTocRule.kt')
  assert.match(model, /val selectable: List<TxtTocRule> get\(\) = all\.filter \{ compiles\(it\.id\) \}/,
    '可选只看用不用得了，不看 enable')
  assert.match(model, /fun compiles\(id: Int\): Boolean = id == PACKAGED_BUILTIN_ID \|\| compile\(id\) != null/,
    '内置那条（id -100）没有正则但不算坏规则')
  assert.match(model, /fun setEnable\(id: Int, enable: Boolean\)/)

  const api = read('../src/api.ts')
  assert.match(api, /toggleTocRule: \(key: string, enable: boolean\)/)
  assert.match(api, /enable\?: boolean; broken\?: boolean/, '选项要带得上"参不参与自动"和"正则坏没坏"')

  const modal = read('../src/CustomizeModal.tsx')
  assert.match(modal, /tocPickable = \(tocRules\?\.options \?\? \[\]\)\.filter\(option => !option\.broken\)/,
    '默认规则选择器列的是全部能用的规则')
  assert.match(modal, /tocRuleRows/, '另有一张规则清单（开关在那儿，不在选择器里）')
  assert.match(modal, /aria-label=\{`\$\{rule\.label\} 参与自动选择`\}/, '开关说的是它真正管的那件事')
  assert.match(modal, /<code title=\{rule\.rule\}>/, '正则原文要露出来，否则没人判断得了它适不适合自己的书')
  assert.match(modal, /手动选一条不需要先"启用"它/, '界面文案把这两件事分开讲')

  const reader = read('../src/ReaderScreen.tsx')
  assert.match(reader, /\.filter\(option => !option\.broken\)/, '阅读设置里那颗选择器同样排除坏正则')
  assert.match(reader, /（不参与自动）/, '选得到但不打分的那几条要标出来，别让人以为勾了就等于生效')
})

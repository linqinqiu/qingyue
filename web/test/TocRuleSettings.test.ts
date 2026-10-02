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

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { autoTagBatches, HEALTH_TAGS } from '../src/sources/sourceGrouping'

/**
 * 「书源体检，除非点击了关闭，其他情况都后台持续体检一直到结束，
 *  体检获得的内容在体检的过程中去给不能正常使用的分好组」（用户 2026-10-02）。
 *
 * 两件事分开钉：**哪些源该在过程中被自动分组**是纯算术，直接喂数据判；
 * "跑在组件外面"是生命周期，只能钉源码结构（判据是"卸载回调里不许出现停止"）。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('过程中的自动分组 - 只圈不能正常使用的，且只打标签', () => {
  const rows = [
    { id: 'ok', statusCategory: 'valid' },
    { id: 'slow', statusCategory: 'slow' },
    { id: 'dead', statusCategory: 'unreachable' },
    { id: 'broken', statusCategory: 'broken' },
    { id: 'login', statusCategory: 'needs_login' },
    { id: 'unknown', statusCategory: 'something_new' },
  ]
  const buckets = autoTagBatches(rows, {}, new Set())
  const byTier = new Map(buckets.map(item => [item.tier, item.ids]))
  assert.deepEqual(byTier.get('bad'), ['dead', 'broken'], '连不上与规则失效进「体检异常」')
  assert.deepEqual(byTier.get('pending'), ['login', 'unknown'], '需登录与认不出的进「体检待确认」，不当成坏')
  assert.deepEqual(byTier.get('good') ?? [], [], '可用的不在这里自动打 —— "可用"是一整轮的结论，跑了一半不该盖')
  assert.deepEqual([...byTier.keys()].sort(), ['bad', 'pending'])
})

test('过程中的自动分组 - 已经打上和本轮已经写过的都不重复写', () => {
  const rows = [{ id: 'a', statusCategory: 'unreachable' }, { id: 'b', statusCategory: 'unreachable' }]
  assert.deepEqual(autoTagBatches(rows, { a: `小说 ${HEALTH_TAGS.bad}`, b: '' }, new Set()), [{ tier: 'bad', ids: ['b'] }],
    '带着我们那档标签的不再写第二遍')
  assert.deepEqual(autoTagBatches(rows, {}, new Set(['a', 'b'])), [],
    '本轮已经写过的不重复写（客户端的 sources 要等刷新才是新的）')
  assert.deepEqual(autoTagBatches(rows, { a: '小说 体检待确认', b: '' }, new Set()),
    [{ tier: 'bad', ids: ['a', 'b'] }], '带着别的档标签的仍要补上它这一档')
})

test('体检跑在弹窗组件之外：卸载不再顺手取消', () => {
  const modal = read('../src/sources/SourceHealthModal.tsx')
  assert.match(modal, /const run = useHealthRun\(\)/, '弹窗是订阅者，不是运行时的持有者')
  assert.match(modal, /if \(!getHealthRun\(\)\.running && scoped\.length/, '已经有一轮在跑就不再开第二轮')
  assert.doesNotMatch(modal, /return \(\) => \{[\s\S]{0,160}cancel/, '卸载回调里不许再出现取消')
  assert.doesNotMatch(modal, /cancelledRef\.current\s*=/, '组件里不该还留着"卸载就置位"的那个开关（注释里提历史不算）')
  assert.match(modal, /aria-label=\{running \? '收起窗口（体检继续在后台跑）'/, '收起这个动作要说清它不停止体检')
  const store = read('../src/sources/sourceHealthRun.ts')
  assert.match(store, /export function stopHealthRun/, '只有显式停止这一个入口')
  assert.match(store, /autoTagBatches/, '分组是在批次循环里做的，不是等跑完再补')
})

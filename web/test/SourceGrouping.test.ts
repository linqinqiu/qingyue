import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGroupingPlan,
  currentTiers,
  HEALTH_TAGS,
  tagPlan,
  tierOf,
} from '../src/sourceGrouping'

/**
 * 用户 2026-09-30：「书源体检……不能根据获得信息正确规划分组」。
 * 这一组测的是"把体检结论变成分组标签"的那套规则，重点是两条红线：
 * ① 只追加，不覆盖书源自带的 `bookSourceGroup`；
 * ② 认不出来的状态一律算"待确认"，不许凭猜测判源已死（上一轮把 4,874 个源停成 2 个就是这类误判）。
 */

test('体检档位 - 只有明确连不上才算异常，其余未知都进待确认', () => {
  assert.equal(tierOf('valid'), 'good')
  assert.equal(tierOf('slow'), 'good')
  assert.equal(tierOf('unreachable'), 'bad')
  assert.equal(tierOf('tls'), 'bad')
  assert.equal(tierOf('broken'), 'bad')
  assert.equal(tierOf('invalid'), 'bad')
  for (const state of ['empty', 'blocked', 'needs_login', 'needs_webview']) assert.equal(tierOf(state), 'pending')
  // 以后服务端加新状态时，默认落"待确认"而不是"异常" —— 宁可让人看一眼，不要自动判死
  assert.equal(tierOf('brand_new_category'), 'pending')
  assert.equal(tierOf(''), 'pending')
})

test('标签计划 - 追加而不覆盖原有分组', () => {
  assert.equal(tagPlan('网络小说 精品', ['good']), '网络小说 精品 体检可用')
  assert.equal(tagPlan('网络小说,精品', ['bad']), '网络小说 精品 体检异常')
  assert.equal(tagPlan('', ['pending']), '体检待确认')
  assert.equal(tagPlan(undefined, ['good']), '体检可用')
  // 重复打同一个标签不该长出一串
  assert.equal(tagPlan('网络小说 体检可用', ['good']), '网络小说 体检可用')
})

test('标签计划 - 撤销只摘我们自己的标签，用户写的原样留着', () => {
  assert.equal(tagPlan('网络小说 体检可用 精品', [], ['good']), '网络小说 精品')
  assert.equal(tagPlan('体检可用', [], ['good']), '')
  assert.equal(tagPlan('网络小说 体检可用 体检异常', [], ['good']), '网络小说 体检异常')
  // 换档 = 一次调用里同时摘与加
  assert.equal(tagPlan('网络小说 体检可用', ['bad'], ['good']), '网络小说 体检异常')
})

test('currentTiers - 认出源当前带着哪几档我们的标签', () => {
  assert.deepEqual(currentTiers('网络小说 体检可用'), ['good'])
  assert.deepEqual(currentTiers('网络小说'), [])
  assert.deepEqual(currentTiers('体检可用 体检异常'), ['good', 'bad'])
  assert.deepEqual(currentTiers(''), [])
})

test('分组计划 - 按档位汇总，并算出"已经打过"的有多少', () => {
  const rows = [
    { id: 'a', name: 'A源', statusCategory: 'valid', latencyMs: 300 },
    { id: 'b', name: 'B源', statusCategory: 'slow', latencyMs: 4200 },
    { id: 'c', name: 'C源', statusCategory: 'needs_login', latencyMs: 900 },
    { id: 'd', name: 'D源', statusCategory: 'unreachable', latencyMs: 0 },
  ]
  const plans = buildGroupingPlan(rows, { a: '网络小说 体检可用', b: '', c: '', d: '' })
  assert.deepEqual(plans.map(plan => plan.tier), ['good', 'pending', 'bad'])
  const good = plans.find(plan => plan.tier === 'good')!
  assert.deepEqual(good.ids, ['a', 'b'])
  assert.equal(good.alreadyApplied, 1, 'A 源已经带「体检可用」，不该再写一遍')
  assert.equal(good.tag, HEALTH_TAGS.good)
  assert.equal(good.examples.length, 2)
  assert.match(good.examples[0], /A源（valid 300ms）/)
})

test('分组计划 - 空档位不占一行，没结果时整个面板不出现', () => {
  const onlyGood = buildGroupingPlan([{ id: 'a', name: 'A', statusCategory: 'valid', latencyMs: 1 }], {})
  assert.deepEqual(onlyGood.map(plan => plan.tier), ['good'])
  assert.deepEqual(buildGroupingPlan([], {}), [])
})

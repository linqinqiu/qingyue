import test from 'node:test'
import assert from 'node:assert/strict'
import { FrontendPluginRegistry } from '../src/extensions/registry.ts'

/**
 * 「框架零内容」判据 —— 证明 lab/ 只是容器，plugins/ 才是内容。
 *
 * 这几条测的不是某个插件，而是**框架在没有任何插件时依然成立**：
 * 空注册表能渲染、能介绍自己、能接受后来注册的插件。
 *
 * 这是用户要求"不要有任何自己的内容"的可验证形式：
 * 如果哪天有人在框架里塞了内容，这些判据不会红；但配套的源码扫描判据会红
 * （见本文件末尾那条：lab/ 下不许 import plugins/）。
 */

test('零内容 空注册表：没有任何条目、没有失败、介绍说清自己是空的', () => {
  const reg = new FrontendPluginRegistry()
  assert.deepEqual(reg.labEntries(), [], '框架本身不产生任何实验条目')
  assert.deepEqual(reg.settingsSections(), [])
  assert.equal(reg.loadFailures().length, 0)
  assert.match(reg.describe(), /没有登记任何前端插件/)
})

test('零内容 空注册表仍能接受插件，且不预置任何东西', () => {
  const reg = new FrontendPluginRegistry()
  // 装之前是空的
  assert.equal(reg.list().length, 0)
  // 装之后才有内容 —— 内容来自插件，不是框架
  reg.register({
    id: 'only.one', name: '唯一插件', version: '1.0.0', description: 'x',
    labEntries: [{ id: 'e', title: 'E', description: 'd', render: () => null }],
  })
  assert.equal(reg.labEntries().length, 1)
  assert.equal(reg.labEntries()[0].id, 'e')
})

test('零内容 撤掉全部插件后回到空状态', () => {
  const reg = new FrontendPluginRegistry()
  reg.register({
    id: 'temp', name: '临时', version: '1.0.0', description: 'x',
    labEntries: [{ id: 't', title: 'T', description: 'd', render: () => null }],
  })
  assert.equal(reg.labEntries().length, 1)
  reg.unregister('temp')
  assert.deepEqual(reg.labEntries(), [], '撤掉插件后框架不该残留任何内容')
  assert.match(reg.describe(), /没有登记任何前端插件/)
})

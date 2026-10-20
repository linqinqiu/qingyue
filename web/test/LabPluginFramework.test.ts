import test from 'node:test'
import assert from 'node:assert/strict'
import { FrontendPluginRegistry, type FrontendPlugin } from '../src/lab/pluginRegistry.ts'

/**
 * 前端插件框架的判据。测的是「框架」：登记、拒绝、注销、合并贡献、自我介绍。
 *
 * 刻意不测任何具体插件 —— 框架不含内容，这里出现的插件都是就地造的最小桩，
 * 用来验证"任意插件都能被登记进来"，而不是验证某个功能。
 */

const stubPlugin = (over: Partial<FrontendPlugin> = {}): FrontendPlugin => ({
  id: 'demo.stub',
  name: '桩插件',
  version: '1.0.0',
  description: '测试用',
  ...over,
})

test('登记 最小插件能登记上并出现在清单里', () => {
  const reg = new FrontendPluginRegistry()
  assert.equal(reg.register(stubPlugin()), true)
  assert.equal(reg.list().length, 1)
  assert.equal(reg.has('demo.stub'), true)
  assert.equal(reg.list()[0].name, '桩插件')
})

test('登记 空 id 被拒并留痕', () => {
  const reg = new FrontendPluginRegistry()
  assert.equal(reg.register(stubPlugin({ id: '' })), false)
  assert.equal(reg.list().length, 0)
  assert.equal(reg.loadFailures().length, 1)
  assert.match(reg.loadFailures()[0], /id 为空/)
})

test('登记 重复 id 被拒，不静默覆盖', () => {
  const reg = new FrontendPluginRegistry()
  assert.equal(reg.register(stubPlugin({ name: '第一个' })), true)
  assert.equal(reg.register(stubPlugin({ name: '第二个' })), false)
  assert.equal(reg.list().length, 1, '只应有一个')
  assert.equal(reg.list()[0].name, '第一个', '第一个不被覆盖')
  assert.match(reg.loadFailures()[0], /已登记/)
})

test('注销 能把插件撤掉', () => {
  const reg = new FrontendPluginRegistry()
  reg.register(stubPlugin())
  assert.equal(reg.unregister('demo.stub'), true)
  assert.equal(reg.has('demo.stub'), false)
  assert.equal(reg.list().length, 0)
  assert.equal(reg.unregister('never'), false, '没登记过的返回 false')
})

test('合并 实验室条目按插件顺序拼起来', () => {
  const reg = new FrontendPluginRegistry()
  reg.register(stubPlugin({
    id: 'a', labEntries: [
      { id: 'a1', title: 'A1', description: 'x', render: () => null },
    ],
  }))
  reg.register(stubPlugin({
    id: 'b', labEntries: [
      { id: 'b1', title: 'B1', description: 'y', render: () => null },
      { id: 'b2', title: 'B2', description: 'z', render: () => null },
    ],
  }))
  const ids = reg.labEntries().map(e => e.id)
  assert.deepEqual(ids, ['a1', 'b1', 'b2'])
})

test('合并 页面/设置分区/命令各自汇总', () => {
  const reg = new FrontendPluginRegistry()
  reg.register(stubPlugin({
    id: 'p',
    pages: [{ key: 'demo', title: '演示页', icon: 'info', render: () => null }],
    settingsSections: [{ id: 's1', title: '演示设置', render: () => null }],
    commands: [{ id: 'c1', title: '演示命令', run: () => true }],
  }))
  assert.equal(reg.pages().length, 1)
  assert.equal(reg.pages()[0].key, 'demo')
  assert.equal(reg.settingsSections().length, 1)
  assert.equal(reg.commands().length, 1)
})

test('合并 没有贡献的插件不产生空项', () => {
  const reg = new FrontendPluginRegistry()
  reg.register(stubPlugin({ id: 'empty' }))
  assert.deepEqual(reg.labEntries(), [])
  assert.deepEqual(reg.pages(), [])
  assert.deepEqual(reg.settingsSections(), [])
  assert.deepEqual(reg.commands(), [])
})

test('框架 默认不含任何插件', () => {
  const reg = new FrontendPluginRegistry()
  assert.equal(reg.list().length, 0, '框架本身不带插件')
  assert.equal(reg.loadFailures().length, 0)
  assert.match(reg.describe(), /没有登记任何前端插件/)
})

test('介绍 装了插件后能列出名字/id/版本/说明/贡献', () => {
  const reg = new FrontendPluginRegistry()
  reg.register(stubPlugin({
    id: 'intro.demo', name: '介绍演示', version: '2.3.4',
    description: '用来说明介绍面板', author: '测试者',
    labEntries: [{ id: 'x', title: 'X', description: 'd', render: () => null }],
    commands: [{ id: 'cmd', title: '命令', run: () => true }],
  }))
  const text = reg.describe()
  assert.match(text, /介绍演示/)
  assert.match(text, /intro\.demo/)
  assert.match(text, /v2\.3\.4/)
  assert.match(text, /用来说明介绍面板/)
  assert.match(text, /测试者/)
  assert.match(text, /实验条目 1/)
  assert.match(text, /命令 1/)
})

test('介绍 登记失败也如实写出来，不静默', () => {
  const reg = new FrontendPluginRegistry()
  reg.register(stubPlugin({ id: '' }))
  assert.match(reg.describe(), /登记失败/)
})

test('框架 已登记插件不影响其它插件的合并结果', () => {
  const reg = new FrontendPluginRegistry()
  reg.register(stubPlugin({ id: 'one', labEntries: [{ id: 'e1', title: 'E1', description: 'd', render: () => null }] }))
  reg.register(stubPlugin({ id: 'one', labEntries: [{ id: 'dup', title: 'DUP', description: 'd', render: () => null }] }))
  // 第二个被拒，所以它的条目不应出现
  assert.deepEqual(reg.labEntries().map(e => e.id), ['e1'])
})

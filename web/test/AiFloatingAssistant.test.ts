import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 用户原话：「ai 功能太差，1 是位置问题，不能随时随地使用，不能在对应地点研究，
 * 没有上下文记忆，部分能力没有」。
 *
 * 这四条要分开钉：
 * 1. **位置** —— 悬浮球必须挂在应用根节点，不是某个页面的弹窗，否则切页就没了。
 * 2. **随时随地** —— 不能只从「设置 → AI 接入」进得去；要有全局按钮。
 * 3. **对应地点** —— 面板必须接收并发送当前页面的 uiContext。
 * 4. **上下文记忆** —— 对话历史必须落在组件外面（模块级 store + localStorage），
 *    关掉再开、换页再回来都还在。活在 `useState` 里就等于没有记忆。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')

test('AI 悬浮球挂在应用根节点，每个页面都在', () => {
  const main = read('../src/main.tsx')
  assert.match(main, /import \{ AiFloatingBall \}/, '根组件要引入悬浮球')
  assert.match(main, /<AiFloatingBall uiContext=\{currentUiContext\} \/>/, '悬浮球要拿到当前界面上下文')

  // 它必须在 App 的返回树里、且常驻，不能是 `{openModal === 'ai' && ...}` 那种"要满足条件才出现"的模态。
  // 判据：悬浮球出现的位置在 `<AiModal` 之后（同属根返回树），且**没有**被包在条件渲染里。
  const fabIndex = main.indexOf('<AiFloatingBall')
  const modalIndex = main.indexOf('openModal === \'ai\'')
  assert.ok(fabIndex > 0, '根返回树里要有悬浮球')
  assert.ok(modalIndex > 0 && fabIndex > modalIndex, '悬浮球在根返回树末尾，与模态并列常驻')
  // 悬浮球那一行前面紧邻的不是 `{xxx && (` 条件
  const before = main.slice(Math.max(0, fabIndex - 120), fabIndex)
  assert.doesNotMatch(before, /\{[^}]*&&\s*\(\s*$/, '悬浮球不许条件渲染 —— 它要一直在')

  const fab = read('../src/features/ai/AiFloatingBall.tsx')
  assert.match(fab, /className=\{`ai-fab/, '要有一个固定的悬浮按钮')
  assert.match(fab, /position: fixed|ai-fab/, '')
})

test('AI 不再只能从设置打开：全局按钮独立于设置模态', () => {
  const fab = read('../src/features/ai/AiFloatingBall.tsx')
  // 悬浮球自己管开关，不依赖 openModal === 'ai'
  assert.match(fab, /toggleAiChat|setAiChatOpen/, '悬浮球要能自己开关面板')
  assert.doesNotMatch(fab, /openModal/, '悬浮球不该依赖设置里的模态状态')

  const main = read('../src/main.tsx')
  // 设置里的 AI 入口仍然保留（那是"配置"，不是"使用"），但不再是唯一入口
  assert.match(main, /openModal === 'ai'/, '设置里的配置入口应保留')
})

test('AI 知道用户在哪：面板发送 uiContext', () => {
  const fab = read('../src/features/ai/AiFloatingBall.tsx')
  assert.match(fab, /uiContextMessage\(uiContext/, '要把界面上下文拼进请求')
  assert.match(fab, /正在看：/, '要让用户看见"助手现在知道什么"')
})

test('书源上下文只在书源页生效（selected 是跨页保留的状态，会误导模型）', () => {
  // `selected` 在切到订阅/书架页后仍然保留。若不按页面收敛，
  // 用户明明在订阅页，助手却以为"你正在看书源「01书库」" —— 会把模型引偏。
  const fab = read('../src/features/ai/AiFloatingBall.tsx')
  assert.match(fab, /ctx\.source && ctx\.page === 'sources'/, '面板提示要按页面判断')

  const ctx = read('../src/lib/uiContext.ts')
  assert.match(ctx, /ctx\.source && ctx\.page === 'sources'/, '发给模型的上下文也要按页面判断')
})

test('对话历史活在组件之外：跨页面、跨会话都还在', () => {
  const store = read('../src/features/ai/aiChatStore.ts')
  // 模块级可变状态 + useSyncExternalStore：组件卸载不影响它
  assert.match(store, /let state: AiChatState/, '状态要在模块级，不能是组件 useState')
  assert.match(store, /useSyncExternalStore/, '用外部 store 订阅，卸载不丢')
  assert.match(store, /localStorage/, '要落 localStorage 才能跨会话')
  assert.match(store, /export function appendAiLine/, '')
  assert.match(store, /export function clearAiChat/, '要能显式清空（用户可控）')

  // 面板只订阅、不自己持有对话
  const fab = read('../src/features/ai/AiFloatingBall.tsx')
  assert.match(fab, /useAiChat\(\)/, '面板是订阅者')
  assert.doesNotMatch(fab, /useState<ChatLine\[\]>/, '对话不能存在组件里 —— 那就是关掉就没')
})

test('刷新后不自动弹面板（open 是瞬时状态，不持久化）', () => {
  const store = read('../src/features/ai/aiChatStore.ts')
  assert.match(store, /open: false/, '读回时要强制收起')
  // 持久化时只写 messages 与 systemPrompt，不写 open
  const persistBlock = store.slice(store.indexOf('function persist'), store.indexOf('function replace'))
  assert.doesNotMatch(persistBlock, /open:\s*state\.open/, '不许把 open 存进去')
})

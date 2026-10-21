import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「订阅」这一处的两件事必须分居（PROPOSAL-021 §3 / P0.2）。
 *
 * 上游三家在这里都是两个数据模型：`RssSource`（要**读**的文章源）与 `RuleSub`
 * （远程**书源** JSON 的下载地址）。我们以前把它们焊在同一页的两个页签里，
 * 于是「订阅」一词同时指两件事，页签上还得各挂一条计数 —— 那点数的作用是
 * 让用户分清"我这一条到底在哪张"，界面自己在制造这个疑问。
 *
 * 现在的形状：
 * - 「订阅」这一页只装 RSS（`pages/RssPage.tsx` → `pages/RssPanel.tsx`）
 * - 书源订阅是书源的一条来源，住在书源域（`sources/SourceSubscriptionPanel.tsx`，
 *   由 `SourcesPage` 开出的一档呈现）
 *
 * 扫描都做成对文本的纯函数 + 注入反扫：只判"真文件里没长回来"证不了分辨力，
 * 得证明把旧形状塞回去时它一定报。
 */

const SRC = path.resolve(import.meta.dirname, '../src')
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')

/** 取一个顶层 `function Name(`（0.8.2 起可能是 `export function`）到下一个顶层声明之间的源码 */
function functionBody(text: string, name: string): string {
  const start = text.search(new RegExp(`^(?:export )?function ${name}\\(`, 'm'))
  assert.ok(start >= 0, `找不到顶层 function ${name}(`)
  // 从声明行的**下一行**起算：从 `function` 中间切开的话，第一行仍是顶格，
  // 下面的 `^[\w]` 立刻命中，函数体就成了空串 —— 三条判据会一起变成空判。
  const rest = text.slice(text.indexOf('\n', start) + 1)
  const next = rest.search(/^[\w]/m)
  return next < 0 ? rest : rest.slice(0, next)
}

/**
 * 扫一遍界面源码，返回"书源订阅又跑回订阅页 / 页签又长回来"的清单。
 * 三条都判**结构与引用**，不判界面措辞：措辞改了事实没变不该红，结构改了才是事故。
 */
function auditSubscriptionSplit(files: { name: string; text: string }[]): string[] {
  const problems: string[] = []
  const byName = new Map(files.map(f => [f.name, f.text]))
  // 0.8.2 拆组：SourcesPage 从 main.tsx 搬进 pages/SourcesPage.tsx；这一判据要的是"书源页开出了那一档"，
  // 读它现在的家。断言逐字不变。
  const main = byName.get('pages/SourcesPage.tsx') ?? ''
  const rssPage = byName.get('pages/RssPage.tsx') ?? ''
  const panel = byName.get('sources/SourceSubscriptionPanel.tsx') ?? ''

  // ① 页签不许长回来：`.subscription-tabs` 在界面与样式表里都不该再出现
  for (const f of files) {
    if (f.text.includes('subscription-tabs')) problems.push(`${f.name} 里还有 .subscription-tabs —— 两件事又被并进同一页的两个页签`)
  }
  // ② 一张页只准有一种订阅：RSS 页不许调书源订阅那三个端点
  for (const call of ['api.subscriptions()', 'api.saveSubscription(', 'api.updateSubscription', 'api.removeSubscription(']) {
    if (rssPage.includes(call)) problems.push(`pages/RssPage.tsx 出现 ${call}：书源订阅又回到「订阅」页了`)
  }
  // ③ 书源订阅必须由书源页开出来（不是自己一张页、也不是弹窗）
  if (panel && !/function SourcesPage\(/.test(main)) problems.push('main.tsx 里找不到 SourcesPage，无法确认书源订阅挂在书源域')
  const sourcesPage = main.includes('function SourcesPage(') ? functionBody(main, 'SourcesPage') : ''
  if (!sourcesPage.includes('<SourceSubscriptionPanel')) {
    problems.push('SourcesPage 里没有渲染 <SourceSubscriptionPanel —— 书源订阅没长在它服务的动作旁边（或这一段根本没切到）')
  }
  // ④ 旧的两个内联件不许复活
  for (const name of ['SubscriptionPage', 'SubscriptionPanel']) {
    const bare = new RegExp(`(?<!Source)\\b${name}\\b`)
    for (const f of files) if (bare.test(f.text)) problems.push(`${f.name} 还引用着 ${name}（合体页已解散，留着就是两份真相）`)
  }
  return problems
}

const filesToScan = () => {
  const collect = (dir: string, base = ''): { name: string; text: string }[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory()
      ? collect(path.join(dir, entry.name), path.join(base, entry.name))
      : (/\.(tsx|ts|css)$/.test(entry.name) ? [{ name: path.join(base, entry.name).replace(/\\/g, '/'), text: fs.readFileSync(path.join(dir, entry.name), 'utf8') }] : []))
  return collect(SRC)
}

test('订阅两件事分居：页签没了、RSS 页不碰书源订阅、书源订阅由书源页开出', () => {
  const problems = auditSubscriptionSplit(filesToScan())
  assert.deepEqual(problems, [], problems.join('\n  '))
})

test('形状核对：新的两份文件各在其位', () => {
  // P2 起页面渲染表在 app/pages.tsx，RssPage 由它引入。
  const pages = read('app/pages.tsx')
  assert.match(pages, /import \{ RssPage \} from '\.\.\/pages\/RssPage'/, '「订阅」页要由 pages/RssPage 提供')
  // 0.8.2 拆组：开书源订阅那一档的是 SourcesPage，这条 import 跟着它住进 pages/SourcesPage.tsx；
  // 事实没变 —— 书源订阅仍由 sources/ 提供（它在书源域），只是"谁引它"从 App 挪到了书源页。
  assert.match(read('pages/SourcesPage.tsx'), /import \{ SourceSubscriptionPanel \} from '[.][./]*sources\/SourceSubscriptionPanel'/,
    '书源订阅要由 sources/ 提供（它在书源域）')
  // 0.8.2 拆组：SourcesPage 的家在 pages/SourcesPage.tsx
  const sourcesPage = functionBody(read('pages/SourcesPage.tsx'), 'SourcesPage')
  assert.ok(sourcesPage.length > 4000, `SourcesPage 只切出 ${sourcesPage.length} 字，切分本身没在做事`)
  assert.ok(sourcesPage.includes('subsOpen'), 'SourcesPage 要有那档的开合状态')
  const rss = read('pages/RssPanel.tsx')
  assert.doesNotMatch(rss, /onChanged/, 'RssPanel 的 onChanged 只为页签计数而存在，页签没了就该一起删')
})

test('反向对照：把旧形状塞回去必须报，而且逐项报得出是哪一条', () => {
  const base = filesToScan()
  const patch = (name: string, fn: (text: string) => string) =>
    base.map(f => (f.name === name ? { ...f, text: fn(f.text) } : f))

  // 塞回页签
  const tabs = auditSubscriptionSplit(patch('pages/RssPage.tsx', t => `${t}\n<nav className="subscription-tabs" />\n`))
  assert.ok(tabs.some(p => p.includes('.subscription-tabs')), `加了页签没报：${tabs.join(' / ')}`)
  // 书源订阅又并进 RSS 页
  const merged = auditSubscriptionSplit(patch('pages/RssPage.tsx', t => `${t}\nvoid api.subscriptions()\n`))
  assert.ok(merged.some(p => p.includes('api.subscriptions()')), `塞回书源订阅 API 没报：${merged.join(' / ')}`)
  // 书源页不再开出那一档（0.8.2 拆组后那一档住在 pages/SourcesPage.tsx）
  const unwired = auditSubscriptionSplit(base.map(f => (f.name === 'pages/SourcesPage.tsx' ? { ...f, text: f.text.split('<SourceSubscriptionPanel').join('<!-- 拆掉了 -->') } : f)))
  assert.ok(unwired.some(p => p.includes('SourcesPage 里没有渲染')), `拆掉书源页那档没报：${unwired.join(' / ')}`)
  // 解散掉的合体组件复活
  const revived = auditSubscriptionSplit(patch('main.tsx', t => `${t}\nfunction SubscriptionPage() { return null }\n`))
  assert.ok(revived.some(p => p.includes('SubscriptionPage')), `合体页复活没报：${revived.join(' / ')}`)

  // 干净样本必须一条都不报 —— 否则上面那些红可能只是扫描本身在乱咬
  assert.deepEqual(auditSubscriptionSplit(base), [])
})

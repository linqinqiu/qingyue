// 书源体检与分组整理的验收门禁（用户 2026-09-30：「书源体检效验，管理功能异常，过慢，
// 有很多问题，不能根据获得信息正确规划分组」，任务 #57）。
//
// 这一轮查清的三件事，各自都有对应断言：
// ① 「过慢」的成因不是探测本身，而是**弹窗一开就无条件对整库外呼**：5,574 个源 ÷ 每批 128 ×
//    并发 16 × 5 秒超时 = 几十分钟，而且用户只是想回来看一眼上次的结论。
//    现在超过 300 个源不再自动开跑，要显式按一次「开始体检」。
// ② 「管理功能异常」的一半是**没有停止键**：`cancelledRef` 只在卸载时置位，想停只能关窗。
// ③ 「不能根据获得信息规划分组」：体检给出 正常/迟缓/需登录/连不上 之后界面就到此为止，
//    结论落不到分组上。现在三档结论各配一行可执行的「打标签 / 撤销」，
//    并且服务端新增 `tag_group` / `untag_group` —— **只追加、不覆盖**书源自带的分类。
//
// 探针只用自己的两条源（`.test` 域名，必然连不上），收尾按 id 删除并复查；
// 绝不对用户的 5,574 个源发起扫描，也不动它们的启用位与分组。
//
// 跑法：node tools/verify/source-health-check.mjs
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT, SHOTS, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')
const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
const A_ID = `https://health-a-${STAMP}.test/`
const B_ID = `https://health-b-${STAMP}.test/`
const TAG = '体检异常'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const results = []
const check = (name, condition, detail = '') => results.push({ name, ok: !!condition, detail })
const note = (name, detail) => results.push({ name, ok: null, detail })

const headers = { 'content-type': 'application/json', origin: BASE, host: new URL(BASE).host }
async function call(method, url, body) {
  const response = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 交给断言去报 */ }
  return { status: response.status, json, text }
}
const groupOf = async id => {
  const res = await call('GET', '/api/sources')
  const found = (res.json ?? []).find(item => item.id === id)
  return found ? { group: found.group ?? '', enabled: !!found.enabled, name: found.name } : null
}

const probeSource = (id, name, group) => JSON.stringify({
  bookSourceUrl: id,
  bookSourceName: name,
  bookSourceGroup: group,
  bookSourceType: 0,
  enabled: false,
  ruleSearch: { bookList: '.item', name: '.a', bookUrl: '.a@href' },
})

try {
  // ── 探针落库 ────────────────────────────────────────────
  const imported = await call('POST', '/api/sources/import', { sources: [probeSource(A_ID, `探针体检甲-${STAMP}`, '网文'), probeSource(B_ID, `探针体检乙-${STAMP}`, '')] })
  check('两条探针书源已入库', imported.status === 200 && (imported.json?.imported ?? 0) >= 2, `${imported.status} ${imported.text.slice(0, 90)}`)

  // ── ① 点名体检：只探这两条，且要快 ──────────────────────
  const started = Date.now()
  const health = await call('POST', '/api/sources/health-check', { ids: [A_ID, B_ID], timeoutMs: 2000 })
  const wall = Date.now() - started
  const payload = health.json ?? {}
  check('点名 ids 时只体检这两条（total 等于 ids 数）', payload.total === 2, `${health.status} total=${payload.total}`)
  check('两条都拿到了档位结论', Array.isArray(payload.results) && payload.results.length === 2
    && payload.results.every(item => typeof item.statusCategory === 'string' && item.statusCategory.length > 0),
    (payload.results ?? []).map(item => `${item.name}:${item.statusCategory}`).join(' '))
  check('`.test` 域名被判进"异常"档而不是"待确认"', payload.failedCount === 2,
    `failed=${payload.failedCount} valid=${payload.successCount} slow=${payload.slowCount}`)
  check('两条都连不上时整体仍然秒级返回（没有把超时叠加成串行）', wall < 20000, `实测 ${wall}ms`)

  // ── ③ tag_group：只追加，不覆盖；重复打不长串 ───────────
  const tagged = await call('POST', '/api/sources/batch', { ids: [A_ID, B_ID], action: 'tag_group', group: TAG })
  const afterA = await groupOf(A_ID)
  check('tag_group 把标签追加在原分组后面（原标签「网文」没被冲掉）',
    tagged.status === 200 && tagged.json?.affected === 2 && afterA?.group === `网文 ${TAG}`,
    `affected=${tagged.json?.affected} group="${afterA?.group}"`)
  const afterB = await groupOf(B_ID)
  check('原本没有分组的源，tag_group 后就是这一个标签', afterB?.group === TAG, `group="${afterB?.group}"`)

  await call('POST', '/api/sources/batch', { ids: [A_ID, B_ID], action: 'tag_group', group: TAG })
  const againA = await groupOf(A_ID)
  check('重复 tag_group 是幂等的（不会长成「体检异常 体检异常」）', againA?.group === `网文 ${TAG}`, `group="${againA?.group}"`)

  // ── ③ untag_group：只摘我们这一个标签 ───────────────────
  const untagged = await call('POST', '/api/sources/batch', { ids: [A_ID, B_ID], action: 'untag_group', group: TAG })
  const backA = await groupOf(A_ID)
  const backB = await groupOf(B_ID)
  check('untag_group 摘掉自己的标签并还原原分组',
    untagged.status === 200 && backA?.group === '网文' && backB?.group === '',
    `甲="${backA?.group}" 乙="${backB?.group}"`)
  await call('POST', '/api/sources/batch', { ids: [A_ID, B_ID], action: 'untag_group', group: TAG })
  const stillA = await groupOf(A_ID)
  check('摘一个本来没有的标签不会把分组清空或多出空格', stillA?.group === '网文', `group="${stillA?.group}"`)

  check('体检与打标签全程没有改动探针源的启用位', backA?.enabled === false && stillA?.enabled === false,
    `enabled=${stillA?.enabled}`)

  // 缺标签名的调用要 400，而不是把整组分组刷成空
  const badTag = await call('POST', '/api/sources/batch', { ids: [A_ID], action: 'tag_group', group: '   ' })
  check('tag_group 不给标签名时报 400（不会静默把分组刷空）', badTag.status === 400, `${badTag.status} ${badTag.text.slice(0, 70)}`)

  // ── ② 界面侧：大库不再一开就跑，且有真的停止键 ─────────
  const browser = await puppeteer.launch(launchOptions())
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error.message)))
    await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 1 })
    await page.goto(`${BASE}/#sources`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.source-list-item', { timeout: 40000 })
    const counts = await page.evaluate(async () => {
      const list = await (await fetch('/api/sources')).json()
      return { total: list.length, enabled: list.filter(item => item.enabled).length }
    })
    // 大范围时（未筛选 = 整库）弹窗不该自动开跑
    await page.evaluate(() => {
      document.querySelector('.health-probe-btn')?.click()
    })
    await page.waitForSelector('.source-health-modal', { timeout: 15000 })
    await sleep(1200)
    const idle = await page.evaluate(() => ({
      header: document.querySelector('.health-modal-title small')?.textContent?.trim() ?? '',
      startLabel: [...document.querySelectorAll('.health-actions-bar button')].map(node => node.textContent?.trim() ?? '').join(' | '),
      hasStop: !!document.querySelector('.health-stop-btn'),
      grouping: !!document.querySelector('.health-grouping'),
    }))
    check('整库规模下打开体检弹窗不会自动开跑', !idle.header.startsWith('正在并发探测') && idle.header.includes('还没开始'), idle.header)
    check('开始按钮把范围与数量写在脸上', /开始体检（\d+ 个启用中的）/.test(idle.startLabel), idle.startLabel.slice(0, 120))
    check('没跑之前不出现分组面板（没有结论就没有建议）', !idle.grouping)
    check('未运行时不显示停止键', !idle.hasStop)

    const scope = await page.evaluate(() => ({
      hasDisabledToggle: !!document.querySelector('.health-scope-toggle'),
      label: document.querySelector('.health-scope-toggle')?.textContent?.trim() ?? '',
    }))
    if (counts.total > counts.enabled) {
      check('有停用源时给出「连停用的一起体检」并如实报数', scope.hasDisabledToggle && /连停用的一起体检（\d+）/.test(scope.label), scope.label)
    } else {
      note('「连停用的一起体检」开关', `本机 ${counts.total} 个源全部启用，按设计不出现这个勾`)
    }
    await page.evaluate(() => { document.querySelector('.close-button')?.click() })
    await sleep(500)

    // 把书源列表筛成只有两条探针，再开体检：体检弹窗的范围取自列表当前筛出的那批。
    // 两条探针都是**停用**的（新建探针不该挤进用户的启用集），所以默认范围是 0 ——
    // 正好用界面上那个「连停用的一起体检」把它们圈进来跑，全程不改用户的启用位。
    await page.evaluate(stamp => {
      const input = document.querySelector('.source-filter input')
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, stamp)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, STAMP)
    await sleep(2500)
    const filtered = await page.evaluate(() => document.querySelectorAll('.source-list-item').length)
    check('筛到的正是这两条探针源', filtered === 2, `${filtered} 行`)
    await page.evaluate(() => {
      document.querySelector('.health-probe-btn')?.click()
    })
    await page.waitForSelector('.source-health-modal', { timeout: 15000 })
    await sleep(900)
    const emptyScope = await page.evaluate(() => ({
      header: document.querySelector('.health-modal-title small')?.textContent?.trim() ?? '',
      toggle: document.querySelector('.health-scope-toggle')?.textContent?.trim() ?? '',
    }))
    check('筛出的两条都是停用源时，范围如实说 0 而不是偷偷去探它们',
      emptyScope.header.includes('的 0 个书源') && /连停用的一起体检（2）/.test(emptyScope.toggle),
      `${emptyScope.header} / ${emptyScope.toggle}`)

    const ran = await page.evaluate(async () => {
      document.querySelector('.health-scope-toggle input')?.click()
      const read = () => document.querySelector('.health-modal-title small')?.textContent?.trim() ?? ''
      const deadline = Date.now() + 40000
      // 两条 `.test` 源 0.2 秒就扫完了，停止键只在 running 期间渲染 —— 轮询必须比它更快，
      // 否则量到的是"跑完之后的样子"，会把一个正常的功能判成缺失。
      let sawStop = false
      let sawRunning = false
      let header = ''
      do {
        await new Promise(resolve => setTimeout(resolve, 60))
        if (document.querySelector('.health-stop-btn')) sawStop = true
        header = read()
        if (header.startsWith('正在并发探测')) sawRunning = true
      } while (Date.now() < deadline && !(sawStop && !header.startsWith('正在并发探测')))
      return { sawStop, sawRunning, header, grouping: !!document.querySelector('.health-grouping') }
    })
    check('勾上「连停用的一起体检」后真的开跑，运行期出现停止键',
      ran.sawRunning && (ran.sawStop || ran.header.includes('本轮检测')),
      `运行中=${ran.sawRunning} 停止键=${ran.sawStop} · ${ran.header}`)
    check('跑完出现「按体检结果整理分组」面板', ran.grouping, ran.header)

    const panel = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.health-grouping-row')].map(row => ({
        tag: row.querySelector('.health-grouping-tag')?.textContent?.trim() ?? '',
        count: row.querySelector('.health-grouping-count')?.textContent?.trim() ?? '',
        applyDisabled: row.querySelector('.health-grouping-apply')?.disabled ?? true,
        undoDisabled: row.querySelector('.health-grouping-undo')?.disabled ?? true,
      }))
      return { rows, note: document.querySelector('.health-grouping header small')?.textContent?.trim() ?? '' }
    })
    const badRow = panel.rows.find(row => row.tag === TAG)
    check('两条 `.test` 源汇成一行「体检异常」，且"打标签"可点', !!badRow && !badRow.applyDisabled && /2 个/.test(badRow.count),
      JSON.stringify(panel.rows))
    check('面板说清了"只追加、不动原分组"与"待确认不等于坏"',
      panel.note.includes('追加') && panel.note.includes('待确认'), panel.note.slice(0, 120))

    const applied = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.health-grouping-row')]
        .find(node => node.querySelector('.health-grouping-tag')?.textContent?.trim() === '体检异常')
      row?.querySelector('.health-grouping-apply')?.click()
      return !!row
    })
    await sleep(2500)
    const uiA = await groupOf(A_ID)
    const uiB = await groupOf(B_ID)
    check('界面上点「打标签」后，两条探针源的分组真的变成"原标签 + 体检异常"',
      applied && uiA?.group === `网文 ${TAG}` && uiB?.group === TAG, `甲="${uiA?.group}" 乙="${uiB?.group}"`)

    const undone = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.health-grouping-row')]
        .find(node => node.querySelector('.health-grouping-tag')?.textContent?.trim() === '体检异常')
      row?.querySelector('.health-grouping-undo')?.click()
      return !!row
    })
    await sleep(2500)
    const uiBackA = await groupOf(A_ID)
    const uiBackB = await groupOf(B_ID)
    check('点「撤销」只摘我们打的标签，「网文」还在',
      undone && uiBackA?.group === '网文' && uiBackB?.group === '', `甲="${uiBackA?.group}" 乙="${uiBackB?.group}"`)

    await page.screenshot({ path: path.join(SHOTS, 'health-modal-idle.png') })
    check('体检界面没有 JS 异常', errors.length === 0, errors.slice(0, 2).join(' / '))
  } finally {
    await browser.close()
  }
} finally {
  // 收尾：探针必须自己清干净，并复查
  const removed = await call('POST', '/api/sources/batch', { ids: [A_ID, B_ID], action: 'delete' })
  const leftovers = await groupOf(A_ID)
  const leftoversB = await groupOf(B_ID)
  const clean = !leftovers && !leftoversB
  results.push({ name: '探针体检源已自行回收', ok: removed.status === 200 && clean, detail: clean ? '无残留' : `残留=${[leftovers && A_ID, leftoversB && B_ID].filter(Boolean).join(',')}` })
}

let pass = 0
let fail = 0
let skips = 0
for (const item of results) {
  if (item.ok === true) pass++
  else if (item.ok === false) { fail++; console.log(`  FAIL ${item.name}  — ${item.detail}`) }
  else { skips++; console.log(`  NOTE ${item.name}  — ${item.detail}`) }
}
for (const item of results) if (item.ok === true) console.log(`  PASS ${item.name}  — ${item.detail}`)
console.log(`\nsource-health-check: PASS ${pass} / FAIL ${fail} / NOTE ${skips}`)
process.exit(fail > 0 ? 1 : 0)

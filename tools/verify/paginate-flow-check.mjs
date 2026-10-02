import path from 'node:path'
import { createRequire } from 'node:module'
import { BASE, OUT, launchOptions } from './env.mjs'

/**
 * 翻页（横版）模式的连续性门禁。
 *
 * 起因（用户 2026-10-02 说过两次，2026-10-03 第三次）：「书籍阅读竖版做好了，横板还是跳转」。
 * 前两轮都在改 JS（顶窗口、页码补偿、ResizeObserver 依赖），而真正的根因是一行 CSS：
 * `.reader-paginated-column-body h1` 上同时写着 `break-before: column` 和
 * `page-break-before: always` —— 后者是 `break-before: page` 的旧别名，写在后面把它顶掉了。
 * 章不换栏，三章就连成一片流，section 的矩形互相重叠，`measurePagination` 按
 * "两节左边缘之差 / 步长"算出来的每章页数是错的：footer 报 7/7 而窗口其实有 15 页宽，
 * 用户翻到"最后一页"就再也按不动，看起来完全是"横版没做好"。
 *
 * 所以这里第一条判据就是量**计算样式**，而不是读 CSS 源码 —— 源码里写着 column，
 * 计算值却是 page，这种覆盖只有浏览器知道。
 */
const puppeteer = createRequire(path.join(import.meta.dirname, '../../web/package.json'))('puppeteer-core')
const STAMP = Date.now().toString(36)
const BOOK_NAME = `翻页连续探针-${STAMP}`
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`) }

/**
 * 一章十几段、每段两三句：保证一章在 1280×860 下要占好几页，翻页才有意义。
 * 正文里**不能出现 `第N章` 这种行首**（第一版就栽了：段落写成「第1章第14段。」，
 * 内置分章规则照着把它切成 137 章，每章一栏，整本变成一页一章，判据全在演空戏）。
 */
const syntheticBook = () => {
  const chapters = Array.from({ length: 8 }, (_, index) => {
    const paragraphs = Array.from({ length: 18 }, (_, part) =>
      `这是第${index + 1}节的第${part + 1}段落。${'这一句要写得足够长，好让它在默认字号下真的占满大半栏。'.repeat(4)}`).join('\n\n')
    return `第${index + 1}章 探针\n\n${paragraphs}`
  }).join('\n\n')
  // 书名取的是 TXT 的第一行 —— 把 STAMP 放进去，两次跑的门禁才不会互相认错书
  return `${BOOK_NAME}\n作者：门禁探针\n\n${chapters}\n`
}

const upload = async () => {
  const form = new FormData()
  form.append('file', new Blob([syntheticBook()], { type: 'text/plain; charset=utf-8' }), `${BOOK_NAME}.txt`)
  const response = await fetch(`${BASE}/api/bookshelf/import-local?tocRule=builtin`, { method: 'POST', body: form })
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

const removeProbe = async bookUrl => {
  if (!bookUrl) return false
  await fetch(`${BASE}/api/bookshelf?sourceId=loc_book&bookUrl=${encodeURIComponent(bookUrl)}`, { method: 'DELETE' })
  const after = await (await fetch(`${BASE}/api/bookshelf`)).json().catch(() => [])
  return !after.some(entry => entry.bookUrl === bookUrl)
}

let probeBookUrl = ''
let browser
try {
  const imported = await upload()
  const first = imported.body?.results?.[0]
  probeBookUrl = first?.bookUrl ?? ''
  check('探针书已导入（否则后面全是空判）', imported.status === 200 && !!first?.success && !!probeBookUrl, `${imported.status} ${first?.name ?? ''} · ${first?.totalChapters ?? 0} 章`)
  if (!first?.success) throw new Error('导入失败，门禁无法继续')

  browser = await puppeteer.launch(launchOptions())
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 860 })
  const errors = []
  page.on('pageerror', event => errors.push(String(event.message)))
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker?.getRegistrations?.() ?? []
    await Promise.all(registrations.map(entry => entry.unregister()))
    const keys = await caches?.keys?.() ?? []
    await Promise.all(keys.map(key => caches.delete(key)))
  })
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ theme: 'light', pageMode: 'paginate' })), 'legado-reader-settings-v2')
  await page.goto(`${BASE}/?t=${Date.now()}#shelf`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(name => [...document.querySelectorAll('.shelf-card-name')]
    .some(node => node.textContent?.trim() === name), { timeout: 60000 }, first.name)
  await page.evaluate(name => {
    const card = [...document.querySelectorAll('.shelf-card')].find(node => node.querySelector('.shelf-card-name')?.textContent?.trim() === name)
    card?.querySelector('.shelf-card-cover')?.click()
  }, first.name)

  await page.waitForSelector('.reader-paginated-column-body', { timeout: 60000 })
  await new Promise(resolve => setTimeout(resolve, 2500))

  // ① 根因本身：章标题必须真的换栏
  const geometry = await page.evaluate(() => {
    const body = document.querySelector('.reader-paginated-column-body')
    const viewport = document.querySelector('.reader-paginated-viewport')
    const sections = [...document.querySelectorAll('.reader-page-chapter')]
    const rects = sections.map(node => node.getBoundingClientRect())
    return {
      breakBefore: getComputedStyle(document.querySelector('.reader-page-chapter h1')).breakBefore,
      legacy: getComputedStyle(document.querySelector('.reader-page-chapter h1')).pageBreakBefore,
      sections: sections.length,
      lefts: rects.map(rect => Math.round(rect.left)),
      rights: rects.map(rect => Math.round(rect.right)),
      scrollWidth: body.scrollWidth,
      viewportWidth: viewport.clientWidth,
      footer: [...document.querySelectorAll('.reader-paginated-footer span')].map(node => node.textContent?.trim()).join(' · '),
    }
  })
  check('章标题的计算值是 column（旧别名 page-break-before: always 会把它顶成 page）',
    geometry.breakBefore === 'column', `实际 ${geometry.breakBefore} / 旧属性 ${geometry.legacy}`)
  check('翻页窗口里确实挂着不止一章', geometry.sections >= 2, `${geometry.sections} 章 · ${geometry.footer}`)
  const monotonic = geometry.lefts.every((left, index) => index === 0 || left >= geometry.lefts[index - 1])
  const noOverlap = geometry.rights.every((right, index) => index + 1 >= geometry.rights.length || right <= geometry.lefts[index + 1] + 2)
  check('各章的矩形按栏序排开、互不重叠（重叠=没换栏，页窗口算的是错的）', monotonic && noOverlap,
    `lefts=${geometry.lefts.join(',')} rights=${geometry.rights.join(',')}`)
  const pagesOfWindow = Math.ceil(geometry.scrollWidth / geometry.viewportWidth)
  const reported = Number(/(\d+) \/ (\d+)/.exec(geometry.footer)?.[2] ?? 0)
  check('footer 报的总页数覆盖整个窗口，不只是锚点那一章',
    reported >= pagesOfWindow - 1, `报 ${reported} 页，窗口 ${geometry.scrollWidth}px / 视口 ${geometry.viewportWidth}px ≈ ${pagesOfWindow} 页`)

  // ② 逐帧翻：不许卡住、不许空白帧、不许重挂子树
  const turnAndWatch = direction => page.evaluate(async key => {
    const viewport = document.querySelector('.reader-paginated-viewport')
    const before = { body: document.querySelector('.reader-paginated-column-body'), text: (viewport?.innerText ?? '').trim() }
    const counterOf = () => [...document.querySelectorAll('.reader-paginated-footer span')].map(node => node.textContent?.trim()).join(' · ')
    const startCounter = counterOf()
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    let remounts = 0
    let blank = 0
    let minChars = Number.POSITIVE_INFINITY
    for (let frame = 0; frame < 30; frame += 1) {
      await new Promise(resolve => requestAnimationFrame(resolve))
      if (document.querySelector('.reader-paginated-column-body') !== before.body) remounts += 1
      const chars = (viewport?.innerText ?? '').trim().length
      minChars = Math.min(minChars, chars)
      if (chars < 60) blank += 1
    }
    return { startCounter, endCounter: counterOf(), remounts, blank, minChars, changed: counterOf() !== startCounter }
  }, direction)

  // ② 逐帧翻：不许卡住、不许空白帧、不许重挂子树。**跨章的那几翻**单独挑出来判，
  // 因为"翻十页里有一页跨章"才是用户说的那件事，平均到十页里就看不见那一次了。
  const titleOf = counter => counter.split(' · ')[0] ?? ''
  let stuckAt = null
  const crossings = []
  for (let step = 0; step < 24; step += 1) {
    const outcome = await turnAndWatch('ArrowRight')
    if (!outcome.changed && !stuckAt) stuckAt = outcome.endCounter
    if (titleOf(outcome.startCounter) !== titleOf(outcome.endCounter)) crossings.push(outcome)
  }
  check('连翻 24 页不会停在"最后一页"按不动（原来 footer 7/7 而窗口有 15 页宽）',
    stuckAt === null, stuckAt ?? '每一下都在走')
  check('这一路真的跨了章（至少 2 次），否则后面的连续性判据是空判',
    crossings.length >= 2, `跨章 ${crossings.length} 次`)
  const badForward = crossings.filter(item => item.remounts > 0 || item.blank > 0)
  check('跨章那一翻不重挂子树、没有空白帧', badForward.length === 0,
    JSON.stringify(crossings.slice(0, 3)))

  const backwards = []
  for (let step = 0; step < 24; step += 1) {
    const outcome = await turnAndWatch('ArrowLeft')
    if (titleOf(outcome.startCounter) !== titleOf(outcome.endCounter)) backwards.push(outcome)
    if (backwards.length >= 2) break
  }
  const badBack = backwards.filter(item => item.remounts > 0 || item.blank > 0)
  check('往回跨章同样不重挂、没有空白帧', backwards.length >= 1 && badBack.length === 0,
    JSON.stringify(backwards))

  // ③ 反向对照：把 break-before 改回 page，判据必须变红（证明这条不是在空转）
  const negative = await page.evaluate(async () => {
    const style = document.createElement('style')
    style.textContent = '.reader-paginated-column-body h1 { break-before: page !important; }'
    document.head.append(style)
    await new Promise(resolve => setTimeout(resolve, 900))
    const sections = [...document.querySelectorAll('.reader-page-chapter')]
    const rects = sections.map(node => node.getBoundingClientRect())
    const overlap = rects.some((rect, index) => index + 1 < rects.length && rect.right > rects[index + 1].left + 2)
    style.remove()
    await new Promise(resolve => setTimeout(resolve, 900))
    const after = [...document.querySelectorAll('.reader-page-chapter')].map(node => node.getBoundingClientRect())
    return { overlapWhenPage: overlap, recovered: after.every((rect, index) => index + 1 >= after.length || rect.right <= after[index + 1].left + 2) }
  })
  check('反向对照：改成 break-before: page 就会重叠，改回来就恢复（判据不是空转）',
    negative.overlapWhenPage && negative.recovered, JSON.stringify(negative))

  check('全程没有页面异常', errors.length === 0, errors.slice(0, 2).join(' | '))
} catch (error) {
  check(`门禁自身出错：${error.message}`, false)
} finally {
  if (browser) await browser.close()
  const removed = await removeProbe(probeBookUrl)
  check('探针书已删除（不留残留在用户书架上）', removed, removed ? '已清' : '没删掉，需要手工清')
}

const failed = results.filter(item => !item.ok)
console.log(`\npaginate-flow-check: PASS ${results.length - failed.length} / FAIL ${failed.length}`)
if (failed.length) process.exitCode = 1

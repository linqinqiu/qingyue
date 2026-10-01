// version-check.mjs —— 版本号只有一个来源，这一条门禁就是钉住这件事的。
//
// 用户 2026-09-30：「我希望加入更新日志，版本号」。
// 光加个显示不算做完：真正的风险是**四处各写一个版本号然后互相漂移** ——
// gradle 里改了版本、界面还显示旧的，或者 CHANGELOG 写着 0.3.0 而 jar 是 0.2.0。
// 所以这里把五个位置逐个读出来比对，任何一处不一致就红：
//   ① server/build.gradle 的 version        （唯一书写处）
//   ② 打出来的 fatJar 清单 Implementation-Version
//   ③ 运行中的服务 /healthz 报回的 version
//   ④ 顶栏功能菜单里显示给用户看的那串字符
//   ⑤ CHANGELOG.md 顶部那一条版本号
// 顺带验一条同样容易漂的：服务里塞着的界面产物就是 web/dist 那一份（前端改了却没进 jar 时，
// 版本号一致也白搭）。
//
// 全程只读，不写用户数据。
//
// 跑法：node tools/verify/version-check.mjs
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { ROOT, BASE, launchOptions } from './env.mjs'

const require = createRequire(path.join(ROOT, 'web/package.json'))
const puppeteer = require('puppeteer-core')

const results = []
const check = (name, condition, detail = '') => results.push({ name, ok: !!condition, detail })
const fail = (name, detail) => results.push({ name, ok: false, detail })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 只要 MANIFEST.MF，所以自带一个最小 zip 读取，不额外拉依赖。 */
function manifestOf(jarPath) {
  const buf = fs.readFileSync(jarPath)
  let eocd = buf.length - 22
  while (eocd > 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd <= 0) return ''
  const count = buf.readUInt16LE(eocd + 10)
  let ptr = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break
    const method = buf.readUInt16LE(ptr + 10)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const offset = buf.readUInt32LE(ptr + 42)
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen)
    const fn = buf.readUInt16LE(offset + 26), fe = buf.readUInt16LE(offset + 28)
    const start = offset + 30 + fn + fe
    const csize = buf.readUInt32LE(ptr + 20)
    const raw = buf.subarray(start, start + csize)
    if (name === 'META-INF/MANIFEST.MF') {
      const text = (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8')
      // 清单行可能以 CRLF 折行；Implementation-Version 只有一行，简单抓即可
      return /^Implementation-Version:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? ''
    }
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return ''
}

const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''

// ── ① gradle：唯一书写处 ──────────────────────────────────
const gradle = read(path.join(ROOT, 'server/build.gradle'))
const gradleVersion = /^\s*version\s*=\s*'([^']+)'/m.exec(gradle)?.[1] ?? ''
check('server/build.gradle 里写了版本号（它是唯一的书写处）', /^\d+\.\d+\.\d+$/.test(gradleVersion), gradleVersion || '没匹配到 version = 行')

// ── ② fatJar 清单 ────────────────────────────────────────
const jarDir = path.join(ROOT, 'server/build/libs')
// 与 start.mjs 同一条挑选规则（字典序取最后一个 *-all.jar）：验的必须真是被启动的那只，
// 而不是版本升上去之后留在 build/libs 里的旧包。
const jars = (fs.existsSync(jarDir) ? fs.readdirSync(jarDir).filter(name => name.endsWith('-all.jar')) : []).sort()
const jar = jars.pop() ?? ''
let jarVersion = ''
if (jar) {
  try { jarVersion = manifestOf(path.join(jarDir, jar)) } catch { jarVersion = '' }
  check('产物清单里有 Implementation-Version', /^\d+\.\d+\.\d+$/.test(jarVersion), `${jar} → ${jarVersion || '空'}`)
  check('产物版本与 gradle 一致', jarVersion === gradleVersion, `清单 ${jarVersion} / gradle ${gradleVersion}`)
  check('build/libs 里没有旧版本号的 all.jar 残留（留着只会让下一步挑错包）',
    jars.filter(name => !name.startsWith(`${gradleVersion}-`) && !name.includes(`-${gradleVersion}-`)).length === 0,
    jars.join(', '))
} else {
  results.push({ name: '产物版本可查', ok: false, detail: 'server/build/libs 下没有 *-all.jar：先跑 :server:fatJar' })
}

// ── ③ /healthz ───────────────────────────────────────────
let health = null
try {
  health = await (await fetch(`${BASE}/healthz`)).json()
} catch (error) {
  fail('服务在跑并且 /healthz 可答', String(error.message))
}
if (health) {
  check('/healthz 报出 title、version、status 三项', Boolean(health.title) && /^\d+\.\d+\.\d+$/.test(String(health.version ?? '')) && health.status === 'ok', JSON.stringify(health))
  check('/healthz 的版本与 gradle 一致', health.version === gradleVersion, `接口 ${health.version} / gradle ${gradleVersion}`)
  check('应用名报的是「青阅」', health.title === '青阅', health.title)
}

// ── ④⑤ 界面显示 + 更新日志 ────────────────────────────────
const changelog = read(path.join(ROOT, 'CHANGELOG.md'))
const loggedVersion = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog)?.[1] ?? ''
check('CHANGELOG.md 顶部有一条本次构建的版本', /^\d+\.\d+\.\d+$/.test(loggedVersion), loggedVersion || '第一处 ## [x.y.z] 都没找到')
check('更新日志的版本与 gradle 一致（发了版但日志还停在旧号时这里红）', loggedVersion === gradleVersion, `日志 ${loggedVersion} / gradle ${gradleVersion}`)
check('更新日志是本项目的，不是抄来的上游片段', changelog.includes('青阅') && !/「阅读」App|Legado 更新说明|版本 2\.0/.test(changelog.slice(0, 600)))

const browser = await puppeteer.launch(launchOptions())
try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message)))
  await page.setViewport({ width: 1440, height: 950 })
  await page.goto(`${BASE}/#library`, { waitUntil: 'domcontentloaded' })
  await sleep(2500)
  // 服务里塞的界面产物 == web/dist（否则版本号一致也验的是旧前端）
  const servedAsset = await page.evaluate(() => [...document.querySelectorAll('script[src]')].map(node => node.getAttribute('src') ?? ''))
  const distRoot = path.join(ROOT, 'web/dist')
  const distAssets = fs.existsSync(path.join(distRoot, 'assets')) ? fs.readdirSync(path.join(distRoot, 'assets')) : []
  const distTop = fs.existsSync(distRoot) ? fs.readdirSync(distRoot) : []
  const hashed = servedAsset.map(src => src.replace(/^\//, ''))
  check('服务返回的入口 bundle 就是 web/dist 里那一份（前端确实打进 jar 了）',
    hashed.length > 0 && hashed.every(name => (name.startsWith('assets/') ? distAssets : distTop).includes(name.split('/').pop() ?? '')),
    `服务 ${hashed.join(',')} · dist/assets ${distAssets.filter(name => name.endsWith('.js')).join(',')} · dist 根 ${distTop.filter(name => name.endsWith('.js')).join(',')}`)

  await page.click('.header-menu-btn')
  await sleep(500)
  const menu = await page.evaluate(() => ({
    version: document.querySelector('.menu-version code')?.textContent?.trim() ?? '',
    status: document.querySelector('.menu-header-title')?.textContent?.trim() ?? '',
    loggedIn: document.body.innerText.includes('已登录服务'),
  }))
  check('顶栏菜单把版本号显示出来了', /^\d+\.\d+\.\d+$/.test(menu.version), menu.version || '（没有 .menu-version code）')
  if (health) check('界面显示的版本 == /healthz 报的 == gradle 的', menu.version === health.version && menu.version === gradleVersion,
    `界面 ${menu.version} / 接口 ${health.version} / gradle ${gradleVersion}`)
  check('状态位说"本机服务在线"，认证那套删了之后不许留"已登录服务"这种谎话',
    menu.status.includes('在线') && !menu.loggedIn, `${menu.status} · 残留登录字样 ${menu.loggedIn}`)
  check('全程没有页面 JS 异常', errors.length === 0, errors.slice(0, 2).join(' / '))
} finally {
  await browser.close()
}

let pass = 0
let failed = 0
let skips = 0
for (const item of results) {
  if (item.ok === true) pass++
  else if (item.ok === false) { failed++; console.log(`  FAIL ${item.name}  — ${item.detail}`) }
  else { skips++; console.log(`  SKIP ${item.name}  — ${item.detail}`) }
}
for (const item of results) if (item.ok === true) console.log(`  PASS ${item.name}  — ${item.detail}`)
console.log(`\nversion-check: PASS ${pass} / FAIL ${failed} / SKIP ${skips}`)
process.exit(failed > 0 ? 1 : 0)

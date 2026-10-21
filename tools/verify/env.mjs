// 本机环境解析：让 tools/verify 下的脚本在任何人的机器上都能跑，
// 不再把某个用户的 Chrome 路径和临时目录写死进仓库。
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const OUT = process.env.LEGADO_VERIFY_OUT || path.join(ROOT, 'tools/verify/out')
export const SHOTS = path.join(OUT, 'shots')
export const TMP = process.env.LEGADO_VERIFY_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'legado-'))

// out/ 与 out/shots 在这里统一建好。
// 此前 17 个门禁脚本会 screenshot({ path: join(SHOTS, ...) }) 却从不 mkdirSync：
// 本机因为历史遗留 out/shots 恰好存在所以一直没炸，而干净 clone（CI）上
// puppeteer 截图到不存在的目录会直接 ENOENT 崩 —— 门禁变成"只有本机能跑"。
// 统一在共享入口建，新增脚本不必各自记得。
fs.mkdirSync(SHOTS, { recursive: true })

const CHROME_CANDIDATES = [
  process.env.LEGADO_CHROME,
  process.env.CHROME_PATH,
  // Windows 上 Chrome 既可能装在全机，也可能只装进当前用户目录（Google 的默认安装方式之一）；
  // Edge 是 Chromium 内核，作为兜底也能跑这些审计。
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe'),
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe'),
  // Edge 在 x86 目录里也有一份（Windows 上很常见的装法），原来只查 Program Files 会漏掉它，
  // 于是"本机明明有 Chromium 内核浏览器"却报"没找到"。
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

/** 找不到就返回 null，由调用方给出可读报错，而不是抛一个 ENOENT 让人猜。 */
export function chromePath() {
  return CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate)) || null
}

/**
 * 门禁用的 Chrome profile。
 *
 * 原来每次 launch 都 `mkdtemp` 开一个全新 profile，理由是"别被上一轮的 Service Worker 钉住旧 bundle"。
 * 理由成立，代价没人量过：**全新 profile 的第一次网络导航在这台机器上要 30~50 秒**
 * （同一 profile 的第二、三次是 50~110ms；把 profile 留着复用，第一次就只要 46ms），
 * 于是每条门禁都恰好把最贵的一笔付在它的**第一次导航**上，30 秒超时的直接红成
 * `Navigation timeout`——红的是探针的冷启动，不是产品（AGENTS §3 第③条同一类，这次量出来了）。
 *
 * 现在改成：一个可复用的 profile，但**每次 launch 前把会藏旧东西的目录删掉**
 * （Service Worker / Cache / Code Cache / Local Storage / Session Storage），
 * 冷 bundle 的坑照样堵住，冷 profile 的钱不再付。实测同一 profile 连跑三轮：
 * 29.8s（首次建目录）→ 5.7s → 4.6s，且每轮拿到的入口 bundle 都是当前那份、`sw.controller=false`。
 *
 * 两个门禁同时跑会抢同一个 profile（Chrome 会直接拒绝启动），所以留了锁：
 * 锁存在就退回一次性临时目录，宁可慢也不假红。`LEGADO_GATE_PROFILE` 可指到别处。
 */
const SHARED_PROFILE = process.env.LEGADO_GATE_PROFILE || path.join(ROOT, 'tmp', 'gate-profile')
const PROFILE_LOCK = SHARED_PROFILE + '.lock'
const WIPED = ['Default/Service Worker', 'Default/Cache', 'Default/Code Cache', 'Default/Local Storage', 'Default/Session Storage', 'Default/blob_storage']

function gateProfile() {
  let held = false
  try {
    fs.mkdirSync(path.dirname(SHARED_PROFILE), { recursive: true })
    // 别的进程还开着这个 profile 时 wx 会失败，那就让它用共享的，我用一次性的
    if (fs.existsSync(PROFILE_LOCK)) {
      const owner = Number(fs.readFileSync(PROFILE_LOCK, 'utf8'))
      const alive = owner && tryAlive(owner)
      if (!alive) fs.rmSync(PROFILE_LOCK, { force: true })
    }
    if (!fs.existsSync(PROFILE_LOCK)) {
      fs.writeFileSync(PROFILE_LOCK, String(process.pid), { flag: 'wx' })
      held = true
    }
  } catch { held = false }
  if (!held) return fs.mkdtempSync(path.join(TMP, 'profile-cold-'))
  process.on('exit', () => { try { fs.rmSync(PROFILE_LOCK, { force: true }) } catch { /* 收尾失败下次再清 */ } })
  for (const sub of WIPED) fs.rmSync(path.join(SHARED_PROFILE, sub), { recursive: true, force: true })
  return SHARED_PROFILE
}

function tryAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** puppeteer-core 的公共启动参数（profile 策略见 gateProfile 的注释）。 */
export function launchOptions(extra = {}) {
  const executablePath = chromePath()
  if (!executablePath) throw new Error('没找到 Chrome/Edge：请设置环境变量 LEGADO_CHROME 指向可执行文件。已尝试 ' + CHROME_CANDIDATES.length + ' 个常见位置')
  return {
    executablePath,
    headless: true,
    userDataDir: gateProfile(),
    // 冷 profile 首启那套（首启向导、默认浏览器检查、后台网络/组件更新、域名可靠性上报）
    // 在这台连不上 google 的机器上每一次都要等到超时，显式关掉。
    args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-sync', '--disable-background-networking', '--disable-component-update',
      '--disable-domain-reliability', '--disable-breakpad', '--metrics-recording-only',
      '--disable-search-engine-choice-screen'],
    ...extra,
  }
}


/** 服务地址：默认 127.0.0.1:1234，可用 LEGADO_BASE_URL 指到别的端口。 */
export const BASE = (process.env.LEGADO_BASE_URL || 'http://127.0.0.1:1234').replace(/\/$/, '')
export const DB = process.env.LEGADO_DB || path.join(ROOT, 'data/legado.sqlite')

/**
 * 把首次运行的「用户协议与免责声明」标记成已同意（0.6.46 引入）。
 *
 * 门禁每次都用清空的 profile（`gateProfile` 会删掉 `Default/Local Storage`），所以那层全屏浮层
 * **每轮都会出现**。用**合成点击**（`page.evaluate(el => el.click())`）的门禁不受影响 ——
 * 合成事件不看遮挡；但用**真鼠标**（`page.click` / `page.keyboard`）的门禁会点到浮层上，
 * 后面全是假红。所以第一次导航到 `BASE` 之后调一次这个。
 */
export async function acceptAgreement(page) {
  await page.evaluate(() => { try { localStorage.setItem('qingyue-agreement-v1', '1') } catch { /* 隐私模式：存不进就每次都看一遍 */ } })
}

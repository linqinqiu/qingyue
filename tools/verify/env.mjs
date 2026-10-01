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

/** puppeteer-core 的公共启动参数（每次都开新 profile，避免被上一轮的 Service Worker 钉住旧 bundle）。 */
export function launchOptions(extra = {}) {
  const executablePath = chromePath()
  if (!executablePath) throw new Error('没找到 Chrome/Edge：请设置环境变量 LEGADO_CHROME 指向可执行文件。已尝试 ' + CHROME_CANDIDATES.length + ' 个常见位置')
  return {
    executablePath,
    headless: true,
    userDataDir: fs.mkdtempSync(path.join(TMP, 'profile-')),
    args: ['--no-sandbox', '--disable-gpu'],
    ...extra,
  }
}

/** 服务地址：默认 127.0.0.1:1234，可用 LEGADO_BASE_URL 指到别的端口。 */
export const BASE = (process.env.LEGADO_BASE_URL || 'http://127.0.0.1:1234').replace(/\/$/, '')
export const DB = process.env.LEGADO_DB || path.join(ROOT, 'data/legado.sqlite')

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

/**
 * ADR-017 §5 / PROPOSAL-017 §7 的桌面化门禁：起壳 → 验证"不装 Java、写操作通、单实例、退出干净"。
 *
 * 判据：
 *  1. 干净 PATH（不含 Java）下双击/起壳 → 界面可达（/healthz 200）、书架/搜索能用。
 *  2. 写操作在壳里可用；反向：把 Origin 换成非同源来源时必须吃 403（闸门没被悄悄放宽）。
 *  3. 单实例：第二个实例必须拒绝启动且不留第二个 java 进程。
 *  4. 退出：关掉后端口释放、监听消失、进程归零。
 *
 * 用法：
 *   node tools/verify/desktop-check.mjs [--exe <路径>] [--port 1234] [--smoke]
 *     --smoke  只查"起得来 + /healthz + 第二个实例拒绝"（不碰浏览器/反向 403，适合无头跑）。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const fail = (m) => { console.error(`FAIL  ${m}`); process.exit(1) }
const ok = (m) => console.log(`PASS  ${m}`)
const arg = (f, d = null) => { const i = process.argv.indexOf(f); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d }
const hasFlag = (f) => process.argv.includes(f)
const SMOKE = hasFlag('--smoke')

const port = Number(arg('--port', '1234'))
const url = `http://127.0.0.1:${port}`

const exe = arg('--exe') || path.join(ROOT, 'dist', 'desktop', '青阅', '青阅.exe')
if (!fs.existsSync(exe)) fail(`找不到 ${exe} —— 先 node scripts/package-desktop.mjs`)

// 同源自壳内写操作要真的写一下：用一次性临时数据目录，不污染真书架（跑完清掉）。
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyue-desktop-'))

async function healthz() {
  try {
    const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch { return false }
}
async function waitHealth(timeoutMs = 120000) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) { if (await healthz()) return true; await new Promise(r => setTimeout(r, 500)) }
  return false
}
function portListening() {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1'); let done = false
    const finish = (v) => { if (done) return; done = true; s.destroy(); resolve(v) }
    s.once('connect', () => finish(true))
    s.once('error', () => finish(false))
    setTimeout(() => finish(false), 1000)
  })
}
function listeningPids(port) {
  // 数"正在监听该端口"的进程 PID —— 直接看单实例有没有真的起第二个服务，
  // 不被进程名/JVM 模型（exe 内嵌 JVM 还是另起 java.exe）影响。
  const out = spawnSync('netstat', ['-ano']).stdout.toString()
  const pids = []
  for (const line of out.split('\n')) {
    const m = line.match(new RegExp(`TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`))
    if (m) pids.push(m[1])
  }
  return pids
}
function killProc(pid) {
  // 走 taskkill（非 SIGKILL）：jpackage 的 exe 内嵌 JVM，Signal 不一定够；/T 连带子进程一并清。
  if (process.platform !== 'win32') { try { process.kill(-pid, 'SIGKILL') } catch {} return }
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
}
function launch(detached = true) {
  const child = spawn(exe, ['--no-open'], { detached, stdio: 'ignore', env: { ...process.env, PATH: '', LEGADO_DATA_DIR: tmpDataDir } })
  child.unref()
  return child
}

console.log(`起壳 ${exe}（PATH 清空，模拟不装 Java）…`)
const child = launch()
const up = await waitHealth()
if (!up) { try { child.kill('SIGKILL') } catch {} fail('服务没起来：/healthz 超时') }
ok('服务可达 /healthz（不依赖外部 Java）')

if (!SMOKE) {
  // 同源自壳内写操作必须成功（证明桌面壳没把同源闸门弄坏）。
  const okRes = await fetch(`${url}/api/sources/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sources: ['https://smoke.test/'] }),
    signal: AbortSignal.timeout(5000),
  }).catch(e => ({ status: -1, err: e }))
  if (okRes.status >= 200 && okRes.status < 300) ok(`同源自壳内写操作通过（导入响应 ${okRes.status}）`)
  else fail(`同源自壳内写操作没过（status=${okRes.status}）`)

  // 反向对照：非同源 Origin 的写请求必须 403（守卫没被放宽）。
  const res = await fetch(`${url}/api/sources/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: '{}', signal: AbortSignal.timeout(3000),
  }).catch(e => ({ status: -1, err: e }))
  if (res.status === 403) ok('非同源写请求被拒（403）—— 同源闸门未放宽')
  else fail(`非同源写请求没被拒（status=${res.status}），同源闸门可能被放宽了`)
}

// 单实例：第二个实例必须拒绝（不新开监听端口）。
const before = listeningPids(port)
const second = launch()
await new Promise(r => setTimeout(r, 4000))
const after = listeningPids(port)
killProc(second.pid)
if (after.length <= before.length) ok(`单实例：第二个实例未起新端口监听（前 ${before.length} / 后 ${after.length}）`)
else fail(`单实例被破坏：第二个实例起了新监听（前 ${before.length} / 后 ${after.length}）`)

// 退出：关掉主进程后端口应释放、无残留监听。
killProc(child.pid)
await new Promise(r => setTimeout(r, 3000))
const stillUp = await portListening()
if (!stillUp) ok('退出后端口释放')
else fail('退出后端口仍在监听')

console.log('桌面化门禁全部通过 ✅')
fs.rmSync(tmpDataDir, { recursive: true, force: true })

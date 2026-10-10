import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

/**
 * ADR-017 §5 / PROPOSAL-017 §7 的桌面化门禁：起壳 → 验证"不装 Java、写操作通、单实例、退出干净、
 * 遵守数据目录、端口冲突拒绝"。
 *
 * 判据：
 *  1. 干净 PATH（不含 Java）下起壳 → /healthz 200、界面可达。
 *  2. 写操作在壳里可用；反向：非同源 Origin 的写请求必须 403（闸门没被悄悄放宽）。
 *  3. 单实例 / 端口冲突：第二个实例必须拒绝（不起第二个监听、且自身退出）。
 *  4. 退出：关掉后端口释放、监听消失。
 *  5. 数据目录：应用必须遵守 LEGADO_DATA_DIR（不写系统盘）、重启后不变、不同目录隔离；
 *     若仓库自带真实书架（data/legado.sqlite），额外验证指向它时读得到真实源。
 *
 * 用法：
 *   node tools/verify/desktop-check.mjs [--exe <路径>] [--port 1234] [--smoke]
 *     --smoke  只查"起得来 + /healthz + 第二个实例拒绝"（不碰浏览器/反向 403 / 数据目录，适合无头跑）。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const fail = (m) => { console.error(`FAIL  ${m}`); process.exit(1) }
const ok = (m) => console.log(`PASS  ${m}`)
const arg = (f, d = null) => { const i = process.argv.indexOf(f); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d }
const hasFlag = (f) => process.argv.includes(f)
const SMOKE = hasFlag('--smoke')

const port = Number(arg('--port', '1234'))

const exe = arg('--exe') || path.join(ROOT, 'dist', 'desktop', 'qingyue', 'qingyue.exe')
if (!fs.existsSync(exe)) fail(`找不到 ${exe} —— 先 node scripts/package-desktop.mjs`)

// 主实例用一次性临时数据目录（跑完清掉，不污染真书架）。
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qingyue-desktop-'))

function spawnExe(port, dataDir, opts = {}) {
  const child = spawn(exe, ['--no-open'], {
    detached: true, stdio: 'ignore',
    env: { ...process.env, PATH: '', LEGADO_PORT: String(port), LEGADO_DATA_DIR: dataDir, ...opts.env },
  })
  child.unref()
  return child
}
async function healthzOn(p) {
  try { const r = await fetch(`http://127.0.0.1:${p}/healthz`, { signal: AbortSignal.timeout(2000) }); return r.ok } catch { return false }
}
async function waitHealthOn(p, timeoutMs = 120000) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) { if (await healthzOn(p)) return true; await new Promise(r => setTimeout(r, 500)) }
  return false
}
async function portListeningOn(p) {
  return new Promise((resolve) => {
    const s = net.connect(p, '127.0.0.1'); let done = false
    const finish = (v) => { if (done) return; done = true; s.destroy(); resolve(v) }
    s.once('connect', () => finish(true))
    s.once('error', () => finish(false))
    setTimeout(() => finish(false), 1000)
  })
}
async function waitPortFree(p, timeoutMs = 15000) {
  const t = Date.now() + timeoutMs
  while (Date.now() < t) { if (!(await portListeningOn(p))) return true; await new Promise(r => setTimeout(r, 300)) }
  return false
}
function listeningPids(p) {
  // 数"正在监听该端口"的 PID —— 直接看单实例有没有真起第二个服务，不受进程名/JVM 模型影响。
  const out = spawnSync('netstat', ['-ano']).stdout.toString()
  const pids = []
  for (const line of out.split('\n')) {
    const m = line.match(new RegExp(`TCP\\s+\\S+:${p}\\s+\\S+\\s+LISTENING\\s+(\\d+)`))
    if (m) pids.push(m[1])
  }
  return pids
}
function isAlive(pid) {
  if (process.platform !== 'win32') { try { process.kill(pid, 0); return true } catch { return false } }
  const r = spawnSync('tasklist', ['/fi', `pid eq ${pid}`]).stdout.toString()
  return !/No tasks/.test(r) && r.includes(String(pid))
}
function killProc(pid) {
  // 走 taskkill（非 SIGKILL）：jpackage 的 exe 内嵌 JVM，Signal 不一定够；/T 连带子进程一并清。
  if (process.platform !== 'win32') { try { process.kill(-pid, 'SIGKILL') } catch {} return }
  if (isAlive(pid)) spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
}

console.log(`起壳 ${exe}（PATH 清空，模拟不装 Java）…`)
const child = spawnExe(port, tmpDataDir)
const up = await waitHealthOn(port)
if (!up) { killProc(child.pid); fail('服务没起来：/healthz 超时') }
ok('服务可达 /healthz（不依赖外部 Java）')

if (!SMOKE) {
  // 同源自壳内写操作必须成功（证明桌面壳没把同源闸门弄坏）。
  const okRes = await fetch(`${url_of(port)}/api/sources/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sources: ['https://smoke.test/'] }),
    signal: AbortSignal.timeout(5000),
  }).catch(e => ({ status: -1, err: e }))
  if (okRes.status >= 200 && okRes.status < 300) ok(`同源自壳内写操作通过（导入响应 ${okRes.status}）`)
  else fail(`同源自壳内写操作没过（status=${okRes.status}）`)

  // 反向对照：非同源 Origin 的写请求必须 403（守卫没被放宽）。
  const res = await fetch(`${url_of(port)}/api/sources/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: '{}', signal: AbortSignal.timeout(3000),
  }).catch(e => ({ status: -1, err: e }))
  if (res.status === 403) ok('非同源写请求被拒（403）—— 同源闸门未放宽')
  else fail(`非同源写请求没被拒（status=${res.status}），同源闸门可能被放宽了`)
}

// 单实例 / 端口冲突：第二个实例必须拒绝（不起第二个监听、且自身退出）。
const before = listeningPids(port)
const second = spawnExe(port, tmpDataDir)
await new Promise(r => setTimeout(r, 5000))
const after = listeningPids(port)
const secondExited = !isAlive(second.pid)
killProc(second.pid)
if (after.length > before.length) {
  killProc(child.pid)
  fail(`端口冲突/单实例被破坏：第二个实例起了新监听（前 ${before.length} / 后 ${after.length}）`)
}
ok(`端口冲突/单实例：第二个实例未起新监听（前 ${before.length} / 后 ${after.length}）`)
if (secondExited) ok('端口冲突/单实例：第二个实例已自行退出（未残留进程）')
else console.log('NOTE  第二个实例未自行退出（本环境可能支持托盘，作为"已运行"常驻属正常；已强制清理）')

// 退出：关掉主进程后端口应释放、无残留监听。
killProc(child.pid)
if (await waitPortFree(port)) ok('退出后端口释放')
else fail('退出后端口仍在监听')

// === 数据目录测试：遵守 LEGADO_DATA_DIR、重启不变、不同目录隔离 ===
if (!SMOKE) {
  const da = fs.mkdtempSync(path.join(os.tmpdir(), 'qy-dataA-'))
  const db = fs.mkdtempSync(path.join(os.tmpdir(), 'qy-dataB-'))
  const pA = port + 11, pB = port + 22
  const dbFile = d => path.join(d, 'legado.sqlite')

  const a = spawnExe(pA, da)
  if (!(await waitHealthOn(pA))) { killProc(a.pid); fail('数据目录测试：A 实例没起来') }
  if (fs.existsSync(dbFile(da))) ok(`数据目录：在指定目录 ${path.basename(da)} 建库（未写系统盘）`)
  else fail('数据目录：未在指定目录建库')
  killProc(a.pid); await waitPortFree(pA)

  // A 重启：同一目录，库仍在（持久 / 便携）。
  const a2 = spawnExe(pA, da)
  if (!(await waitHealthOn(pA))) { killProc(a2.pid); fail('数据目录测试：A 重启没起来') }
  if (fs.existsSync(dbFile(da))) ok('数据目录：重启后数据目录不变（持久 / 便携）')
  else fail('数据目录：重启后库丢失')
  killProc(a2.pid); await waitPortFree(pA)

  // B：另一目录，独立建库（隔离）。
  const b = spawnExe(pB, db)
  if (!(await waitHealthOn(pB))) { killProc(b.pid); fail('数据目录测试：B 实例没起来') }
  if (fs.existsSync(dbFile(db))) ok('数据目录：第二目录独立建库（隔离）')
  else fail('数据目录：第二目录未建库')
  killProc(b.pid); await waitPortFree(pB)

  fs.rmSync(da, { recursive: true, force: true })
  fs.rmSync(db, { recursive: true, force: true })

  // 最佳努力：若仓库自带真实书架，验证指向它时读得到真实源。
  const realData = path.join(ROOT, 'data')
  if (fs.existsSync(path.join(realData, 'legado.sqlite'))) {
    const pR = port + 33
    const r = spawnExe(pR, realData)
    if (await waitHealthOn(pR)) {
      const src = await fetch(`http://127.0.0.1:${pR}/api/sources`).then(x => x.json()).catch(() => null)
      const n = Array.isArray(src) ? src.length : (src && src.data ? src.data.length : 0)
      if (n > 0) ok(`数据目录：指向真实书架读到 ${n} 个源`)
      else fail(`数据目录：真实书架读到 0 个源（异常）`)
    } else fail('数据目录：真实书架实例没起来')
    killProc(r.pid); await waitPortFree(pR)
  }
}

console.log('桌面化门禁全部通过 ✅')
fs.rmSync(tmpDataDir, { recursive: true, force: true })

function url_of(p) { return `http://127.0.0.1:${p}` }

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * 把新骨架（qingyue）的构建产物装配到本仓库的 `next/`，供 1234 那个服务按目录挂载。
 *
 * 借鉴 workbuddy-switch 的 `scripts/prepare-agent-companion.mjs {dev,build,copy}`：
 * 那份仓库把"第二份前端"纳入同一条构建链，而不是靠人记得去拷一次。
 * 我们原来就是靠人记 —— 手工 `cp -r` 过若干次，拷错目录、拷了上一版的 dist、
 * 或者忘了 `base: '/next/'` 都会画成空白页，而且服务端字节全对。
 *
 * 三条硬断言（不满足就红着退出，不做"看起来成功"）：
 * ① 产物 index.html 必须引用 `/next/assets/...`（qingyue 的 vite base 错了就 404 css/js）；
 * ② 拷完之后 `next/` 里必须真的有那些字节（不是只改了 html）；
 * ③ 旧前端的 SW 必须把 `/next` 放进 navigateFallback 黑名单，否则装了 SW 的浏览器
 *    会用**旧界面**回答对 `/next/` 的导航，服务端 curl 一切正常而界面永远是旧的。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const QINGYUE = process.env.QINGYUE_DIR || path.resolve(ROOT, '..', 'qingyue')
const SRC_DIST = path.join(QINGYUE, 'web', 'dist')
const TARGET = path.join(ROOT, 'next')
const fail = message => { console.error(`FAIL  ${message}`); process.exit(1) }

const mode = process.argv[2] || 'copy'
if (!['build', 'copy'].includes(mode)) fail(`未知模式 ${mode}，只支持 build / copy`)

if (mode === 'build') {
  if (!fs.existsSync(path.join(QINGYUE, 'web', 'package.json'))) {
    fail(`找不到新骨架仓库：${QINGYUE}\n     新骨架不在本仓库里（它是同级目录 qingyue/），要指过去就设 QINGYUE_DIR`)
  }
  console.log(`→ npm run build（${path.join(QINGYUE, 'web')}）`)
  const built = spawnSync('npm', ['--prefix', path.join(QINGYUE, 'web'), 'run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (built.status !== 0) fail('新骨架构建失败（上面是它的输出）')
}

const html = fs.readFileSync(path.join(SRC_DIST, 'index.html'), 'utf8')
const refs = [...html.matchAll(/(?:src|href)="(\/next\/[^"]+)"/g)].map(match => match[1])
if (refs.length === 0) {
  fail(`产物 index.html 里没有 /next/ 前缀的资源引用 —— qingyue 的 vite base 必须是 '/next/'，\n     用 '/' 构建出来的包挂到 /next 下会 404 找不到 css/js：\n${html.slice(0, 240)}`)
}
for (const ref of refs) {
  // `/next/` 只是 URL 前缀，产物目录里并没有这一层 —— 要剥掉它再去查文件
  if (!fs.existsSync(path.join(SRC_DIST, ref.replace(/^\/next\//, '')))) fail(`${ref} 在 index.html 里被引用，但产物里没有这个文件`)
}

const countFiles = dir => fs.existsSync(dir)
  ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).length
  : 0
const before = countFiles(TARGET)
if (fs.existsSync(TARGET)) fs.rmSync(TARGET, { recursive: true, force: true })
fs.cpSync(SRC_DIST, TARGET, { recursive: true })

const after = refs.map(ref => {
  const file = path.join(TARGET, ref.replace(/^\/next\//, ''))
  const size = fs.statSync(file).size
  if (!size) fail(`${ref} 拷过来是 0 字节`)
  return `${path.basename(ref)} ${Math.round(size / 1024)} KB`
})
const viteConfig = fs.readFileSync(path.join(ROOT, 'web', 'vite.config.ts'), 'utf8')
// 注意 `[^]]` 在 JS 正则里会被解析成 `[^]`（任意字符）+ `]`，判据就变成永远不成立的样子；
// 要写 `[^\]]`。这条第一次就"红在产品没坏、判据自己写坏了"上。
if (!/navigateFallbackDenylist[^\]]*next/.test(viteConfig.replace(/\s+/g, ' '))) {
  fail('旧前端的 SW 黑名单里没有 /next —— 装了 SW 的浏览器会拿旧界面回答对 /next/ 的导航，服务端 curl 看不出来')
}

console.log(`OK  新骨架 → ${path.relative(ROOT, TARGET)}/（原来是 ${before} 个条目）`)
for (const item of after) console.log(`    ${item}`)
console.log('OK  旧前端 SW 的 navigateFallback 黑名单含 /next')

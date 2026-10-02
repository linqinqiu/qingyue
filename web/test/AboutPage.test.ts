import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 「加入关于（名称，开发者，更新日志，检查更新，用户协议，开源许可，免责声明）」（用户 2026-10-02）。
 * 这七样是用户点名要的清单，少一样就是没做完 —— 而"少一样"在界面上不会报错，
 * 所以按名字逐项判，而不是"页面上有字"。
 */
const read = (...parts: string[]) => fs.readFileSync(path.resolve(import.meta.dirname, ...parts), 'utf8')
const page = read('../src/AboutPage.tsx')

test('七样点名要的东西都在这一页上', () => {
  for (const [label, pattern] of [
    ['名称', /info\?\.title/],
    ['版本', /about-facts[\s\S]*?版本/],
    ['开发者', /开发者/],
    ['更新日志', /onOpenChangelog/],
    ['检查更新', /检查更新/],
    ['用户协议', /title="用户协议"/],
    ['开源许可', /title="开源许可"/],
    ['免责声明', /title="免责声明"/],
  ] as const) {
    assert.match(page, pattern, `关于页缺「${label}」`)
  }
})

test('版本与仓库都来自服务端，界面不写死', () => {
  assert.match(page, /api\.about\(\)/)
  // 字面量版本号会造出第二个事实来源（这条在本项目里翻过车，见 version-check.mjs）
  assert.doesNotMatch(page, /['"`]\d+\.\d+\.\d+['"`]/, 'AboutPage 里出现了写死的版本号')
  assert.match(read('../src/api.ts'), /about: \(\) => request<AboutInfo>\('\/api\/about'\)/)
})

test('检查更新是点了才打，且地址不接受用户输入', () => {
  assert.match(read('../src/api.ts'), /checkUpdate: \(\) => request<UpdateCheckResult>\('\/api\/about\/update-check', \{ method: 'POST' \}\)/)
  const server = read('../../server/src/main/kotlin/io/legado/server/UpdateCheck.kt')
  assert.match(server, /System\.getenv\("LEGADO_REPO"\)/, '仓库 slug 只有一个可覆盖的来源')
  assert.doesNotMatch(server, /call\.request\.queryParameters/, '检查更新不许从请求参数里拼 URL —— 那是开在本机上的 SSRF 门')
  assert.match(server, /connectTimeout/, '外网请求必须有超时，不然「检查更新」能把页面钉死')
  assert.match(read('../../server/src/main/kotlin/io/legado/server/Routes.kt'), /post\("\/about\/update-check"\)[\s\S]*?requireSameOriginWrite/)
})

test('许可那一栏说的是真话：运行时依赖与协议都列出来', () => {
  assert.match(page, /GPL-3\.0/)
  for (const name of ['Ktor', 'Jsoup', 'Rhino', 'React']) {
    assert.ok(page.includes(name), `第三方依赖表里少了 ${name}`)
  }
  // 借鉴过语义的上游必须点名，尤其 AGPL 那条：不写出来就会被后来人当成可以拷
  assert.match(page, /LegadoTeam\/legado/)
})

test('路由与样式都接上了', () => {
  assert.match(read('../src/main.tsx'), /location\.hash === '#about' \? 'about'/)
  assert.match(read('../src/main.tsx'), /<AboutPage onOpenChangelog=/)
  assert.match(read('../src/AppHeader.tsx'), /<span>关于<\/span>/)
  assert.match(read('../src/styles.css'), /\.about-page \{/)
})

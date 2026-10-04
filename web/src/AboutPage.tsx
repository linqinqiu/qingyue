import React, { useEffect, useState } from 'react'
import { api, type AboutInfo, type UpdateCheckResult } from './api'

/**
 * 「关于」（用户 2026-10-02：「加入关于（名称，开发者，更新日志，检查更新，用户协议，开源许可，免责声明）」）。
 *
 * 这一页也是"这条产品是谁做的、改到哪一版、怎么按键"的落点：顶栏「我的」里原来的
 * 「快捷键」「更新日志」两条都收到这里来了（用户 2026-10-03：「顶栏『我的』菜单堆太多」）。
 * 版本号本身在顶栏还是个芯片，点它同样进更新日志 —— 那是同一个目标的第二条路，不算重复入口。
 *
 * 版本与仓库地址都从服务端 `/api/about` 拿：界面里写死一个版本号，就有了第二个事实来源，
 * 而那两个来源一定会漂（这条在本项目里翻过车，见 `tools/verify/version-check.mjs`）。
 */

/** 第三方运行时依赖：名字、用途、协议。只列"跑起来离不开"的那些，构建工具不算。 */
const THIRD_PARTY: Array<[string, string, string]> = [
  ['Kotlin / kotlinx.serialization', '服务端语言与 JSON 编解码', 'Apache-2.0'],
  ['Ktor', 'HTTP 服务与路由', 'Apache-2.0'],
  ['SQLite JDBC (xerial)', '本机单文件数据库', 'Apache-2.0'],
  ['Jsoup', 'HTML 解析', 'MIT'],
  ['JsoupXpath', 'XPath 取值（书源规则里的 `@xpath:`）', 'Apache-2.0'],
  ['JsonPath (jayway)', 'JSON 取值（书源规则里的 `@json:`）', 'Apache-2.0'],
  ['Rhino (Mozilla)', '书源里 `@js:` 那段的沙箱执行', 'MPL-2.0'],
  ['React / ReactDOM', '前端界面', 'MIT'],
  ['Vite + Workbox', '前端构建与离线缓存', 'MIT'],
]

/**
 * 参照过语义的上游项目。**不许写"未拷代码"这种一概而论的话**：
 * 随包的 TXT 分章规则表 `assets/txtTocRule.json`（26 条）与上游那份 `cmp` 逐字节相同（2026-10-05 实测），
 * 那是人家的 GPL-3.0 数据，跟着我们的 GPL-3.0 一起分发是兼容的，但"没拷代码"就是假话。
 * 口径与 README 同一份。
 */
const REFERENCED: Array<[string, string, string]> = [
  ['LegadoTeam/legado', '书源规则 DSL 的求值语义、体检口径、书架版式与书源编辑字段分组', 'GPL-3.0'],
  ['LegadoTeam/legado（随包数据）', 'TXT 分章规则表 26 条：原样副本，不是重抄', 'GPL-3.0'],
  ['gedoor/legado_web_source_editor', '书源编辑器的字段分栏形式', 'MIT'],
]

const LICENSE_TEXT = '本项目以 GNU GPL-3.0 发布，完整条款见仓库根目录的 LICENSE 文件。你可以自由运行、研究、修改并分发本程序，但修改后的版本必须以同一协议公开。'

const TERMS_TEXT = '青阅是一个自托管的本地程序：它跑在你自己的机器上，数据放在你自己的目录里，服务默认只监听 127.0.0.1。使用它意味着你自己保管这些数据、自己负责访问了哪些站点。本程序不提供账号、不上传你的书架、不替你保存任何云端内容。'

const DISCLAIMER_TEXT = '本程序只是"按你给出的规则去取并渲染公开网页内容"的工具，本身不含任何书源、订阅源或发现源，也不内置任何作品。你导入的规则与地址所指向的内容由第三方站点提供，其合法性由内容提供方与使用者负责；请在你所在地区的法律允许范围内使用，并遵守目标站点的访问条款。作者不对因使用本程序产生的任何后果承担责任。'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="about-section">
      <h2>{title}</h2>
      <div className="about-section-body">{children}</div>
    </section>
  )
}

export function AboutPage({
  onOpenChangelog,
  onOpenShortcuts,
}: {
  onOpenChangelog: () => void
  onOpenShortcuts: () => void
}) {
  const [info, setInfo] = useState<AboutInfo | null>(null)
  const [check, setCheck] = useState<UpdateCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    void api.about().then(setInfo).catch(() => setNotice('关于信息没能从服务端读到'))
  }, [])

  const runCheck = () => {
    setChecking(true)
    setCheck(null)
    void api.checkUpdate().then(setCheck).catch(() => {
      // 这句原来写的是「检查请求没有发出去」—— 而真相往往是**发出去了、服务端 500 了**
      // （User-Agent 里塞中文应用名把 JDK 惹炸那次就是），话说明错了方向，排查的人就去查网络了。
      setCheck({ current: info?.version ?? '', repository: info?.repository ?? '', status: 'unreachable', message: '检查接口没回话：服务端报错或本机连不上 GitHub（看运行日志里那条异常）' })
    }).finally(() => setChecking(false))
  }

  const repository = info?.repository ?? ''
  const homepage = repository ? `https://github.com/${repository}` : ''

  return (
    <main className="about-page">
      <header className="about-hero">
        <h1>{info?.title ?? '青阅'}</h1>
        <p>把 Legado 书源规则跑在服务端的本地阅读库：书架、发现、订阅、朗读与离线缓存都在自己的机器上。</p>
        <dl className="about-facts">
          {/* 取失败时不能一直挂着「载入中…」：那行字会永远停在屏幕上（notice 在旁边，但版本这一格在说谎） */}
          <div><dt>版本</dt><dd>{info?.version ?? (notice ? '没取到' : '载入中…')}</dd></div>
          <div><dt>运行位置</dt><dd>{window.location.host}</dd></div>
          {/* 「开发者」这一格原来印的是仓库 slug，而 slug 的兜底值硬写着别人家的仓库
              （`lukelzlz/legado-server`，这份代码 clone 来的地方，不是本项目的归属）。
              现在没配仓库地址就直说没配，绝不替谁署名。 */}
          <div><dt>开发者</dt><dd>{repository || '未配置仓库地址（LEGADO_REPO）'}</dd></div>
        </dl>
        <div className="about-actions">
          {/* 没配仓库时按钮照旧可点：点了服务端会回一句"没配置"，比一颗点不动的按钮说得清 */}
          <button type="button" className="primary-button" onClick={runCheck} disabled={checking}>
            {checking ? '正在检查…' : '检查更新'}
          </button>
          <button type="button" className="ghost-button" onClick={onOpenChangelog}>更新日志</button>
          {/* 「更新日志」「快捷键」从「我的」下拉里收进来：那一栏原来堆了 9 项，
              用户 2026-10-03 拍板「顶栏『我的』菜单堆太多」。版本芯片本身也能进日志。 */}
          <button type="button" className="ghost-button" onClick={onOpenShortcuts}>快捷键</button>
          {homepage && <a className="ghost-button" href={homepage} target="_blank" rel="noreferrer">项目主页</a>}
        </div>
        {notice && <p className="about-check is-unreachable">{notice}</p>}
        {check && (
          <p className={`about-check is-${check.status}`}>
            {check.status === 'available' && <>有新版本 <strong>{check.latest}</strong>（当前 {check.current}）
              {check.url && <> · <a href={check.url} target="_blank" rel="noreferrer">查看这一版</a></>}</>}
            {check.status === 'latest' && <>已经是最新的 {check.current}（{check.repository} 上没有更新的发布）</>}
            {(check.status === 'not_found' || check.status === 'unreachable' || check.status === 'not_configured') && <>{check.message}</>}
          </p>
        )}
      </header>

      <Section title="用户协议">
        <p>{TERMS_TEXT}</p>
      </Section>

      <Section title="开源许可">
        <p>{LICENSE_TEXT}</p>
        <table className="about-table">
          <thead><tr><th>依赖</th><th>用途</th><th>协议</th></tr></thead>
          <tbody>{THIRD_PARTY.map(([name, purpose, license]) => <tr key={name}><td>{name}</td><td>{purpose}</td><td>{license}</td></tr>)}</tbody>
        </table>
        <h3>语义参照与随包的上游数据</h3>
        <table className="about-table">
          <thead><tr><th>项目</th><th>借鉴了什么</th><th>协议</th></tr></thead>
          <tbody>{REFERENCED.map(([name, purpose, license]) => <tr key={name}><td>{name}</td><td>{purpose}</td><td>{license}</td></tr>)}</tbody>
        </table>
      </Section>

      <Section title="免责声明">
        <p>{DISCLAIMER_TEXT}</p>
      </Section>
    </main>
  )
}

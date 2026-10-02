import React, { useEffect, useState } from 'react'
import { api, type AboutInfo, type UpdateCheckResult } from './api'

/**
 * 「关于」（用户 2026-10-02：「加入关于（名称，开发者，更新日志，检查更新，用户协议，开源许可，免责声明）」）。
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

/** 参照过语义的上游项目：借鉴设计，不拷代码。口径与 README 同一份。 */
const REFERENCED: Array<[string, string, string]> = [
  ['LegadoTeam/legado', '书源规则 DSL 的求值语义、体检口径、书架版式与书源编辑字段分组', 'GPL-3.0'],
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

export function AboutPage({ onOpenChangelog }: { onOpenChangelog: () => void }) {
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
      setCheck({ current: info?.version ?? '', repository: info?.repository ?? '', status: 'unreachable', message: '检查请求没有发出去' })
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
          <div><dt>版本</dt><dd>{info?.version ?? '载入中…'}</dd></div>
          <div><dt>运行位置</dt><dd>{window.location.host}</dd></div>
          <div><dt>开发者</dt><dd>{repository || '未署名'}</dd></div>
        </dl>
        <div className="about-actions">
          <button type="button" className="primary-button" onClick={runCheck} disabled={checking || !repository}>
            {checking ? '正在检查…' : '检查更新'}
          </button>
          <button type="button" className="ghost-button" onClick={onOpenChangelog}>更新日志</button>
          {homepage && <a className="ghost-button" href={homepage} target="_blank" rel="noreferrer">项目主页</a>}
        </div>
        {notice && <p className="about-check is-unreachable">{notice}</p>}
        {check && (
          <p className={`about-check is-${check.status}`}>
            {check.status === 'available' && <>有新版本 <strong>{check.latest}</strong>（当前 {check.current}）
              {check.url && <> · <a href={check.url} target="_blank" rel="noreferrer">查看这一版</a></>}</>}
            {check.status === 'latest' && <>已经是最新的 {check.current}（{check.repository} 上没有更新的发布）</>}
            {(check.status === 'not_found' || check.status === 'unreachable') && <>{check.message}</>}
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
        <h3>语义参照（借鉴设计，未拷代码）</h3>
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

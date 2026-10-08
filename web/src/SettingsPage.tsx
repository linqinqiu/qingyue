import React from 'react'

/**
 * 「设置」（用户 2026-10-03：「在我的里面新加一个设置，把一些 txt 目录规则、备份、替换净化之类的放进去」，
 * 并拍板「设置页收纳，原处只留快捷入口」）。
 *
 * 这一页**不重复实现任何编辑器**：每一行只是"它是什么 + 在哪儿改"，点下去仍然打开
 * 原来那个弹窗/页面（同一份实现，两个入口）。所以这里没有 settings prop、没有第二份状态 ——
 * 摆两个都能改的地方迟早会各改各的。
 *
 * 每行末尾那句 `also` 是写给用户看的：告诉他"平时更顺手的那条路在哪儿"，
 * 免得这一页变成新的杂物间。
 */
export type SettingsRow = {
  title: string
  hint: string
  /** 就近入口在哪儿；没有就只写这一页能进。 */
  also?: string
  action: string
  onClick: () => void
}

export type SettingsSection = { title: string; rows: SettingsRow[] }

export function SettingsPage({ sections }: { sections: SettingsSection[] }) {
  return (
    <main className="settings-page">
      <header className="page-title">
        <h1>设置</h1>
      </header>
      {sections.map(section => (
        <section key={section.title} className="settings-section">
          <h2>{section.title}</h2>
          <div className="settings-rows">
            {section.rows.map(row => (
              <div key={row.title} className="settings-row">
                <div className="settings-row-main">
                  <strong>{row.title}</strong>
                  <small>{row.hint}</small>
                  {!!row.also && <small className="settings-row-also">就近：{row.also}</small>}
                </div>
                <button type="button" className="subtle-button" onClick={row.onClick}>{row.action}</button>
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  )
}

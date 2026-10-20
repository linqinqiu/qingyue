import React, { useState } from 'react'
import { filterSettingsSections } from '../settings/settingsSections'

/**
 * 「设置」（用户 2026-10-03：「在我的里面新加一个设置，把一些 txt 目录规则、备份、替换净化之类的放进去」，
 * 并拍板「设置页收纳，原处只留快捷入口」）。
 *
 * 这一页**不重复实现任何编辑器**：每一行只是"它是什么 + 在哪儿改"，点下去仍然打开
 * 原来那个弹窗/页面（同一份实现，两个入口）。所以这里没有 settings prop、没有第二份数据状态 ——
 * 摆两个都能改的地方迟早会各改各的。
 *
 * 它有一个 `useState`，装的是**搜索框里的字**：那是这一页自己的界面态，不是任何设置的值。
 * 分区表与筛选算式都在 `settings/settingsSections.ts`，这里只管画。
 */
export type SettingsRow = {
  title: string
  hint: string
  action: string
  onClick: () => void
}

export type SettingsSection = { title: string; rows: SettingsRow[] }

/**
 * 插件贡献的设置分区。
 *
 * 与内置分区（[SettingsSection]）刻意不同形：内置分区是"一行一个入口"的导航表，
 * 插件分区是**自带渲染的内容块** —— 插件想放表单、开关、说明都行，宿主不规定里面长什么样。
 * 硬把两者塞进同一个形状，要么让插件只能放"打开某处"的按钮，要么让内置分区背上一堆用不上的字段。
 */
export type PluginSection = {
  id: string
  title: string
  description?: string
  render: () => React.ReactNode
}

export function SettingsPage({ sections, pluginSections = [] }: {
  sections: SettingsSection[]
  /** 插件贡献的分区。宿主只负责摆位置与搜索，不解释内容。 */
  pluginSections?: PluginSection[]
}) {
  const [query, setQuery] = useState('')
  const shown = filterSettingsSections(sections, query)
  const needle = query.trim().toLowerCase()
  // 插件分区也参与搜索：命中标题或说明就留着（内容内部不筛 —— 宿主不认识它的结构）
  const shownPlugins = needle === ''
    ? pluginSections
    : pluginSections.filter(s => `${s.title} ${s.description ?? ''}`.toLowerCase().includes(needle))
  const searching = query.trim() !== ''
  const nothingMatched = searching && shown.length === 0 && shownPlugins.length === 0
  return (
    <main className="settings-page">
      <header className="page-title">
        <h1>设置</h1>
      </header>
      <div className="settings-search-row">
        {/* type=search 是刻意的：`/` 与 Ctrl/⌘+F 找"这一页的搜索框"就认这个选择器（见 main.tsx 的 focusSearch） */}
        <input
          type="search"
          className="settings-search"
          placeholder="搜设置项"
          aria-label="搜设置项"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        {searching && <button type="button" className="link-button" onClick={() => setQuery('')}>清空</button>}
      </div>
      {nothingMatched ? (
        <p className="settings-no-match">
          {`没有匹配「${query.trim()}」的设置项。`}
          <button type="button" className="link-button" onClick={() => setQuery('')}>清空搜索</button>
        </p>
      ) : shown.map(section => (
        <section key={section.title} className="settings-section">
          <h2>{section.title}</h2>
          <div className="settings-rows">
            {section.rows.map(row => (
              <div key={row.title} className="settings-row">
                <div className="settings-row-main">
                  <strong>{row.title}</strong>
                  <small>{row.hint}</small>
                </div>
                <button type="button" className="subtle-button" onClick={row.onClick}>{row.action}</button>
              </div>
            ))}
          </div>
        </section>
      ))}
      {shownPlugins.map(section => (
        <section key={`plugin-${section.id}`} className="settings-section settings-section-plugin">
          <h2>{section.title}</h2>
          {section.description && <p className="settings-plugin-desc">{section.description}</p>}
          <div className="settings-plugin-body">{section.render()}</div>
        </section>
      ))}
    </main>
  )
}

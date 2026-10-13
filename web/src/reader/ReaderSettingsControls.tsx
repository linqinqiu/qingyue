import { useState } from 'react'
import { Icon } from '../icons'
import type { TocRuleOption } from '../lib/api'
import type { ReaderSettings } from './readerSettings'
import { TypographyTab } from './settingsPanel/TypographyTab'
import { ColorTab } from './settingsPanel/ColorTab'
import { BehaviorTab } from './settingsPanel/BehaviorTab'

/**
 * 阅读设置抽屉的内容 —— **三标签页容器**（P1，仿 legado「界面」面板的信息架构）。
 *
 * 原来是 11+ 个 section 挤一根长列（PROPOSAL-019 F 抽出时的形状），找一项要滚很久；
 * 现在按「排版 / 颜色 / 行为」三页组织，各页的行控件与值口径在 settingsPanel/ 下：
 *   - TypographyTab  字体、字号与间距、段落与版心、分栏、对齐
 *   - ColorTab       主题网格（内置七套 + customSkins 一处渲染）、阅读背景
 *   - BehaviorTab    简繁、翻页方式与动画、点击区域、工具栏、本地书目录、净化入口
 * 所有改动仍走 `onChange` 即时生效；本组件只管「现在显示哪一页」。
 */
const TABS = [
  { id: 'typography', label: '排版', icon: 'columns' },
  { id: 'color', label: '颜色', icon: 'eye' },
  { id: 'behavior', label: '行为', icon: 'sliders' },
] as const

type TabId = (typeof TABS)[number]['id']

export function ReaderSettingsControls({
  settings,
  onChange,
  onOpenReplaceRules,
  onEditTapZones,
  localBook,
  tocRuleOptions,
  onReparseLocal,
}: {
  settings: ReaderSettings
  onChange: (next: ReaderSettings) => void
  onOpenReplaceRules?: () => void
  /** 打开"在正文上编辑点击区域"那层。见 TapZoneEditor。 */
  onEditTapZones?: () => void
  /** 当前是导入到本机的书才给；在线书没有"目录规则"这件事。 */
  localBook?: { name: string; tocRule?: string | null } | null
  tocRuleOptions?: TocRuleOption[]
  /** 返回一句给人看的话；null 表示成功（成功的话由 reparseMessage 自己报）。 */
  onReparseLocal?: (ruleKey: string) => Promise<string | null>
}) {
  const [tab, setTab] = useState<TabId>('typography')
  return <div className="drawer-scroll-content settings-panel">
    <nav className="settings-tabs" role="tablist" aria-label="阅读设置分组">
      {TABS.map(entry => (
        <button
          key={entry.id}
          type="button"
          role="tab"
          aria-selected={tab === entry.id}
          className={`settings-tab${tab === entry.id ? ' selected' : ''}`}
          onClick={() => setTab(entry.id)}
        >
          <Icon name={entry.icon} />{entry.label}
        </button>
      ))}
    </nav>
    <div className="settings-tab-body" role="tabpanel">
      {tab === 'typography' && <TypographyTab settings={settings} onChange={onChange} />}
      {tab === 'color' && <ColorTab settings={settings} onChange={onChange} />}
      {tab === 'behavior' && (
        <BehaviorTab
          settings={settings}
          onChange={onChange}
          onOpenReplaceRules={onOpenReplaceRules}
          onEditTapZones={onEditTapZones}
          localBook={localBook}
          tocRuleOptions={tocRuleOptions}
          onReparseLocal={onReparseLocal}
        />
      )}
    </div>
  </div>
}

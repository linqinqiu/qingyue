import { useEffect, useState } from 'react'
import { Icon } from '../../icons'
import { Select } from '../../components/Select'
import type { TocRuleOption } from '../../lib/api'
import { type ReaderSettings } from '../readerSettings'
import { SCRIPT_MODE_OPTIONS } from '../scriptConvert'
import { moveReaderMenu, READER_MENU_ITEMS, toggleReaderMenu } from '../readerMenu'
import { mapCells } from '../tapZones'
import { SettingGroup } from './SettingRow'

/**
 * 「翻页与其它」标签页：简繁 / 翻页方式与动画 / 点击区域 / 工具栏 / 本地书目录 / 内容净化。
 * 从原 ReaderSettingsControls 单列拆来（P1 三标签页）——各节的值口径与文案原样保留，
 * 那些口径背后都踩过坑（注释也是），动之前先读。
 */
export function BehaviorTab({
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
  const update = (value: Partial<ReaderSettings>) => onChange({ ...settings, ...value })
  const [reparseBusy, setReparseBusy] = useState(false)
  const [reparseMessage, setReparseMessage] = useState('')
  /**
   * 「这本换成哪条重切」的暂选，**只影响这一本**：不写进 `settings.txtTocRule`，
   * 否则"给在读的这本换个规则"会顺手把下一本导入的默认规则也改掉（用户 2026-10-03：
   * 一个元素干两件事、功能分配不当）。null 表示还没改过，跟着这本当前生效的那条。
   */
  const [repick, setRepick] = useState<string | null>(null)
  const repickRule = repick ?? (localBook?.tocRule || 'auto')
  // 抽屉常驻挂载：换一本书读时那颗选择器要回到"跟着这本"，不能留着上一本的暂选。
  useEffect(() => { setRepick(null) }, [localBook?.name])
  const ruleLabelOf = (key?: string | null) =>
    tocRuleOptions?.find(option => option.key === (key || 'auto'))?.label ?? (key || '自动选择（按正文打分）')
  const runReparse = async () => {
    if (!onReparseLocal || reparseBusy) return
    setReparseBusy(true)
    setReparseMessage('')
    const failure = await onReparseLocal(repickRule).catch((error: unknown) => error instanceof Error ? error.message : '重切失败')
    setReparseMessage(failure ?? '')
    setReparseBusy(false)
  }
  return <>
    {/*
      简繁转换（用户 2026-10-11 的 A–F 里 C 项）。只换字形不换词 ——
      不摆"台湾用词"那种档，读小说时把「软件」写成「軟體」只会觉得译者换了个人。
    */}
    <SettingGroup title="简繁转换">
      <div className="page-modes">
        {SCRIPT_MODE_OPTIONS.map(option => (
          <button key={option.id} type="button" className={settings.scriptMode === option.id ? 'selected' : ''} onClick={() => update({ scriptMode: option.id })}>{option.label}</button>
        ))}
      </div>
      <small className="setting-hint">{settings.scriptMode === 'off' ? '按原样显示书里的字。' : `正文、章名、目录一起转${settings.scriptMode === 's2t' ? '，繁体按台港排版习惯（因为 → 因為）' : ''}；第一次打开要取一次词表，稍等一下。`}</small>
    </SettingGroup>
    <SettingGroup title="翻页方式">
      <div className="page-modes"><button className={settings.pageMode === 'scroll' ? 'selected' : ''} onClick={() => update({ pageMode: 'scroll' })}>连续滚动</button><button className={settings.pageMode === 'paginate' ? 'selected' : ''} onClick={() => update({ pageMode: 'paginate' })}>平移分页</button></div>
      <small className="setting-hint">{settings.pageMode === 'paginate' ? '左右轻扫或点击屏幕两侧平滑翻页' : '垂直滚动阅读，点击上下可快速翻滚'}</small>
    </SettingGroup>
    {settings.pageMode === 'paginate' && (
      <SettingGroup title="翻页动画">
        <div className="page-modes">
          <button className={settings.pageAnim === 'slide' ? 'selected' : ''} onClick={() => update({ pageAnim: 'slide' })}>平移过渡</button>
          <button className={settings.pageAnim === 'cover' ? 'selected' : ''} onClick={() => update({ pageAnim: 'cover' })}>覆盖</button>
          <button className={settings.pageAnim === 'fade' ? 'selected' : ''} onClick={() => update({ pageAnim: 'fade' })}>淡化</button>
          <button className={settings.pageAnim === 'none' ? 'selected' : ''} onClick={() => update({ pageAnim: 'none' })}>无动画</button>
        </div>
        <small className="setting-hint">翻页时怎么过渡。连续滚动模式没有页，用不上这一项。</small>
      </SettingGroup>
    )}
    {/*
      点击区域改到正文上编辑（用户 2026-10-09：「这个改成底下一小行，可以折叠进去，目的是显示更多书籍内容」）：
      抽屉里只留一颗入口，真正的编辑器是盖在正文上的一层 —— 调分区时看得见书，控制条收在底部一行。
    */}
    <SettingGroup
      title="点击区域"
      hint={`当前「${settings.pageMode === 'paginate' ? '平移分页' : '连续滚动'}」分 ${mapCells(settings.pageMode === 'paginate' ? settings.tapZones.paginate : settings.tapZones.scroll)} 区；进去在正文上拖横竖虚线改分区，改完立刻生效，不用重开这本书。`}
    >
      <button type="button" className="rules-setting-btn is-wide" onClick={onEditTapZones}>
        <span className="rules-setting-btn-label"><Icon name="sliders" />在正文上编辑点击区域</span>
        <Icon name="arrowRight" />
      </button>
    </SettingGroup>
    {/*
      工具栏可配置（用户 2026-10-11「阅读菜单可配置」）。清单来自 readerMenu.ts ——
      与右上角工具栏的渲染是同一份，这里只改「显示哪些 / 什么顺序」，不重写按钮。
    */}
    <SettingGroup title="工具栏">
      <div className="reader-menu-config">
        {READER_MENU_ITEMS.map(item => {
          const shown = settings.menuItems.includes(item.id)
          const index = settings.menuItems.indexOf(item.id)
          return (
            <div key={item.id} className={`reader-menu-row${shown ? '' : ' is-hidden'}`}>
              <button
                type="button"
                className="reader-menu-toggle"
                aria-pressed={shown}
                onClick={() => update({ menuItems: toggleReaderMenu(settings.menuItems, item.id) })}
              >
                <Icon name={shown ? 'check' : 'close'} />{item.label}
              </button>
              {shown && (
                <span className="reader-menu-move">
                  <button type="button" aria-label={`上移${item.label}`} disabled={index <= 0} onClick={() => update({ menuItems: moveReaderMenu(settings.menuItems, item.id, -1) })}>↑</button>
                  <button type="button" aria-label={`下移${item.label}`} disabled={index >= settings.menuItems.length - 1} onClick={() => update({ menuItems: moveReaderMenu(settings.menuItems, item.id, 1) })}>↓</button>
                </span>
              )}
            </div>
          )
        })}
      </div>
      <small className="setting-hint">右上角显示哪些按钮、按什么顺序。至少留一个。</small>
    </SettingGroup>
    {/*
      这一档只管**手上这一本**（用户 2026-10-03：「抽屉里只留『这本用的哪条 + 重切』」）。
      "下一本导入用哪条"不在这儿改 —— 那是在书架「导入本地」旁边的「分章规则」弹窗里，
      两处各管一件事，就不会出现"想改这本却把默认值带跑了"。
      上面那句报的是**实际生效**的那条，不是框里选中的那条：选了 A 而 A 在这本书上切不出
      第二个章节时服务端会回落，界面不能装作 A 生效了。
    */}
    {!!localBook && (tocRuleOptions?.length ?? 0) > 0 && (
      <SettingGroup title="本地书目录">
        <small className="setting-hint">
          这本《{localBook.name}》现在用的是「{ruleLabelOf(localBook.tocRule)}」。
          换规则会重切目录并清掉正文缓存，读到的位置会回到第 1 章（章号整个变了，没法照原样挪过去）。
        </small>
        {!!onReparseLocal && (
          <div className="toc-repick">
            <Select
              ariaLabel="换一条规则重切这本"
              value={repickRule}
              options={tocRuleOptions!
                .filter(option => !option.broken)
                .map(option => ({
                  value: option.key,
                  label: option.enable || option.builtIn || option.key === 'auto' ? option.label : `${option.label}（不参与自动）`,
                  hint: option.example || undefined,
                }))}
              onChange={setRepick}
            />
            <button type="button" className="rules-setting-btn" disabled={reparseBusy} onClick={() => void runReparse()}>
              {reparseBusy ? '正在重切目录…' : '按这条规则重新识别目录'}
            </button>
          </div>
        )}
        {!!reparseMessage && <small className="setting-hint">{reparseMessage}</small>}
      </SettingGroup>
    )}
    {onOpenReplaceRules && (
      <SettingGroup title="内容净化">
        {/* 之前这颗挂着 12 条内联样式，而隔壁「按这条规则重新识别目录」用同一个类名却是裸按钮
            —— 类名不管用、样式写在 JSX 里，改一处漏一处。现在两边都走 .rules-setting-btn。 */}
        <button type="button" className="rules-setting-btn is-wide" onClick={onOpenReplaceRules}>
          <span className="rules-setting-btn-label"><Icon name="edit" />替换净化规则管理</span>
          <Icon name="arrowRight" />
        </button>
        <small className="setting-hint">针对当前书籍/书源过滤广告与特定字符</small>
      </SettingGroup>
    )}
  </>
}

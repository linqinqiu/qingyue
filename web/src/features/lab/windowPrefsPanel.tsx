import React from 'react'
import type { PluginSettingsSection } from '../../extensions/registry'

/**
 * 「界面偏好」—— 实验室功能的设置分区，**不是插件**。
 *
 * 用户要求："我希望各个功能的界面位置也可以自定义……悬浮窗的固定、大小样式，
 * 能否移动之类的细节方面照样支持。"
 *
 * 这条把"窗口默认行为"做成可在设置页里调的项 —— 也就是把浮动窗口框架的能力
 * 暴露给用户，而不是只能拖一次记一次。
 *
 * 它贡献的是**设置分区**而不是实验室条目：这类配置属于设置页，不该塞进实验室窗口。
 * 设置分区既可由实验室功能提供，也可由插件提供 —— 这条属于前者。
 */

/** 窗口偏好的存储键（与 FloatingWindow 的 storageKey 无关 —— 那是每个窗口自己的几何）。 */
const PREF_KEY = 'qingyue-window-prefs-v1'

export type WindowPrefs = {
  /** 打开浮动窗口时是否默认钉住（固定位置，不可拖动）。 */
  defaultPinned: boolean
  /** 打开时是否默认最小化（只留悬浮按钮）。 */
  startMinimized: boolean
}

const DEFAULTS: WindowPrefs = { defaultPinned: false, startMinimized: false }

export function loadWindowPrefs(): WindowPrefs {
  try {
    const raw = window.localStorage.getItem(PREF_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<WindowPrefs>
    return { ...DEFAULTS, ...parsed }
  } catch {
    return DEFAULTS
  }
}

function saveWindowPrefs(prefs: WindowPrefs): void {
  try { window.localStorage.setItem(PREF_KEY, JSON.stringify(prefs)) } catch { /* 存不进就算了 */ }
}

/** 设置分区的内容体：两个开关。 */
function WindowPrefsPanel() {
  const [prefs, setPrefs] = React.useState<WindowPrefs>(loadWindowPrefs)
  const update = (next: Partial<WindowPrefs>) => {
    const merged = { ...prefs, ...next }
    setPrefs(merged)
    saveWindowPrefs(merged)
  }
  return (
    <>
      <label className="settings-plugin-row">
        <input
          type="checkbox"
          checked={prefs.defaultPinned}
          onChange={event => update({ defaultPinned: event.target.checked })}
        />
        <span>浮动窗口默认钉住（打开就固定位置，不可拖动）</span>
      </label>
      <label className="settings-plugin-row">
        <input
          type="checkbox"
          checked={prefs.startMinimized}
          onChange={event => update({ startMinimized: event.target.checked })}
        />
        <span>浮动窗口默认收起（只留一个悬浮按钮）</span>
      </label>
      <p className="settings-plugin-note">
        位置与大小在拖动/缩放时自动记住，不需要在这里配。
      </p>
    </>
  )
}

/** 设置分区：实验室功能自己贡献的那一块。 */
export const windowPrefsSection: PluginSettingsSection = {
  id: 'window-prefs',
  title: '界面偏好',
  description: '控制浮动窗口打开时的默认状态。位置与大小会自动记住，不用在这里配。',
  render: () => <WindowPrefsPanel />,
}


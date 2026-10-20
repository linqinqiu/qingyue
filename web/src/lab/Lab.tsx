import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'
import { FloatingWindow } from './FloatingWindow'
import { useEscapeClose } from '../lib/useEscapeClose'

/**
 * 实验室（Lab）—— 悬浮式框架容器，承载"还没进主界面"的能力。
 *
 * 设计定位（用户原话："ai 相关界面你还没有做好，将其放到实验室，可以悬浮"）：
 * 实验室**本身不含任何功能**。它只提供三样东西：
 * 1. 一个**可悬浮**的容器（拖拽、最小化、贴边），不占路由、不占导航栏；
 * 2. 一组**实验条目**的登记位（[LabEntry]）—— 谁想进来，自己登记；
 * 3. 统一的入口与关闭语义（Esc、role=dialog、.dialog-shell 一档几何）。
 *
 * 所以"把 AI 接入放进实验室"这件事，对实验室而言只是**登记了一条实验条目**，
 * 而不是实验室里写死了 AI。将来加别的实验件（插件管理、调试探针、实验开关），
 * 同样是登记一条，实验室本身不用改。
 *
 * 悬浮能力：拖标题栏可移动位置，位置记在 localStorage；双击标题栏复位。
 * 不引入拖拽库 —— 一个 mousedown/mousemove 循环够了，也省掉一个依赖。
 */

/** 一条实验条目。实验室只认这个形状，不认具体内容。 */
export type LabEntry = {
  /** 稳定 id，用于记住"上次停在哪个实验"。 */
  id: string
  /** 显示名。 */
  title: string
  /** 一句话说明这是什么、能干什么。 */
  description: string
  /**
   * 渲染这个实验的内容。
   *
   * 参数是**宿主上下文**（[LabHostContext]）—— 由实验室的调用方提供，
   * 让条目能知道"用户此刻在哪个界面、在看什么"。实验室自己不认识这些字段，
   * 只是原样转发：框架不解释内容，只提供通道。
   */
  render: (host: LabHostContext) => React.ReactNode
  /** 可选：条目标签，如 '实验' / '调试' / 'AI'。 */
  badge?: string
}

/**
 * 宿主上下文 —— 实验室向条目转发的"外面世界"。
 *
 * 刻意用 `unknown` 而不是具体类型：实验室是框架，不该知道 `uiContext` 是什么形状
 * （那是插件与宿主之间的约定）。框架只负责**通道**，不解释内容。
 *
 * 两条通道，刻意分开：
 * - [actions]：**做**某事（打开浮层、跳页、刷新）
 * - [data]：**取**某个值（某个清单、加载状态、当前设置 —— 具体是什么由插件与宿主约定）
 *
 * 为什么不合成一个：动作有副作用、数据不该有；混在一张表里，插件很容易在 render
 * 期间调一个"顺便改了状态"的动作，那就是在渲染期写状态（React 会警告且行为不可预期）。
 * 分开之后，`data` 明确是只读快照，`actions` 明确是事件回调。
 */
export type LabHostContext = {
  /** 任意宿主提供的上下文（当前是 UI 上下文，见 lib/uiContext.ts）。 */
  uiContext?: unknown
  /** 宿主的服务端版本号（来自 /healthz）。插件要显示版本时用它，别自己写死。 */
  serverVersion?: string
  /**
   * 宿主能替插件做的事（打开别的浮层、跳页等）。
   *
   * 为什么用 `Record<string, (...args: never[]) => void>` 而不是具体签名：
   * 实验室是框架，不该知道"宿主支持哪些动作"。插件与宿主之间自己约定 key
   * （如 `openShortcuts`），框架只负责**原样转发**这张表。
   */
  actions?: Record<string, (...args: any[]) => void>
  /**
   * 宿主能给插件读的数据快照（某个清单、加载状态等 —— 具体是什么由插件与宿主约定）。
   *
   * 同样是开放表：key 由插件与宿主约定，框架不认识内容。
   * 取到的是**渲染那一刻的快照** —— 插件要更新就靠宿主重新渲染，
   * 不要在插件里缓存它（缓存了就会看到过期数据）。
   */
  data?: Record<string, unknown>
}

export function Lab({
  entries,
  onClose,
  title = '实验室',
  host = {},
  initialEntryId,
}: {
  entries: LabEntry[]
  onClose: () => void
  title?: string
  /** 宿主上下文：原样转发给每个条目，实验室不解释内容。 */
  host?: LabHostContext
  /** 直接打开某个条目（深链/快捷入口用）。找不到就退回第一条。 */
  initialEntryId?: string
}) {
  useEscapeClose(onClose)

  const [activeId, setActiveId] = useState<string>(() => {
    // 指定了 initialEntryId 且确实存在就用它（深链/快捷入口），否则第一条。
    if (initialEntryId && entries.some(e => e.id === initialEntryId)) return initialEntryId
    return entries[0]?.id ?? ''
  })

  // initialEntryId 变了就跟着切（同一次会话里点不同深链/不同入口时会发生）。
  // 只靠 useState 的初始值不行 —— 那是一次性的，组件没重挂就永远停在第一条。
  //
  // 依赖里刻意不放 `entries`：宿主每次渲染都会传一个新数组（插件清单是现拼的），
  // 放进来就是每轮都重跑 effect。条目存在性用 ref 读最新值来判断。
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  useEffect(() => {
    if (!initialEntryId) return
    if (!entriesRef.current.some(e => e.id === initialEntryId)) return
    setActiveId(initialEntryId)
  }, [initialEntryId])
  const active = useMemo(
    () => entries.find(e => e.id === activeId) ?? entries[0],
    [entries, activeId],
  )

  // 悬浮定位：有记忆位置就 fixed 到那儿，否则用默认的右下角
  // 窗口几何/钉住/最小化/拖拽/缩放全部交给 FloatingWindow —— 实验室自己不再管定位。
  // 这正是"宏大架构"的落点：窗口怎么摆是框架能力，装什么内容是插件的事。
  return (
    <FloatingWindow
      storageKey="qingyue-lab-window-v1"
      title={title}
      defaultRect={{ width: 780, height: 560 }}
      minWidth={420}
      minHeight={320}
      onClose={onClose}
      actions={<Icon name="sliders" />}
    >
      <div className="lab-body">
        <nav className="lab-nav" aria-label="实验条目">
          {entries.map(entry => (
            <button
              key={entry.id}
              type="button"
              className={`lab-nav-item${entry.id === active?.id ? ' active' : ''}`}
              onClick={() => setActiveId(entry.id)}
            >
              <span className="lab-nav-title">{entry.title}</span>
              {entry.badge && <span className="lab-nav-badge">{entry.badge}</span>}
            </button>
          ))}
          {entries.length === 0 && <p className="lab-empty">还没有登记任何实验条目。</p>}
        </nav>

        <section className="lab-content" aria-label={active?.title ?? '实验内容'}>
          {active ? (
            <>
              <p className="lab-desc">{active.description}</p>
              {active.render(host)}
            </>
          ) : (
            <p className="lab-empty">实验室是空的：这里是承载"还没进主界面"能力的地方。</p>
          )}
        </section>
      </div>
    </FloatingWindow>
  )
}
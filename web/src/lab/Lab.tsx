import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'
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
  /** 渲染这个实验的内容。 */
  render: () => React.ReactNode
  /** 可选：条目标签，如 '实验' / '调试' / 'AI'。 */
  badge?: string
}

const POS_KEY = 'qingyue-lab-position-v1'
const MINIMIZED_KEY = 'qingyue-lab-minimized-v1'

type Position = { x: number; y: number }

function loadPosition(): Position | null {
  try {
    const raw = window.localStorage.getItem(POS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Position
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return parsed
  } catch { /* 存不进就当没存过 */ }
  return null
}

function savePosition(pos: Position) {
  try { window.localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch { /* 忽略 */ }
}

export function Lab({
  entries,
  onClose,
  title = '实验室',
}: {
  entries: LabEntry[]
  onClose: () => void
  title?: string
}) {
  useEscapeClose(onClose)

  const [activeId, setActiveId] = useState<string>(() => entries[0]?.id ?? '')
  const [position, setPosition] = useState<Position | null>(() => loadPosition())
  const [minimized, setMinimized] = useState<boolean>(() => {
    try { return window.localStorage.getItem(MINIMIZED_KEY) === '1' } catch { return false }
  })
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)

  const active = useMemo(
    () => entries.find(e => e.id === activeId) ?? entries[0],
    [entries, activeId],
  )

  // 拖拽：按下标题栏开始，松开结束。用 window 监听保证鼠标移出容器也不丢。
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const next = {
        x: drag.origX + (event.clientX - drag.startX),
        y: drag.origY + (event.clientY - drag.startY),
      }
      setPosition(next)
    }
    const onUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
      setPosition(prev => {
        if (prev) savePosition(prev)
        return prev
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const startDrag = (event: React.MouseEvent) => {
    // 只认左键，且不抢关闭按钮/切换按钮的点击
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button')) return
    const shell = shellRef.current
    const rect = shell?.getBoundingClientRect()
    const orig = position ?? { x: rect?.left ?? 0, y: rect?.top ?? 0 }
    dragRef.current = { startX: event.clientX, startY: event.clientY, origX: orig.x, origY: orig.y }
  }

  const resetPosition = () => {
    setPosition(null)
    try { window.localStorage.removeItem(POS_KEY) } catch { /* 忽略 */ }
  }

  const toggleMinimize = () => {
    setMinimized(prev => {
      const next = !prev
      try { window.localStorage.setItem(MINIMIZED_KEY, next ? '1' : '0') } catch { /* 忽略 */ }
      return next
    })
  }

  // 悬浮定位：有记忆位置就 fixed 到那儿，否则用默认的右下角
  const shellStyle: React.CSSProperties = position
    ? { position: 'fixed', left: position.x, top: position.y, margin: 0, right: 'auto', bottom: 'auto' }
    : { position: 'fixed', right: 24, bottom: 24, margin: 0, left: 'auto', top: 'auto' }

  if (minimized) {
    return (
      <button
        type="button"
        className="lab-fab"
        style={shellStyle}
        onClick={toggleMinimize}
        aria-label={`展开${title}`}
        title={`展开${title}`}
      >
        <Icon name="sliders" />
        <span>{title}</span>
      </button>
    )
  }

  return (
    <div className="lab-overlay" onClick={onClose}>
      <div
        ref={shellRef}
        className="dialog-shell size-l lab-shell"
        style={shellStyle}
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="dialog-head lab-head" onMouseDown={startDrag} onDoubleClick={resetPosition}>
          <h2><Icon name="sliders" /> {title}</h2>
          <div className="lab-head-actions">
            <button
              type="button"
              className="overlay-close"
              aria-label="最小化"
              title="最小化（再点悬浮按钮展开）"
              onClick={toggleMinimize}
            >
              <Icon name="chevronDown" />
            </button>
            <button type="button" className="overlay-close" aria-label="关闭" onClick={onClose}>
              <Icon name="close" />
            </button>
          </div>
        </header>

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
                {active.render()}
              </>
            ) : (
              <p className="lab-empty">实验室是空的：这里是承载"还没进主界面"能力的地方。</p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

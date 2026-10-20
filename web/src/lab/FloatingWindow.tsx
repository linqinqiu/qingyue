/**
 * 浮动窗口框架 —— 让"窗口怎么摆"成为可自定义的能力，而不是每个浮层各写一套。
 *
 * 用户要求（原话）："我希望各个功能的界面位置也可以自定义，咱们提供非常宏大的架构，
 * 提供支持，比如悬浮窗的固定、大小样式，能否移动之类的细节方面照样支持。"
 *
 * 所以这里把"浮动窗口"的**几何与行为**抽成框架，与"窗口里装什么"彻底分开：
 *
 * ```
 * FloatingWindow（框架：位置/尺寸/钉住/最小化/拖拽/缩放/记忆）
 *      └── 内容（插件提供，框架不认识）
 * ```
 *
 * 四条设计决定：
 * 1. **状态全部可持久化**：位置、尺寸、钉住、最小化都记在 localStorage，重开还在原处。
 * 2. **钉住（pin）**：钉住后不可拖动、不可缩放、不可最小化 —— 给"我要它一直待在这儿"用。
 * 3. **边界夹取**：窗口不许被拖到视口外（拖出去就再也点不到了，这是最常见的浮动窗 bug）。
 * 4. **框架不认识内容**：这里没有任何业务字样，装什么由调用方决定。
 *
 * 为什么不做成通用 hook + 组件两层：几何计算（夹取、缩放）需要 ref 与事件循环，
 * 塞进 hook 反而更难读；一个组件把"状态 + 渲染 + 交互"放一起最直接。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** 窗口几何。坐标是视口坐标（position: fixed）。 */
export type WindowRect = {
  x: number
  y: number
  width: number
  height: number
}

/** 窗口的持久化状态。 */
export type WindowState = {
  rect: WindowRect
  /** 钉住：不可拖动/缩放/最小化。 */
  pinned: boolean
  /** 最小化：只留一个悬浮按钮。 */
  minimized: boolean
  /** 折叠成按钮时的位置（与 rect 分开记，展开时回到 rect）。 */
  fab?: { x: number; y: number }
}

export type FloatingWindowProps = {
  /** 持久化 key：同一个 key 的窗口共享记忆。 */
  storageKey: string
  /** 标题栏文字。 */
  title: string
  /** 初始几何（没有记忆时用）。 */
  defaultRect?: Partial<WindowRect>
  /** 最小/最大尺寸限制。 */
  minWidth?: number
  minHeight?: number
  /** 内容。 */
  children: React.ReactNode
  /** 标题栏右侧的自定义动作（关闭键等由调用方给）。 */
  actions?: React.ReactNode
  /** 关闭回调。 */
  onClose?: () => void
  /** 是否显示"钉住"按钮（默认显示）。 */
  showPin?: boolean
  /** 是否显示"最小化"按钮（默认显示）。 */
  showMinimize?: boolean
  /** 关闭时是否允许点外部遮罩（默认允许）。 */
  closeOnBackdrop?: boolean
}

const DEFAULT_RECT: WindowRect = { x: 0, y: 0, width: 720, height: 520 }
/** 窗口离视口边缘至少留这么多，避免拖到完全看不见。 */
const EDGE_MARGIN = 8

function loadState(key: string): WindowState | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as WindowState
    if (!parsed?.rect || typeof parsed.rect.x !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function saveState(key: string, state: WindowState) {
  try {
    window.localStorage.setItem(key, JSON.stringify(state))
  } catch {
    /* 存不进就当没记忆，不影响使用 */
  }
}

/** 把矩形夹回视口内。窗口拖出去再也点不到是最常见的浮动窗 bug。 */
function clampRect(rect: WindowRect, minW: number, minH: number): WindowRect {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(Math.max(rect.width, minW), Math.max(vw - EDGE_MARGIN * 2, minW))
  const height = Math.min(Math.max(rect.height, minH), Math.max(vh - EDGE_MARGIN * 2, minH))
  // x 允许略微超出左侧（负值），但要保证**标题栏右半截还在视口里** ——
  // 标题栏是唯一能把它拖回来的地方，全拖出去就再也抓不到了。
  // 所以下限是「标题栏至少留 160px 可见」：`-(width - 160)`。
  const xMin = -(width - 160)
  const x = Math.min(Math.max(rect.x, xMin), vw - 160)
  // y 不许为负（标题栏跑到顶栏底下就抓不到了），也不许整条掉出底部。
  const y = Math.min(Math.max(rect.y, 0), vh - 40)
  return { x, y, width, height }
}

export function FloatingWindow({
  storageKey,
  title,
  defaultRect,
  minWidth = 320,
  minHeight = 240,
  children,
  actions,
  onClose,
  showPin = true,
  showMinimize = true,
  closeOnBackdrop = true,
}: FloatingWindowProps) {
  const initial = useMemo(() => {
    const remembered = loadState(storageKey)
    if (remembered) return remembered
    const base = { ...DEFAULT_RECT, ...defaultRect }
    return { rect: base, pinned: false, minimized: false } as WindowState
  }, [storageKey, defaultRect])

  const [state, setState] = useState<WindowState>(initial)
  const shellRef = useRef<HTMLDivElement | null>(null)
  // 拖动/缩放期间的起始快照（用 ref 避免每次 mousemove 都触发重渲染以外的开销）
  const dragRef = useRef<{ kind: 'move' | 'resize'; startX: number; startY: number; origin: WindowRect } | null>(null)

  // 状态变了就记下来（钉住/最小化也记 —— 用户下次打开该是同一个样子）
  useEffect(() => {
    saveState(storageKey, state)
  }, [storageKey, state])

  const updateRect = useCallback((next: WindowRect) => {
    setState(prev => ({ ...prev, rect: clampRect(next, minWidth, minHeight) }))
  }, [minWidth, minHeight])

  // 视口变小（窗口缩放/手机横竖屏）时把窗口夹回来，否则会有一半在屏幕外
  useEffect(() => {
    const onResize = () => setState(prev => ({ ...prev, rect: clampRect(prev.rect, minWidth, minHeight) }))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [minWidth, minHeight])

  // 拖动与缩放共用一个鼠标循环：按下时记快照，move 时算差值。
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      if (drag.kind === 'move') {
        updateRect({ ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy })
      } else {
        updateRect({
          ...drag.origin,
          width: drag.origin.width + dx,
          height: drag.origin.height + dy,
        })
      }
    }
    const onUp = () => {
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [updateRect])

  const beginDrag = (kind: 'move' | 'resize') => (event: React.MouseEvent) => {
    if (state.pinned) return
    if (event.button !== 0) return
    // 拖动标题栏时别抢按钮的点击
    if (kind === 'move' && (event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    dragRef.current = { kind, startX: event.clientX, startY: event.clientY, origin: state.rect }
    document.body.style.userSelect = 'none'
    if (kind === 'resize') document.body.style.cursor = 'nwse-resize'
  }

  const togglePin = () => setState(prev => ({ ...prev, pinned: !prev.pinned }))
  const toggleMinimize = () => setState(prev => ({ ...prev, minimized: !prev.minimized }))
  const reset = () => {
    setState({ rect: { ...DEFAULT_RECT, ...defaultRect }, pinned: false, minimized: false })
  }

  // —— 最小化：只留一个悬浮按钮 ——
  if (state.minimized) {
    const fab = state.fab ?? { x: Math.max(state.rect.x, 24), y: Math.max(state.rect.y, 24) }
    return (
      <button
        type="button"
        className="fw-fab"
        style={{ position: 'fixed', left: fab.x, top: fab.y }}
        onClick={toggleMinimize}
        aria-label={`展开${title}`}
        title={`展开${title}`}
      >
        <span className="fw-fab-title">{title}</span>
      </button>
    )
  }

  return (
    <div
      className="fw-backdrop"
      onClick={closeOnBackdrop ? onClose : undefined}
      // 钉住时也不许点外部关闭：钉住语义就是"别动它"
      style={state.pinned || !closeOnBackdrop ? { pointerEvents: 'none' } : undefined}
    >
      <div
        ref={shellRef}
        className={`fw-shell${state.pinned ? ' is-pinned' : ''}`}
        style={{
          position: 'fixed',
          left: state.rect.x,
          top: state.rect.y,
          width: state.rect.width,
          height: state.rect.height,
          pointerEvents: 'auto',
        }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={event => event.stopPropagation()}
      >
        <header className="fw-head" onMouseDown={beginDrag('move')} onDoubleClick={reset}>
          <span className="fw-title">{title}</span>
          <span className="fw-head-actions">
            {actions}
            {showPin && (
              <button
                type="button"
                className={`fw-btn${state.pinned ? ' is-on' : ''}`}
                aria-label={state.pinned ? '取消钉住' : '钉住'}
                title={state.pinned ? '取消钉住（钉住时不可拖动）' : '钉住（固定位置，不可拖动）'}
                onClick={togglePin}
              >
                {state.pinned ? '钉' : '钉'}
              </button>
            )}
            {showMinimize && (
              <button type="button" className="fw-btn" aria-label="最小化" title="最小化" onClick={toggleMinimize}>
                收
              </button>
            )}
            {onClose && (
              <button type="button" className="fw-btn" aria-label="关闭" title="关闭" onClick={onClose}>
                关
              </button>
            )}
          </span>
        </header>

        <div className="fw-body">{children}</div>

        {/* 右下角缩放把手：钉住时不给（钉住就是别动） */}
        {!state.pinned && (
          <span
            className="fw-resize"
            onMouseDown={beginDrag('resize')}
            role="presentation"
            title="拖动调整大小"
          />
        )}
      </div>
    </div>
  )
}

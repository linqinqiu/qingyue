import { useEffect, useState } from 'react'
import { Icon, type IconName } from './icons'

export type ContextMenuItem = {
  label: string
  icon?: IconName
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

type OpenMenu = { x: number; y: number; items: ContextMenuItem[] }

let publish: (menu: OpenMenu | null) => void = () => {}

/** 在 onContextMenu 里调用：拦下浏览器原生菜单，换成应用内动作菜单。 */
export function showContextMenu(event: { preventDefault: () => void; clientX: number; clientY: number }, items: ContextMenuItem[]) {
  const usable = items.filter(item => !item.disabled)
  if (!usable.length) return
  event.preventDefault()
  publish({ x: event.clientX, y: event.clientY, items: usable })
}

export function ContextMenuLayer() {
  const [menu, setMenu] = useState<OpenMenu | null>(null)

  useEffect(() => {
    publish = setMenu
    return () => { publish = () => {} }
  }, [])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    // 捕获阶段拦下这一次的 pointerdown，避免「右键→菜单刚出现就被自己关掉」
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      close()
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    addEventListener('pointerdown', onPointerDown, true)
    addEventListener('blur', close)
    addEventListener('resize', close)
    addEventListener('scroll', close, true)
    addEventListener('keydown', onKey)
    return () => {
      removeEventListener('pointerdown', onPointerDown, true)
      removeEventListener('blur', close)
      removeEventListener('resize', close)
      removeEventListener('scroll', close, true)
      removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (!menu) return null
  const width = 210
  const height = menu.items.length * 34 + 12
  return (
    <div
      ref={node => { menuRef.current = node }}
      className="context-menu"
      role="menu"
      style={{
        left: Math.max(8, Math.min(menu.x, innerWidth - width - 8)),
        top: Math.max(8, Math.min(menu.y, innerHeight - height - 8)),
      }}
      onContextMenu={event => event.preventDefault()}
    >
      {menu.items.map(item => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? 'context-menu-danger' : ''}
          onClick={() => { setMenu(null); item.onSelect() }}
        >
          {item.icon && <Icon name={item.icon} />}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  )
}

const menuRef: { current: HTMLDivElement | null } = { current: null }

import type { ReactNode } from 'react'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'

/**
 * MD3 底部弹层（PROPOSAL-020 P3/P4）—— 阅读「界面」「设置」两处共用。
 *
 * 浮层并档（PROPOSAL-018 W2）：外壳复用 `.dialog-shell`、挡片复用 `.overlay-backdrop`、
 * 关闭键复用 `.overlay-close`，只加一个 `.is-sheet` 开关把它从"居中"改成"贴底" —— 不新造几何。
 */
export function ReaderSheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  useEscapeClose(onClose)
  if (!open) return null
  return (
    <div className="overlay-backdrop is-sheet" onClick={onClose}>
      <div
        className="dialog-shell is-sheet"
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="md3-sheet-header">
          <span className="md3-sheet-handle" aria-hidden="true" />
          <div className="md3-sheet-title">
            <strong>{title}</strong>
            <button type="button" className="overlay-close" aria-label={`关闭${title}`} onClick={onClose}><Icon name="close" /></button>
          </div>
        </header>
        <div className="md3-sheet-body">{children}</div>
      </div>
    </div>
  )
}

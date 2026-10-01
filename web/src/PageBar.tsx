import type { ReactNode } from 'react'

/**
 * 每页的页头只有一行：页名 + 就地上下文 + 右侧动作。
 *
 * 改版前每页是「绿色小标 + 34px 衬线大标题 + 一句说明书」，在 1440×900 下光页头就吃掉
 * 150~180px；库页与发现页因此有 47% 与 67% 的屏是空的（数字见 tools/verify/frame-metrics.mjs
 * 的 out/frame-metrics-before.json）。标题不再承担"介绍这个产品是谁"，那一行是工具条。
 */
export function PageBar({ title, meta, actions }: { title: string; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-bar">
      <h1>{title}</h1>
      {meta ? <span className="page-bar-meta">{meta}</span> : null}
      {actions ? <div className="page-bar-actions">{actions}</div> : null}
    </header>
  )
}

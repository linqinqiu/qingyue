// 书架布局偏好。数值口径照抄上游 Legado 的 `bookshelfLayout`
// （reference/legado-team `ui/main/bookshelf`：0=列表 1=紧凑列表 2~6=网格且值即列数），
// 这样以后对齐全局设置时不用再造一套编号。7 是我们自己加的一档：
// 照「发现」页那样按容器宽度自动排封面（auto-fill），也是新用户的默认值。
export type ShelfLayout = { mode: 'list' | 'compact' | 'grid' | 'auto'; columns: number }

const KEY = 'legado-shelf-layout-v1'
export const GRID_RANGE = [3, 4, 5, 6] as const
export const DEFAULT_LAYOUT = 7

export function layoutToCode(layout: ShelfLayout): number {
  if (layout.mode === 'list') return 0
  if (layout.mode === 'compact') return 1
  if (layout.mode === 'auto') return 7
  return Math.min(6, Math.max(2, layout.columns))
}

export function codeToLayout(code: number): ShelfLayout {
  if (code === 0) return { mode: 'list', columns: 0 }
  if (code === 1) return { mode: 'compact', columns: 0 }
  if (code === 7) return { mode: 'auto', columns: 0 }
  return { mode: 'grid', columns: Math.min(6, Math.max(2, code)) }
}

export function readShelfLayout(): ShelfLayout {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return codeToLayout(DEFAULT_LAYOUT)
    const code = Number(raw)
    return Number.isInteger(code) ? codeToLayout(code) : codeToLayout(DEFAULT_LAYOUT)
  } catch {
    return codeToLayout(DEFAULT_LAYOUT)
  }
}

export function writeShelfLayout(layout: ShelfLayout) {
  try {
    localStorage.setItem(KEY, String(layoutToCode(layout)))
  } catch {
    // 隐私模式下 localStorage 会抛，布局偏好丢了不影响阅读
  }
}

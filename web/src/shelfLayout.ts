// 书架布局偏好。
//
// 列表 / 紧凑列表两档沿用上游 Legado 的 `bookshelfLayout` 0/1（reference/legado-team
// `ui/main/bookshelf`）。网格档不照抄上游的「2~6 列」：上游跑在屏宽固定的手机上，列数就等于封面大小；
// 浏览器窗口从 320 到 3440 都可能，实测同一档在桌面是 567x756 的巨图、在手机是 60x80 的邮票
// （`tools/verify/shelf-layout-measure.mjs`）。所以网格用 `auto-fill` 让列数随窗口自己算，
// 封面尺寸只留一档（用户 2026-09-29：「封面网格的大中小，只留下小的，其余不用了」）。
export type ShelfMode = 'grid' | 'list' | 'compact'
export type ShelfLayout = { mode: ShelfMode }

const KEY = 'legado-shelf-layout-v2'
const LEGACY_KEY = 'legado-shelf-layout-v1'

export const DEFAULT_LAYOUT: ShelfLayout = { mode: 'grid' }
/** 只用于读懂历史值，界面不再提供这些档。 */
const RETIRED_DENSITY = ['sm', 'md', 'lg']

/** 旧版本存的是上游那种数值编号（0=列表 1=紧凑 2~7=列数/自动），一次性搬到新口径。 */
export function layoutFromLegacyCode(code: number): ShelfLayout {
  if (code === 0) return { mode: 'list' }
  if (code === 1) return { mode: 'compact' }
  return { mode: 'grid' }
}

export function encodeLayout(layout: ShelfLayout): string {
  return layout.mode
}

export function decodeLayout(value: string): ShelfLayout | null {
  if (value === 'list') return { mode: 'list' }
  if (value === 'compact') return { mode: 'compact' }
  if (value === 'grid') return { mode: 'grid' }
  // 密度档已经废弃，但老用户 localStorage 里存的就是 `grid:sm|md|lg`，要还能读成"网格"这一件事；
  // 只认这三个旧名字，别的后缀照样算非法值，否则这个函数就退化成"以 grid 开头都收"。
  const suffix = value.startsWith('grid:') ? value.slice('grid:'.length) : null
  return suffix !== null && (suffix === '' || RETIRED_DENSITY.includes(suffix)) ? { mode: 'grid' } : null
}

export function readShelfLayout(): ShelfLayout {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw !== null) {
      const parsed = decodeLayout(raw)
      if (parsed) return parsed
    }
    const legacy = localStorage.getItem(LEGACY_KEY)
    // 只有真的存过旧编号才迁移；全新用户直接吃默认值。
    return legacy === null ? DEFAULT_LAYOUT : layoutFromLegacyCode(Number(legacy))
  } catch {
    return DEFAULT_LAYOUT
  }
}

export function writeShelfLayout(layout: ShelfLayout) {
  try {
    localStorage.setItem(KEY, encodeLayout(layout))
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // 隐私模式下 localStorage 会抛，布局偏好丢了不影响阅读
  }
}

/** 书架排序偏好（桌面端库管理）。默认按最后阅读时间倒序。 */
export type ShelfSort = 'recent' | 'name' | 'author' | 'progress'
const SORT_KEY = 'legado-shelf-sort-v1'
const SORT_VALUES: ShelfSort[] = ['recent', 'name', 'author', 'progress']

export function readShelfSort(): ShelfSort {
  try {
    if (typeof localStorage === 'undefined') return 'recent'
    const raw = localStorage.getItem(SORT_KEY)
    return SORT_VALUES.includes(raw as ShelfSort) ? (raw as ShelfSort) : 'recent'
  } catch {
    return 'recent'
  }
}

export function writeShelfSort(sort: ShelfSort) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(SORT_KEY, sort)
  } catch {
    // 隐私模式忽略
  }
}

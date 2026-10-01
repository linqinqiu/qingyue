// 书架布局偏好。
//
// 列表 / 紧凑列表两档沿用上游 Legado 的 `bookshelfLayout` 0/1（reference/legado-team
// `ui/main/bookshelf`）。网格档不照抄上游的「2~6 列」：上游跑在屏宽固定的手机上，列数就等于封面大小；
// 浏览器窗口从 320 到 3440 都可能，实测同一档在桌面是 567x756 的巨图、在手机是 60x80 的邮票
// （`tools/verify/shelf-layout-measure.mjs`）。所以这里改成「密度档 + auto-fill」：封面宽度落在
// 区间内，列数随窗口自己算。
export type ShelfMode = 'grid' | 'list' | 'compact'
export type ShelfDensity = 'sm' | 'md' | 'lg'
export type ShelfLayout = { mode: ShelfMode; density: ShelfDensity }

const KEY = 'legado-shelf-layout-v2'
const LEGACY_KEY = 'legado-shelf-layout-v1'

export const DENSITY_ORDER: ShelfDensity[] = ['sm', 'md', 'lg']
export const DENSITY_LABEL: Record<ShelfDensity, string> = { sm: '小', md: '中', lg: '大' }
export const DENSITY_HINT: Record<ShelfDensity, string> = { sm: '一屏放更多本', md: '默认', lg: '封面更大、更好认' }
export const DEFAULT_LAYOUT: ShelfLayout = { mode: 'grid', density: 'md' }

/** 旧版本存的是上游那种数值编号（0=列表 1=紧凑 2~6=列数 7=自动），一次性搬到新口径。 */
export function layoutFromLegacyCode(code: number): ShelfLayout {
  if (code === 0) return { mode: 'list', density: 'md' }
  if (code === 1) return { mode: 'compact', density: 'md' }
  // 列数越多封面越小；2~3 列在桌面本来就是超大封面，归到「大」。
  const density: ShelfDensity = code <= 3 ? 'lg' : code === 4 ? 'md' : 'sm'
  return { mode: 'grid', density }
}

export function encodeLayout(layout: ShelfLayout): string {
  return layout.mode === 'grid' ? `grid:${layout.density}` : layout.mode
}

export function decodeLayout(value: string): ShelfLayout | null {
  if (value === 'list') return { mode: 'list', density: 'md' }
  if (value === 'compact') return { mode: 'compact', density: 'md' }
  const density = value.startsWith('grid:') ? value.slice(5) : ''
  return DENSITY_ORDER.includes(density as ShelfDensity) ? { mode: 'grid', density: density as ShelfDensity } : null
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

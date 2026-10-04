/**
 * 阅读器的点击分区（用户 2026-10-04：「书籍阅读时，点击区域有问题，可以自定义点击区域范围并设置，自定义管理」）。
 *
 * 上游手机端是一整块 **3×3 九宫格**，每一格单独挑一个动作（`ReadView.setRect9x` 三分点 0.33/0.66，
 * 默认 左上/上中/左/下左 = 上一页，右上/右/下中/右下 = 下一页，正中 = 呼出菜单），
 * 另有一个"边缘点击阈值"数字。原来我们这边只有写死的三区（`readerInteractions.ts` 的 30%/70%），
 * 既不能改范围也不能改动作 —— 手机习惯的人点中间会以为"没反应"，横屏点两侧又容易误触。
 *
 * 这里只放**纯算式与预设**：DOM 归 ReaderScreen，落库归 readerSettings，判据归 web/test/TapZones.test.ts。
 * 默认值刻意保持"和现在一样"（翻页模式按列分、滚动模式按行分），改了才生效，不改不漂移。
 */

export type TapAction = 'previous' | 'next' | 'toggle' | 'toc' | 'marks' | 'addMark' | 'settings' | 'none'

export type TapGrid = { rows: number; cols: number; actions: TapAction[] }

export const TAP_ACTION_LABELS: Record<TapAction, { label: string; hint: string }> = {
  previous: { label: '上一页 / 上一章', hint: '往回翻一栏；在窗口开头则把上一章接到前面' },
  next: { label: '下一页 / 下一章', hint: '往前翻一栏，跨过章界只是"下一页"' },
  toggle: { label: '呼出 / 收起工具栏', hint: '现在中间那一格的行为' },
  toc: { label: '打开章节目录', hint: '直接进目录，不用先呼工具栏' },
  marks: { label: '打开书签', hint: '这本书的书签列表' },
  addMark: { label: '给这一章加书签', hint: '一键标整章，批注进书签栏再补' },
  settings: { label: '打开阅读设置', hint: '字号、行距、主题、翻页方式' },
  none: { label: '不做任何事', hint: '防误触：这一格点了没反应' },
}

export const TAP_ACTION_ORDER: TapAction[] = ['previous', 'next', 'toggle', 'toc', 'marks', 'addMark', 'settings', 'none']

/** 两种模式各自的出厂默认：与改动前逐字一致（翻页按左右列、滚动按上下段）。 */
export const DEFAULT_GRIDS: Record<'paginate' | 'scroll', TapGrid> = {
  paginate: { rows: 1, cols: 3, actions: ['previous', 'toggle', 'next'] },
  scroll: { rows: 3, cols: 1, actions: ['previous', 'toggle', 'next'] },
}

/** 预设（"自定义管理"里的"从预设开始"）：每个都是完整的格子表，挑一个就整套换掉。 */
export const TAP_PRESETS: { key: string; label: string; hint: string; paginate: TapGrid; scroll: TapGrid }[] = [
  {
    key: 'current', label: '默认（翻页分列、滚动分段）', hint: '与老版本一致，不改手感',
    paginate: DEFAULT_GRIDS.paginate, scroll: DEFAULT_GRIDS.scroll,
  },
  {
    key: 'nine', label: '九宫格（同手机端）', hint: '四角与左右都算翻页，正中呼出工具栏',
    paginate: {
      rows: 3, cols: 3,
      actions: ['previous', 'previous', 'next', 'previous', 'toggle', 'next', 'previous', 'next', 'next'],
    },
    scroll: {
      rows: 3, cols: 3,
      actions: ['previous', 'previous', 'next', 'previous', 'toggle', 'next', 'previous', 'next', 'next'],
    },
  },
  {
    key: 'edges', label: '只认两侧', hint: '中间与上下边全部不响应：最容易误触的一种',
    paginate: { rows: 1, cols: 3, actions: ['previous', 'none', 'next'] },
    scroll: { rows: 3, cols: 1, actions: ['none', 'toggle', 'none'] },
  },
  {
    key: 'menu', label: '整屏只呼出工具栏', hint: '翻页完全交给键盘/滚轮/滑动',
    paginate: { rows: 1, cols: 1, actions: ['toggle'] },
    scroll: { rows: 1, cols: 1, actions: ['toggle'] },
  },
]

/** 一格落在第几行第几列（行优先）。边界值归给"更靠外"的那一格，与原来的 30%/70% 口径一致。 */
export function zoneAt(grid: TapGrid, x: number, y: number, width: number, height: number): TapAction {
  const rows = Math.max(1, grid.rows)
  const cols = Math.max(1, grid.cols)
  if (width <= 0 || height <= 0) return 'none'
  const col = Math.min(cols - 1, Math.max(0, Math.floor((x / width) * cols)))
  const row = Math.min(rows - 1, Math.max(0, Math.floor((y / height) * rows)))
  return grid.actions[row * cols + col] ?? 'none'
}

/** 格子表画在界面上要说的尺寸。 */
export const gridCells = (grid: TapGrid) => Math.max(1, grid.rows) * Math.max(1, grid.cols)

/** 设置里存进来的东西可能缺项或写错，一律清洗成能用的表（不清洗就会点到 undefined 上没反应）。 */
export function sanitizeGrid(value: unknown, fallback: TapGrid): TapGrid {
  const source = (value ?? {}) as Partial<TapGrid>
  const rows = Number.isFinite(source.rows) ? Math.min(6, Math.max(1, Math.trunc(source.rows as number))) : fallback.rows
  const cols = Number.isFinite(source.cols) ? Math.min(6, Math.max(1, Math.trunc(source.cols as number))) : fallback.cols
  const cells = rows * cols
  const known = new Set<string>(TAP_ACTION_ORDER)
  const actions = Array.from({ length: cells }, (_, index) => {
    const item = source.actions?.[index]
    return typeof item === 'string' && known.has(item) ? item as TapAction : (fallback.actions[index % fallback.actions.length] ?? 'none')
  })
  return { rows, cols, actions }
}

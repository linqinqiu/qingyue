import { Select } from './Select'
import { TAP_ACTION_LABELS, TAP_ACTION_ORDER, TAP_PRESETS, type TapAction, type TapGrid } from './tapZones'

/**
 * 「点击区域」的编辑面板（用户 2026-10-04：「可以自定义点击区域范围并设置，自定义管理」）。
 *
 * 一屏只编辑**当前这种翻页方式**的那张表：连续滚动与平移分页本来就该有不同的分区
 * （上游手机端也是"翻页方式"决定点击语义），把它们混在一个面板里改，
 * 用户改完发现"另一种方式没跟着变"就会以为设置没生效。
 */
export function TapZoneConfig({
  grid, modeLabel, onGrid, onPreset,
}: {
  grid: TapGrid
  modeLabel: string
  onGrid: (next: TapGrid) => void
  onPreset: (paginate: TapGrid, scroll: TapGrid) => void
}) {
  const rows = Math.max(1, grid.rows)
  const cols = Math.max(1, grid.cols)
  const cells = Array.from({ length: rows * cols }, (_, index) => grid.actions[index] ?? 'none')

  const setCell = (index: number, action: TapAction) => {
    const next = [...cells]
    next[index] = action
    onGrid({ rows, cols, actions: next })
  }

  /** 换行列数时按"同一格位置"保留原动作：越界的格子回落成不做任何事，而不是悄悄挪位。 */
  const resize = (nextRows: number, nextCols: number) => {
    const limitedRows = Math.min(4, Math.max(1, nextRows))
    const limitedCols = Math.min(4, Math.max(1, nextCols))
    const actions: TapAction[] = []
    for (let row = 0; row < limitedRows; row += 1) {
      for (let col = 0; col < limitedCols; col += 1) {
        const source = row < rows && col < cols ? grid.actions[row * cols + col] : undefined
        actions.push(source ?? 'none')
      }
    }
    onGrid({ rows: limitedRows, cols: limitedCols, actions })
  }

  return (
    <section className="setting-section tap-zone-config">
      <span className="setting-label">点击区域 · {modeLabel}</span>
      <div className="tap-zone-presets" role="group" aria-label="点击区域预设">
        {TAP_PRESETS.map(preset => (
          <button key={preset.key} type="button" title={preset.hint} onClick={() => onPreset(preset.paginate, preset.scroll)}>
            {preset.label}
          </button>
        ))}
      </div>
      <div className="tap-zone-size">
        <span>分区尺寸</span>
        <button type="button" onClick={() => resize(rows, cols - 1)} disabled={cols <= 1} aria-label="减少一列">列 −</button>
        <strong>{rows} × {cols}</strong>
        <button type="button" onClick={() => resize(rows, cols + 1)} disabled={cols >= 4} aria-label="增加一列">列 +</button>
        <button type="button" onClick={() => resize(rows - 1, cols)} disabled={rows <= 1} aria-label="减少一行">行 −</button>
        <button type="button" onClick={() => resize(rows + 1, cols)} disabled={rows >= 4} aria-label="增加一行">行 +</button>
      </div>
      <div className="tap-zone-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {cells.map((action, index) => (
          <Select
            key={`${rows}x${cols}-${index}`}
            ariaLabel={`第 ${Math.floor(index / cols) + 1} 行 ${index % cols + 1} 列的动作`}
            value={action}
            options={TAP_ACTION_ORDER.map(item => ({ value: item, label: TAP_ACTION_LABELS[item].label }))}
            onChange={value => setCell(index, value as TapAction)}
          />
        ))}
      </div>
      <small className="setting-hint">
        每一格挑一个动作；「不做任何事」用来挡误触。改完立刻生效，不用重开这本书。
      </small>
    </section>
  )
}

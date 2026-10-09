import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_GRIDS, sanitizeGrid, TAP_ACTION_ORDER, TAP_PRESETS, gridCells, zoneAt } from '../src/tapZones.ts'

/**
 * 点击分区（用户 2026-10-04：「可以自定义点击区域范围并设置，自定义管理」）。
 *
 * 这里钉三件容易悄悄坏掉的事：
 * ① **出厂默认必须与改动前逐字一致** —— 这次只是把写死的三区变成可配，
 *    顺手"改得更合理"就是无谓地换掉用户已经习惯的手感（AGENTS：改 X 而整体不变）。
 * ② 格子数与动作表长度必须相等 —— 不相等时缺的那些格会静默变成「不做任何事」，
 *    界面上看不出来，用户只会说"这一格点了没反应"。
 * ③ 读设置时必须清洗 —— 老数据没有这一项、或手改过 localStorage，
 *    不清洗就会拿到 undefined 的动作，表现同样是"某格失灵"。
 */

test('出厂默认 = 改动前那三区（翻页按列、滚动按段），一格都不许多', () => {
  assert.deepEqual(DEFAULT_GRIDS.paginate, { rows: 1, cols: 3, actions: ['previous', 'toggle', 'next'] })
  assert.deepEqual(DEFAULT_GRIDS.scroll, { rows: 3, cols: 1, actions: ['previous', 'toggle', 'next'] })
})

test('zoneAt 的边界归"更靠外"那一格，与原来 30%/70% 的口径同一形状', () => {
  const grid = DEFAULT_GRIDS.paginate
  assert.equal(zoneAt(grid, 0, 400, 1200, 800), 'previous')
  assert.equal(zoneAt(grid, 399, 400, 1200, 800), 'previous')
  assert.equal(zoneAt(grid, 400, 400, 1200, 800), 'toggle')
  assert.equal(zoneAt(grid, 800, 400, 1200, 800), 'next')
  assert.equal(zoneAt(grid, 1199, 400, 1200, 800), 'next')
  // 越界坐标（子像素、负数、比视口还靠外）不许算出格外的下标
  assert.equal(zoneAt(grid, -50, 0, 1200, 800), 'previous')
  assert.equal(zoneAt(grid, 9999, 9999, 1200, 800), 'next')
})

test('视口宽或高为 0（折叠、隐藏、还没排版）时不许凭空翻页', () => {
  assert.equal(zoneAt(DEFAULT_GRIDS.paginate, 10, 10, 0, 800), 'none')
  assert.equal(zoneAt(DEFAULT_GRIDS.scroll, 10, 10, 1200, 0), 'none')
})

test('每个预设的动作表长度 = 行 × 列（缺的格会静默变成"不做任何事"）', () => {
  for (const preset of TAP_PRESETS) {
    for (const [mode, grid] of [['paginate', preset.paginate], ['scroll', preset.scroll]] as const) {
      assert.equal(grid.actions.length, gridCells(grid), `${preset.key}/${mode} 的动作数与格子数不符`)
      for (const action of grid.actions) assert.ok(TAP_ACTION_ORDER.includes(action), `${preset.key} 里有认不出的动作 ${action}`)
    }
  }
})

test('九宫格预设：正中呼出工具栏，左右两侧都是翻页（与手机端同一形状）', () => {
  const nine = TAP_PRESETS.find(preset => preset.key === 'nine')
  assert.ok(nine)
  const at = (row: number, col: number) => nine.paginate.actions[row * 3 + col]
  assert.equal(at(1, 1), 'toggle')
  assert.equal(at(0, 0), 'previous')
  assert.equal(at(2, 2), 'next')
  assert.equal(zoneAt(nine.paginate, 1100, 400, 1200, 900), 'next')
  assert.equal(zoneAt(nine.paginate, 100, 850, 1200, 900), 'previous')
})

test('清洗：缺项、长度不够、认不出的动作、行列离谱都回到能用的表', () => {
  const fallback = DEFAULT_GRIDS.paginate
  assert.deepEqual(sanitizeGrid(undefined, fallback), fallback)
  assert.deepEqual(sanitizeGrid({}, fallback), fallback)
  assert.deepEqual(sanitizeGrid({ rows: 1, cols: 3 }, fallback), fallback)
  assert.deepEqual(sanitizeGrid({ rows: 1, cols: 3, actions: ['next'] }, fallback),
    { rows: 1, cols: 3, actions: ['next', 'toggle', 'next'] })
  assert.deepEqual(sanitizeGrid({ rows: 1, cols: 3, actions: ['nope', 'toc', 'settings'] }, fallback),
    { rows: 1, cols: 3, actions: ['previous', 'toc', 'settings'] })
  // 上限：不许存出 99×99 这种把抽屉撑爆的表
  const huge = sanitizeGrid({ rows: 99, cols: 99, actions: [] }, fallback)
  assert.equal(huge.rows, 6)
  assert.equal(huge.cols, 6)
  assert.equal(huge.actions.length, 36)
})

test('反向对照：把默认表中间那格改成 next，正中间就必须是"下一页"（证明 zoneAt 真的在读这张表）', () => {
  const grid = { rows: 1, cols: 3, actions: ['previous', 'next', 'next'] }
  assert.equal(zoneAt(grid, 600, 400, 1200, 800), 'next')
  assert.equal(zoneAt(DEFAULT_GRIDS.paginate, 600, 400, 1200, 800), 'toggle')
})

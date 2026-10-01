import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LAYOUT,
  DENSITY_ORDER,
  decodeLayout,
  encodeLayout,
  layoutFromLegacyCode,
  readShelfLayout,
  writeShelfLayout,
} from '../src/shelfLayout'

// node:test 在同一进程里跑所有文件，offline-pwa.test.ts 也自带一份 localStorage mock，
// 所以桩件必须用完就还原（还原成调用现场的值，模块顶层缓存的那份可能是空的）。
function withStorage(initial: Record<string, string> | undefined, body: (store: Map<string, string>) => void) {
  const previous = (globalThis as any).localStorage
  const store = new Map(Object.entries(initial || {}))
  const writable = initial !== undefined
  ;(globalThis as any).localStorage = writable
    ? {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      }
    : undefined
  try {
    body(store)
  } finally {
    ;(globalThis as any).localStorage = previous
  }
}

test('ShelfLayout - 五种状态都能编码再解码回来', () => {
  for (const mode of ['list', 'compact'] as const) {
    const layout = { mode, density: 'md' as const }
    assert.deepEqual(decodeLayout(encodeLayout(layout)), layout)
  }
  for (const density of DENSITY_ORDER) {
    const layout = { mode: 'grid' as const, density }
    assert.deepEqual(decodeLayout(encodeLayout(layout)), layout, `grid:${density} 应能往返`)
  }
  assert.equal(encodeLayout({ mode: 'grid', density: 'sm' }), 'grid:sm')
  assert.equal(encodeLayout({ mode: 'list', density: 'lg' }), 'list', '列表档不该把密度写进去')
})

test('ShelfLayout - 认不出的值返回 null 而不是猜一个', () => {
  for (const junk of ['', 'grid', 'grid:xl', 'grid:', 'LIST', '7']) {
    assert.equal(decodeLayout(junk), null, `${JSON.stringify(junk)} 不是合法值`)
  }
})

test('ShelfLayout - 旧的列数编号搬到密度档', () => {
  // v1 存的是上游编号：0=列表 1=紧凑 2~6=固定列数 7=自动
  assert.deepEqual(layoutFromLegacyCode(0), { mode: 'list', density: 'md' })
  assert.deepEqual(layoutFromLegacyCode(1), { mode: 'compact', density: 'md' })
  assert.deepEqual(layoutFromLegacyCode(7), { mode: 'grid', density: 'sm' })
  assert.deepEqual(layoutFromLegacyCode(2), { mode: 'grid', density: 'lg' })
  assert.deepEqual(layoutFromLegacyCode(3), { mode: 'grid', density: 'lg' })
  assert.deepEqual(layoutFromLegacyCode(4), { mode: 'grid', density: 'md' })
  assert.deepEqual(layoutFromLegacyCode(6), { mode: 'grid', density: 'sm' })
  // 列数越多封面越小，密度档序号越小：搬过去的档位必须单调，否则老用户的书架会突然跳档
  const ranks = [2, 3, 4, 5, 6, 7].map(code => DENSITY_ORDER.indexOf(layoutFromLegacyCode(code).density))
  assert.ok(ranks.every((rank, index) => index === 0 || rank <= ranks[index - 1]), `列数↑ 封面应↓，实际 ${ranks.join('>')}`)
})

test('ShelfLayout - 没有偏好时吃默认值，有旧编号时迁移并清掉旧键', () => {
  withStorage({}, store => {
    assert.deepEqual(readShelfLayout(), DEFAULT_LAYOUT)
    assert.equal(store.size, 0, '只读不该写盘')
  })

  withStorage({ 'legado-shelf-layout-v1': '2' }, store => {
    assert.deepEqual(readShelfLayout(), { mode: 'grid', density: 'lg' })
    assert.equal(store.get('legado-shelf-layout-v1'), '2', '读取本身不迁移，等用户下次改动再落新键')
    writeShelfLayout({ mode: 'grid', density: 'sm' })
    assert.equal(store.get('legado-shelf-layout-v2'), 'grid:sm')
    assert.equal(store.has('legado-shelf-layout-v1'), false, '写新键时旧键要清掉，避免下次又被搬一遍')
  })

  withStorage({ 'legado-shelf-layout-v1': '1', 'legado-shelf-layout-v2': 'compact' }, () => {
    assert.deepEqual(readShelfLayout(), { mode: 'compact', density: 'md' }, '新键优先于旧键')
  })
})

test('ShelfLayout - localStorage 不可用时不抛异常', () => {
  withStorage(undefined, () => {
    assert.deepEqual(readShelfLayout(), DEFAULT_LAYOUT)
    assert.doesNotThrow(() => writeShelfLayout({ mode: 'list', density: 'md' }))
  })
})

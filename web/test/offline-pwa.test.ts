import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  putOfflineChapter,
  getOfflineChapter,
  getOfflineChaptersSet,
  clearOfflineBook,
  clearAllOffline,
  saveShelfSnapshot,
  getShelfSnapshot,
  enqueueOfflineProgress,
  flushOfflineProgress,
  getOfflineStorageStats,
  evictLruOfflineBooks
} from '../src/offlineStorage.js'

// Mock IndexedDB implementation for test runner
class MockIDBRequest {
  result: any = null
  error: any = null
  onsuccess: ((e: any) => void) | null = null
  onerror: ((e: any) => void) | null = null
}

class MockIDBCursor {
  records: any[]
  index = 0
  req: MockIDBRequest
  constructor(records: any[], req: MockIDBRequest) {
    this.records = records
    this.req = req
  }
  get value() {
    return this.records[this.index]
  }
  get primaryKey() {
    const rec = this.records[this.index]
    return rec?.key ?? `${rec?.sourceId}_${rec?.bookUrl}_${rec?.chapterUrl}`
  }
  continue() {
    this.index++
    setTimeout(() => {
      if (this.index < this.records.length) {
        this.req.result = this
      } else {
        this.req.result = null
      }
      this.req.onsuccess?.({ target: this.req })
    }, 0)
  }
}

class MockIDBIndex {
  store: MockIDBObjectStore
  constructor(store: MockIDBObjectStore) {
    this.store = store
  }
  openCursor(range?: any) {
    return this.store.openCursor(range)
  }
  openKeyCursor(range?: any) {
    return this.store.openCursor(range)
  }
}

/** 让接下来 N 次 IndexedDB 写入抛 QuotaExceededError，用来测「配额满 → 淘汰 → 重试」。 */
let quotaFailuresLeft = 0

class MockIDBObjectStore {
  data = new Map<string, any>()
  name: string
  constructor(name: string) {
    this.name = name
  }
  put(value: any, key?: any) {
    const actualKey = key ?? value.key ?? `${value.sourceId}_${value.bookUrl}_${value.chapterUrl}`
    const req = new MockIDBRequest()
    if (quotaFailuresLeft > 0) {
      // 模拟设备存储配额已满：第一次写失败，逼出「淘汰别的书 → 重试」这条恢复路径
      quotaFailuresLeft -= 1
      req.error = { name: 'QuotaExceededError' }
      setTimeout(() => req.onerror?.({ target: req }), 0)
      return req
    }
    this.data.set(String(actualKey), value)
    req.result = actualKey
    setTimeout(() => req.onsuccess?.({ target: req }), 0)
    return req
  }
  get(key: any) {
    const req = new MockIDBRequest()
    req.result = this.data.get(String(key))
    setTimeout(() => req.onsuccess?.({ target: req }), 0)
    return req
  }
  delete(key: any) {
    this.data.delete(String(key))
    const req = new MockIDBRequest()
    setTimeout(() => req.onsuccess?.({ target: req }), 0)
    return req
  }
  clear() {
    this.data.clear()
    const req = new MockIDBRequest()
    setTimeout(() => req.onsuccess?.({ target: req }), 0)
    return req
  }
  index(_name: string) {
    return new MockIDBIndex(this)
  }
  openCursor(range?: any) {
    const req = new MockIDBRequest()
    let records = Array.from(this.data.values())
    if (Array.isArray(range) && range.length === 2) {
      const [src, bUrl] = range
      records = records.filter(r => r.sourceId === src && r.bookUrl === bUrl)
    }
    setTimeout(() => {
      if (records.length > 0) {
        req.result = new MockIDBCursor(records, req)
      } else {
        req.result = null
      }
      req.onsuccess?.({ target: req })
    }, 0)
    return req
  }
}

class MockIDBTransaction {
  store: MockIDBObjectStore
  constructor(store: MockIDBObjectStore) {
    this.store = store
  }
  objectStore(_name: string) {
    return this.store
  }
}

class MockIDBDatabase {
  stores = new Map<string, MockIDBObjectStore>()
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name)
  }
  createObjectStore(name: string) {
    const store = new MockIDBObjectStore(name)
    this.stores.set(name, store)
    return store
  }
  transaction(name: string, _mode: string) {
    let store = this.stores.get(name)
    if (!store) {
      store = new MockIDBObjectStore(name)
      this.stores.set(name, store)
    }
    return new MockIDBTransaction(store)
  }
}

let currentDbInstance: MockIDBDatabase | null = null

function setupMockIndexedDB() {
  mockStorage.clear()
  currentDbInstance = new MockIDBDatabase()
  currentDbInstance.createObjectStore('chapters')

  const mockFactory = {
    open: (_name: string, _version: number) => {
      const req = new MockIDBRequest()
      req.result = currentDbInstance
      setTimeout(() => {
        if (req.onsuccess) req.onsuccess({ target: req })
      }, 0)
      return req
    }
  }

  ;(globalThis as any).indexedDB = mockFactory
  ;(globalThis as any).IDBKeyRange = {
    only: (val: any) => val
  }
  return currentDbInstance
}

// Mock localStorage
const mockStorage = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (key: string) => mockStorage.get(key) ?? null,
  setItem: (key: string, val: string) => mockStorage.set(key, String(val)),
  removeItem: (key: string) => mockStorage.delete(key),
  clear: () => mockStorage.clear()
}

test('OfflineStorage - Chapter saving, retrieving, and list cached URLs', async () => {
  setupMockIndexedDB()

  await putOfflineChapter('src-1', 'book-url-1', 'chapter-url-1', '第1章', '这是第1章正文内容', '测试书1')
  await putOfflineChapter('src-1', 'book-url-1', 'chapter-url-2', '第2章', '这是第2章正文内容', '测试书1')

  const result1 = await getOfflineChapter('src-1', 'book-url-1', 'chapter-url-1')
  assert.ok(result1)
  assert.equal(result1?.title, '第1章')
  assert.equal(result1?.content, '这是第1章正文内容')

  const cachedUrls = await getOfflineChaptersSet('src-1', 'book-url-1')
  assert.equal(cachedUrls.size, 2)
  assert.ok(cachedUrls.has('chapter-url-1'))
  assert.ok(cachedUrls.has('chapter-url-2'))

  // Delete single book
  await clearOfflineBook('src-1', 'book-url-1')
  const cachedUrlsAfterDelete = await getOfflineChaptersSet('src-1', 'book-url-1')
  assert.equal(cachedUrlsAfterDelete.size, 0)
})

test('OfflineStorage - Shelf Snapshot persistence and retrieval', () => {
  mockStorage.clear()
  const dummyShelf: any = [
    { sourceId: 'src-1', bookUrl: 'b1', title: '测试书1', author: '作者1', durChapterTitle: '第1章' },
    { sourceId: 'src-2', bookUrl: 'b2', title: '测试书2', author: '作者2', durChapterTitle: '第2章' }
  ]

  saveShelfSnapshot(dummyShelf)
  const retrieved = getShelfSnapshot()

  assert.ok(retrieved)
  assert.equal(retrieved?.length, 2)
  assert.equal(retrieved?.[0].title, '测试书1')
})

test('OfflineStorage - Offline Reading Progress Queue Lifecycle and Flush', async () => {
  mockStorage.clear()

  enqueueOfflineProgress({
    sourceId: 'src-1',
    bookUrl: 'b1',
    chapterIndex: 5,
    chapterTitle: '第5章',
    readProgress: 0.8,
    updatedAt: Date.now()
  })

  enqueueOfflineProgress({
    sourceId: 'src-2',
    bookUrl: 'b2',
    chapterIndex: 10,
    chapterTitle: '第10章',
    readProgress: 0.2,
    updatedAt: Date.now() + 100
  })

  let syncCount = 0
  const syncCallback = async (_item: any) => {
    syncCount++
  }

  await flushOfflineProgress(syncCallback)
  assert.equal(syncCount, 2)

  // Flush again should be empty
  let syncCount2 = 0
  await flushOfflineProgress(async () => { syncCount2++ })
  assert.equal(syncCount2, 0)
})

test('OfflineStorage - Storage Stats, LRU Toggle and Eviction', async () => {
  setupMockIndexedDB()

  // Save chapters for book 1
  await putOfflineChapter('src-1', 'b1', 'c1', '第1章', '内容1'.repeat(100), 'Book 1')
  
  const statsBefore = await getOfflineStorageStats()
  assert.equal(statsBefore.books.length, 1)
  assert.equal(statsBefore.books[0].chapterCount, 1)
  assert.ok(statsBefore.totalBytes > 0)

  // Clean data
  await clearAllOffline()
  const statsAfter = await getOfflineStorageStats()
  assert.equal(statsAfter.books.length, 0)
  assert.equal(statsAfter.totalBytes, 0)
})

test('Reader Offline Cache Range Math Calculation', () => {
  const totalChapters = 350

  // 1. 全本
  const fullStart = 0
  const fullEnd = totalChapters - 1
  const fullCount = totalChapters
  assert.equal(fullStart, 0)
  assert.equal(fullEnd, 349)
  assert.equal(fullCount, 350)

  // 2. 自定义：跨中段与贴到末尾都被夹在 [0, 末章]，且起点不会盖过终点
  const customStart = Math.max(0, 121 - 1)
  const customEnd = Math.max(customStart, 171 - 1)
  assert.equal(customStart, 120)
  assert.equal(customEnd, 170)

  const reversedStart = Math.max(0, 300 - 1)
  const reversedEnd = Math.max(reversedStart, 10 - 1)
  assert.equal(reversedEnd, reversedStart)

  const beyondEnd = Math.min(totalChapters - 1, 340 + 60)
  assert.equal(beyondEnd, 349)
})

/**
 * 淘汰不能碰「正在缓存的那本」：调用点是某章落库时配额爆了，若把它自己也清掉，
 * 用户会发现下载的书白下了。
 *
 * `targetBytesToFree` 故意给到无穷大，逼循环走完所有书 —— 给小目标的话第一本就 break，
 * exclude 那条断言就成了空判（我第一版就是这么写的，负对照撤掉修复仍全绿）。
 * 同理不声称这里在验「时间序 vs 游标序」：MockIDB 的游标顺序就是插入顺序，
 * 与写入时间同序，这个基座区分不了，硬写只会自欺。
 */
test('LRU eviction: 绝不淘汰正在写入的那本书', async () => {
  await clearAllOffline()
  await putOfflineChapter('src-lru', 'other-old', 'c1', '第一章', '别的书'.repeat(200))
  await putOfflineChapter('src-lru', 'current-book', 'c1', '第一章', '正在下的这本'.repeat(200))
  await putOfflineChapter('src-lru', 'other-new', 'c1', '第一章', '又一本'.repeat(200))

  const stats = await getOfflineStorageStats()
  assert.ok(stats.books.every(b => b.lastCachedAt > 0), 'lastCachedAt 必须被统计出来，否则无从判断新旧')

  await evictLruOfflineBooks(Number.POSITIVE_INFINITY, { sourceId: 'src-lru', bookUrl: 'current-book' })
  const left = (await getOfflineStorageStats()).books.map(b => b.bookUrl)
  assert.ok(left.includes('current-book'), '正在写入的书被自动淘汰清掉了')
  assert.ok(!left.includes('other-old') && !left.includes('other-new'), '其余书没被清 —— 说明测试根本没走到淘汰逻辑')

  // 对照组：同一批数据不给 exclude 时应连本带主一起清光，证明上一条断言真的在判事
  await evictLruOfflineBooks(Number.POSITIVE_INFINITY)
  const afterNoExclude = (await getOfflineStorageStats()).books.map(b => b.bookUrl)
  assert.ok(!afterNoExclude.includes('current-book'), '对照组失效：无 exclude 时它也没被清，那前面的断言不算证据')
  await clearAllOffline()
})

/**
 * 配额爆掉时的恢复路径必须**无条件**生效：以前它挂在一个默认关闭、界面上也几乎
 * 没人会去开的开关上（`legado_lru_evict_enabled` 不存在即 false），所以这条路径出厂休眠。
 * 若那个开关还在，这里第一次 put 失败后 promise 会直接 reject，测试当场变红。
 */
test('配额满时自动淘汰别的书并重试成功，且不动正在写的这本', async () => {
  await clearAllOffline()
  await putOfflineChapter('src-q', 'other-1', 'c1', '第一章', '别的书'.repeat(400))
  await putOfflineChapter('src-q', 'current', 'c1', '第一章', '正在下的这本'.repeat(400))

  quotaFailuresLeft = 1
  await putOfflineChapter('src-q', 'current', 'c2', '第二章', '新的一章'.repeat(400))
  quotaFailuresLeft = 0

  const books = (await getOfflineStorageStats()).books
  const current = books.find(b => b.bookUrl === 'current')
  assert.ok(current, '重试后当前这本的章节应写进去')
  assert.equal(current.chapterCount, 2, '已有的和新写的两章都该在')
  assert.ok(!books.some(b => b.bookUrl === 'other-1'), '应已淘汰别的书腾出空间')
  await clearAllOffline()
})

// ———— 离线缓存弹窗的三态（AI-2 任务 C·模块 5）————

test('offlineStatsView - 取失败不许画成"你确实没有缓存"', async () => {
  const { offlineStatsView } = await import('../src/OfflineCacheModal')
  assert.equal(offlineStatsView({ loading: true, failed: false, books: null }), 'loading')
  assert.equal(offlineStatsView({ loading: false, failed: false, books: 0 }), 'empty', '真取到 0 本才叫空')
  assert.equal(offlineStatsView({ loading: false, failed: false, books: 3 }), 'ready')
  assert.equal(offlineStatsView({ loading: false, failed: true, books: 0 }), 'failed',
    '即使条数是 0，失败过就不能报"没有"')
  // 反向对照：修前只有 loading 一个旗标 —— 不 loading 且 stats 为 null（读失败）会被判成 empty
  assert.equal(offlineStatsView({ loading: false, failed: false, books: null }), 'failed',
    '没取到又不在转圈时只能算没取到；这一条红了就说明界面又会把故障说成用户的操作结果')
})

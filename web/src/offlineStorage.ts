/**
 * Offline Storage & Client-side Two-tier Cache Engine
 * Uses IndexedDB for rich structured offline chapter storage,
 * localStorage for bookshelf snapshots and offline reading progress queues.
 */

export interface OfflineChapterRecord {
  key: string // `${sourceId}::${bookUrl}::${chapterUrl}`
  sourceId: string
  bookUrl: string
  chapterUrl: string
  title: string | null
  content: string
  cachedAt: number
  byteSize: number
}

export interface OfflineBookStat {
  sourceId: string
  bookUrl: string
  name?: string
  chapterCount: number
  totalBytes: number
  /**
   * 这本书最近一次写入缓存的时间。没有它就没法做真正的 LRU ——
   * `stats.books` 原本是 IndexedDB 游标顺序（键是 `sourceId::bookUrl::chapterUrl`，
   * 等于按书名排序），拿它当"最久未用"来淘汰是假的。
   */
  lastCachedAt: number
}

export interface OfflineStorageStats {
  books: OfflineBookStat[]
  totalChapters: number
  totalBytes: number
}

const DB_NAME = 'legado_offline_db'
const DB_VERSION = 1
const STORE_CHAPTERS = 'chapters'

const SNAPSHOT_SHELF_KEY = 'legado_shelf_snapshot'
const OFFLINE_PROGRESS_QUEUE_KEY = 'legado_offline_progress_queue'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not supported in current environment'))
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_CHAPTERS)) {
        const store = db.createObjectStore(STORE_CHAPTERS, { keyPath: 'key' })
        store.createIndex('by_book', ['sourceId', 'bookUrl'], { unique: false })
        store.createIndex('by_cached_at', 'cachedAt', { unique: false })
      }
    }
    request.onblocked = () => reject(new Error('IndexedDB 升级被其它标签页占用，请关闭旧标签后重试'))
    request.onsuccess = () => {
      const db = request.result
      // 另一标签触发版本升级 / 浏览器回收连接时，本连接会失效：关掉并清空缓存，
      // 下次 openDb 重开新连接，避免后续事务对着 stale 连接全抛 InvalidStateError。
      db.onversionchange = () => { db.close(); if (dbPromise === promise) dbPromise = null }
      db.onclose = () => { if (dbPromise === promise) dbPromise = null }
      resolve(db)
    }
    request.onerror = () => { if (dbPromise === promise) dbPromise = null; reject(request.error) }
  })
  dbPromise = promise
  return dbPromise
}

function makeChapterKey(sourceId: string, bookUrl: string, chapterUrl: string): string {
  return `${sourceId}::${bookUrl}::${chapterUrl}`
}

/**
 * Saves a chapter to client-side IndexedDB offline pool
 */
export async function putOfflineChapter(
  sourceId: string,
  bookUrl: string,
  chapterUrl: string,
  title: string | null,
  content: string
): Promise<void> {
  const db = await openDb()
  const key = makeChapterKey(sourceId, bookUrl, chapterUrl)
  const byteSize = new Blob([content]).size
  const record: OfflineChapterRecord = {
    key,
    sourceId,
    bookUrl,
    chapterUrl,
    title,
    content,
    cachedAt: Date.now(),
    byteSize,
  }

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_CHAPTERS, 'readwrite')
      const store = tx.objectStore(STORE_CHAPTERS)
      const req = store.put(record)
      req.onsuccess = () => resolve()
      req.onerror = () => {
        if (req.error && req.error.name === 'QuotaExceededError') {
          // 空间不足就先按最久未写淘汰别的书，再重试一次。必须把**当前这本**排除掉：
          // 否则"清一点空间"会把用户正在下载的书连同它已存好的章节一起删掉。
          void evictLruOfflineBooks(byteSize * 10, { sourceId, bookUrl }).then(() => {
            const retryTx = db.transaction(STORE_CHAPTERS, 'readwrite')
            const retryReq = retryTx.objectStore(STORE_CHAPTERS).put(record)
            retryReq.onsuccess = () => resolve()
            retryReq.onerror = () => reject(retryReq.error)
          }).catch(reject)
        } else {
          reject(req.error)
        }
      }
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Retrieves a chapter from client-side IndexedDB offline pool
 */
export async function getOfflineChapter(
  sourceId: string,
  bookUrl: string,
  chapterUrl: string
): Promise<{ title: string | null; content: string } | null> {
  const db = await openDb()
  const key = makeChapterKey(sourceId, bookUrl, chapterUrl)

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_CHAPTERS, 'readonly')
      const store = tx.objectStore(STORE_CHAPTERS)
      const req = store.get(key)
      req.onsuccess = () => {
        const record = req.result as OfflineChapterRecord | undefined
        if (record && record.content) {
          resolve({ title: record.title, content: record.content })
        } else {
          resolve(null)
        }
      }
      req.onerror = () => reject(req.error)
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Returns a Set of cached chapterUrls for a specific book in client IndexedDB
 */
export async function getOfflineChaptersSet(
  sourceId: string,
  bookUrl: string
): Promise<Set<string>> {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_CHAPTERS, 'readonly')
      const store = tx.objectStore(STORE_CHAPTERS)
      const index = store.index('by_book')
      const range = IDBKeyRange.only([sourceId, bookUrl])
      const req = index.openCursor(range)
      const result = new Set<string>()

      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          const record = cursor.value as OfflineChapterRecord
          if (record && record.chapterUrl) {
            result.add(record.chapterUrl)
          }
          cursor.continue()
        } else {
          resolve(result)
        }
      }
      req.onerror = () => reject(req.error)
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Calculates storage stats across all offline books
 */
export async function getOfflineStorageStats(): Promise<OfflineStorageStats> {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_CHAPTERS, 'readonly')
      const store = tx.objectStore(STORE_CHAPTERS)
      const req = store.openCursor()
      const bookMap = new Map<string, OfflineBookStat>()
      let totalChapters = 0
      let totalBytes = 0

      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          const record = cursor.value as OfflineChapterRecord
          const bookKey = `${record.sourceId}::${record.bookUrl}`
          const stat = bookMap.get(bookKey) || {
            sourceId: record.sourceId,
            bookUrl: record.bookUrl,
            chapterCount: 0,
            totalBytes: 0,
            lastCachedAt: 0,
          }
          stat.chapterCount += 1
          const bytes = record.byteSize || (record.content?.length || 0) * 2
          stat.totalBytes += bytes
          stat.lastCachedAt = Math.max(stat.lastCachedAt, record.cachedAt || 0)
          bookMap.set(bookKey, stat)

          totalChapters += 1
          totalBytes += bytes
          cursor.continue()
        } else {
          resolve({
            books: Array.from(bookMap.values()),
            totalChapters,
            totalBytes,
          })
        }
      }
      req.onerror = () => reject(req.error)
      // 事务被中止时 cursor 不会再回 onsuccess（另一个标签页触发 versionchange、库被外部关闭都会走到这里）：
      // 少了这一行这个 Promise 永远不 settle，界面就永远停在"正在统计设备存储占用…"
      tx.onabort = () => reject(tx.error ?? new Error('离线存储事务被中断'))
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Clears offline chapters for a specific book
 */
export async function clearOfflineBook(sourceId: string, bookUrl: string): Promise<number> {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_CHAPTERS, 'readwrite')
      const store = tx.objectStore(STORE_CHAPTERS)
      const index = store.index('by_book')
      const range = IDBKeyRange.only([sourceId, bookUrl])
      const req = index.openKeyCursor(range)
      const keysToDelete: IDBValidKey[] = []

      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          keysToDelete.push(cursor.primaryKey)
          cursor.continue()
        } else {
          for (const key of keysToDelete) {
            store.delete(key)
          }
          resolve(keysToDelete.length)
        }
      }
      req.onerror = () => reject(req.error)
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Clears all offline chapters
 */
export async function clearAllOffline(): Promise<void> {
  const db = await openDb()

  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE_CHAPTERS, 'readwrite')
      const store = tx.objectStore(STORE_CHAPTERS)
      const req = store.clear()
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * 空间不足时的自动淘汰：按**最久未写入**的顺序清掉整本离线书，直到腾出 `targetBytesToFree`。
 *
 * `exclude` 是必须的：调用点是"某本书的某一章正要落库时配额爆了"，
 * 不排除的话这里会把**用户正在下载的那一本**（含它已经存好的章节）一起清掉。
 * 排序也不能省 —— `stats.books` 是 IndexedDB 游标顺序（按书名），不排就等于随机淘汰。
 */
export async function evictLruOfflineBooks(
  targetBytesToFree = 10 * 1024 * 1024,
  exclude?: { sourceId: string; bookUrl: string },
): Promise<number> {
  const stats = await getOfflineStorageStats()
  const candidates = stats.books
    .filter(book => !(exclude && book.sourceId === exclude.sourceId && book.bookUrl === exclude.bookUrl))
    .sort((a, b) => a.lastCachedAt - b.lastCachedAt)
  if (candidates.length === 0) return 0

  let freed = 0
  for (const book of candidates) {
    if (freed >= targetBytesToFree) break
    const count = await clearOfflineBook(book.sourceId, book.bookUrl)
    if (count > 0) {
      freed += book.totalBytes
    }
  }
  return freed
}

/**
 * Bookshelf Snapshot for instant offline display
 */
export function saveShelfSnapshot(items: any[]): void {
  try {
    localStorage.setItem(SNAPSHOT_SHELF_KEY, JSON.stringify({
      items,
      updatedAt: Date.now(),
    }))
  } catch {
    // ignore
  }
}

export function getShelfSnapshot(): any[] | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_SHELF_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.items) ? parsed.items : null
  } catch {
    return null
  }
}

/**
 * Offline Reading Progress Queue
 */
export interface OfflineProgressItem {
  sourceId: string
  bookUrl: string
  chapterUrl: string
  chapterIndex: number
  scrollPosition: number
  updatedAt: number
}

export function enqueueOfflineProgress(progress: OfflineProgressItem): void {
  try {
    const raw = localStorage.getItem(OFFLINE_PROGRESS_QUEUE_KEY)
    const queue: OfflineProgressItem[] = raw ? JSON.parse(raw) : []
    // Remove older entries for same book
    const filtered = queue.filter(
      (item) => !(item.sourceId === progress.sourceId && item.bookUrl === progress.bookUrl)
    )
    filtered.push(progress)
    localStorage.setItem(OFFLINE_PROGRESS_QUEUE_KEY, JSON.stringify(filtered))
  } catch {
    // ignore
  }
}

export async function flushOfflineProgress(
  sendProgressApi: (item: OfflineProgressItem) => Promise<any>
): Promise<number> {
  try {
    const raw = localStorage.getItem(OFFLINE_PROGRESS_QUEUE_KEY)
    if (!raw) return 0
    const queue: OfflineProgressItem[] = JSON.parse(raw)
    if (!queue.length) return 0

    let flushedCount = 0
    const remaining: OfflineProgressItem[] = []

    for (const item of queue) {
      try {
        await sendProgressApi(item)
        flushedCount++
      } catch {
        remaining.push(item)
      }
    }

    if (remaining.length > 0) {
      localStorage.setItem(OFFLINE_PROGRESS_QUEUE_KEY, JSON.stringify(remaining))
    } else {
      localStorage.removeItem(OFFLINE_PROGRESS_QUEUE_KEY)
    }

    return flushedCount
  } catch {
    return 0
  }
}

/**
 * 4-concurrency sliding window offline chapter downloader
 */
export async function downloadChaptersToOffline(
  sourceId: string,
  bookUrl: string,
  chapters: Array<{ index: number; title: string; url: string }>,
  fetchChapterContent: (chapterUrl: string) => Promise<{ title?: string | null; content: string }>,
  onProgress?: (completed: number, total: number) => void,
  signal?: AbortSignal
): Promise<{ successful: number; failed: number }> {
  const existingSet = await getOfflineChaptersSet(sourceId, bookUrl)
  const remaining = chapters.filter((c) => !existingSet.has(c.url))
  const total = remaining.length

  if (total === 0) {
    onProgress?.(chapters.length, chapters.length)
    return { successful: 0, failed: 0 }
  }

  const CONCURRENCY = 4
  let completed = 0
  let successful = 0
  let failed = 0
  let currentIndex = 0

  const runWorker = async (): Promise<void> => {
    while (currentIndex < remaining.length) {
      if (signal?.aborted) break
      const item = remaining[currentIndex++]
      if (!item) break

      try {
        const result = await fetchChapterContent(item.url)
        if (result && result.content) {
          await putOfflineChapter(sourceId, bookUrl, item.url, result.title || item.title, result.content)
          successful++
        } else {
          failed++
        }
      } catch (err) {
        if (signal?.aborted) break
        failed++
      } finally {
        completed++
        onProgress?.(existingSet.size + completed, chapters.length)
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, remaining.length) }, () => runWorker())
  await Promise.all(workers)

  return { successful, failed }
}

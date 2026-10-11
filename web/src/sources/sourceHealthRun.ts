import { useSyncExternalStore } from 'react'
import { api, type SourceHealthCheckItem } from '../lib/api'
import { autoTagBatches, HEALTH_TAGS, tierCounts } from './sourceGrouping'

/**
 * 书源体检的"跑在组件外面"的那一半（用户 2026-10-02：
 * 「除非点击了关闭，其他情况都后台持续体检一直到结束，体检获得的内容在体检的过程中去给不能正常使用的分好组」）。
 *
 * 原来整个循环挂在弹窗组件里：关窗、换页、开别的对话框都会卸载它，
 * 卸载时 `cancelledRef.current = true` —— 于是一次几十分钟的整库体检，
 * 只要用户点一下别的地方就静默作废，结果也没了。这一版把运行状态搬进模块，
 * 组件只是它的一个订阅者：**只有「停止体检」这个显式动作能中止**，收起窗口与换页都让它继续跑。
 *
 * 另一半是"过程中就分组"：每落地一批，就把这一批里判定为「异常 / 待确认」的源打上标签，
 * 不等跑完再让用户去点按钮 —— 用户要的是跑完抬眼就能按分组筛，而不是一屏结论摆在那儿。
 * 只打标签，绝不动启用位（把 4,874 个源停成 2 个那类事故的来源）。
 */

/** 服务端每请求并发 16：一批 128 正好 8 轮，既能让界面逐批显示进度，又不会把请求数炸开。 */
export const HEALTH_CHUNK = 128
/** 攒够这么多待打标的源再写一次库：一个一个打会把手风琴拉成几千次请求。 */
const TAG_FLUSH_AT = 200

export type HealthRunState = {
  running: boolean
  total: number
  checked: number
  startedAt: number
  durationMs: number
  results: SourceHealthCheckItem[]
  /** 体检过程中自动打上的标签条数 */
  autoTagged: number
  finished: 'done' | 'stopped' | null
}

let state: HealthRunState = {
  running: false, total: 0, checked: 0, startedAt: 0, durationMs: 0, results: [], autoTagged: 0, finished: null,
}
const listeners = new Set<() => void>()
let timer: number | null = null
let cancelled = false

export const getHealthRun = () => state
export function useHealthRun(): HealthRunState {
  return useSyncExternalStore(subscribeHealthRun, getHealthRun, getHealthRun)
}
export function subscribeHealthRun(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function replace(next: HealthRunState) {
  state = next
  listeners.forEach(listener => listener())
}

/**
 * 一批结论落地后，把"不能正常使用"的那些送去打标签。
 * `alreadyTagged` 记的是本轮已经打过的 id：客户端的 sources 要等刷新才是新的，
 * 不自己记账就会每批重复打同一批源。
 */
async function tagFailing(
  batch: SourceHealthCheckItem[],
  groupsOf: () => Record<string, string>,
  alreadyTagged: Set<string>,
  onSourcesChange: () => void,
): Promise<number> {
  const groups = groupsOf()
  const buckets = autoTagBatches(batch, groups, alreadyTagged)
  let written = 0
  for (const { tier, ids } of buckets) {
    ids.forEach(id => alreadyTagged.add(id))
    try {
      await api.batchSources('tag_group', ids, HEALTH_TAGS[tier])
      written += ids.length
    } catch {
      // 打标签失败不能打断体检：结论比标签重要，漏的在最后一批还会再试一次
      ids.forEach(id => alreadyTagged.delete(id))
    }
  }
  if (written > 0) onSourcesChange()
  return written
}

export type HealthRunStart = {
  ids: string[]
  previous?: SourceHealthCheckItem[]
  groupsOf: () => Record<string, string>
  onSourcesChange: () => void
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void
}

/** 发起一轮体检。已经在跑就先停掉旧的 —— 同时跑两轮只会互相把结果盖掉。 */
export function startHealthRun(options: HealthRunStart): void {
  if (state.running) stopHealthRun()
  const merged = new Map((options.previous ?? []).map(item => [item.id, item]))
  cancelled = false
  if (timer) clearInterval(timer)
  const startedAt = Date.now()
  replace({
    ...state, running: true, finished: null, total: options.ids.length, checked: 0,
    startedAt, durationMs: 0, results: Array.from(merged.values()),
  })
  timer = window.setInterval(() => {
    replace({ ...state, durationMs: Date.now() - startedAt })
  }, 500)

  void (async () => {
    const alreadyTagged = new Set<string>()
    let pendingTag: SourceHealthCheckItem[] = []
    let autoTagged = 0
    try {
      for (let offset = 0; offset < options.ids.length; offset += HEALTH_CHUNK) {
        if (cancelled) return
        const chunk = options.ids.slice(offset, offset + HEALTH_CHUNK)
        const response = await api.healthCheckSources(chunk, 5000)
        for (const item of response.results) merged.set(item.id, item)
        pendingTag = pendingTag.concat(response.results)
        if (pendingTag.length >= TAG_FLUSH_AT) {
          autoTagged += await tagFailing(pendingTag, options.groupsOf, alreadyTagged, options.onSourcesChange)
          pendingTag = []
        }
        replace({
          ...state,
          results: Array.from(merged.values()),
          checked: Math.min(options.ids.length, offset + chunk.length),
          autoTagged,
        })
      }
      if (cancelled) return
      autoTagged += await tagFailing(pendingTag, options.groupsOf, alreadyTagged, options.onSourcesChange)
      replace({
        ...state, running: false, finished: 'done', checked: options.ids.length, autoTagged,
        durationMs: Date.now() - startedAt,
        results: Array.from(merged.values()),
      })
      // 结论按本轮点到的那些源算（`merged` 里可能还留着上一轮别的范围的源）。
      // 不再用服务端的 failedCount：它等于 `!ok`，把"没配搜索"和"真连不上"混成一个数。
      const tiers = tierCounts(options.ids.map(id => merged.get(id)).filter(Boolean) as SourceHealthCheckItem[])
      options.onToast(
        `体检完成：${tiers.good} 个能搜到书，${tiers.bad} 个确认有问题，`
        + `${tiers.pending} 个待确认，${tiers.unconfigured} 个没配搜索地址（没发过请求，不算坏）`
        + (autoTagged > 0 ? `；过程中已给 ${autoTagged} 个分好体检标签` : ''),
        'info',
      )
    } catch (error) {
      replace({ ...state, running: false, finished: 'stopped' })
      options.onToast(error instanceof Error ? error.message : '体检请求失败', 'error')
    } finally {
      if (timer) { clearInterval(timer); timer = null }
    }
  })()
}

/** 显式停止。这是唯一能提前结束一轮体检的入口。 */
export function stopHealthRun(): void {
  if (!state.running) return
  cancelled = true
  if (timer) { clearInterval(timer); timer = null }
  replace({ ...state, running: false, finished: 'stopped', durationMs: Date.now() - state.startedAt })
}

/** 一轮跑完/停掉之后把结果清掉，让下次打开是干净的。正在跑的时候什么都不做。 */
export function resetHealthRun(): void {
  if (state.running) return
  replace({ running: false, total: 0, checked: 0, startedAt: 0, durationMs: 0, results: [], autoTagged: 0, finished: null })
}

/**
 * 源被删掉之后把它的结论一并摘掉：留着就是界面上有一排点不动的僵尸条目
 * （它们连 `book_source` 行都没了，重试只会全红）。
 */
export function dropHealthResults(ids: string[]): void {
  const gone = new Set(ids)
  if (!state.results.some(item => gone.has(item.id))) return
  replace({ ...state, results: state.results.filter(item => !gone.has(item.id)) })
}

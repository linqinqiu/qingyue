/**
 * 把体检拿到的信息变成分组动作。
 *
 * 用户 2026-09-30：「书源体检效验，管理功能异常，过慢，有很多问题，**不能根据获得信息正确规划分组**」。
 * 前三条是速度与可中止性；这一条是：体检跑完给出 正常/迟缓/需登录/连不上 一堆结论，
 * 但界面上没有任何地方把这些结论变成能用的分组，用户还是得一个源一个源手动挪。
 *
 * 这里的规则刻意保守：
 * ① 只**追加**我们自己打的档位标签，绝不覆盖书源自带的 `bookSourceGroup`（那是用户/作者写的分类，
 *    冲掉它就等于用一次体检的结论否掉了整库的原始信息）；
 * ② 档位只分三档，且"待确认"明确不等于坏 —— 零结果 / 需登录 / 需渲染 JS 是我们这边差能力或差凭据，
 *    把它们和"连不上"混成一档去停用，就是上一轮把 4,874 个源停成 2 个的那类事故。
 */

export type HealthTier = 'good' | 'pending' | 'bad'

/** 三档标签名。写进 `bookSourceGroup` 里，与用户自己的标签并列。 */
export const HEALTH_TAGS: Record<HealthTier, string> = {
  good: '体检可用',
  pending: '体检待确认',
  bad: '体检异常',
}

const GOOD = new Set(['valid', 'slow'])
const BAD = new Set(['unreachable', 'tls', 'broken', 'invalid'])

/** 体检状态 → 档位。没见过的状态一律算"待确认"，不许凭猜测判源已死。 */
export function tierOf(statusCategory: string): HealthTier {
  if (GOOD.has(statusCategory)) return 'good'
  if (BAD.has(statusCategory)) return 'bad'
  return 'pending'
}

const splitTags = (raw: string | null | undefined) =>
  (raw ?? '').split(/[,，、\s]+/).map(tag => tag.trim()).filter(Boolean)

const joinTags = (tags: string[]) => [...new Set(tags)].join(' ')

/**
 * 生成新的 `bookSourceGroup` 串。
 *
 * `add` 与 `remove` 都只作用于我们自己的三档标签，用户原本写的标签原样保留；
 * 全清空时返回空串（等于回到"未分组"），不返回空格串污染列表。
 */
export function tagPlan(currentGroup: string | null | undefined, add: HealthTier[] = [], remove: HealthTier[] = []): string {
  const ours = new Set(Object.values(HEALTH_TAGS))
  const removed = new Set(remove.map(tier => HEALTH_TAGS[tier]))
  const kept = splitTags(currentGroup).filter(tag => !ours.has(tag) || !removed.has(tag))
  const appended = add.map(tier => HEALTH_TAGS[tier])
  return joinTags([...kept, ...appended])
}

/** 某源当前带着哪几档我们的标签。 */
export function currentTiers(currentGroup: string | null | undefined): HealthTier[] {
  const tags = new Set(splitTags(currentGroup))
  return (Object.keys(HEALTH_TAGS) as HealthTier[]).filter(tier => tags.has(HEALTH_TAGS[tier]))
}

export type GroupingRow = { id: string; name: string; statusCategory: string; latencyMs: number }
export type GroupingPlan = {
  tier: HealthTier
  tag: string
  ids: string[]
  /** 与当前标签已经一致、不需要写的数量 —— 面板要说"其中 N 个已经是这样"，否则每次点都全库重写。 */
  alreadyApplied: number
  examples: string[]
}

/**
 * 按体检结论汇总出可执行的分组计划。
 * `currentGroups` 是 id → 现有 `bookSourceGroup` 串，用来算"已经打过标签"的那部分。
 */
export function buildGroupingPlan(rows: GroupingRow[], currentGroups: Record<string, string>): GroupingPlan[] {
  const buckets = new Map<HealthTier, GroupingPlan>()
  for (const tier of ['good', 'pending', 'bad'] as HealthTier[]) {
    buckets.set(tier, { tier, tag: HEALTH_TAGS[tier], ids: [], alreadyApplied: 0, examples: [] })
  }
  for (const row of rows) {
    const plan = buckets.get(tierOf(row.statusCategory))!
    plan.ids.push(row.id)
    if (currentTiers(currentGroups[row.id]).includes(plan.tier)) plan.alreadyApplied += 1
    if (plan.examples.length < 3) plan.examples.push(`${row.name}（${row.statusCategory}${row.latencyMs ? ` ${Math.round(row.latencyMs)}ms` : ''}）`)
  }
  return [...buckets.values()].filter(plan => plan.ids.length > 0)
}

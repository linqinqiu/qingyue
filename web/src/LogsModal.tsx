import { useCallback, useEffect, useState } from 'react'
import { api, type LogEntry } from './api'
import { Icon } from './icons'
import { Select } from './Select'
import { toast } from './Toast'

/**
 * 「运行日志」弹窗：把服务端 LogService 收集的结构化日志摊开给人看。
 *
 * 之前这套日志只写文件 + 内存队列，界面上没有任何入口，等于收集了却看不见。
 * 现在落库后从这里按类别/等级筛、翻历史、清空。等级用颜色区分，堆栈默认折叠。
 */
const CATEGORIES = [
  ['ENGINE', '规则引擎'], ['NETWORK', '网络请求'], ['PARSING', '内容解析'],
  ['RULE_EXECUTION', '书源规则'], ['DATABASE', '数据库'], ['CACHE', '缓存'],
  ['GUARD', '同源闸门'], ['SYSTEM', '系统'],
] as const

const LEVELS = [['ERROR', '错误'], ['WARN', '警告'], ['INFO', '信息'], ['DEBUG', '调试']] as const

const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(CATEGORIES)

export function LogsModal({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('')
  const [level, setLevel] = useState('')
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setEntries(await api.logs({ category: category || undefined, level: level || undefined, limit: 300 }))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '无法载入日志')
    } finally {
      setLoading(false)
    }
  }, [category, level])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [onClose])

  const clear = async () => {
    if (!confirm('清空服务端全部运行日志？此操作不可恢复。')) return
    try {
      await api.clearLogs()
      toast.success('已清空日志')
      setExpanded(new Set())
      await load()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '清空失败')
    }
  }

  const toggle = (index: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="source-login-modal logs-modal"
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="运行日志"
      >
        <div className="logs-modal-header">
          <h2>运行日志</h2>
          <div className="logs-modal-actions">
            <button type="button" className="logs-btn" onClick={() => void load()} disabled={loading}>
              <Icon name="refresh" /><span>刷新</span>
            </button>
            <button type="button" className="logs-btn danger" onClick={() => void clear()}>
              <Icon name="trash" /><span>清空</span>
            </button>
            <button type="button" className="logs-btn" onClick={onClose} aria-label="关闭">
              <Icon name="close" />
            </button>
          </div>
        </div>

        <div className="logs-filters">
          <div className="logs-filter">
            <span>类别</span>
            <Select
              ariaLabel="日志类别"
              value={category}
              options={[{ value: '', label: '全部' }, ...CATEGORIES.map(([value, label]) => ({ value, label }))]}
              onChange={setCategory}
            />
          </div>
          <div className="logs-filter">
            <span>等级</span>
            <Select
              ariaLabel="日志等级"
              value={level}
              options={[{ value: '', label: '全部' }, ...LEVELS.map(([value, label]) => ({ value, label }))]}
              onChange={setLevel}
            />
          </div>
          <span className="logs-count">{loading ? '载入中…' : `${entries.length} 条`}</span>
        </div>

        <div className="logs-list">
          {!loading && entries.length === 0 && <p className="logs-empty">这个条件下没有日志。</p>}
          {entries.map(entry => {
            const hasContext = entry.context && Object.keys(entry.context).length > 0
            const hasStack = !!entry.stackTrace
            const expandable = hasContext || hasStack
            // 按日志 id 展开，不按数组下标：点一次「刷新」列表就重排，下标会让"我刚才看的那条"变成另一条。
            const open = expanded.has(entry.id)
            return (
              <div key={entry.id} className={`logs-row level-${entry.level.toLowerCase()}`}>
                <button
                  type="button"
                  className="logs-row-main"
                  onClick={() => expandable && toggle(entry.id)}
                  aria-expanded={expandable ? open : undefined}
                >
                  <span className="logs-badge">{CATEGORY_LABEL[entry.category] ?? entry.category}</span>
                  <span className="logs-level">{entry.level}</span>
                  <span className="logs-msg">{entry.message}</span>
                  <time className="logs-time">{entry.timestamp.replace('T', ' ').slice(0, 19)}</time>
                  {expandable && <Icon name={open ? 'chevronDown' : 'chevronRight'} />}
                </button>
                {expandable && open && (
                  <div className="logs-detail">
                    {hasContext && (
                      <dl className="logs-context">
                        {Object.entries(entry.context!).map(([key, value]) => (
                          <div key={key}><dt>{key}</dt><dd>{value}</dd></div>
                        ))}
                      </dl>
                    )}
                    {hasStack && <pre className="logs-stack">{entry.stackTrace}</pre>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

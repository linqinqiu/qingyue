import { useState, useEffect, useRef, useMemo } from 'react'
import { api, SourceHealthCheckItem, SourceHealthCheckResponse, SourceSummary } from './api'
import { Icon } from './icons'

interface SourceHealthModalProps {
  sources: SourceSummary[]
  onClose: () => void
  onSourcesChange: () => void
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void
}

/**
 * 体检结论分档。只有「确认可用性有问题」的四类允许被一键停用/删除；
 * empty / blocked / needs_login / needs_webview 是「我们这边差能力或差登录」，
 * 把它们一起关掉就是上一轮把整库 4,874 个源停成 2 个的那种事故。
 */
export const HEALTH_LABELS: Record<string, string> = {
  valid: '正常', slow: '迟缓', empty: '零结果', blocked: '访问受限', needs_login: '需登录',
  needs_webview: '需渲染JS', unreachable: '连不上', tls: '证书问题', broken: '规则失效', invalid: '结构错误',
}
const DEAD_STATES = ['unreachable', 'tls', 'broken', 'invalid']
const PENDING_STATES = ['empty', 'blocked', 'needs_login', 'needs_webview']
const isDead = (state: string) => DEAD_STATES.includes(state)
const isPending = (state: string) => PENDING_STATES.includes(state)

type TabFilter = 'all' | 'valid' | 'slow' | 'pending' | 'dead'

/** 服务端每请求并发 16：一批 128 正好 8 轮，既能让前端逐批显示进度，又不会把请求数炸开。 */
const HEALTH_CHUNK = 128

export function SourceHealthModal({
  sources,
  onClose,
  onSourcesChange,
  onToast,
}: SourceHealthModalProps) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ total: number; checked: number }>({ total: sources.length, checked: 0 })
  const [results, setResults] = useState<SourceHealthCheckItem[]>([])
  const [activeTab, setActiveTab] = useState<TabFilter>('all')
  const [filterQuery, setFilterQuery] = useState('')
  const [durationMs, setDurationMs] = useState(0)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const timerRef = useRef<number | null>(null)
  const cancelledRef = useRef(false)
  const startTimeRef = useRef<number>(0)

  const stats = useMemo(() => {
    let valid = 0
    let slow = 0
    let pending = 0
    let dead = 0
    for (const r of results) {
      if (r.statusCategory === 'valid') valid++
      else if (r.statusCategory === 'slow') slow++
      else if (isDead(r.statusCategory)) dead++
      else pending++
    }
    return { total: results.length, valid, slow, pending, dead }
  }, [results])

  const filteredResults = useMemo(() => {
    return results.filter(item => {
      if (activeTab === 'valid' && item.statusCategory !== 'valid') return false
      if (activeTab === 'slow' && item.statusCategory !== 'slow') return false
      if (activeTab === 'dead' && !isDead(item.statusCategory)) return false
      if (activeTab === 'pending' && !isPending(item.statusCategory)) return false
      if (filterQuery) {
        const q = filterQuery.toLowerCase()
        return item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q)
      }
      return true
    })
  }, [results, activeTab, filterQuery])

  const startCheck = async (targetIds?: string[]) => {
    const idsToCheck = targetIds ?? sources.map(s => s.id)
    if (idsToCheck.length === 0) {
      onToast('没有可检测的书源', 'info')
      return
    }
    setRunning(true)
    setProgress({ total: idsToCheck.length, checked: 0 })
    startTimeRef.current = Date.now()
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = window.setInterval(() => {
      setDurationMs(Date.now() - startTimeRef.current)
    }, 100)
    cancelledRef.current = false

    // 一次 POST 打整库时，服务端要全部探完才回，进度条只能作假；
    // 按批发送就能每批落地一次：条子是真走完的，结果也是一条条冒出来的。
    const merged = new Map(results.map(item => [item.id, item]))
    let tallied = { ok: 0, slow: 0, failed: 0 }
    try {
      for (let offset = 0; offset < idsToCheck.length; offset += HEALTH_CHUNK) {
        if (cancelledRef.current) return
        const chunk = idsToCheck.slice(offset, offset + HEALTH_CHUNK)
        const resp = await api.healthCheckSources(chunk, 5000)
        for (const item of resp.results) merged.set(item.id, item)
        tallied = { ok: tallied.ok + resp.successCount, slow: tallied.slow + resp.slowCount, failed: tallied.failed + resp.failedCount }
        setResults(Array.from(merged.values()))
        setProgress({ total: idsToCheck.length, checked: Math.min(idsToCheck.length, offset + chunk.length) })
      }
      if (cancelledRef.current) return
      setDurationMs(Date.now() - startTimeRef.current)
      setProgress({ total: idsToCheck.length, checked: idsToCheck.length })
      onToast(`体检完成：${tallied.ok + tallied.slow} 个能搜到书（${tallied.slow} 个迟缓），${tallied.failed} 个有问题（其中待确认的要先看原因，别急着停用）`, 'info')
    } catch (err) {
      onToast(err instanceof Error ? err.message : '体检请求失败', 'error')
    } finally {
      setRunning(false)
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }

  useEffect(() => {
    // Auto-start on modal mount
    void startCheck()
    return () => {
      cancelledRef.current = true
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  const handleBatchDisableFailed = async () => {
    const failedItems = results.filter(r => isDead(r.statusCategory))
    if (failedItems.length === 0) {
      onToast('当前无失效书源需要停用', 'info')
      return
    }
    setBusyAction('disable_failed')
    try {
      const resp = await api.batchSources('disable', failedItems.map(i => i.id))
      onToast(resp.message || `已停用 ${resp.affected} 个失效书源`, 'success')
      onSourcesChange()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '停用失败', 'error')
    } finally {
      setBusyAction(null)
    }
  }

  const handleBatchDeleteFailed = async () => {
    const failedItems = results.filter(r => isDead(r.statusCategory))
    if (failedItems.length === 0) {
      onToast('当前无失效书源需要删除', 'info')
      return
    }
    const names = failedItems.slice(0, 3).map(i => i.name).join('、') + (failedItems.length > 3 ? ` 等共 ${failedItems.length} 个` : '')
    if (!confirm(`确定要彻底删除以下 ${failedItems.length} 个失效书源吗？\n（${names}）\n删除后不可恢复！`)) {
      return
    }
    setBusyAction('delete_failed')
    try {
      const resp = await api.batchSources('delete', failedItems.map(i => i.id))
      onToast(resp.message || `已删除 ${resp.affected} 个失效书源`, 'success')
      setResults(prev => prev.filter(r => !isDead(r.statusCategory)))
      onSourcesChange()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setBusyAction(null)
    }
  }

  const handleRetryFailed = () => {
    const failedIds = results
      .filter(r => isDead(r.statusCategory))
      .map(r => r.id)
    if (failedIds.length === 0) {
      onToast('没有失效书源需要重试', 'info')
      return
    }
    void startCheck(failedIds)
  }

  const handleRetrySingle = (id: string) => {
    void startCheck([id])
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card source-health-modal" onClick={e => e.stopPropagation()}>
        <header className="modal-header">
          <div className="health-modal-title">
            <Icon name="activity" />
            <div>
              <h2>书源连通性与健康体检</h2>
              <small>
                {running
                  ? `正在并发探测书源 Host 与入口连通性：已检测 ${progress.checked} / ${progress.total}（${(durationMs / 1000).toFixed(1)}s）...`
                  : `共检测 ${stats.total} 个书源 · 用时 ${(durationMs / 1000).toFixed(1)}s`}
              </small>
            </div>
          </div>
          <button type="button" className="close-button" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>

        {/* Progress bar */}
        <div
          className="health-progress-wrap"
          role="progressbar"
          aria-label="体检进度"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.checked}
        >
          <div
            className="health-progress-bar"
            style={{ width: progress.total > 0 ? `${Math.round(progress.checked / progress.total * 100)}%` : '0%' }}
          />
        </div>

        {/* Stats and Filter Tabs */}
        <div className="health-stats-tabs">
          <div className="health-tabs">
            <button
              type="button"
              className={`health-tab-btn ${activeTab === 'all' ? 'active' : ''}`}
              onClick={() => setActiveTab('all')}
            >
              全部 ({stats.total})
            </button>
            <button
              type="button"
              className={`health-tab-btn tab-valid ${activeTab === 'valid' ? 'active' : ''}`}
              onClick={() => setActiveTab('valid')}
            >
              🟢 正常 ({stats.valid})
            </button>
            <button
              type="button"
              className={`health-tab-btn tab-slow ${activeTab === 'slow' ? 'active' : ''}`}
              onClick={() => setActiveTab('slow')}
            >
              🟡 迟缓 ({stats.slow})
            </button>
            <button
              type="button"
              className={`health-tab-btn tab-failed ${activeTab === 'pending' ? 'active' : ''}`}
              onClick={() => setActiveTab('pending')}
            >
              🟠 待确认 ({stats.pending})
            </button>
            <button
              type="button"
              className={`health-tab-btn tab-failed ${activeTab === 'dead' ? 'active' : ''}`}
              onClick={() => setActiveTab('dead')}
            >
              🔴 连不上 ({stats.dead})
            </button>
          </div>
          <div className="health-search-input">
            <Icon name="search" />
            <input
              type="text"
              placeholder="搜索检测结果..."
              value={filterQuery}
              onChange={e => setFilterQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Action Quick Bar */}
        <div className="health-actions-bar">
          <div className="health-actions-left">
            <button
              type="button"
              className="subtle-button"
              onClick={() => void startCheck()}
              disabled={running || busyAction !== null}
            >
              <Icon name="refresh" className={running ? 'spin' : ''} />
              <span>{running ? '体检中...' : '重新全量体检'}</span>
            </button>
            {stats.dead > 0 && !running && (
              <button
                type="button"
                className="subtle-button"
                onClick={handleRetryFailed}
                disabled={busyAction !== null}
              >
                <span>重试连不上的 ({stats.dead})</span>
              </button>
            )}
          </div>
          {stats.dead > 0 && (
            <div className="health-actions-right">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleBatchDisableFailed()}
                disabled={running || busyAction !== null}
              >
                <span>一键停用连不上的源 ({stats.dead})</span>
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void handleBatchDeleteFailed()}
                disabled={running || busyAction !== null}
              >
                <span>一键删除连不上的源 ({stats.dead})</span>
              </button>
            </div>
          )}
        </div>

        {/* Results List */}
        <div className="health-results-list">
          {filteredResults.length === 0 ? (
            <div className="health-empty-state">
              <p>{running ? '正在努力探测中...' : '无符合筛选条件的结果'}</p>
            </div>
          ) : (
            filteredResults.map(item => {
              // 结论标签取自服务端定的类；「待确认」不再被并进「失效」一起停用/删除
              const badgeClass = item.ok
                ? (item.statusCategory === 'slow' ? 'badge-slow' : 'badge-valid')
                : isDead(item.statusCategory) ? 'badge-failed'
                  : item.statusCategory === 'blocked' ? 'badge-blocked' : 'badge-pending'
              const badgeText = HEALTH_LABELS[item.statusCategory] ?? item.statusCategory

              return (
                <article key={item.id} className={`health-item-card ${item.statusCategory}`}>
                  <div className="health-item-main">
                    <div className="health-item-top">
                      <strong className="health-item-name">{item.name}</strong>
                      <span className={`health-badge ${badgeClass}`}>{badgeText}</span>
                      {item.latencyMs > 0 && (
                        <span className="health-latency">{item.latencyMs}ms</span>
                      )}
                      {item.statusCode > 0 && (
                        <span className="health-code">HTTP {item.statusCode}</span>
                      )}
                    </div>
                    <div className="health-item-url" title={item.id}>
                      {item.id}
                    </div>
                    {item.error && <p className="health-item-error">{item.error}</p>}
                  </div>
                  <div className="health-item-actions">
                    <button
                      type="button"
                      className="subtle-button icon-only"
                      title="单独重测"
                      onClick={() => handleRetrySingle(item.id)}
                      disabled={running}
                    >
                      <Icon name="refresh" />
                    </button>
                  </div>
                </article>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

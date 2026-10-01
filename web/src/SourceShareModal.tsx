import { useEffect, useMemo, useState } from 'react'
import { api, SourceSummary } from './api'
import { Icon } from './icons'

/** 当前访问来源；导出链接要按它拼绝对地址。 */
const currentOrigin = () => (typeof location === 'undefined' ? '' : location.origin)
import { useEscapeClose } from './useEscapeClose'

interface SourceShareModalProps {
  /** 要分享的书源 id；一个就是单源分享，多个打包成数组。 */
  sourceIds: string[]
  sources: SourceSummary[]
  onClose: () => void
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void
}

/**
 * 书源分享。
 *
 * 上游安卓端的网络一键导入格式是 `legado://import/{path}?src={url}`
 * （`ui/association/OnLineImportActivity.kt` 文件头注释），`src` 必须是**手机能访问到的地址**，
 * 所以这里能立刻用的是「剪贴板导入」：手机 Legado 的书源管理里有从剪贴板导入，
 * 不依赖任何网络暴露。真正的 `legado://` 链接要能落地，得先有一个手机可达的服务地址。
 */
export function SourceShareModal({ sourceIds, sources, onClose, onToast }: SourceShareModalProps) {
  const [payload, setPayload] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<'json' | 'link' | null>(null)

  useEscapeClose(onClose)
  const picked = useMemo(
    () => sourceIds.map(id => sources.find(item => item.id === id)).filter(Boolean) as SourceSummary[],
    [sourceIds, sources]
  )

  useEffect(() => {
    let cancelled = false
    setPayload('')
    setError('')
    void api.exportSources(sourceIds).then(list => {
      if (cancelled) return
      const parsed = list.map(item => runCatchingParse(item))
      const missing = list.length - parsed.filter(Boolean).length
      const body = sourceIds.length === 1 ? parsed[0] : parsed.filter(Boolean)
      setPayload(JSON.stringify(body, null, 2))
      if (missing) setError(`有 ${missing} 个书源的存储内容不是合法 JSON，已从分享结果里跳过`)
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : '导出失败')
    })
    return () => { cancelled = true }
  }, [sourceIds])

  const shareLink = useMemo(() => {
    if (!payload) return ''
    // 深链里的 src 指向本机导出接口：只有手机能访问到这个地址时才打得开
    const src = `${currentOrigin()}/api/sources/export?${sourceIds.map(id => `id=${encodeURIComponent(id)}`).join('&')}`
    return `legado://import/bookSource?src=${encodeURIComponent(src)}`
  }, [payload, sourceIds])

  const copy = async (text: string, which: 'json' | 'link') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(which)
      onToast(which === 'json' ? '书源 JSON 已复制，手机上用「从剪贴板导入」即可' : '分享链接已复制', 'success')
      window.setTimeout(() => setCopied(null), 2000)
    } catch {
      onToast('浏览器拒绝了剪贴板写入，请手动选中框内内容复制', 'error')
    }
  }

  const download = () => {
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const stem = sourceIds.length === 1 ? (picked[0]?.name || 'source') : `legado-sources-${sourceIds.length}`
    link.download = `legado-source-${stem.replace(/[\\/:*?"<>|]/g, '_')}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="source-share-dialog" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="分享书源">
        <header className="source-share-header">
          <div>
            <h2>分享书源</h2>
            <small>
              {picked.length === 1
                ? `${picked[0].name}${picked[0].group ? `｜${picked[0].group}` : ''}`
                : `已选 ${picked.length} 个书源，打包成一个 JSON 数组`}
            </small>
          </div>
          <button type="button" className="source-webview-icon-btn" title="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>

        <div className="source-share-body">
          <p className="source-share-tip">
            最稳的路子是<strong>剪贴板</strong>：手机 Legado「我的 → 书源管理 → ⋮ → 本地导入/剪贴板导入」直接粘进去，
            不需要手机能访问这台电脑。下面的 <code>legado://</code> 链接要能打开，前提是手机真的访问得到
            <code>{currentOrigin().replace(/^https?:\/\//, '')}</code> —— 服务当前只绑在 127.0.0.1 时，这个链接在手机上打不开。
          </p>
          {error && <p className="form-error">{error}</p>}
          <textarea className="source-share-text" readOnly value={payload} onFocus={event => event.currentTarget.select()} />
        </div>

        <footer className="source-share-footer">
          <button type="button" className="primary-button" disabled={!payload} onClick={() => void copy(payload, 'json')}>
            {copied === 'json' ? '已复制' : '复制书源 JSON'}
          </button>
          <button type="button" className="subtle-button" disabled={!payload} onClick={download}>
            下载 .json
          </button>
          <button type="button" className="subtle-button" disabled={!shareLink} onClick={() => void copy(shareLink, 'link')}>
            {copied === 'link' ? '已复制' : '复制 legado:// 链接'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function runCatchingParse(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

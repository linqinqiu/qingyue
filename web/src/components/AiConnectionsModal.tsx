import React, { useEffect, useRef, useState } from 'react'
import { api, AgentChatMessage, AgentConnection } from '../lib/api'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'

/**
 * 「AI 接入」（自定义接入面 /api/agent/*）。
 *
 * 这一页把后端那套**已在 127.0.0.1:1234 跑起来的** HTTP 接口做成本地设置入口。
 * 主形态是**对话助手**：在输入框里说话，消息走 `POST /api/agent/chat`——
 * 有外部模型（openai-compatible）就真对话，没有或连不上就回退本地说明。
 *
 * 连接管理（登记 / 删除外部模型）收进「高级」折叠区：要真对话，先在那里登记一个
 * openai-compatible 地址（或在 agent-profiles.json 里配置）。书源只读校验也放在折叠区。
 *
 * 写操作由服务端同源闸门把关（浏览器自动带 Origin），这里不注入令牌。
 */
export function AiConnectionsModal({ onClose }: { onClose: () => void }) {
  useEscapeClose(onClose)
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div
        className="dialog-shell size-l page-dialog"
        onClick={event => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="AI 接入"
      >
        <header className="dialog-head">
          <h2><Icon name="sliders" /> AI 接入 · 对话助手</h2>
          <button type="button" className="overlay-close" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
        </header>
        <div className="page-dialog-body">
          <AiConnectionsPanel />
        </div>
      </div>
    </div>
  )
}

type ChatLine = {
  role: 'system' | 'user' | 'assistant'
  content: string
  pending?: boolean
  engine?: string
  fallback?: boolean
}

function AiConnectionsPanel() {
  const [connections, setConnections] = useState<AgentConnection[]>([])
  const [loadError, setLoadError] = useState('')
  const external = connections.find(c => !c.builtin)

  const refresh = () => {
    api.listAgentConnections()
      .then(setConnections)
      .catch(err => setLoadError(err instanceof Error ? err.message : '读取连接失败'))
  }
  useEffect(() => { refresh() }, [])

  return (
    <div className="ai-connections">
      <ChatPanel externalConnected={!!external} externalName={external?.name} onConnectionsChanged={refresh} />
      <details className="ai-advanced">
        <summary>连接与工具（登记外部模型、校验书源）</summary>
        <section className="ai-section">
          <h3>连接</h3>
          <p className="ai-section-hint">
            内置 <code>local</code> 永远在、不可删；其余 openai-compatible 连接可登记/删除，重启后保留。
            要真正对话，请登记一个外部模型（多个时只走第一条）。
          </p>
          {loadError ? (
            <p className="customize-error" role="alert">{loadError}</p>
          ) : (
            <ul className="ai-conn-list">
              {connections.map(c => (
                <li key={c.id} className="ai-conn-item">
                  <div className="ai-conn-main">
                    <strong>{c.name}</strong>
                    <small>{c.builtin ? '内置' : '外部'} · {c.model ?? '—'}{c.baseUrl ? ` · ${c.baseUrl}` : ''}</small>
                  </div>
                  {!c.builtin && (
                    <button
                      type="button"
                      className="link-button ai-conn-del"
                      onClick={() => void api.deleteAgentConnection(c.id).then(refresh).catch(() => setLoadError('删除失败'))}
                    >删除</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <RegisterConnection onRegistered={refresh} />
        </section>
        <SourceValidatePanel />
      </details>
    </div>
  )
}

function ChatPanel({
  externalConnected,
  externalName,
  onConnectionsChanged,
}: {
  externalConnected: boolean
  externalName?: string
  onConnectionsChanged: () => void
}) {
  const [messages, setMessages] = useState<ChatLine[]>([])
  const [systemPrompt, setSystemPrompt] = useState('你是青阅的阅读助手，帮助用户理解文章、管理书源、解答阅读相关的问题。')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // 实测便携状态：真正发一条探测消息走 /api/agent/chat，看外部模型此刻是否可达。
  // 与上方「显示状态」（仅看是否登记了外部连接）不同，这里是实时连通性实测。
  const [probe, setProbe] = useState<'idle' | 'probing' | 'ok' | 'fail'>('idle')
  const [probeEngine, setProbeEngine] = useState('')

  const runProbe = async () => {
    setProbe('probing')
    try {
      const res = await api.agentChat([{ role: 'user', content: 'ping' }])
      if (res.engine.startsWith('external:')) {
        setProbe('ok')
        setProbeEngine(res.engine.replace('external:', ''))
      } else {
        setProbe('fail')
      }
    } catch {
      setProbe('fail')
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  // 打开且已登记外部模型时，自动实测一次连通性。
  useEffect(() => {
    if (externalConnected) { void runProbe() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalConnected])

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    setError('')
    const userLine: ChatLine = { role: 'user', content: text }
    const history: ChatLine[] = [...messages, userLine]
    setMessages([...history, { role: 'assistant', content: '', pending: true }])
    setInput('')

    const payload: AgentChatMessage[] = []
    if (systemPrompt.trim()) payload.push({ role: 'system', content: systemPrompt.trim() })
    for (const m of history) payload.push({ role: m.role, content: m.content })

    setSending(true)
    try {
      const res = await api.agentChat(payload)
      setMessages(prev => {
        const copy = [...prev]
        const idx = copy.findIndex(m => m.role === 'assistant' && m.pending)
        if (idx >= 0) copy[idx] = { role: 'assistant', content: res.content, engine: res.engine, fallback: res.fallback === true }
        return copy
      })
    } catch (failure) {
      setMessages(prev => {
        const copy = [...prev]
        const idx = copy.findIndex(m => m.role === 'assistant' && m.pending)
        if (idx >= 0) copy[idx] = { role: 'assistant', content: '（请求失败：' + (failure instanceof Error ? failure.message : '未知错误') + '）' }
        return copy
      })
      setError(failure instanceof Error ? failure.message : '发送失败')
    } finally {
      setSending(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <section className="ai-chat">
      <div className="ai-chat-status">
        {externalConnected ? (
          <span className="ai-tag">已连接外部模型{externalName ? `：${externalName}` : ''}，可真实对话</span>
        ) : (
          <span className="ai-tag ai-tag-warn">尚未登记外部模型，当前为本地兜底（无法真正对话）</span>
        )}
        <span className="ai-status-sep">·</span>
        {externalConnected ? (
          probe === 'probing' ? (
            <span className="ai-tag ai-tag-testing">实测中…</span>
          ) : probe === 'ok' ? (
            <span className="ai-tag ai-tag-ok">实测可达{probeEngine ? `（${probeEngine}）` : ''}</span>
          ) : probe === 'fail' ? (
            <span className="ai-tag ai-tag-warn">实测不可达，将回退本地</span>
          ) : (
            <span className="ai-tag">待实测</span>
          )
        ) : (
          <span className="ai-tag">无需实测（无外部模型）</span>
        )}
        {externalConnected && (
          <button type="button" className="link-button ai-probe-btn" onClick={() => void runProbe()} disabled={probe === 'probing'}>
            重新实测
          </button>
        )}
      </div>

      <details className="ai-chat-system">
        <summary>系统提示词（可选，设定助手人设）</summary>
        <textarea
          className="ai-chat-system-input"
          value={systemPrompt}
          onChange={e => setSystemPrompt(e.target.value)}
          rows={2}
          placeholder="例如：你是书源调试助手…"
        />
      </details>

      <div className="ai-chat-log" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="ai-chat-empty">在下面输入消息开始对话。有外部模型时会真正调用它；没有时只回本地说明。</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`ai-bubble ai-bubble-${m.role}${m.pending ? ' ai-bubble-pending' : ''}`}>
            <div className="ai-bubble-role">{m.role === 'user' ? '我' : '助手'}</div>
            <div className="ai-bubble-content">{m.content || (m.pending ? '思考中…' : '')}</div>
            {m.role === 'assistant' && !m.pending && m.engine && (
              <div className="ai-bubble-meta">
                <span className="ai-tag">{m.engine.startsWith('external:') ? `外部模型 ${m.engine.replace('external:', '')}` : '本地兜底'}</span>
                {m.fallback && <span className="ai-tag ai-tag-warn">已回退本地</span>}
              </div>
            )}
          </div>
        ))}
      </div>

      {!!error && <p className="customize-error" role="alert">{error}</p>}

      <div className="ai-chat-input">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
        />
        <button type="button" className="primary-button" onClick={() => void send()} disabled={sending || !input.trim()}>
          {sending ? '发送中…' : '发送'}
        </button>
      </div>
      <p className="ai-muted ai-chat-hint">
        快捷键：Enter 发送，Shift+Enter 换行。对话走 <code>POST /api/agent/chat</code>，不落库。
        {!externalConnected && ' 要真对话，请在下方「连接与工具」里登记一个 openai-compatible 模型。'}
      </p>
    </section>
  )
}

function RegisterConnection({ onRegistered }: { onRegistered: () => void }) {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const submit = async () => {
    if (!name.trim() || !baseUrl.trim() || !model.trim()) {
      setError('名称、接口地址、模型名都要填')
      return
    }
    setBusy(true)
    setError('')
    setNote('')
    try {
      const created = await api.registerAgentConnection({
        name: name.trim(),
        kind: 'openai-compatible',
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
      })
      setNote(`已登记「${created.name}」（id: ${created.id}）。注意：有多个外部连接时只走第一条，想让它生效就放在第一条。`)
      setName(''); setBaseUrl(''); setModel(''); setApiKey('')
      onRegistered()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '登记失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ai-register">
      <h4>登记外部连接（openai-compatible）</h4>
      <div className="ai-field-grid">
        <label className="customize-field">
          <span>名称</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="如 我的网关" />
        </label>
        <label className="customize-field">
          <span>接口地址（到 /v1）</span>
          <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:5591/v1" />
        </label>
        <label className="customize-field">
          <span>模型名</span>
          <input value={model} onChange={e => setModel(e.target.value)} placeholder="gpt-4o" />
        </label>
        <label className="customize-field">
          <span>密钥（可空）</span>
          <input value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-…（留空则不带 Authorization）" />
        </label>
      </div>
      {!!error && <p className="customize-error" role="alert">{error}</p>}
      {!!note && <p className="customize-note">{note}</p>}
      <div className="customize-actions">
        <button type="button" className="primary-button" onClick={() => void submit()} disabled={busy}>登记</button>
      </div>
    </div>
  )
}

function SourceValidatePanel() {
  const [json, setJson] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ valid: boolean; errors: string[]; warnings: string[] } | null>(null)

  const run = async () => {
    if (!json.trim()) { setError('先粘贴书源 JSON'); return }
    setBusy(true); setError(''); setResult(null)
    try {
      const r = await api.validateAgentSource(json)
      setResult(r)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '校验失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ai-section">
      <h3>书源校验</h3>
      <p className="ai-section-hint">只读校验书源 JSON 结构，不写入数据库。</p>
      <label className="customize-field">
        <span>书源 JSON</span>
        <textarea value={json} onChange={e => setJson(e.target.value)} rows={5} placeholder='{"bookSourceUrl":"https://x.com","bookSourceName":"demo"}' />
      </label>
      {!!error && <p className="customize-error" role="alert">{error}</p>}
      <div className="customize-actions">
        <button type="button" className="primary-button" onClick={() => void run()} disabled={busy}>校验</button>
      </div>
      {result && (
        <div className="ai-result">
          <p><span className={`ai-tag ${result.valid ? '' : 'ai-tag-warn'}`}>{result.valid ? '结构合法' : '结构有误'}</span></p>
          {result.errors.map((e, i) => <p key={i} className="customize-error">{e}</p>)}
          {result.warnings.map((w, i) => <p key={i} className="ai-muted">{w}</p>)}
        </div>
      )}
    </section>
  )
}

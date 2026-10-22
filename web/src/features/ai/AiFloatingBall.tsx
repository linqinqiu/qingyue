import React, { useEffect, useRef, useState } from 'react'
import { api, type AgentChatMessage, type AgentConnection } from '../../lib/api'
import { Icon } from '../../icons'
import { EMPTY_UI_CONTEXT, uiContextMessage, type UiContext } from '../../lib/uiContext'
import {
  appendAiLine,
  clearAiChat,
  DEFAULT_SYSTEM_PROMPT,
  resolvePendingAiLine,
  setAiChatOpen,
  setAiSystemPrompt,
  toggleAiChat,
  useAiChat,
  type ChatLine,
} from './aiChatStore'

/**
 * 全局 AI 悬浮球 —— 解决用户说的「不能随时随地使用，不能在对应地点研究」。
 *
 * 以前 AI 只能从「设置 → AI 接入」打开一个模态弹窗：人要离开当前正在看的书/书源，
 * 走三层才能问一句话，问完还得再走回来。位置错了，于是"在对应地点研究"做不到。
 *
 * 现在它挂在应用最外层（`main.tsx` 的根节点里），**每个页面都在**：
 * - 右下角一个球，点一下展开成对话面板；再点收起。
 * - 面板带着当前页面的 `uiContext`（在书源页就带书源、在阅读器就带这本书与章节），
 *   所以「这个源为什么搜不到」「这一章讲了什么」问的就是眼前这个东西。
 * - 对话历史存在 `aiChatStore`（跨页面、跨会话），关掉再开、换页再回来都不丢。
 *
 * 与「设置 → AI 接入」的关系：那里仍然是**配置**入口（登记外部模型、看书源校验），
 * 这个球是**使用**入口。两边共用同一个 `/api/agent/chat`，不是两套 AI。
 */
export function AiFloatingBall({ uiContext }: { uiContext?: UiContext }) {
  const chat = useAiChat()
  return (
    <>
      <button
        type="button"
        className={`ai-fab${chat.open ? ' ai-fab-open' : ''}`}
        onClick={toggleAiChat}
        aria-label={chat.open ? '收起 AI 助手' : '打开 AI 助手'}
        title={chat.open ? '收起 AI 助手' : '打开 AI 助手（任意页面可用）'}
      >
        <Icon name={chat.open ? 'close' : 'sparkles'} />
      </button>
      {chat.open && <AiFloatingPanel uiContext={uiContext} />}
    </>
  )
}

function AiFloatingPanel({ uiContext }: { uiContext?: UiContext }) {
  const chat = useAiChat()
  const [connections, setConnections] = useState<AgentConnection[]>([])
  const [loadError, setLoadError] = useState('')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const external = connections[0]

  useEffect(() => {
    api.listAgentConnections()
      .then(setConnections)
      .catch(err => setLoadError(err instanceof Error ? err.message : '读取连接失败'))
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [chat.messages.length, sending])

  // 展开时把焦点给输入框：随手就能问，不用再点一次
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Esc 收起面板（不关闭整页、不清对话）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAiChatOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const send = async () => {
    const text = input.trim()
    if (!text || sending || !external) return
    setError('')
    setInput('')
    appendAiLine({ role: 'user', content: text })
    const history: ChatLine[] = [...chat.messages, { role: 'user', content: text, at: Date.now() }]

    // 先放一个"思考中"占位气泡，位置记下来，回来精确替换它
    appendAiLine({ role: 'assistant', content: '', toolRounds: [] })
    const pendingIndex = history.length

    const payload: AgentChatMessage[] = []
    if (chat.systemPrompt.trim()) payload.push({ role: 'system', content: chat.systemPrompt.trim() })
    const ctxMsg = uiContextMessage(uiContext ?? EMPTY_UI_CONTEXT)
    if (ctxMsg) payload.push(ctxMsg)
    for (const m of history) payload.push({ role: m.role, content: m.content })

    setSending(true)
    try {
      const res = await api.agentChat(payload)
      resolvePendingAiLine(pendingIndex, {
        role: 'assistant',
        content: res.content,
        engine: res.engine,
        toolRounds: res.toolRounds,
      })
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '未知错误'
      resolvePendingAiLine(pendingIndex, { role: 'assistant', content: `（请求失败：${message}）` })
      setError(message)
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <aside className="ai-fab-panel dialog-shell" role="dialog" aria-modal="false" aria-label="AI 助手">
      <header className="ai-fab-head">
        <div className="ai-fab-title">
          <Icon name="sparkles" />
          <span>AI 助手</span>
        </div>
        <div className="ai-fab-actions">
          {chat.messages.length > 0 && (
            <button type="button" className="link-button" onClick={clearAiChat} title="清空对话（不可恢复）">
              清空
            </button>
          )}
          <button
            type="button"
            className="link-button"
            onClick={() => setShowSystem(v => !v)}
            title="系统提示词（设定助手人设）"
          >
            人设
          </button>
          <button type="button" className="overlay-close" aria-label="收起" onClick={() => setAiChatOpen(false)}>
            <Icon name="close" />
          </button>
        </div>
      </header>

      <div className="ai-fab-status">
        {loadError ? (
          <span className="ai-tag ai-tag-warn" role="alert">{loadError}</span>
        ) : external ? (
          <span className="ai-tag ai-tag-ok">已连接外部模型{external.name ? `：${external.name}` : ''}</span>
        ) : (
          <span className="ai-tag ai-tag-warn">
            未连接外部模型 —— 去「设置 → AI 接入」登记一个 openai-compatible 地址
          </span>
        )}
        <ContextHint uiContext={uiContext} />
      </div>

      {showSystem && (
        <textarea
          className="ai-fab-system"
          value={chat.systemPrompt}
          onChange={e => setAiSystemPrompt(e.target.value)}
          rows={2}
          placeholder={`默认：${DEFAULT_SYSTEM_PROMPT}`}
        />
      )}

      <div className="ai-fab-log" ref={scrollRef}>
        {chat.messages.length === 0 && (
          <p className="ai-fab-empty">
            {external
              ? '在下面问点什么。助手知道你在哪个页面、在看哪本书。'
              : '先登记一个外部模型才能对话。'}
          </p>
        )}
        {chat.messages.map((m, i) => (
          <div key={`${m.at}-${i}`} className={`ai-bubble ai-bubble-${m.role}`}>
            <div className="ai-bubble-role">{m.role === 'user' ? '我' : '助手'}</div>
            <div className="ai-bubble-content">{m.content || '思考中…'}</div>
            {m.role === 'assistant' && m.toolRounds && m.toolRounds.length > 0 && (
              <div className="ai-bubble-tools">
                <span className="ai-bubble-tools-label">用了 {m.toolRounds.length} 个能力</span>
                <ul className="ai-tool-list">
                  {m.toolRounds.map((r, k) => <li key={k} className="ai-tool-item">{r.replace(':', ' · ')}</li>)}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>

      {error && <p className="customize-error ai-fab-error" role="alert">{error}</p>}

      <div className="ai-fab-compose">
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={external ? '问点什么…（Enter 发送，Shift+Enter 换行）' : '未连接外部模型，暂不可用'}
          disabled={!external || sending}
        />
        <button type="button" className="primary-button" onClick={() => void send()} disabled={!external || sending || !input.trim()}>
          {sending ? '…' : '发送'}
        </button>
      </div>
    </aside>
  )
}

/** 让用户看见"助手现在知道什么"——否则上下文记忆是隐形的，出问题也没法判断。 */
function ContextHint({ uiContext }: { uiContext?: UiContext }) {
  const ctx = uiContext ?? EMPTY_UI_CONTEXT
  if (!ctx.book && !ctx.source && ctx.page === 'unknown') return null
  const parts: string[] = []
  if (ctx.book) parts.push(`《${ctx.book.name}》第 ${ctx.book.chapterIndex + 1} 章`)
  // 书源只在**书源页**算"正在看"：`selected` 是跨页面保留的状态，
  // 切到订阅/书架页还显示"正在看书源「x」"会让人以为助手盯错了地方。
  if (ctx.source && ctx.page === 'sources') parts.push(`书源「${ctx.source.name}」`)
  if (parts.length === 0) return null
  return <span className="ai-fab-ctx" title="这些信息会随你的问题一起发给模型">正在看：{parts.join(' · ')}</span>
}

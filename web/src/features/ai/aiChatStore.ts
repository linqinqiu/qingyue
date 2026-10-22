/**
 * AI 对话的全局状态 —— **跨页面、跨会话**保留。
 *
 * 用户原话：「ai 功能太差，1 是位置问题，不能随时随地使用，不能在对应地点研究，
 * 没有上下文记忆」。这一层解决后两个：
 *
 * - **跨页面**：对话不再活在某个弹窗组件的 `useState` 里 —— 悬浮球在任意页面都能开，
 *   关掉再开、切到别的页再切回来，说的话都还在。
 * - **跨会话**：落 localStorage，刷新页面/重开浏览器仍在（用户不用每次重新交代背景）。
 *
 * 和 `uiContext` 的分工：uiContext 说的是「用户此刻在哪个界面、在看什么」，每轮随请求发；
 * 这里说的是「我们之前聊过什么」，是对话本身的历史。两者互不替代。
 */
import { useSyncExternalStore } from 'react'

export type ChatRole = 'user' | 'assistant'

export type ChatLine = {
  role: ChatRole
  content: string
  /** 这一轮实际用到的外部模型（`external:<id>`）；错误轮为空 */
  engine?: string
  /** 这一轮 AI 实际执行过的工具（`工具id:结果码`） */
  toolRounds?: string[]
  /** 这条消息产生的时间戳，用于显示与清理 */
  at: number
}

export type AiChatState = {
  /** 悬浮球是否展开成对话面板 */
  open: boolean
  messages: ChatLine[]
  /** 用户自定义的人设/系统提示词 */
  systemPrompt: string
}

const STORAGE_KEY = 'legado.ai.chat.v1'
/** 只保留最近这么多条，避免 localStorage 无限膨胀（一对问答 = 2 条）。 */
const MAX_LINES = 200

export const DEFAULT_SYSTEM_PROMPT = '你是青阅的阅读助手，帮助用户理解文章、管理书源、解答阅读相关的问题。'

function readStorage(): AiChatState {
  const fallback: AiChatState = { open: false, messages: [], systemPrompt: DEFAULT_SYSTEM_PROMPT }
  try {
    if (typeof localStorage === 'undefined') return fallback
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<AiChatState> | null
    if (!parsed || typeof parsed !== 'object') return fallback
    const messages = Array.isArray(parsed.messages)
      ? parsed.messages
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .slice(-MAX_LINES)
          .map(m => ({ ...m, at: typeof m.at === 'number' ? m.at : Date.now() }))
      : []
    return {
      // `open` 不持久化：刷新后不该自动弹出一个面板挡住用户
      open: false,
      messages,
      systemPrompt: typeof parsed.systemPrompt === 'string' && parsed.systemPrompt.trim()
        ? parsed.systemPrompt
        : DEFAULT_SYSTEM_PROMPT,
    }
  } catch {
    return fallback
  }
}

let state: AiChatState = readStorage()
const listeners = new Set<() => void>()

function persist(): void {
  try {
    if (typeof localStorage === 'undefined') return
    // 只存需要跨会话的部分；`open` 是瞬时 UI 状态，存了会让刷新后莫名其妙弹面板。
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      messages: state.messages.slice(-MAX_LINES),
      systemPrompt: state.systemPrompt,
    }))
  } catch {
    // 存不下（隐私模式/超额）就丢：对话还在内存里，只是下次打开接不上
  }
}

function replace(next: AiChatState): void {
  state = next
  listeners.forEach(fn => fn())
}

function update(patch: Partial<AiChatState>): void {
  replace({ ...state, ...patch })
}

export function getAiChat(): AiChatState {
  return state
}

export function subscribeAiChat(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * 别的标签页改了对话时同步过来。
 *
 * 不加这个的话：在 A 标签页聊了半天，B 标签页（或另一个窗口）永远停在打开时读到的旧快照，
 * 而且它下一次写盘会把 A 的内容整份盖掉。`storage` 事件只在**其它**文档写入时触发，
 * 自己写不会回环，正好用来做单向同步。
 */
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY) return
    // 保留本页的 open（那是瞬时 UI 状态，不该被别的标签页带着走）
    const incoming = readStorage()
    replace({ ...incoming, open: state.open })
  })
}

export function useAiChat(): AiChatState {
  return useSyncExternalStore(subscribeAiChat, getAiChat, getAiChat)
}

/** 展开/收起对话面板。收起不丢对话。 */
export function setAiChatOpen(open: boolean): void {
  update({ open })
}

export function toggleAiChat(): void {
  update({ open: !state.open })
}

/** 追加一条消息（用户提问或助手回答）。 */
export function appendAiLine(line: Omit<ChatLine, 'at'> & { at?: number }): void {
  const next = [...state.messages, { ...line, at: line.at ?? Date.now() }].slice(-MAX_LINES)
  replace({ ...state, messages: next })
  persist()
}

/**
 * 把"正在思考"的占位气泡换成真正的回答。
 * 用 `pendingIndex` 定位而不是"找最后一条 assistant"—— 并发/重试时后者会换错气泡。
 */
export function resolvePendingAiLine(
  pendingIndex: number,
  line: Omit<ChatLine, 'at'> & { at?: number },
): void {
  const next = [...state.messages]
  if (pendingIndex < 0 || pendingIndex >= next.length) return
  next[pendingIndex] = { ...line, at: line.at ?? Date.now() }
  replace({ ...state, messages: next })
  persist()
}

export function setAiSystemPrompt(systemPrompt: string): void {
  replace({ ...state, systemPrompt })
  persist()
}

export function clearAiChat(): void {
  replace({ ...state, messages: [] })
  persist()
}

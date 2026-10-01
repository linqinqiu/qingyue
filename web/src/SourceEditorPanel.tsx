import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, type SourceRecord, type SourceSummary } from './api'
import { Icon } from './icons'
import { SOURCE_FIELD_GROUPS, type SourceField } from './bookSourceFields'

type Json = Record<string, unknown>

/** 上游 App 的新建书源即一个空 BookSource()：只铺关键字段，规则留空由用户填。 */
export function newSourceDraft(): Json {
  return {
    bookSourceUrl: '',
    bookSourceName: '',
    bookSourceGroup: '',
    bookSourceComment: '',
    bookSourceType: 0,
    enabled: true,
    enabledExplore: true,
    customOrder: 0,
    weight: 0,
    searchUrl: '',
    ruleSearch: { checkKeyWord: '', bookList: '', name: '', bookUrl: '', author: '' },
    ruleExplore: { bookList: '', name: '', bookUrl: '' },
    ruleBookInfo: { name: '', author: '', kind: '', wordCount: '', lastChapter: '', intro: '', coverUrl: '', tocUrl: '' },
    ruleToc: { chapterList: '', chapterName: '', chapterUrl: '' },
    ruleContent: { content: '', nextContentUrl: '' },
  }
}

/** 与服务端 SourceCodec.normalizeSourceUrl 同口径：书源主键是去掉 `#` / `##` 注解后的域名。 */
const declaredSourceId = (json: Json | null) =>
  String(json?.bookSourceUrl ?? '').split('##')[0].split('#')[0].trim()

const isEmpty = (value: unknown) => value === '' || value === null || value === undefined

function fieldValue(json: Json, field: SourceField): unknown {
  if (!field.ns) return json[field.id]
  const scope = json[field.ns]
  return scope && typeof scope === 'object' && !Array.isArray(scope) ? (scope as Json)[field.id] : undefined
}

function withFieldValue(json: Json, field: SourceField, value: unknown): Json {
  const next: Json = { ...json }
  if (!field.ns) {
    if (isEmpty(value)) delete next[field.id]
    else next[field.id] = value
    return next
  }
  const current = json[field.ns]
  const scope: Json = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Json) } : {}
  if (isEmpty(value)) delete scope[field.id]
  else scope[field.id] = value
  if (Object.keys(scope).length) next[field.ns] = scope
  else delete next[field.ns]
  return next
}

const MULTILINE = /^(bookSourceComment|exploreUrl|loginUi|header|jsLib|variableComment)$/
const isMultiline = (field: SourceField) => MULTILINE.test(field.id) || field.id.endsWith('Js')

const SourceFieldRow: React.FC<{
  json: Json
  field: SourceField
  onChange: (field: SourceField, value: unknown) => void
}> = ({ json, field, onChange }) => {
  const raw = fieldValue(json, field)
  const id = `source-field-${field.ns ?? 'root'}-${field.id}`
  const hint = field.hint && <small className="source-field-hint">{field.hint}</small>
  const label = (
    <label className="source-field-label" htmlFor={id}>
      <span>{field.title}</span>
      {field.required && <em className="source-field-required">必填</em>}
      <code>{field.ns ? `${field.ns}.${field.id}` : field.id}</code>
    </label>
  )

  if (field.type === 'Array' && field.array) {
    const index = Number.isFinite(Number(raw)) ? Number(raw) : 0
    return (
      <div className="source-field">
        {label}
        <select id={id} value={index} onChange={e => onChange(field, Number(e.target.value))}>
          {field.array.map((name, i) => <option key={name} value={i}>{name}</option>)}
        </select>
        {hint}
      </div>
    )
  }
  if (field.type === 'Boolean') {
    return (
      <div className="source-field source-field-inline">
        <label className="source-field-switch" htmlFor={id}>
          <input id={id} type="checkbox" checked={raw === true} onChange={e => onChange(field, e.target.checked)} />
          <span>{field.title}</span>
        </label>
        {hint}
      </div>
    )
  }
  const value = isEmpty(raw) ? '' : String(raw)
  const common = {
    id,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(field, e.target.value),
    spellCheck: false as const,
  }
  return (
    <div className="source-field">
      {label}
      {isMultiline(field)
        ? <textarea className="source-field-textarea" rows={3} {...common} />
        : <input className="source-field-input" type={field.type === 'Number' ? 'number' : 'text'} {...common} />}
      {hint}
    </div>
  )
}

const JSON_TAB = '__json__'
const TABS = [...SOURCE_FIELD_GROUPS.map(group => ({ key: group.key, name: group.name })), { key: JSON_TAB, name: 'JSON' }]

export const SourceEditor: React.FC<{
  selected: SourceSummary | null
  /** 新建模式：左侧列表不选中任何书源，编辑器填一份空模板，保存时才落库。 */
  creating: boolean
  summary?: { total: number; enabled: number; js: number; login: number; groups: number }
  onSaved: () => void
  onCreateCancel: () => void
  onCreated: (source: SourceSummary) => void
  onOpenLogin?: (source: SourceSummary) => void
  onOpenDebug?: (source: SourceSummary) => void
}> = ({ selected, creating, summary, onSaved, onCreateCancel, onCreated, onOpenLogin, onOpenDebug }) => {
  const [record, setRecord] = useState<SourceRecord | null>(null)
  const [text, setText] = useState('')
  const [status, setStatus] = useState('')
  const [tab, setTab] = useState(SOURCE_FIELD_GROUPS[0].key)
  const [saving, setSaving] = useState(false)
  const loadedKey = useRef<string | null>(null)
  const skipNextLoad = useRef(false)

  useEffect(() => {
    const key = creating ? '__new__' : selected?.id ?? ''
    // 重复点同一行不该重读：正在编辑的内容会被服务端旧版本盖掉。
    if (key === loadedKey.current) return
    const justCreated = skipNextLoad.current
    skipNextLoad.current = false
    loadedKey.current = key
    setTab(SOURCE_FIELD_GROUPS[0].key)
    // 保存后父组件把新建的书源回选给我们，内容就是刚写回去的那份；重读会顺手抹掉「已保存」。
    if (justCreated) return
    setStatus('')
    if (creating) {
      setRecord(null)
      setText(JSON.stringify(newSourceDraft(), null, 2))
      return
    }
    if (!selected) { setRecord(null); setText(''); return }
    // 响应可能乱序落地：先点 A 再点 B，A 的 JSON 若后到就会填进 B 的编辑器，
    // 用户一按保存就用 A 的规则覆盖了 B（换源即丢一个可用书源）。
    let cancelled = false
    void api.source(selected.id)
      .then(value => { if (!cancelled) { setRecord(value); setText(value.json) } })
      .catch(error => { if (!cancelled) setStatus(error instanceof Error ? error.message : '无法读取书源') })
    return () => { cancelled = true }
  }, [selected, creating])

  const json = useMemo<Json | null>(() => {
    try {
      const parsed: unknown = JSON.parse(text)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : null
    } catch {
      return null
    }
  }, [text])

  const setField = (field: SourceField, value: unknown) => {
    if (!json) return
    setText(JSON.stringify(withFieldValue(json, field, value), null, 2))
  }

  const urlChanged = !creating && !!selected && !!json && declaredSourceId(json) !== selected.id

  const save = async () => {
    const targetId = creating ? declaredSourceId(json) : selected?.id ?? ''
    if (!targetId) { setStatus('请先填写「源域名」'); setTab('base'); return }
    setSaving(true)
    try {
      const next = await api.save(targetId, text, creating ? undefined : record?.version)
      setRecord(next)
      setStatus('已保存')
      onSaved()
      if (creating) {
        skipNextLoad.current = true
        const group = json?.bookSourceGroup
        onCreated({
          id: next.id,
          name: String(json?.bookSourceName ?? '').trim() || next.id,
          url: next.id,
          group: typeof group === 'string' ? group : undefined,
          enabled: json?.enabled !== false,
          isJsSource: typeof json?.mainJs === 'string' && json.mainJs.trim() !== '',
          hasLogin: ['loginUrl', 'loginUi', 'loginCheckJs'].some(key => typeof json?.[key] === 'string' && (json[key] as string).trim() !== ''),
          updatedAt: next.updatedAt,
          version: next.version,
        })
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const validate = async () => {
    try {
      // 送当前编辑内容而不是书源 id：否则校验的是上一次落库的旧版本，改坏了也看不出。
      const result = await api.validate(creating ? declaredSourceId(json) || 'draft' : selected!.id, text)
      setStatus(result.valid ? result.warnings.join('；') || '结构校验通过' : result.errors.join('；'))
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '校验失败')
    }
  }

  if (!selected && !creating) return (
    <section className="source-editor empty-editor">
      <Icon name="book" />
      <h2>选择一个书源</h2>
      <p>从左侧列表挑选书源，新建一条，或导入一个 JSON 文件。</p>
      {summary && (
        <dl className="source-summary">
          <div><dt>书源</dt><dd>{summary.total}</dd></div>
          <div><dt>已启用</dt><dd>{summary.enabled}</dd></div>
          <div><dt>JS 书源</dt><dd>{summary.js}</dd></div>
          <div><dt>支持登录</dt><dd>{summary.login}</dd></div>
          <div><dt>分组</dt><dd>{summary.groups}</dd></div>
        </dl>
      )}
    </section>
  )

  return (
    <section className="source-editor source-editor-form">
      <header>
        <div>
          <span className="section-kicker">{creating ? '新建书源' : '书源编辑'}</span>
          <div className="source-editor-name-row">
            <h2>{creating ? String(json?.bookSourceName || '').trim() || '未命名书源' : selected!.name}</h2>
            {!creating && selected!.hasLogin && <span className="source-login-badge" title="支持登录鉴权">登录</span>}
          </div>
          <small>{creating ? '保存后才会进入书源列表' : selected!.url}</small>
        </div>
        <div className="editor-actions">
          {creating
            ? <button type="button" className="subtle-button" onClick={onCreateCancel}>取消新建</button>
            : selected!.hasLogin && <button type="button" className="subtle-button source-login-entry-btn" onClick={() => onOpenLogin?.(selected!)}>登录</button>
          }
          {!creating && (
            <button
              type="button"
              className="subtle-button"
              title="分阶段调试：真联网跑完整链路 搜索 → 详情 → 目录 → 正文，逐步看每一步拿到了什么。单源、慢、看得细。"
              onClick={() => onOpenDebug?.(selected!)}
            >
              调试
            </button>
          )}
          <button
            type="button"
            className="subtle-button"
            title="结构校验：只判这份 JSON 合不合法、必填字段在不在，不发任何网络请求。侧栏的「体检」才是联网批量轻探测（只看能否搜出条目）；顺序就是先校验、再体检、体检不过再调试。"
            onClick={() => void validate()}
          >
            校验
          </button>
          <button type="button" className="primary-button" disabled={saving || !json} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </header>

      {!json && <div className="source-editor-broken">JSON 无法解析，已切到原文编辑：{text.slice(0, 200)}</div>}
      {urlChanged && (
        <div className="source-editor-broken">
          源域名已从 <code>{selected!.id}</code> 改成 <code>{declaredSourceId(json) || '（空）'}</code>。
          书源以域名为主键，保存会<strong>新增一条书源</strong>，原来那条仍保留 —— 需要换址请保存后删除旧条目。
        </div>
      )}

      <div className="source-form-tabs" role="tablist">
        {TABS.map(item => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={tab === item.key ? 'active' : ''}
            onClick={() => setTab(item.key)}
          >
            {item.name}
          </button>
        ))}
      </div>

      {tab === JSON_TAB || !json ? (
        <textarea className="source-editor-raw" aria-label="书源 JSON 编辑器" value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
      ) : (
        <div className="source-form-fields">
          {SOURCE_FIELD_GROUPS.find(group => group.key === tab)!.fields.map(field => (
            <SourceFieldRow key={`${field.ns ?? 'root'}/${field.id}`} json={json} field={field} onChange={setField} />
          ))}
        </div>
      )}
      {status && <footer className={status.includes('失败') || status.includes('错误') ? 'form-error' : ''}>{status}</footer>}
    </section>
  )
}

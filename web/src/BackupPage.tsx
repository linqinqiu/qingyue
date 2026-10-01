import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, type BackupImportSummary, type KeptBackupEntry } from './api'
import { toast } from './Toast'
import { Icon } from './icons'
import { loadReaderSettings, saveReaderSettings } from './readerSettings'
import { applyPreferencePatch, mapReadStyle, mapTtsEngine } from './backupPreferences'

/**
 * 「备份」页：把 Legado 导出的 zip 选进来就恢复，全程只在本机与这台服务之间传输。
 *
 * 这条路径以前是"先把 zip 放进 WebDAV 存储区，再点导入"，而那个服务只绑回环时手机根本推不上来 ——
 * 等于没有。现在浏览器直接上传，服务端写临时文件、读完即删，包不落盘。
 *
 * 措辞口径（用户 2026-09-30：「手机恢复这个名词解释有些难听，咱们这是电脑啊」）：
 * 主语是**备份包**，不是手机。这台服务跑在电脑上，"读得懂安卓端导出的包"只是它的输入格式。
 */

/** 服务端承接的内容；界面要提前说清楚，而不是导入完让人猜。 */
const RESTORED_SECTIONS: [string, string][] = [
  ['书源', '同名书源按 ID 覆盖规则内容；**已存在的书源保留你本机的启用/停用选择**'],
  ['替换净化规则', '按规则标识覆盖'],
  ['书架与阅读进度', '书架按书合并，进度只在更新时间较新时覆盖'],
  ['RSS 订阅源', '「订阅」页那一栏，按 sourceUrl 合并'],
  ['分组', '包里的组号会换成本机组号（同名只留一个）'],
]

/** 没有原生界面、但已原样收进数据目录的条目，以及它们各自的下落。 */
const KEPT_SECTIONS: [string, string][] = [
  ['阅读样式', '可套用到本机阅读设置（下面「包里收下的条目」里一键套用）'],
  ['朗读引擎', '可套用到本机朗读设置'],
  ['书签', '原样存在服务器数据目录，界面上暂未提供浏览'],
  ['字典规则', '这台服务还没有取词入口，先原样存着'],
  ['TXT 分章规则', '导入本地书时按包里的规则名匹配，未匹配到的原样存着'],
  ['其余条目', '搜索历史、书籍笔记、RSS 收藏、阅读记录 —— 原样存着，界面上暂未提供入口'],
]

export function reportImportSummary(summary: BackupImportSummary) {
  const total = (a?: number, b?: number) => (a ?? 0) + (b ?? 0)
  const skipped = summary.skippedSections ?? []
  const kept = summary.keptSections ?? []
  const books = total(summary.books, summary.booksUpdated)
  const rss = total(summary.rssSources, summary.rssSourcesUpdated)
  if (total(summary.sources, summary.sourcesUpdated) + total(summary.rules, summary.rulesUpdated) + books + rss === 0) {
    toast.warning(skipped.length ? `备份包里没有可导入的内容，已跳过：${skipped.join('、')}` : '备份包里没有可导入的内容')
    return
  }
  toast.success(
    `导入完成：书源 ${total(summary.sources, summary.sourcesUpdated)}（已存在的保留本机启用状态），` +
    `替换规则 ${total(summary.rules, summary.rulesUpdated)}，书籍 ${books}，阅读进度 ${summary.progress}` +
    `${rss ? `，RSS 订阅源 ${rss}` : ''}${summary.bookGroups ? `，分组 ${summary.bookGroups}` : ''}` +
    `${summary.cookies ? `，登录凭据 ${summary.cookies} 条` : ''}`,
  )
  // 凭据只是"这一节没做成"，不是导入失败：单独一句，别和"不承接"混在一起
  if (summary.cookiesNote) toast.warning(summary.cookiesNote)
  if (kept.length) toast.info(`另外原样收下 ${kept.length} 类条目：${kept.map(item => item.label).join('、')}`)
  if (skipped.length) toast.warning(`这些条目连收下的地方都还没有：${skipped.join('、')}`)
  // 单条读坏了以前只停在服务端的 ImportResponse 里，界面上完全看不见 —— 静默丢东西比报错了更难查
  const errors = summary.errors ?? []
  if (errors.length) toast.warning(`${errors.length} 条没读进去：${errors.slice(0, 2).join('；')}${errors.length > 2 ? '…' : ''}`)
}

export function BackupPage() {
  const [backupPassword, setBackupPassword] = useState('')
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [kept, setKept] = useState<KeptBackupEntry[]>([])
  const backupInputRef = useRef<HTMLInputElement>(null)

  const loadKept = useCallback(async () => {
    try { setKept(await api.keptBackupEntries()) } catch { /* 还没导过包时这里本来就是空的，不报错打扰 */ }
  }, [])
  useEffect(() => { void loadKept() }, [loadKept])

  const handleImport = async (file: File) => {
    const warned = window.confirm(
      `导入备份包「${file.name}」？\n` +
      '会写入其中的书源、替换净化规则、书架、阅读进度、RSS 订阅源与分组。' +
      '已存在的书源保留你本机的启用/停用选择，包里的启用位不会把架上筛好的状态刷掉。' +
      '其余个性化条目（书签、阅读样式、朗读引擎等）原样收在服务器数据目录里，不会丢。',
    )
    if (!warned) return
    setBusy(true)
    try {
      // 不传密码也能导入：cookies.json 那节会单独报告没解开，其他内容照常写入。
      const summary = await api.importBackupFile(file, backupPassword.trim())
      reportImportSummary(summary)
      // 只有包内确实有加密凭据、又没填密码时，才提示可以补密码重试 ——
      // 它不是导入的前置条件，以前摆在主操作行上，看着像必填。
      if (summary.cookiesNote && !summary.cookies) setPasswordOpen(true)
      await loadKept()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '备份导入失败')
    } finally {
      setBusy(false)
    }
  }

  const applyKept = async (entry: KeptBackupEntry) => {
    let raw = ''
    try { raw = await api.keptBackupEntry(entry.name) }
    catch (error) { toast.error(error instanceof Error ? error.message : '读不出来'); return }
    const current = loadReaderSettings()
    const result = entry.name.toLowerCase().startsWith('httptts')
      ? mapTtsEngine(raw)
      : mapReadStyle(raw, current)
    if (!result.applied.length) {
      toast.warning(result.notes.join('；') || '这条里没有能映射到本机设置的字段')
      return
    }
    saveReaderSettings(applyPreferencePatch(current, result.patch))
    toast.success(`已套用：${result.applied.join('、')}${result.notes.length ? `（${result.notes.join('；')}）` : ''}`)
  }

  return (
    <main className="backup-page">
      <header className="page-bar">
        <h1>备份包</h1>
        <span className="page-bar-meta">Legado 导出的 zip · 全程只在本机与这台服务之间传输</span>
      </header>

      <section className="backup-panel">
        <div className="backup-actions">
          <input
            ref={backupInputRef}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={event => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void handleImport(file)
            }}
          />
          <button type="button" className="primary-button" onClick={() => backupInputRef.current?.click()} disabled={busy}>
            <Icon name="importFile" />
            <span>{busy ? '导入中…' : '选择备份包导入'}</span>
          </button>
          <button type="button" className="link-button" onClick={() => setPasswordOpen(open => !open)}>
            {passwordOpen ? '收起凭据解密密码' : '需要解开包里的登录凭据？'}
          </button>
        </div>
        {passwordOpen && (
          <div className="backup-password-row">
            <input
              className="backup-password"
              type="password"
              value={backupPassword}
              onChange={event => setBackupPassword(event.target.value)}
              placeholder="凭据解密密码（只用于解开 cookies.json）"
              autoComplete="off"
              aria-label="凭据解密密码"
            />
            <p className="backup-hint">
              只有 <code>cookies.json</code> 需要它 —— 上游把整份凭据做了 AES 加密。
              不填也照样导入其余全部内容，凭据那一节会单独告诉你没解开。密码只在本次请求内存里用一次，不写日志。
            </p>
          </div>
        )}
        <p className="backup-hint">服务端把包写到临时文件、读完即删，包本身不会留在磁盘上。</p>
      </section>

      <section className="backup-panel">
        <h2>这个包会恢复什么</h2>
        <dl className="backup-scope">
          {RESTORED_SECTIONS.map(([name, detail]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{detail.replace(/\*\*(.+?)\*\*/g, '$1')}</dd>
            </div>
          ))}
          {KEPT_SECTIONS.map(([name, detail]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{detail}</dd>
            </div>
          ))}
        </dl>
      </section>

      {kept.length > 0 && (
        <section className="backup-panel">
          <h2>包里收下的其余条目</h2>
          <p className="backup-hint">
            这些条目这台服务还没有自己的界面去用它们，所以是原样收在数据目录里而不是丢掉；
            其中阅读样式与朗读引擎可以直接套到本机设置上。
          </p>
          <ul className="backup-kept-list">
            {kept.map(entry => (
              <li key={entry.name}>
                <span className="backup-kept-label">{entry.label}</span>
                <span className="backup-kept-meta">
                  {entry.items > 0 ? `${entry.items} 条 · ` : ''}{Math.max(1, Math.round(entry.bytes / 1024))} KB
                </span>
                {entry.appliable && (
                  <button type="button" className="subtle-button" onClick={() => void applyKept(entry)}>套用</button>
                )}
                <a className="subtle-button backup-kept-download" href={api.keptBackupEntryUrl(entry.name)} download={entry.name}>下载</a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}

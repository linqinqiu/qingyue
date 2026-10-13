import { Icon } from '../icons'
import { ReaderMenuAction } from './readerMenu'
import { TtsPlayState } from './ttsEngine'

/**
 * MD3 阅读外壳（PROPOSAL-020 P1）：顶栏 + 底栏，参照 legado-with-MD3 的阅读界面。
 *
 * 与旧 `ReaderHeader` 并列、由 `reader-ui-v2` 开关切换（默认走旧界面）。只换摆放与观感，
 * 功能一律复用现有回调，不新增能力。底栏进度条本阶段按**章节**走（真实页码进度见 P2）。
 */

type ActionProps = {
  isFullscreen: boolean
  mediaDisabled: boolean
  ttsActive: boolean
  ttsPlayState: TtsPlayState
  onOpenSourceSwitch: () => void
  onToggleSettings: () => void
  onToggleFullscreen: () => void
  onToggleTts: () => void
  onResetTtsBar: () => void
}

/** 顶栏右侧那排可配置动作（与旧工具栏同源 `settings.menuItems`）。 */
function TopAction({ id, ...props }: { id: ReaderMenuAction } & ActionProps) {
  const { mediaDisabled, ttsActive, ttsPlayState, isFullscreen } = props
  switch (id) {
    case 'switchSource':
      return <button className="md3-icon-btn" aria-label="切换书源" title="切换书源" onClick={props.onOpenSourceSwitch}><Icon name="sliders" /></button>
    case 'settings':
      return <button className="md3-icon-btn" aria-label="阅读设置" title="阅读设置" onClick={props.onToggleSettings}><Icon name="settings" /></button>
    case 'fullscreen':
      return <button className="md3-icon-btn" aria-label={isFullscreen ? '退出全屏' : '全屏阅读'} title={isFullscreen ? '退出全屏' : '全屏阅读'} onClick={props.onToggleFullscreen}><Icon name="expand" /></button>
    case 'tts':
      return <button
        className={`md3-icon-btn${ttsActive && ttsPlayState === 'playing' ? ' is-active' : ''}`}
        aria-label={mediaDisabled ? '本类型不支持朗读' : !ttsActive ? '朗读本章' : ttsPlayState === 'playing' ? '暂停朗读' : '继续朗读'}
        title={mediaDisabled ? '本类型不支持朗读' : '朗读（双击把朗读条放回默认位置）'}
        onClick={props.onToggleTts}
        onDoubleClick={props.onResetTtsBar}
        disabled={mediaDisabled}
      ><Icon name={ttsActive && ttsPlayState === 'playing' ? 'pause' : 'volume2'} /></button>
    default:
      return null
  }
}

export function Md3TopBar({ bookName, chapterTitle, menuItems, onBack, onToggleToc, ...action }: {
  bookName: string
  chapterTitle: string | null
  menuItems: ReaderMenuAction[]
  onBack: () => void
  onToggleToc: () => void
} & ActionProps) {
  return <header className="md3-topbar" data-testid="reader-header">
    <div className="md3-topbar-side">
      <button className="md3-icon-btn" aria-label="返回书架" title="返回书架" onClick={onBack}><Icon name="arrowLeft" /></button>
      <button className="md3-icon-btn" aria-label="目录" title="目录" onClick={onToggleToc}><Icon name="list" /></button>
    </div>
    <div className="md3-topbar-title">
      <strong data-testid="reader-chapter-title">{chapterTitle || bookName}</strong>
      <small>{bookName}</small>
    </div>
    <div className="md3-topbar-side md3-topbar-actions">
      {menuItems.map(id => <TopAction key={id} id={id} {...action} />)}
    </div>
  </header>
}

export function Md3BottomBar({ chapterIndex, totalChapters, chapterTitle, notesCount, ttsActive, onSeekChapter, onPrev, onNext, onToggleToc, onToggleNotes, onToggleTts, onToggleSettings }: {
  chapterIndex: number
  totalChapters: number
  chapterTitle: string | null
  notesCount: number
  ttsActive: boolean
  onSeekChapter: (index: number) => void
  onPrev: () => void
  onNext: () => void
  onToggleToc: () => void
  onToggleNotes: () => void
  onToggleTts: () => void
  onToggleSettings: () => void
}) {
  const max = Math.max(0, totalChapters - 1)
  const atStart = chapterIndex <= 0
  const atEnd = chapterIndex >= max
  return <footer className="md3-bottombar" data-testid="reader-bottombar">
    <div className="md3-progress-row">
      <button className="md3-icon-btn" aria-label="上一章" title="上一章" disabled={atStart} onClick={onPrev}><Icon name="skipBack" /></button>
      <div className="md3-progress">
        <div className="md3-progress-meta">
          <span className="md3-progress-chapter">{chapterTitle || '—'}</span>
          <span className="md3-progress-count">{chapterIndex + 1} / {totalChapters}</span>
        </div>
        <input
          type="range"
          aria-label="阅读进度"
          min={0}
          max={max || 1}
          value={chapterIndex}
          onChange={event => onSeekChapter(Number(event.target.value))}
        />
      </div>
      <button className="md3-icon-btn" aria-label="下一章" title="下一章" disabled={atEnd} onClick={onNext}><Icon name="skipForward" /></button>
    </div>
    <div className="md3-actions-row">
      <button className="md3-pill" aria-label="目录" onClick={onToggleToc}><Icon name="list" /><span>目录</span></button>
      <button className="md3-pill" aria-label={`笔记（${notesCount}）`} onClick={onToggleNotes}><Icon name="bookmark" /><span>笔记{notesCount > 0 ? ` ${notesCount}` : ''}</span></button>
      <button className={`md3-pill${ttsActive ? ' is-active' : ''}`} aria-label="朗读" onClick={onToggleTts}><Icon name="volume2" /><span>朗读</span></button>
      <button className="md3-pill" aria-label="阅读设置" onClick={onToggleSettings}><Icon name="sliders" /><span>界面</span></button>
    </div>
  </footer>
}

/**
 * 非文本章节的渲染：音频播放器 / 视频播放器 / 文件下载（`mediaSrc` 为空时返回 null）。
 *
 * 从 `ReaderScreen` 抽出来（PROPOSAL-019 F）：只跟媒体地址与书源类型打交道 ——
 * 音频放完自动进下一章由调用方通过 `onEnded` 决定，组件本身不碰翻页状态。
 */
export function MediaBlock({ mediaSrc, sourceType, onEnded }: {
  mediaSrc: string | null
  sourceType: number
  onEnded: () => void
}) {
  if (!mediaSrc) return null
  if (sourceType === 1) {
    return (
      <div className="reader-media" data-media-type="audio">
        <audio src={mediaSrc} controls autoPlay onEnded={onEnded} />
      </div>
    )
  }
  if (sourceType === 4) {
    return (
      <div className="reader-media" data-media-type="video">
        <video src={mediaSrc} controls />
      </div>
    )
  }
  return (
    <div className="reader-media" data-media-type="file">
      <a className="reader-media-download" href={mediaSrc} target="_blank" rel="noreferrer" download>下载文件</a>
    </div>
  )
}

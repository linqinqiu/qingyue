import React from 'react'
import { RssPanel } from './RssPanel'

/**
 * 「订阅」这一页只装 RSS 源（上游 `RssSource`：要**读**的文章源）。
 *
 * 书源订阅（远程书源 JSON 直链，上游 `RuleSub`）不在这 —— 它同步进来的产物是书源，
 * 所以长在「书源」页里（`sources/SourceSubscriptionPanel.tsx`）。
 * 以前两件事焊在同一页的两个页签里，「订阅」同时指两个数据模型，
 * 页签上还得各挂一个条数，为的就是让用户分清"我这条到底在哪张"。
 */
export function RssPage({ onOpenBackup }: { onOpenBackup: () => void }) {
  return (
    <main className="rss-page">
      <header className="page-title">
        <div>
          <h1>订阅</h1>
          <p>读文章类的订阅源（RSS）：一条源是一个站点或一个栏目，点进去看它的条目。导入手机备份包后源会出现在这里。书源订阅（同步远程书源 JSON）在「书源」页。</p>
        </div>
      </header>
      <RssPanel onOpenBackup={onOpenBackup} />
    </main>
  )
}

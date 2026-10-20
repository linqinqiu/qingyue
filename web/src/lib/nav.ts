// 顶层导航的共享类型（0.8.2 结构重排从 main.tsx 挪出）

export type Page = 'sources' | 'subscriptions' | 'library' | 'shelf' | 'explore' | 'reader' | 'settings'
/** 不占导航栏、也不占整页的目的地（0.6.27 起全部悬浮化）：规则 / 备份 / 更新日志 / 关于 */
export type PageDialogKind = 'rules' | 'backup' | 'about' | 'reading-log'

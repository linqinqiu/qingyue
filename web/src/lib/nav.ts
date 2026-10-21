// 顶层导航的共享类型（0.8.2 结构重排从 main.tsx 挪出）

export type Page = 'sources' | 'subscriptions' | 'library' | 'shelf' | 'explore' | 'reader' | 'settings'
/** 不占导航栏、也不占整页的目的地。0.8.3 起只剩「替换净化规则」——
 * 备份 / 更新日志 / 关于 / 阅读记录 都下沉成插件（住实验室里）了。 */
export type PageDialogKind = 'rules'
/** 同一时刻只开一个的单例弹窗。加新弹窗往这里加一个字面量，不必再加一个 useState。 */
export type AppModal = 'offline-cache' | 'logs' | 'shortcuts' | 'customize' | 'server-port'

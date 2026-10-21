/**
 * 主壳能直达的实验室条目 id。
 *
 * 主壳（顶栏、设置页、深链）不该散落一地字符串字面量：这里收成一份表，
 * 新增一个「宿主直达」的条目只改这里。
 *
 * 注意：这只是**主壳知道的入口**，不是实验室条目清单 ——
 * 条目由功能（`features/`）与插件（`plugins/`）各自贡献，主壳不枚举它们。
 */
export const LAB_ENTRY = {
  ai: 'ai',
  changelog: 'changelog',
  about: 'about',
  readingLog: 'reading-log',
  backup: 'backup',
} as const

export type LabEntryId = typeof LAB_ENTRY[keyof typeof LAB_ENTRY]

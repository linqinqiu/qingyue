import type { LabEntry } from '../lab/Lab'
import { aiLabEntry } from './ai/labEntry'

/**
 * 随程序发布的功能型实验条目。
 *
 * 这些不是插件：它们和主程序同版本、同发布节奏，只是还没定稿到值得占一级导航。
 * 插件贡献的条目在 `plugins/`，由装配点合并到同一张清单里。
 *
 * 顺序 = 实验室里的显示顺序。功能条目排在插件前面。
 */
export const featureLabEntries: LabEntry[] = [aiLabEntry]

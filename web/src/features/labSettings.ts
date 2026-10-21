import type { PluginSettingsSection } from '../extensions/registry'
import { windowPrefsSection } from './lab/windowPrefsPanel'

/**
 * 实验室**自带**功能贡献的设置分区。
 *
 * 与 `labEntries.ts` 同一个分类逻辑：这些是产品决定要有的（随程序发布、用户卸不掉），
 * 不是插件。插件贡献的分区由 `frontendPlugins.settingsSections()` 单独给。
 *
 * 为什么要分开：设置页末尾原来只挂插件分区，导致"产品自带的配置项"没有地方放 ——
 * 「界面偏好」就被塞进了一个插件壳子里，身份是错的。
 */
export const labOwnedSettingsSections: PluginSettingsSection[] = [windowPrefsSection]

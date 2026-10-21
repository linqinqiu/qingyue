import type { PluginSettingsSection } from '../extensions/registry'
import { windowPrefsSection } from './settings/windowPrefsPanel'

/**
 * **产品自带**功能贡献的设置分区。
 *
 * 与插件贡献的分区（`frontendPlugins.settingsSections()`）是两条路：
 * 这里的随程序发布、用户卸不掉；插件那份是可装可卸的。
 *
 * 从前设置页末尾只挂插件分区，导致产品自带的配置项没有地方放 ——
 * 「界面偏好」被塞进一个插件壳子里，身份是错的。
 */
export const builtinSettingsSections: PluginSettingsSection[] = [windowPrefsSection]

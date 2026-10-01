/**
 * 选源控件的排序与筛选。
 *
 * 用户 2026-09-30：「指定书源-选择书源功能不能正常使用」。真实原因不是点不动，
 * 而是这台库里 5,574 个源只有 690 个启用，下拉却按名字把停用的也全塞进来 ——
 * 选到一个停用源后搜索必然空，看上去就像"功能坏了"。
 * 所以默认只给启用中的，并且把分组当副标题带上；要挑停用的源再显式勾选。
 */
export type PickableSource = { id: string; name: string; enabled: boolean; group?: string | null }
export type SourcePickerOption = { value: string; label: string; hint?: string }

const byName = (a: PickableSource, b: PickableSource) => a.name.localeCompare(b.name, 'zh-Hans-CN')

export function sourcePickerOptions(sources: PickableSource[], includeDisabled = false): SourcePickerOption[] {
  const enabled = sources.filter(source => source.enabled).sort(byName)
  const disabled = includeDisabled ? sources.filter(source => !source.enabled).sort(byName) : []
  return [...enabled, ...disabled].map(source => ({
    value: source.id,
    label: source.name,
    hint: source.enabled ? (source.group?.trim() || undefined) : '已停用，搜不到',
  }))
}

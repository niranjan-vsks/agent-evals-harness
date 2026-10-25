// Descriptive config diff for the comparison screen (DESIGN.md section 1): the UI states which of harness, model and
// settings differ between the 2 configs. It names the axis only when exactly 1 group differs. Display only: no statistic.
import type { Config } from '../api/types';

export type AxisGroup = 'harness' | 'model' | 'settings';

export interface AxisDescription {
  groups: AxisGroup[];
  /** Dotted paths of the settings leaves that differ, sorted, e.g. "memory.mode". Empty unless settings differ. */
  settingPaths: string[];
  /** True when exactly 1 group differs, so a difference can be attributed to that group alone. */
  attributable: boolean;
  text: string;
}

/** Every leaf of a settings object as dotted path -> JSON text. Arrays are leaves; an empty object has no leaves. */
function leaves(value: unknown, path: string, out: Map<string, string>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) leaves(child, path ? `${path}.${key}` : key, out);
    return;
  }
  out.set(path, JSON.stringify(value) ?? 'undefined');
}

function differingSettingPaths(a: Config['settings'], b: Config['settings']): string[] {
  const la = new Map<string, string>();
  const lb = new Map<string, string>();
  leaves(a, '', la);
  leaves(b, '', lb);
  const paths = new Set<string>([...la.keys(), ...lb.keys()]);
  return [...paths].filter((p) => la.get(p) !== lb.get(p)).sort();
}

export function describeAxis(a: Config, b: Config): AxisDescription {
  const harnessFields: string[] = [];
  if (a.harness_id !== b.harness_id) harnessFields.push('harness_id');
  if (a.harness_version !== b.harness_version) harnessFields.push('harness_version');
  const settingPaths = differingSettingPaths(a.settings, b.settings);

  const groups: AxisGroup[] = [];
  if (harnessFields.length > 0) groups.push('harness');
  if (a.model_id !== b.model_id) groups.push('model');
  if (settingPaths.length > 0) groups.push('settings');

  if (groups.length === 0) {
    return { groups, settingPaths, attributable: false, text: 'the 2 configs are identical in harness, model and settings' };
  }
  if (groups.length >= 2) {
    return { groups, settingPaths, attributable: false, text: 'multiple axes differ: not attributable' };
  }
  const group = groups[0];
  const detail = group === 'harness' ? harnessFields : group === 'model' ? ['model_id'] : settingPaths;
  return { groups, settingPaths, attributable: true, text: `differs in ${group} only (${detail.join(', ')})` };
}

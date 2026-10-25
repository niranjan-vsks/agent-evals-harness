import { describe, expect, it } from 'vitest';
import { makeConfig, memoryOff, memorySeeded } from '../../views/__tests__/fixtures/compare';
import { describeAxis } from '../axis';

describe('describeAxis', () => {
  it('memory off vs seeded differs in settings only and lists the memory leaf paths', () => {
    const d = describeAxis(memoryOff(), memorySeeded());
    expect(d.groups).toEqual(['settings']);
    expect(d.settingPaths).toEqual(['memory.fixture', 'memory.fixture_hash', 'memory.mode']);
    expect(d.attributable).toBe(true);
    expect(d.text).toBe('differs in settings only (memory.fixture, memory.fixture_hash, memory.mode)');
  });

  it('a model change differs in model only and has no setting paths', () => {
    const d = describeAxis(memoryOff(), makeConfig({ model_id: 'model-c', model_slug: 'other/model' }));
    expect(d.groups).toEqual(['model']);
    expect(d.settingPaths).toEqual([]);
    expect(d.attributable).toBe(true);
    expect(d.text).toBe('differs in model only (model_id)');
  });

  it('a harness version change differs in harness only', () => {
    const d = describeAxis(memoryOff(), makeConfig({ harness_version: '0000000000' }));
    expect(d.groups).toEqual(['harness']);
    expect(d.text).toBe('differs in harness only (harness_version)');
  });

  it('a harness id change and a model change together are not attributable', () => {
    const d = describeAxis(memoryOff(), makeConfig({ harness_id: 'minimal_loop', model_id: 'model-c' }));
    expect(d.groups).toEqual(['harness', 'model']);
    expect(d.attributable).toBe(false);
    expect(d.text).toBe('multiple axes differ: not attributable');
  });

  it('a settings change plus a model change is not attributable', () => {
    const d = describeAxis(memorySeeded(), makeConfig({ model_id: 'model-c' }));
    expect(d.groups).toEqual(['model', 'settings']);
    expect(d.text).toBe('multiple axes differ: not attributable');
    expect(d.settingPaths).toContain('memory.mode');
  });

  it('identical configs differ in nothing', () => {
    const d = describeAxis(memoryOff(), memoryOff());
    expect(d.groups).toEqual([]);
    expect(d.settingPaths).toEqual([]);
    expect(d.attributable).toBe(false);
    expect(d.text).toBe('the 2 configs are identical in harness, model and settings');
  });

  it('names and ids do not count as a difference', () => {
    const d = describeAxis(memoryOff(), makeConfig({ id: 'other-id', name: 'other name', config_hash: 'zzz' }));
    expect(d.groups).toEqual([]);
  });

  it('compares array and nested leaves by value, with dotted paths', () => {
    const d = describeAxis(
      memoryOff(),
      makeConfig({}, { max_steps: 30, tools: ['files'], harness_options: { providers_ignored: ['Darkbloom'], extra: 1 } }),
    );
    expect(d.groups).toEqual(['settings']);
    expect(d.settingPaths).toEqual(['harness_options.extra', 'harness_options.providers_ignored', 'max_steps', 'tools']);
  });

  it('lists a changed temperature as the only setting path', () => {
    const d = describeAxis(memoryOff(), makeConfig({}, { skills: { enabled: false, preload: [] }, temperature: 0.7 }));
    expect(d.settingPaths).toEqual(['temperature']);
  });
});

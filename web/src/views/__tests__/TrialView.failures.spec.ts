import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { api } from '../../api/client';
import type { FailureEvidence, Trace, Trial } from '../../api/types';
import { routes } from '../../router';
import TrialView from '../TrialView.vue';
import { TRIAL_ID, exactMatchPass, makeExperiment, makeFullTrace, makeTrial, manyEvents } from './fixtures/trial';

// The failure category (P6) on the trial page. The category and its evidence come from the API; these tests cover what the page does
// with them: show them, and make the evidence link land on the event or grader the rule used.

afterEach(() => {
  vi.restoreAllMocks();
});

async function mountView(trial: Trial, trace: Trace = makeFullTrace()): Promise<VueWrapper> {
  vi.spyOn(api, 'getTrial').mockResolvedValue(trial);
  vi.spyOn(api, 'getTrace').mockResolvedValue(trace);
  vi.spyOn(api, 'getExperiment').mockResolvedValue(makeExperiment());
  vi.spyOn(api, 'listTasks').mockResolvedValue([]);
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(`/trials/${TRIAL_ID}`);
  await router.isReady();
  const w = mount(TrialView, { props: { id: TRIAL_ID }, global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return w;
}

const sec = (w: VueWrapper, name: string) => w.find(`[data-test="${name}"]`);
const row = (w: VueWrapper, seq: number) => w.find(`li.ev[data-seq="${seq}"]`);
const focused = (w: VueWrapper) => w.findAll('li.ev[data-focused="true"]').map((r) => r.attributes('data-seq'));

const evidence = (over: Partial<FailureEvidence>): FailureEvidence => ({
  rule: 5,
  category: 'tool_error_unrecovered',
  detail: 'the last tool result (event 8) is an error and nothing followed it',
  ...over,
});
const failed = (cat: Trial['failure_category'], ev: FailureEvidence | null): Trial => makeTrial({ failure_category: cat, failure_evidence: ev });

describe('TrialView failure category', () => {
  it('shows the category, its rule and the evidence sentence at the top of "Why it failed"', async () => {
    const w = await mountView(failed('tool_error_unrecovered', evidence({ event_seq: 8 })));
    const box = sec(w, 'failure-category');
    expect(box.find('[data-test="failure-category-name"]').text()).toBe('tool_error_unrecovered');
    expect(box.find('[data-test="failure-rule"]').text()).toContain('rule 5');
    expect(box.find('[data-test="failure-detail"]').text()).toBe('the last tool result (event 8) is an error and nothing followed it');
    const why = sec(w, 'why');
    expect(why.element.contains(box.element)).toBe(true);
    expect(why.find('h2').element.compareDocumentPosition(box.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the event link expands, outlines and scrolls to the event with that seq, and no other', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll as never;
    const w = await mountView(failed('tool_error_unrecovered', evidence({ event_seq: 8 })));
    expect(row(w, 8).find('.ev-body').exists()).toBe(false);
    await sec(w, 'failure-evidence').find('[data-test="evidence-event"]').trigger('click');
    await flushPromises();
    expect(row(w, 8).find('button.ev-head').attributes('aria-expanded')).toBe('true');
    expect(focused(w)).toEqual(['8']);
    expect(row(w, 8).text()).toContain('exit 1 no matches');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(row(w, 8).element);
  });

  it('shows a hidden event: the link turns its kind filter back on', async () => {
    Element.prototype.scrollIntoView = vi.fn() as never;
    const w = await mountView(failed('tool_error_unrecovered', evidence({ event_seq: 8 })));
    await w.get('[data-kind-filter="tool_result"]').setValue(false);
    expect(row(w, 8).exists()).toBe(false);
    await sec(w, 'failure-evidence').find('[data-test="evidence-event"]').trigger('click');
    await flushPromises();
    expect(row(w, 8).exists()).toBe(true);
    expect(focused(w)).toEqual(['8']);
  });

  it('pages the 200-row window onto the event in a long trace', async () => {
    Element.prototype.scrollIntoView = vi.fn() as never;
    const w = await mountView(failed('wrong_answer', evidence({ rule: 10, category: 'wrong_answer', event_seq: 1001 })), makeFullTrace({ events: manyEvents(1200) }));
    expect(row(w, 1001).exists()).toBe(false);
    await sec(w, 'failure-evidence').find('[data-test="evidence-event"]').trigger('click');
    await flushPromises();
    expect(sec(w, 'timeline').find('[data-test="window-text"]').text()).toBe('events 1001-1200 of 1200');
    expect(focused(w)).toEqual(['1001']);
    expect(row(w, 1001).find('button.ev-head').attributes('aria-expanded')).toBe('true');
  });

  it('rule 3 offers both events: the failed result and the call that repeated it', async () => {
    Element.prototype.scrollIntoView = vi.fn() as never;
    const ev = evidence({ rule: 3, category: 'hallucinated_tool_args', detail: 'shell failed with an argument error (event 8) and the next turn sent the same call again (event 7)', event_seq: 8, related_event_seq: 7 });
    const w = await mountView(failed('hallucinated_tool_args', ev));
    await sec(w, 'failure-evidence').find('[data-test="evidence-related-event"]').trigger('click');
    await flushPromises();
    expect(focused(w)).toEqual(['7']);
    await sec(w, 'failure-evidence').find('[data-test="evidence-event"]').trigger('click');
    await flushPromises();
    expect(focused(w)).toEqual(['8']);
  });

  it('a grader link scrolls to that grader result', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll as never;
    const ev = evidence({ rule: 4, category: 'wrong_tool_usage', detail: 'trace_check tool_called failed', grader_index: 0, assertion_index: 0 });
    const w = await mountView(failed('wrong_tool_usage', ev));
    expect(sec(w, 'failure-evidence').find('[data-test="evidence-event"]').exists()).toBe(false);
    await sec(w, 'failure-evidence').find('[data-test="evidence-grader"]').trigger('click');
    await flushPromises();
    expect(scroll.mock.contexts[0]).toBe(w.get('[data-grader-index="0"]').element);
  });

  it('says so when the evidence names an event the loaded trace does not have', async () => {
    const w = await mountView(failed('tool_error_unrecovered', evidence({ event_seq: 999 })));
    expect(sec(w, 'failure-evidence').find('[data-test="evidence-event"]').exists()).toBe(false);
    expect(sec(w, 'failure-evidence').find('[data-test="evidence-event-missing"]').text()).toContain('event #999');
  });

  it('a category with no evidence link (step_exhaustion) shows no link row', async () => {
    const w = await mountView(failed('step_exhaustion', { rule: 1, category: 'step_exhaustion', detail: 'exit_reason is max_steps (15 steps)' }));
    expect(sec(w, 'failure-category').exists()).toBe(true);
    expect(sec(w, 'failure-evidence').exists()).toBe(false);
  });

  it('a failed trial without a stored category says to run the backfill; a passed trial shows no failure section', async () => {
    const w = await mountView(failed(null, null));
    expect(sec(w, 'failure-category').exists()).toBe(false);
    expect(sec(w, 'failure-category-none').text()).toContain('npm run failures:backfill');
    const passed = await mountView(makeTrial({ passed: true, failure_category: null, failure_evidence: null, grader_results: [exactMatchPass()] }));
    expect(sec(passed, 'why').exists()).toBe(false);
  });
});

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { api } from '../../api/client';
import type { ComparePayload } from '../../api/types';
import { routes } from '../../router';
import CompareView from '../CompareView.vue';
import { failures, makeCompare, makeExperiment, memoryOff, memorySeeded, perTask, realP3Payload } from './fixtures/compare';

// The failure categories (P6) on the comparison screen. The counts come from the payload; the page only lists them.

const EXP = '01EXPERIMENT0000000000000A';

afterEach(() => {
  vi.restoreAllMocks();
});

async function mountView(payload: ComparePayload): Promise<VueWrapper> {
  vi.spyOn(api, 'getExperiment').mockResolvedValue(makeExperiment());
  vi.spyOn(api, 'compare').mockResolvedValue(payload);
  vi.spyOn(api, 'listConfigs').mockResolvedValue([memoryOff(), memorySeeded()]);
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(`/experiments/${EXP}/compare`);
  await router.isReady();
  const wrapper = mount(CompareView, { props: { id: EXP }, global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return wrapper;
}

const tid = (w: VueWrapper, id: string): string => w.get(`[data-testid="${id}"]`).text().replace(/\s+/g, ' ');
const follows = (first: Element, second: Element): boolean => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

const RULE_ORDER = [
  'step_exhaustion',
  'timeout',
  'hallucinated_tool_args',
  'wrong_tool_usage',
  'tool_error_unrecovered',
  'no_final_answer',
  'gave_up_early',
  'judge_criteria_unmet',
  'grader_disagreement',
  'memory_ignored',
  'abstained',
  'wrong_answer',
];

describe('CompareView failure categories', () => {
  it('lists the 12 categories in rule order with the counts of A and B and a total row', async () => {
    const w = await mountView(makeCompare({ failures: failures({ step_exhaustion: 3, wrong_answer: 2 }, { memory_ignored: 1, wrong_answer: 4 }) }));
    const table = w.get('[data-testid="failures-table"]');
    expect(table.findAll('tbody tr').map((r) => r.attributes('data-testid'))).toEqual([...RULE_ORDER.map((k) => `failure-row-${k}`), 'failure-row-total']);
    expect(tid(w, 'failure-a-count-step_exhaustion')).toBe('3');
    expect(tid(w, 'failure-b-count-step_exhaustion')).toBe('0');
    expect(tid(w, 'failure-a-count-wrong_answer')).toBe('2');
    expect(tid(w, 'failure-b-count-wrong_answer')).toBe('4');
    expect(tid(w, 'failure-b-count-memory_ignored')).toBe('1');
    expect(tid(w, 'failure-total-a')).toBe('5');
    expect(tid(w, 'failure-total-b')).toBe('5');
    expect(table.text()).toContain('A: config alpha');
    expect(table.text()).toContain('B: config beta');
  });

  it('comes after the per-task table and carries no interval', async () => {
    const w = await mountView(makeCompare({ failures: failures({ wrong_answer: 1 }) }));
    expect(follows(w.get('[data-testid="per-task-table"]').element, w.get('[data-testid="failures-table"]').element)).toBe(true);
    expect(tid(w, 'failures-caption')).toContain('has no interval');
  });

  it('shows 0 for every category when nothing failed', async () => {
    const w = await mountView(makeCompare({ failures: failures() }));
    for (const k of RULE_ORDER) {
      expect(tid(w, `failure-a-count-${k}`)).toBe('0');
      expect(tid(w, `failure-b-count-${k}`)).toBe('0');
    }
    expect(tid(w, 'failure-total-a')).toBe('0');
  });

  it('adds an uncategorized row, counted in the total, with a backfill hint, only when the API reports some', async () => {
    const none = await mountView(makeCompare({ failures: failures({ wrong_answer: 1 }) }));
    expect(none.find('[data-testid="failure-row-uncategorized"]').exists()).toBe(false);
    expect(none.find('[data-testid="failures-uncategorized"]').exists()).toBe(false);
    const some = await mountView(makeCompare({ failures: failures({ wrong_answer: 1 }, {}, { a: 2, b: 3 }) }));
    expect(some.get('[data-testid="failure-row-uncategorized"]').findAll('td').slice(0, 3).map((c) => c.text())).toEqual(['uncategorized', '2', '3']);
    expect(tid(some, 'failures-uncategorized')).toContain('npm run failures:backfill');
    expect(tid(some, 'failure-total-a')).toBe('3');
    expect(tid(some, 'failure-total-b')).toBe('3');
  });

  it('shows the commonest category of each side in the per-task rows, and a dash when there is none', async () => {
    const w = await mountView(
      makeCompare({
        per_task: [
          perTask({ task_id: 'mem-01', failure_category_a: 'step_exhaustion', failure_category_b: null }),
          perTask({ task_id: 'det-01', failure_category_a: null, failure_category_b: 'wrong_tool_usage' }),
        ],
      }),
    );
    expect(tid(w, 'failure-a-mem-01')).toBe('step_exhaustion');
    expect(tid(w, 'failure-b-mem-01')).toBe('-');
    expect(tid(w, 'failure-a-det-01')).toBe('-');
    expect(tid(w, 'failure-b-det-01')).toBe('wrong_tool_usage');
  });

  it('shows the categories of a judge-excluded task in its own table too', async () => {
    const rows = [perTask({ task_id: 'jdg-out', category: 'neutral_judged', judge_excluded: true, failure_category_a: 'grader_disagreement', failure_category_b: null })];
    const w = await mountView(makeCompare({ per_task: rows, judge_policy_applied: 'excluded', judge_excluded_tasks: ['jdg-out'] }));
    expect(tid(w, 'excluded-row-jdg-out')).toContain('grader_disagreement');
  });

  it('renders the P3 payload with its synthetic failure block', async () => {
    const w = await mountView(realP3Payload);
    expect(tid(w, 'failure-a-count-wrong_answer')).toBe('2');
    expect(tid(w, 'failure-a-mem-01-staging-db')).toBe('wrong_answer');
  });
});

import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ApiError, api } from '../../api/client';
import type { ExperimentDetail, Task, Trace, TraceEvent, Trial } from '../../api/types';
import { routes } from '../../router';
import TrialView from '../TrialView.vue';
import {
  EXP_ID,
  FINAL_RESPONSE,
  JUDGE_REASONING,
  SYSTEM_PROMPT,
  TRIAL_ID,
  USER_PROMPT,
  exactMatchFail,
  exactMatchNoResponse,
  exactMatchPass,
  fileStateFail,
  llmJudgeFail,
  makeEvents,
  makeExperiment,
  makeFullTrace,
  makePartialTrace,
  makeTask,
  makeTrial,
  manyEvents,
  traceCheckFail,
  unitTestFail,
} from './fixtures/trial';

afterEach(() => {
  vi.restoreAllMocks();
});

interface Setup {
  trial?: Trial | Error;
  trace?: Trace | Error;
  experiment?: ExperimentDetail | Error;
  tasks?: Task[] | Error;
}

const settle = <T>(v: T | Error): Promise<T> => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));

async function mountView(s: Setup = {}): Promise<{ w: VueWrapper; listTasks: ReturnType<typeof vi.spyOn> }> {
  vi.spyOn(api, 'getTrial').mockImplementation(() => settle(s.trial ?? makeTrial()));
  vi.spyOn(api, 'getTrace').mockImplementation(() => settle(s.trace ?? makeFullTrace()));
  vi.spyOn(api, 'getExperiment').mockImplementation(() => settle(s.experiment ?? makeExperiment()));
  const listTasks = vi.spyOn(api, 'listTasks').mockImplementation(() => settle(s.tasks ?? []));
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(`/trials/${TRIAL_ID}`);
  await router.isReady();
  const w = mount(TrialView, { props: { id: TRIAL_ID }, global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return { w, listTasks };
}

const sec = (w: VueWrapper, name: string) => w.find(`[data-test="${name}"]`);
const rows = (w: VueWrapper) => w.findAll('li.ev');
const row = (w: VueWrapper, seq: number) => w.find(`li.ev[data-seq="${seq}"]`);
const clickRow = async (w: VueWrapper, seq: number) => {
  await row(w, seq).find('button.ev-head').trigger('click');
};

describe('TrialView header', () => {
  it('shows FAIL, the exit reason and the step count in the first section', async () => {
    const { w } = await mountView();
    const header = sec(w, 'header');
    expect(header.find('[data-test="verdict"]').text()).toBe('FAIL');
    expect(header.find('[data-test="verdict"]').classes()).toContain('fail');
    expect(header.find('[data-test="exit-reason"]').text()).toBe('max_steps');
    expect(header.find('[data-test="steps"]').text()).toBe('15');
    expect(header.text()).toContain(TRIAL_ID);
    expect(header.text()).toContain('mem-01-staging-db');
    expect(header.text()).toContain('hermes memory seeded');
    expect(header.text()).toContain('$0.001419');
    expect(header.text()).toContain('61.0 s');
    expect(header.text()).toContain('73431');
    expect(header.text()).toContain('2026-10-24 22:18:30Z');
    expect(sec(w, 'why').exists()).toBe(true);
  });

  it('shows PASS for a passing trial and no WHY IT FAILED section', async () => {
    const { w } = await mountView({ trial: makeTrial({ passed: true, exit_reason: 'completed', steps: 2, grader_results: [{ ...exactMatchFail(), passed: true }] }) });
    expect(sec(w, 'header').find('[data-test="verdict"]').text()).toBe('PASS');
    expect(sec(w, 'header').find('[data-test="verdict"]').classes()).toContain('pass');
    expect(sec(w, 'header').find('[data-test="exit-reason"]').text()).toBe('completed');
    expect(sec(w, 'why').exists()).toBe(false);
  });

  it('shows "no verdict" when passed is null and prints the error class and message', async () => {
    const { w } = await mountView({
      trial: makeTrial({ passed: null, status: 'errored', exit_reason: null, steps: null, error_class: 'provider_error', error_message: 'upstream 502', grader_results: [] }),
      trace: makePartialTrace(),
    });
    const header = sec(w, 'header');
    expect(header.find('[data-test="verdict"]').text()).toBe('no verdict');
    expect(header.find('[data-test="trial-error-info"]').text()).toContain('provider_error');
    expect(header.find('[data-test="trial-error-info"]').text()).toContain('upstream 502');
    expect(sec(w, 'why').exists()).toBe(false);
  });

  it('links back to /experiments/<experiment_id>', async () => {
    const { w } = await mountView();
    const link = w.find('[data-test="back-link"]');
    expect(link.attributes('href')).toBe(`/experiments/${EXP_ID}`);
    expect(link.text()).toContain('memory off vs seeded');
  });

  it('still renders, with the back link and an inline error, when the experiment cannot be loaded', async () => {
    const { w } = await mountView({ experiment: new ApiError(500, 'experiment store down', ['db timeout'], null) });
    expect(sec(w, 'header').find('[data-test="verdict"]').text()).toBe('FAIL');
    expect(w.find('[data-test="back-link"]').attributes('href')).toBe(`/experiments/${EXP_ID}`);
    const err = w.find('[data-test="experiment-error"]');
    expect(err.classes()).toContain('error');
    expect(err.text()).toContain('experiment store down');
    expect(err.text()).toContain('db timeout');
    expect(sec(w, 'header').find('[data-test="config-name"]').text()).toContain('config 01M5Q85G0G...');
  });

  it('shows the API message and reasons when the trial itself cannot be loaded', async () => {
    const { w } = await mountView({ trial: new ApiError(404, 'trial not found', ['no such id'], null) });
    const err = w.find('[data-test="trial-error"]');
    expect(err.classes()).toContain('error');
    expect(err.text()).toContain('trial not found');
    expect(err.text()).toContain('no such id');
    expect(sec(w, 'header').exists()).toBe(false);
  });

  it('shows a trace load failure inline while keeping the trial and its grader results', async () => {
    const { w } = await mountView({ trace: new ApiError(500, 'trace unreadable', [], null) });
    expect(w.find('[data-test="trace-error"]').text()).toContain('trace unreadable');
    expect(sec(w, 'graders').text()).toContain('pg-stage-07.internal:6432');
  });
});

describe('TrialView why it failed and grader results', () => {
  it('restates a failed exact_match as expected vs extracted, in the WHY section and in the grader section', async () => {
    const { w } = await mountView();
    const why = sec(w, 'why');
    expect(why.text()).toContain('expected pg-stage-07.internal:6432 but the extracted answer was unknown:unknown');
    expect(why.text()).not.toContain('no FINAL line');
    const graders = sec(w, 'graders');
    expect(graders.find('.g-expected').text()).toBe('pg-stage-07.internal:6432');
    expect(graders.find('.g-extracted').text()).toBe('unknown:unknown');
    expect(graders.text()).toContain('normalized: unknown:unknown');
    expect(graders.text()).toContain('used fallback: false');
    expect(graders.find('.grader-verdict').text()).toBe('FAIL');
  });

  it('says that no FINAL line was found when used_fallback is true', async () => {
    const { w } = await mountView({ trial: makeTrial({ grader_results: [exactMatchFail({ used_fallback: true, extracted: 'last line text' })] }) });
    expect(sec(w, 'why').text()).toContain('no FINAL line was found');
    expect(sec(w, 'why').text()).toContain('the extracted answer was last line text');
    expect(sec(w, 'graders').text()).toContain('used fallback: true');
    expect(sec(w, 'graders').text()).toContain('no FINAL line was found');
  });

  it('shows the judge reasoning verbatim and the unmet criteria only', async () => {
    const { w } = await mountView({ trial: makeTrial({ grader_results: [llmJudgeFail()] }) });
    const why = sec(w, 'why');
    expect(why.find('.why-reasoning').element.textContent).toBe(JUDGE_REASONING);
    expect(why.text()).toContain('criterion c2 was not met: port missing from the answer');
    expect(why.text()).not.toContain('criterion c1 was not met');

    const g = sec(w, 'graders');
    expect(g.find('.g-reasoning').element.textContent).toBe(JUDGE_REASONING);
    const critRows = g.findAll('.g-criteria tbody tr');
    expect(critRows).toHaveLength(2);
    expect(critRows[0].text()).toContain('met');
    expect(critRows[0].text()).not.toContain('NOT met');
    expect(critRows[1].text()).toContain('NOT met');
    expect(critRows[1].text()).toContain('port missing from the answer');
    expect(g.text()).toContain('pass rule: all');
    expect(g.text()).toContain('01JUDGEMODELID0000000000');
    expect(g.text()).toContain('abc123def4567890');
    const inputs = g.find('details.g-inputs');
    expect((inputs.element as HTMLDetailsElement).open).toBe(false);
    expect(inputs.text()).toContain('JUDGED-INPUT-TEXT');
    // fields the structured view does not print are kept under "Other recorded fields"
    expect(g.find('details.g-rest').text()).toContain('raw_response');
  });

  it('renders the specifics of file_state, unit_test and trace_check graders', async () => {
    const { w } = await mountView({ trial: makeTrial({ grader_results: [fileStateFail(), unitTestFail(), traceCheckFail()] }) });
    const why = sec(w, 'why');
    expect(why.text()).toContain('file does not exist');
    expect(why.text()).toContain('deploy/notes.txt');
    expect(why.text()).not.toContain('port=6432'); // the passing check is not listed as a cause
    expect(why.text()).toContain('the command pytest -q tests/test_parse.py exited with code 1');
    expect(why.text()).toContain('last line of its output: FAILED tests/test_parse.py::test_ports - AssertionError: 6431 != 6432');
    expect(why.text()).toContain('15 step(s), limit 10');
    expect(why.text()).not.toContain('4 call(s) of shell');

    const g = sec(w, 'graders');
    const fsRows = g.findAll('.g-checks tbody tr');
    expect(fsRows).toHaveLength(2);
    expect(fsRows[0].text()).toContain('passed');
    expect(fsRows[1].text()).toContain('failed');
    expect(fsRows[1].text()).toContain('file does not exist');
    expect(g.find('.g-command').text()).toBe('pytest -q tests/test_parse.py');
    expect(g.find('[data-grader-type="unit_test"]').text()).toContain('exit code: 1');
    expect(g.find('[data-grader-type="unit_test"]').text()).toContain('timed out: false');
    expect(g.find('.g-output').text()).toContain('collected 3 items');
    const tcRows = g.findAll('.g-assertions tbody tr');
    expect(tcRows).toHaveLength(2);
    expect(tcRows[0].text()).toContain('4 call(s) of shell');
    expect(tcRows[1].text()).toContain('15 step(s), limit 10');
    expect(tcRows[1].text()).toContain('failed');
  });

  it('reports a unit_test timeout instead of an exit code', async () => {
    const { w } = await mountView({ trial: makeTrial({ grader_results: [unitTestFail({ exit_code: null, timed_out: true, output: 'still running\n' })] }) });
    expect(sec(w, 'why').text()).toContain('timed out; last line of its output: still running');
    expect(sec(w, 'why').text()).not.toContain('exited with code');
    expect(sec(w, 'graders').text()).toContain('timed out: true');
  });

  it('falls back to pretty JSON for an unknown details shape', async () => {
    const odd = { ...exactMatchFail(), grader_type: 'exact_match' as const, details: { weird: { nested: [1, 2] } } };
    const { w } = await mountView({ trial: makeTrial({ grader_results: [odd] }) });
    expect(sec(w, 'graders').find('.g-json').text()).toContain('"nested"');
    expect(sec(w, 'why').text()).toContain('exact_match did not pass');
  });

  it('explains a trial with no grader results from its error class and message', async () => {
    const { w } = await mountView({
      trial: makeTrial({ passed: false, status: 'errored', error_class: 'grader_error', error_message: 'workspace vanished', grader_results: [] }),
      trace: makeFullTrace({ grader_results: [] }),
    });
    expect(sec(w, 'why-no-grader').text()).toContain('error class grader_error');
    expect(sec(w, 'why-no-grader').text()).toContain('workspace vanished');
    expect(sec(w, 'graders').text()).toContain('No grader results were recorded');
  });
});

describe('TrialView event timeline', () => {
  it('renders every event in seq order with a kind label, collapsed', async () => {
    const trace = makeFullTrace({ events: [...makeEvents()].reverse() });
    const { w } = await mountView({ trace });
    const rs = rows(w);
    expect(rs.map((r) => r.attributes('data-seq'))).toEqual(makeEvents().map((e) => String(e.seq)));
    const labels = rs.map((r) => r.find('.ev-kind').text());
    expect(labels).toEqual(['MESSAGE', 'MESSAGE', 'MEMORY READ', 'SKILL', 'API CALL', 'TOOL CALL', 'TOOL RESULT', 'TOOL CALL', 'TOOL RESULT', 'MEMORY WRITE', 'API CALL', 'ERROR', 'MESSAGE']);
    expect(rs.every((r) => r.find('.ev-body').exists() === false)).toBe(true);
    expect(rs.every((r) => r.find('button.ev-head').attributes('aria-expanded') === 'false')).toBe(true);
    // collapsed summaries
    expect(row(w, 1).text()).toContain('user: What are the host and the port');
    expect(row(w, 1).find('.ev-t').text()).toBe('11.0 s');
    expect(row(w, 5).find('.ev-summary').text()).toContain('files (search_files) {"path":"","limit":20,"target":"files","pattern":"staging"}');
    expect(row(w, 6).find('.ev-summary').text()).toContain('ok, 447 ms');
    expect(row(w, 8).find('.ev-summary').text()).toContain('ERROR, 89 ms');
    expect(row(w, 4).find('.ev-summary').text()).toContain('step 1, openai/gpt-oss-20b, in 4191 / out 72 tokens');
    expect(row(w, 2).find('.ev-summary').text()).toBe('MEMORY.md, loaded by harness');
    expect(row(w, 9).find('.ev-summary').text()).toBe('MEMORY.md, add');
    expect(row(w, 3).find('.ev-summary').text()).toBe('db-lookup, via preload');
    expect(row(w, 11).find('.ev-summary').text()).toBe('run: provider hiccup (retryable)');
  });

  it('colours a non-ok api_call status and leaves ok plain', async () => {
    const { w } = await mountView();
    expect(row(w, 10).find('.ev-status').classes()).toContain('badge-warn');
    expect(row(w, 10).find('.ev-status').text()).toBe('retry 429');
    expect(row(w, 4).find('.ev-status').classes()).not.toContain('badge-warn');
    expect(row(w, 4).find('.ev-status').text()).toBe('ok 200');
    expect(row(w, 4).classes()).toContain('ev-api');
  });

  it('expands a tool_call to show its args JSON and the paired result matched by call_id, and collapses again', async () => {
    const { w } = await mountView();
    expect(row(w, 5).find('.ev-args').exists()).toBe(false);
    await clickRow(w, 5);
    expect(row(w, 5).find('button.ev-head').attributes('aria-expanded')).toBe('true');
    expect(row(w, 5).find('.ev-args').text()).toBe(JSON.stringify({ path: '', limit: 20, target: 'files', pattern: 'staging' }, null, 2));
    expect(row(w, 5).find('.ev-paired-output').text()).toBe('{"total_count": 0, "marker": "RESULT-OUTPUT-A"}');
    // the other call's result is not shown on this call
    expect(row(w, 5).text()).not.toContain('exit 1 no matches');
    // the result row itself is still collapsed
    expect(row(w, 6).find('.ev-body').exists()).toBe(false);

    await clickRow(w, 5);
    expect(row(w, 5).find('.ev-args').exists()).toBe(false);
    expect(row(w, 5).find('.ev-paired-output').exists()).toBe(false);
    expect(row(w, 5).find('button.ev-head').attributes('aria-expanded')).toBe('false');
  });

  it('shows on a tool_result which call it answers, and marks an error output', async () => {
    const { w } = await mountView();
    await clickRow(w, 8);
    const body = row(w, 8).find('.ev-body');
    expect(body.text()).toContain('answers tool call #7: shell (terminal) {"command":"env | grep -i staging"}');
    expect(body.find('.ev-output').text()).toBe('exit 1 no matches');
    expect(body.find('.ev-output').classes()).toContain('ev-out-error');
    await clickRow(w, 6);
    expect(row(w, 6).find('.ev-output').classes()).not.toContain('ev-out-error');
    expect(row(w, 6).text()).toContain('answers tool call #5: files (search_files)');
  });

  it('shows an unmatched call_id as such', async () => {
    const events: TraceEvent[] = [
      { seq: 0, t_ms: 0, kind: 'tool_call', step: 1, tool: 'shell', call_id: 'x1', harness_tool: 'terminal', args: { command: 'ls' } },
      { seq: 1, t_ms: 5, kind: 'tool_result', call_id: 'other', output: 'stray', is_error: false, duration_ms: 1 },
    ];
    const { w } = await mountView({ trace: makeFullTrace({ events }) });
    await clickRow(w, 0);
    await clickRow(w, 1);
    expect(row(w, 0).text()).toContain('no tool_result with this call id');
    expect(row(w, 1).text()).toContain('no tool_call with this call id');
  });

  it('expands and collapses every row with Expand all and Collapse all', async () => {
    const { w } = await mountView();
    await w.find('[data-test="expand-all"]').trigger('click');
    expect(rows(w).every((r) => r.find('.ev-body').exists())).toBe(true);
    expect(rows(w)).toHaveLength(13);
    await w.find('[data-test="collapse-all"]').trigger('click');
    expect(rows(w).some((r) => r.find('.ev-body').exists())).toBe(false);
  });

  it('shows full content for message, memory_write, api_call and error rows', async () => {
    const { w } = await mountView();
    await w.find('[data-test="expand-all"]').trigger('click');
    expect(row(w, 12).find('.ev-content').element.textContent).toBe(FINAL_RESPONSE);
    expect(row(w, 9).text()).toContain('staging db: pg-stage-07.internal:6432\nnote to self');
    expect(row(w, 9).text()).toContain('"content": "note to self"');
    expect(row(w, 2).find('.ev-content').text()).toBe('staging db: pg-stage-07.internal:6432');
    expect(row(w, 10).text()).toContain('http status');
    expect(row(w, 10).text()).toContain('429');
    expect(row(w, 11).find('.ev-content').text()).toBe('provider hiccup');
    expect(row(w, 3).text()).toContain('invoked via preload');
  });

  it('gives memory events class ev-memory, skill events ev-skill, and the classes differ', async () => {
    const { w } = await mountView();
    const mr = row(w, 2);
    const mw = row(w, 9);
    const sk = row(w, 3);
    expect(mr.classes()).toContain('ev-memory');
    expect(mw.classes()).toContain('ev-memory');
    expect(sk.classes()).toContain('ev-skill');
    expect(sk.classes()).not.toContain('ev-memory');
    expect(mr.classes()).not.toContain('ev-skill');
    expect(row(w, 11).classes()).toContain('ev-error');
    expect(row(w, 5).classes()).not.toContain('ev-memory');
    expect(row(w, 5).classes()).not.toContain('ev-skill');
    expect(mr.find('.ev-kind').text()).toBe('MEMORY READ');
    expect(mw.find('.ev-kind').text()).toBe('MEMORY WRITE');
    expect(sk.find('.ev-kind').text()).toBe('SKILL');
    expect(w.findAll('li.ev-memory')).toHaveLength(2);
    expect(w.findAll('li.ev-skill')).toHaveLength(1);
  });

  it('hides rows of an unchecked kind and keeps the count per kind', async () => {
    const { w } = await mountView();
    const labels = w.findAll('label.kind-filter').map((l) => l.text());
    expect(labels).toContain('API CALL (2)');
    expect(labels).toContain('MESSAGE (3)');
    expect(labels).toContain('TOOL CALL (2)');
    expect(rows(w)).toHaveLength(13);
    await w.find('input[data-kind-filter="api_call"]').setValue(false);
    expect(rows(w)).toHaveLength(11);
    expect(w.findAll('li.ev[data-kind="api_call"]')).toHaveLength(0);
    expect(w.find('[data-test="shown-count"]').text()).toBe('11 of 13 events shown');
    await w.find('input[data-kind-filter="api_call"]').setValue(true);
    expect(rows(w)).toHaveLength(13);
  });

  it('keeps a row expanded across a filter that hides and shows it', async () => {
    const { w } = await mountView();
    await clickRow(w, 5);
    await w.find('input[data-kind-filter="tool_call"]').setValue(false);
    expect(row(w, 5).exists()).toBe(false);
    await w.find('input[data-kind-filter="tool_call"]').setValue(true);
    expect(row(w, 5).find('.ev-args').exists()).toBe(true);
  });

  it('shows the original length of a truncated event', async () => {
    const events: TraceEvent[] = [
      { seq: 0, t_ms: 0, kind: 'message', role: 'user', step: 1, content: 'abc', truncated: true, orig_len: 54321 },
      { seq: 1, t_ms: 1, kind: 'tool_result', call_id: 'c', output: 'xyz', is_error: false, duration_ms: 3, truncated: true, orig_len: 99000 },
      { seq: 2, t_ms: 2, kind: 'message', role: 'assistant', step: 1, content: 'fine' },
    ];
    const { w } = await mountView({ trace: makeFullTrace({ events }) });
    expect(row(w, 0).text()).toContain('truncated');
    await clickRow(w, 0);
    await clickRow(w, 1);
    await clickRow(w, 2);
    expect(row(w, 0).find('.ev-body').text()).toContain('truncated, original length 54321 characters');
    expect(row(w, 1).find('.ev-body').text()).toContain('truncated, original length 99000 characters');
    expect(row(w, 2).find('.ev-body').text()).not.toContain('truncated');
  });

  it('renders event text as text, never as HTML', async () => {
    const evil = '<img src=x onerror="window.__pwned=1"><b>bold</b>';
    const events: TraceEvent[] = [{ seq: 0, t_ms: 0, kind: 'message', role: 'assistant', step: 1, content: evil }];
    const { w } = await mountView({ trace: makeFullTrace({ events, final_response: evil, system_prompt: evil }) });
    await clickRow(w, 0);
    expect(row(w, 0).find('.ev-content').element.textContent).toBe(evil);
    expect(w.find('img').exists()).toBe(false);
    expect(w.find('.ev-content b').exists()).toBe(false);
  });

  it('renders judge reasoning, prompts and the final response as text, never as HTML', async () => {
    const evil = '<i id="pwn">x</i> <script>window.__pwned = 1</script>';
    const judge = { ...llmJudgeFail(), reasoning: evil };
    const { w } = await mountView({
      trial: makeTrial({ grader_results: [judge] }),
      trace: makeFullTrace({ final_response: evil, system_prompt: evil, events: [{ seq: 0, t_ms: 0, kind: 'message', role: 'user', step: 1, content: evil }] }),
    });
    expect(w.find('#pwn').exists()).toBe(false);
    expect(w.find('i').exists()).toBe(false);
    expect(sec(w, 'graders').find('.g-reasoning').element.textContent).toBe(evil);
    expect(sec(w, 'why').find('.why-reasoning').element.textContent).toBe(evil);
    expect(sec(w, 'final-response').find('pre').element.textContent).toBe(evil);
    expect(sec(w, 'prompt-text').element.textContent).toBe(evil);
    expect(sec(w, 'system-prompt').find('pre').element.textContent).toBe(evil);
  });

  it('renders at most 200 rows for 1200 events and Next moves the window', async () => {
    const { w } = await mountView({ trace: makeFullTrace({ events: manyEvents(1200) }) });
    expect(rows(w).length).toBe(200);
    expect(w.find('[data-test="window-text"]').text()).toBe('events 1-200 of 1200');
    expect(rows(w)[0].attributes('data-seq')).toBe('0');
    expect((w.find('[data-test="prev"]').element as HTMLButtonElement).disabled).toBe(true);

    await w.find('[data-test="next"]').trigger('click');
    expect(w.find('[data-test="window-text"]').text()).toBe('events 201-400 of 1200');
    expect(rows(w).length).toBe(200);
    expect(rows(w)[0].attributes('data-seq')).toBe('200');
    expect(rows(w)[199].attributes('data-seq')).toBe('399');

    await w.find('[data-test="prev"]').trigger('click');
    expect(w.find('[data-test="window-text"]').text()).toBe('events 1-200 of 1200');

    for (let i = 0; i < 5; i++) await w.find('[data-test="next"]').trigger('click');
    expect(w.find('[data-test="window-text"]').text()).toBe('events 1001-1200 of 1200');
    expect((w.find('[data-test="next"]').element as HTMLButtonElement).disabled).toBe(true);
    // Expand all on a windowed trace still never puts more than 200 rows in the DOM
    await w.find('[data-test="expand-all"]').trigger('click');
    expect(rows(w).length).toBe(200);
  });

  it('windows by the filtered count and shows a partial last window', async () => {
    // 1342 events: 672 messages (seq 0 and the odd seqs) and 670 api_calls
    const { w } = await mountView({ trace: makeFullTrace({ events: manyEvents(1342) }) });
    expect(w.find('[data-test="window-text"]').text()).toBe('events 1-200 of 1342');
    await w.find('input[data-kind-filter="api_call"]').setValue(false);
    expect(w.find('[data-test="window-text"]').text()).toBe('events 1-200 of 672');
    for (let i = 0; i < 3; i++) await w.find('[data-test="next"]').trigger('click');
    expect(w.find('[data-test="window-text"]').text()).toBe('events 601-672 of 672');
    expect(rows(w).length).toBe(72);
  });

  it('renders all events with no pager at exactly 500, and pages at 501', async () => {
    const a = await mountView({ trace: makeFullTrace({ events: manyEvents(500) }) });
    expect(rows(a.w).length).toBe(500);
    expect(a.w.find('[data-test="pager"]').exists()).toBe(false);
    const b = await mountView({ trace: makeFullTrace({ events: manyEvents(501) }) });
    expect(rows(b.w).length).toBe(200);
    expect(b.w.find('[data-test="window-text"]').text()).toBe('events 1-200 of 501');
  });
});

describe('TrialView prompt, final response, memory and system prompt', () => {
  it('takes the task prompt from the first user message event, not from the registry', async () => {
    const events: TraceEvent[] = [
      { seq: 0, t_ms: 0, kind: 'message', role: 'system', step: 1, content: 'sys' },
      { seq: 1, t_ms: 1, kind: 'message', role: 'user', step: 1, content: 'FIRST user message' },
      { seq: 2, t_ms: 2, kind: 'message', role: 'user', step: 2, content: 'SECOND user message' },
    ];
    const { w, listTasks } = await mountView({ trace: makeFullTrace({ events }), tasks: [makeTask()] });
    expect(sec(w, 'prompt-text').element.textContent).toBe('FIRST user message');
    expect(sec(w, 'prompt').text()).toContain('first user message of the trace');
    expect(listTasks).not.toHaveBeenCalled();
  });

  it('falls back to the registry task only when the version hash matches', async () => {
    const noUser = makeFullTrace({ events: [{ seq: 0, t_ms: 0, kind: 'message', role: 'system', step: 1, content: 'sys' }] });
    const ok = await mountView({ trace: noUser, tasks: [makeTask()] });
    expect(ok.listTasks).toHaveBeenCalled();
    expect(sec(ok.w, 'prompt-text').element.textContent).toBe('REGISTRY-PROMPT what is the staging database?');
    expect(sec(ok.w, 'prompt-unavailable').exists()).toBe(false);

    const bad = await mountView({ trace: noUser, tasks: [makeTask({ version_hash: 'f'.repeat(64) })] });
    expect(sec(bad.w, 'prompt-text').exists()).toBe(false);
    expect(sec(bad.w, 'prompt-unavailable').text()).toContain('task prompt unavailable');
    expect(bad.w.text()).not.toContain('REGISTRY-PROMPT');

    const other = await mountView({ trace: noUser, tasks: [makeTask({ id: 'other-task' })] });
    expect(sec(other.w, 'prompt-unavailable').exists()).toBe(true);
  });

  it('shows the registry error inline when the fallback lookup fails', async () => {
    const noUser = makeFullTrace({ events: [] });
    const { w } = await mountView({ trace: noUser, tasks: new ApiError(500, 'registry down', ['tasks table locked'], null) });
    const prompt = sec(w, 'prompt');
    expect(prompt.find('.error').text()).toContain('registry down');
    expect(prompt.find('.error').text()).toContain('tasks table locked');
    expect(sec(w, 'prompt-unavailable').exists()).toBe(true);
  });

  it('shows the final response verbatim', async () => {
    const { w } = await mountView();
    expect(sec(w, 'final-response').find('pre').element.textContent).toBe(FINAL_RESPONSE);
    expect(sec(w, 'prompt-text').element.textContent).toBe(USER_PROMPT);
  });

  it('keeps the system prompt closed by default and notes its length', async () => {
    const { w } = await mountView();
    const d = sec(w, 'system-prompt');
    expect((d.element as HTMLDetailsElement).open).toBe(false);
    expect(d.find('summary').text()).toContain(`${SYSTEM_PROMPT.length} characters`);
    expect(d.find('pre').element.textContent).toBe(SYSTEM_PROMPT);
  });

  it('falls back to the first system message when trace.system_prompt is null', async () => {
    const { w } = await mountView({ trace: makeFullTrace({ system_prompt: null }) });
    const d = sec(w, 'system-prompt');
    expect(d.find('pre').element.textContent).toBe(SYSTEM_PROMPT);
    expect((d.element as HTMLDetailsElement).open).toBe(false);
  });

  it('opens only the memory files that changed and says memory changed', async () => {
    const { w } = await mountView();
    const m = sec(w, 'memory');
    expect(m.find('[data-test="memory-changed"]').text()).toBe('memory changed during the trial');
    const changed = m.find('details[data-memory-file="MEMORY.md"]');
    const same = m.find('details[data-memory-file="USER.md"]');
    expect((changed.element as HTMLDetailsElement).open).toBe(true);
    expect((same.element as HTMLDetailsElement).open).toBe(false);
    const pres = changed.findAll('pre').map((p) => p.element.textContent);
    expect(pres).toEqual(['staging db: pg-stage-07.internal:6432', 'staging db: pg-stage-07.internal:6432\nnote to self']);
    expect(m.find('[data-test="skills"]').text()).toBe('db-lookup');
    expect(m.find('[data-test="notes"]').text()).toBe('adapter note: memory was seeded');
  });

  it('shows no change note and keeps every file closed when memory is identical', async () => {
    const same = { 'MEMORY.md': 'a', 'USER.md': 'b' };
    const { w } = await mountView({ trace: makeFullTrace({ memory_initial: same, memory_final: { ...same } }) });
    const m = sec(w, 'memory');
    expect(m.find('[data-test="memory-changed"]').exists()).toBe(false);
    expect(m.findAll('details').every((d) => (d.element as HTMLDetailsElement).open === false)).toBe(true);
  });
});

describe('TrialView partial trace', () => {
  it('shows the partial banner with the error class and message, renders the events, and omits system prompt, final response and memory', async () => {
    const { w } = await mountView({
      trial: makeTrial({ passed: null, status: 'errored', exit_reason: null, steps: null, error_class: 'provider_error', error_message: 'upstream closed the connection', grader_results: [] }),
      trace: makePartialTrace(),
    });
    const banner = sec(w, 'partial-banner');
    expect(banner.classes()).toContain('warn');
    expect(banner.text()).toContain('partial trace: this trial errored; only the events of its last attempt were kept');
    expect(banner.text()).toContain('error class: provider_error');
    expect(banner.text()).toContain('error message: upstream closed the connection');
    expect(sec(w, 'system-prompt-section').exists()).toBe(false);
    expect(sec(w, 'system-prompt').exists()).toBe(false);
    expect(sec(w, 'final-response').exists()).toBe(false);
    expect(sec(w, 'memory').exists()).toBe(false);
    expect(rows(w)).toHaveLength(2);
    expect(sec(w, 'prompt-text').element.textContent).toBe(USER_PROMPT);
    expect(sec(w, 'graders').text()).toContain('No grader results were recorded');
  });

  it('does not show the partial banner for a full trace', async () => {
    const { w } = await mountView();
    expect(sec(w, 'partial-banner').exists()).toBe(false);
  });
});

describe('TrialView reload', () => {
  it('uses the trial id prop for every request', async () => {
    const { w } = await mountView();
    expect(api.getTrial).toHaveBeenCalledWith(TRIAL_ID);
    expect(api.getTrace).toHaveBeenCalledWith(TRIAL_ID);
    expect(api.getExperiment).toHaveBeenCalledWith(EXP_ID);
    w.unmount();
  });

  it('shows the trial of the latest id prop even when the response for the earlier id arrives last', async () => {
    const OTHER_ID = '01M5QZWXZBM7R7JCTAESKJKQ70';
    let releaseFirst: (t: Trial) => void = () => undefined;
    const slowFirst = new Promise<Trial>((resolve) => {
      releaseFirst = resolve;
    });
    vi.spyOn(api, 'getTrial').mockImplementation((id: string) =>
      id === TRIAL_ID ? slowFirst : Promise.resolve(makeTrial({ id: OTHER_ID, task_id: 'second-task' })),
    );
    vi.spyOn(api, 'getTrace').mockImplementation(() => Promise.resolve(makeFullTrace()));
    vi.spyOn(api, 'getExperiment').mockImplementation(() => Promise.resolve(makeExperiment()));
    vi.spyOn(api, 'listTasks').mockImplementation(() => Promise.resolve([]));
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push(`/trials/${TRIAL_ID}`);
    await router.isReady();
    const w = mount(TrialView, { props: { id: TRIAL_ID }, global: { plugins: [createPinia(), router] } });
    await flushPromises();
    expect(sec(w, 'trial-id').exists()).toBe(false); // the first request is still pending

    await w.setProps({ id: OTHER_ID });
    await flushPromises();
    expect(api.getTrial).toHaveBeenCalledWith(OTHER_ID);
    expect(sec(w, 'trial-id').text()).toBe(OTHER_ID);

    releaseFirst(makeTrial({ id: TRIAL_ID, task_id: 'first-task' }));
    await flushPromises();
    expect(sec(w, 'trial-id').text()).toBe(OTHER_ID);
    expect(sec(w, 'header').text()).toContain('second-task');
    expect(sec(w, 'header').text()).not.toContain('first-task');
    w.unmount();
  });
});

describe('TrialView review fixes', () => {
  it('keeps the grader reason when the agent produced no final response', async () => {
    const { w } = await mountView({ trial: makeTrial({ grader_results: [exactMatchNoResponse()] }) });
    expect(sec(w, 'why').text()).toContain('expected x:1 but the extracted answer was null');
    expect(sec(w, 'why').text()).toContain('grader reason: no final response');
    const card = sec(w, 'graders');
    expect(card.find('.g-reason').text()).toBe('reason: no final response');
    expect(card.find('.g-extracted').text()).toBe('null');
    // normalized and used_fallback were never recorded, so the card does not print "(missing)" for them
    expect(card.text()).not.toContain('(missing)');
    expect(card.text()).not.toContain('used fallback');
    // the reason is shown up front, not only inside the collapsed "Other recorded fields"
    expect(card.find('details.g-rest').exists()).toBe(false);
  });

  it('lists only failing graders in WHY IT FAILED, not a passing one beside them', async () => {
    const { w } = await mountView({
      trial: makeTrial({ grader_results: [exactMatchPass(), { ...fileStateFail(), grader_index: 1 }] }),
    });
    const items = sec(w, 'why').findAll('li.why-item');
    expect(items).toHaveLength(1);
    expect(items[0].text()).toContain('file_state');
    expect(items[0].text()).toContain('file does not exist');
    expect(sec(w, 'why').text()).not.toContain('PASSING-EXPECTED-VALUE');
    // the passing grader is still shown in full in the grader section
    const cards = sec(w, 'graders').findAll('.grader');
    expect(cards).toHaveLength(2);
    expect(cards[0].text()).toContain('PASSING-EXPECTED-VALUE');
    expect(cards[0].find('.grader-verdict').text()).toBe('PASS');
  });

  it('leads the file_state and trace_check lines with the reason and keeps the raw check in brackets', async () => {
    const { w } = await mountView({ trial: makeTrial({ grader_results: [fileStateFail(), traceCheckFail()] }) });
    const lines = sec(w, 'why').findAll('.why-line').map((l) => l.text());
    expect(lines[0]).toBe('file check failed: file does not exist (check {"path":"deploy/notes.txt","exists":true})');
    expect(lines[1]).toBe('trace assertion failed: 15 step(s), limit 10 (assertion {"kind":"max_steps","limit":10})');
  });

  it('renders graders in grader_index order even when the API returns them out of order', async () => {
    const { w } = await mountView({ trial: makeTrial({ grader_results: [unitTestFail(), fileStateFail(), exactMatchFail()] }) });
    expect(sec(w, 'graders').findAll('.grader').map((g) => g.attributes('data-grader-index'))).toEqual(['0', '1', '2']);
    expect(sec(w, 'why').findAll('.why-item').map((i) => i.find('strong').text())).toEqual(['exact_match', 'file_state', 'unit_test']);
  });

  it('falls back to the grader results of the trace when the trial carries none', async () => {
    const { w } = await mountView({
      trial: makeTrial({ grader_results: [] }),
      trace: makeFullTrace({ grader_results: [exactMatchFail()] }),
    });
    expect(sec(w, 'graders').find('.g-expected').text()).toBe('pg-stage-07.internal:6432');
    expect(sec(w, 'why').text()).toContain('expected pg-stage-07.internal:6432 but the extracted answer was unknown:unknown');
    expect(sec(w, 'why-no-grader').exists()).toBe(false);
  });

  it('resets the window to the start when a kind filter changes', async () => {
    const { w } = await mountView({ trace: makeFullTrace({ events: manyEvents(1342) }) });
    await w.find('[data-test="next"]').trigger('click');
    await w.find('[data-test="next"]').trigger('click');
    expect(w.find('[data-test="window-text"]').text()).toBe('events 401-600 of 1342');
    await w.find('input[data-kind-filter="api_call"]').setValue(false);
    expect(w.find('[data-test="window-text"]').text()).toBe('events 1-200 of 672');
    expect(rows(w)[0].attributes('data-seq')).toBe('0');
  });

  it('still pairs a tool_call with its result when the tool_result kind is filtered out', async () => {
    const { w } = await mountView();
    await w.find('input[data-kind-filter="tool_result"]').setValue(false);
    expect(w.findAll('li.ev[data-kind="tool_result"]')).toHaveLength(0);
    await clickRow(w, 5);
    expect(row(w, 5).find('.ev-paired-output').text()).toBe('{"total_count": 0, "marker": "RESULT-OUTPUT-A"}');
    expect(row(w, 5).text()).not.toContain('no tool_result with this call id');
  });

  it('expands only the events that pass the kind filter with Expand all', async () => {
    const { w } = await mountView();
    await w.find('input[data-kind-filter="api_call"]').setValue(false);
    await w.find('[data-test="expand-all"]').trigger('click');
    expect(rows(w).every((r) => r.find('.ev-body').exists())).toBe(true);
    await w.find('input[data-kind-filter="api_call"]').setValue(true);
    expect(rows(w)).toHaveLength(13);
    expect(row(w, 4).find('.ev-body').exists()).toBe(false);
    expect(row(w, 10).find('.ev-body').exists()).toBe(false);
    expect(row(w, 5).find('.ev-body').exists()).toBe(true);
  });

  it('says when the task prompt was truncated by the runner', async () => {
    const events: TraceEvent[] = [{ seq: 0, t_ms: 0, kind: 'message', role: 'user', step: 1, content: 'cut prompt', truncated: true, orig_len: 54321 }];
    const { w } = await mountView({ trace: makeFullTrace({ events }) });
    expect(sec(w, 'prompt-text').element.textContent).toBe('cut prompt');
    expect(sec(w, 'prompt-truncated').text()).toBe('truncated, original length 54321 characters');
  });

  it('shows no truncation note for a complete task prompt', async () => {
    const { w } = await mountView();
    expect(sec(w, 'prompt-truncated').exists()).toBe(false);
  });

  it('words the partial banner for a cancelled trial as cancelled, not errored', async () => {
    const { w } = await mountView({
      trial: makeTrial({ passed: null, status: 'cancelled', exit_reason: null, steps: null, error_class: 'cancelled', error_message: 'cancelled', grader_results: [] }),
      trace: makePartialTrace({ events: [], error_class: 'cancelled', error_message: 'cancelled' }),
    });
    const banner = sec(w, 'partial-banner').text();
    expect(banner).toContain('partial trace: this trial was cancelled; only the events of its last attempt were kept');
    expect(banner).not.toContain('this trial errored');
    expect(banner).toContain('error class: cancelled');
  });

  it('does not print "undefined" for an api_call that lacks http_status', async () => {
    const odd = { seq: 0, t_ms: 0, kind: 'api_call', step: 1, model: 'm', status: 'ok', latency_ms: 5, input_tokens: 1, output_tokens: 1 } as unknown as TraceEvent;
    const { w } = await mountView({ trace: makeFullTrace({ events: [odd] }) });
    expect(row(w, 0).find('.ev-status').text()).toBe('ok');
    await clickRow(w, 0);
    expect(row(w, 0).text()).not.toContain('undefined');
    expect(row(w, 0).text()).toContain('none');
  });
});

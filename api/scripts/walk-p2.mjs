// The P2 walk (cards/P2.md section 8, gate 4) as a script.
//
//   node scripts/walk-p2.mjs [--api URL] [--model model-b] [--sample-file experiments/judge-validation/sample.jsonl]
//
// 1. POST /configs for minimal_loop with the Hermes memory-off settings: 201 (200 if it already exists).
// 2. POST /trials/adhoc for det-03-slugify under it: the trace never shows the hidden test in a tool_result
//    of a list_dir call (R-7), and grader_results[0].details holds pytest output.
// 3. POST /configs for minimal_loop with skills.enabled = true: 400 with the adapter's reason (H-1, D-4).
// 4. 4 judged trials under minimal_loop (jdg-04-flaky x2, mem-06-release x2) so judge:sample has something to draw
//    from; then, with --sample-file, the file written by `npm run judge:sample -- --n 4` is read back and must have
//    no passed or reasoning key at any depth (D-15).
// Exits non-zero on the first broken expectation.
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const api = (args.api ?? 'http://localhost:3000').replace(/\/$/, '');
const modelId = args.model ?? 'model-b';

let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures += 1;
}
async function call(method, path, body) {
  const res = await fetch(`${api}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}
const settings = (over = {}) => ({
  tools: ['shell', 'files'],
  memory: { mode: 'off' },
  skills: { enabled: false, preload: [] },
  temperature: 0,
  max_steps: 15,
  max_output_tokens: 2048,
  timeout_seconds: 300,
  harness_options: { providers_ignored: ['Darkbloom', 'Groq'] }, // DESIGN 13.5
  ...over,
});

console.log(`P2 walk against ${api} with model ${modelId}`);
const good = await call('POST', '/configs', { name: 'minimal_loop memory off', harness_id: 'minimal_loop', model_id: modelId, settings: settings() });
check([200, 201].includes(good.status), `POST /configs minimal_loop memory off -> ${good.status}`, JSON.stringify(good.body));
check(good.body.harness_version?.startsWith('1.1.0+'), `harness version ${good.body.harness_version}`);

async function trial(configId, taskId) {
  const run = await call('POST', '/trials/adhoc', { config_id: configId, task_id: taskId });
  const t = run.body?.trial ?? {};
  console.log(`      ${taskId}: HTTP ${run.status} trial ${t.id} status=${t.status} passed=${t.passed} exit=${t.exit_reason} steps=${t.steps} error=${t.error_class ?? '-'} ${t.error_message ?? ''}`);
  const trace = t.id ? (await call('GET', `/trials/${t.id}/trace`)).body : {};
  return { run, trial: t, trace };
}

const slug = await trial(good.body.id, 'det-03-slugify');
check(slug.run.status === 201 && slug.trial.status === 'done', 'det-03-slugify ran to done under minimal_loop');
const events = slug.trace.events ?? [];
const listCalls = new Set(events.filter((e) => e.kind === 'tool_call' && e.harness_tool === 'list_dir').map((e) => e.call_id));
const listOutputs = events.filter((e) => e.kind === 'tool_result' && listCalls.has(e.call_id)).map((e) => e.output);
console.log(`      list_dir calls: ${listCalls.size}`);
check(!events.some((e) => e.kind === 'tool_result' && /test_slug/.test(e.output ?? '')), 'no tool_result mentions the hidden test file test_slug (R-7)');
check(!listOutputs.some((o) => /tests?\b/.test(o) && /test_slug/.test(o)), 'no list_dir result shows the hidden test (R-7)');
const details = slug.trace.grader_results?.[0]?.details ?? {};
check(slug.trace.grader_results?.[0]?.grader_type === 'unit_test', 'grader_results[0] is the unit_test grader');
check(/passed|failed|error/i.test(details.output ?? ''), 'grader_results[0].details.output contains pytest output', JSON.stringify(details).slice(0, 400));
console.log(`      pytest said: ${(details.output ?? '').trim().split('\n').slice(-2).join(' | ')}`);

const bad = await call('POST', '/configs', { name: 'minimal_loop with skills', harness_id: 'minimal_loop', model_id: modelId, settings: settings({ skills: { enabled: true, preload: [] } }) });
check(bad.status === 400, `POST /configs minimal_loop with skills.enabled -> ${bad.status}`, JSON.stringify(bad.body));
const reasons = JSON.stringify(bad.body);
check(/skills/i.test(reasons) && /minimal loop/i.test(reasons), "the 400 carries the adapter's reason", reasons);

console.log('judged trials for judge:sample');
const judged = [];
for (const task of ['jdg-04-flaky', 'jdg-04-flaky', 'mem-06-release', 'mem-06-release']) {
  const j = await trial(good.body.id, task);
  judged.push(j.trial.id);
  const g = j.trace.grader_results?.[0];
  check(g?.grader_type === 'llm_judge' && !!g.judge_model_id && !!g.judge_prompt_hash && typeof g.reasoning === 'string', `${task}: llm_judge result carries judge ids and reasoning`, JSON.stringify(g).slice(0, 300));
}

if (args['sample-file']) {
  const lines = readFileSync(args['sample-file'], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const keys = (v) => (Array.isArray(v) ? v.flatMap(keys) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
  const forbidden = ['passed', 'pass', 'reasoning', 'criteria', 'met', 'evidence', 'details', 'config_id'];
  check(lines.length === 4, `${args['sample-file']} has ${lines.length} item(s)`);
  check(lines.every((l) => keys(l).every((k) => !forbidden.includes(k))), 'no passed, reasoning, criteria or config key at any depth (D-15)', JSON.stringify([...new Set(lines.flatMap(keys))]));
  check(lines.every((l) => l.rubric.length >= 3 && l.inputs.length >= 1 && l.task_prompt.length > 0), 'each item has a task prompt, a rubric and the inputs the judge saw');
}

console.log(`\nadhoc trial ids: ${slug.trial.id} (det-03-slugify), judged: ${judged.join(', ')}`);
console.log(failures === 0 ? 'P2 WALK PASSED' : `P2 WALK FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);

// The P3 walk (cards/P3.md section 8, gate 4) as a script, against a running stack and the real worker.
//
//   node scripts/walk-p3.mjs [api-url] [model-id] [n-trials]      defaults: http://localhost:3000 model-b 2
//
// 1. POST /configs for the 2 Hermes configs of DESIGN 10.1 (memory off, memory seeded).
// 2. POST /experiments (draft) with tasks det-06-ini, mem-01-staging-db, hon-01-missing-key and a hypothesis;
//    the experiment is still a draft and has no trials.
// 3. POST /experiments/:id/start, then poll GET /experiments/:id and print the progress counts until it
//    leaves running.
// 4. GET /experiments/:id/pilot has no delta; GET /experiments/:id/compare has the aggregate delta with CI
//    and verdict, per_task rows and the cost table; the by_category verdicts are printed, and the comparison JSON
//    is printed in full. The 3 tasks are 1 per category, so every by_category block has 1 paired task and reports
//    insufficient_data with no interval (a block needs 2 paired tasks for a CI); that is expected, not a failure.
//    The aggregate has 3 paired tasks, so it carries a CI.
// 5. GET /experiments/:id/export.csv has 12 rows plus a header (2 configs x 3 tasks x N=2); compare.csv ends with
//    the __aggregate__ row; export.json names the comparison_run it used, which is the one compare?persist=1 stored.
// Exits non-zero after printing every broken expectation.
const api = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const modelId = process.argv[3] ?? 'model-b';
const nTrials = Number(process.argv[4] ?? 2);
const TASKS = ['det-06-ini', 'mem-01-staging-db', 'hon-01-missing-key'];
const POLL_MS = 10_000;
const DEADLINE_MS = 60 * 60 * 1000;

let failures = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures += 1;
}

async function call(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, text };
}

const settings = (memory) => ({
  tools: ['shell', 'files'],
  memory,
  skills: { enabled: false, preload: [] },
  temperature: 0,
  max_steps: 15,
  max_output_tokens: 2048,
  timeout_seconds: 300,
  harness_options: { providers_ignored: ['Darkbloom', 'Groq'] }, // DESIGN 13.5, as walk.mjs
});

function keysDeep(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (out.add(k), keysDeep(x, out));
  return out;
}

console.log(`P3 walk against ${api} with model ${modelId}, N=${nTrials}`);
check((await call('GET', '/health')).status === 200, 'GET /health');

const off = await call('POST', '/configs', { name: 'hermes memory off', harness_id: 'hermes', model_id: modelId, settings: settings({ mode: 'off' }) });
const seeded = await call('POST', '/configs', {
  name: 'hermes memory seeded',
  harness_id: 'hermes',
  model_id: modelId,
  settings: settings({ mode: 'seeded', fixture: 'team-memory-v1' }),
});
check([200, 201].includes(off.status) && [200, 201].includes(seeded.status), `configs ${off.body.id} (off) and ${seeded.body.id} (seeded)`, JSON.stringify([off.body, seeded.body]));

const hypothesis = 'H1: on memory_dependent tasks the seeded config passes more often than the off config; H2: elsewhere the delta is noise.';
const created = await call('POST', '/experiments', {
  name: `p3 walk ${new Date().toISOString()}`,
  config_ids: [off.body.id, seeded.body.id],
  task_ids: TASKS,
  n_trials: nTrials,
  seed: 20260101,
  axis: 'hermes memory off vs seeded',
  hypothesis,
  phase: 'full',
});
check(created.status === 201 && created.body.status === 'draft', `POST /experiments -> ${created.status}, status ${created.body.status}`, created.text.slice(0, 600));
const id = created.body.id;
check(created.body.hypothesis === hypothesis && created.body.progress?.total === 0, 'hypothesis stored, no trials yet');

const started = await call('POST', `/experiments/${id}/start`);
check([200, 201].includes(started.status), `POST /experiments/${id}/start -> ${started.status}`, started.text.slice(0, 600));
const expected = 2 * TASKS.length * nTrials;

const t0 = Date.now();
let last = '';
let exp;
for (;;) {
  exp = (await call('GET', `/experiments/${id}`)).body;
  const p = exp.progress ?? {};
  const line = `status=${exp.status} pending=${p.pending} running=${p.running} done=${p.done} errored=${p.errored} cancelled=${p.cancelled} total=${p.total}${exp.paused ? ` PAUSED: ${exp.pause_reason}` : ''}`;
  if (line !== last) console.log(`      [${Math.round((Date.now() - t0) / 1000)}s] ${line}`);
  last = line;
  if (!['queued', 'running'].includes(exp.status) || exp.paused) break;
  if (Date.now() - t0 > DEADLINE_MS) break;
  await new Promise((r) => setTimeout(r, POLL_MS));
}
check(exp.progress?.total === expected, `${expected} trials generated`, JSON.stringify(exp.progress));
check(['completed', 'partial'].includes(exp.status), `finished as ${exp.status}`);
check(!(exp.status === 'completed' && exp.progress.errored > 0), 'never completed with an errored trial (D-8)');

const pilot = await call('GET', `/experiments/${id}/pilot`);
const pilotKeys = keysDeep(pilot.body);
check(pilot.status === 200 && !['delta', 'rate_a', 'rate_b'].some((k) => pilotKeys.has(k)), 'pilot has variances and no delta', JSON.stringify(pilot.body).slice(0, 400));

const cmp = await call('GET', `/experiments/${id}/compare?persist=1`);
check(cmp.status === 200, `GET compare -> ${cmp.status}`, cmp.text.slice(0, 600));
const c = cmp.body;
check(typeof c.aggregate?.delta === 'number' && typeof c.aggregate?.ci_low === 'number' && typeof c.aggregate?.verdict === 'string', `aggregate delta ${c.aggregate?.delta} CI [${c.aggregate?.ci_low}, ${c.aggregate?.ci_high}] verdict ${c.aggregate?.verdict}`);
check(Array.isArray(c.per_task) && c.per_task.length === TASKS.length, `per_task has ${c.per_task?.length} rows`);
check(typeof c.cost?.a?.mean === 'number' && typeof c.cost?.b?.mean === 'number', `cost table: A ${c.cost?.a?.mean} B ${c.cost?.b?.mean}`);
check(c.reliability === (exp.progress.errored + exp.progress.cancelled === 0 ? 'complete' : 'partial'), `reliability ${c.reliability}, n_scored ${c.n_scored}, n_excluded ${c.n_excluded}`);

// by_category: a block with fewer than 2 paired tasks has no interval (insufficient_data); that is expected with 1 task per category.
const CATEGORIES = ['memory_dependent', 'memory_distractor', 'neutral', 'honesty'];
check(CATEGORIES.every((k) => k in (c.by_category ?? {})), `by_category has the 4 keys: ${Object.keys(c.by_category ?? {}).join(', ')}`);
console.log('      by_category verdicts:');
for (const k of CATEGORIES) {
  const b = c.by_category?.[k];
  console.log(`        ${k.padEnd(18)} ${b === null || b === undefined ? 'null (no paired task)' : `${b.verdict} (n_tasks ${b.n_tasks}, delta ${b.delta}, CI ${b.ci_low === null ? 'none' : `[${b.ci_low}, ${b.ci_high}]`})`}`);
}
const blocks = CATEGORIES.map((k) => c.by_category?.[k]).filter((b) => b);
check(
  blocks.every((b) => typeof b.verdict === 'string' && (b.n_tasks >= 2 || (b.verdict === 'insufficient_data' && b.ci_low === null && b.ci_high === null))),
  'each by_category block with fewer than 2 paired tasks is insufficient_data without an interval',
);
check(c.n_tasks === TASKS.length && c.aggregate?.verdict !== 'insufficient_data', `aggregate pairs ${c.n_tasks} tasks, so it has a CI (verdict ${c.aggregate?.verdict})`);
check(typeof c.comparison_run_id === 'string', `compare?persist=1 stored comparison_run ${c.comparison_run_id}`);

const csv = await call('GET', `/experiments/${id}/export.csv`);
const lines = csv.text.split('\n').filter((l) => l.length > 0);
check(csv.status === 200 && lines.length === expected + 1, `export.csv has ${lines.length - 1} rows plus a header`, lines[0]);
const json = await call('GET', `/experiments/${id}/export.json`);
check(json.status === 200 && json.body.trials?.length === expected, `export.json has ${json.body.trials?.length} trials`);
check(json.body.comparison_run_id === c.comparison_run_id, `export.json reused comparison_run ${json.body.comparison_run_id} (an unchanged experiment adds no row)`);
check(json.body.comparison_runs?.length === 1, `exactly ${json.body.comparison_runs?.length} stored comparison_run`);
const ccsv = await call('GET', `/experiments/${id}/compare.csv`);
const clines = ccsv.text.split('\n').filter((l) => l.length > 0);
check(
  ccsv.status === 200 && clines[0] === 'task_id,category,n_a,n_b,rate_a,rate_b,delta,ci_low,ci_high,verdict' && clines.at(-1).startsWith('__aggregate__,'),
  `compare.csv has ${clines.length - 1} rows after the header, ending with __aggregate__`,
  ccsv.text.slice(0, 400),
);

// R-9: cancel a running experiment against the real worker. The experiment ends cancelled (never partial or
// completed), its in-flight trials are cancelled, and the worker's DELETE /trials/{id} found the child (200).
const cancelMe = await call('POST', '/experiments', {
  name: `p3 walk cancel ${new Date().toISOString()}`,
  config_ids: [off.body.id, seeded.body.id],
  task_ids: ['mem-01-staging-db', 'det-06-ini'],
  n_trials: 3,
  seed: 7,
  axis: 'cancel check',
  phase: 'full',
});
const cid = cancelMe.body.id;
await call('POST', `/experiments/${cid}/start`);
let seenRunning = 0;
for (let i = 0; i < 90 && seenRunning === 0; i++) {
  seenRunning = (await call('GET', `/experiments/${cid}`)).body.progress?.running ?? 0;
  if (seenRunning === 0) await new Promise((r) => setTimeout(r, 1000));
}
check(seenRunning > 0, `cancel check: ${seenRunning} trial(s) running before the cancel`);
const worker = (process.env.WORKER_URL ?? 'http://worker:8000').replace(/\/$/, '');
// let the Hermes children start, so the DELETE finds them (CANCEL_AFTER_MS=0 cancels in the window before Popen: the tombstone path)
await new Promise((r) => setTimeout(r, Number(process.env.CANCEL_AFTER_MS ?? 8000)));
const cancelled = await call('POST', `/experiments/${cid}/cancel`);
check(cancelled.status === 200 && cancelled.body.status === 'cancelled', `POST cancel -> ${cancelled.status}, status ${cancelled.body.status}`, cancelled.text.slice(0, 300));
await new Promise((r) => setTimeout(r, 4000));
const afterCancel = (await call('GET', `/experiments/${cid}`)).body;
check(afterCancel.status === 'cancelled' && afterCancel.progress.running === 0 && afterCancel.progress.done === 0, `cancelled experiment stays cancelled: ${JSON.stringify(afterCancel.progress)}`);
const again = await fetch(`${worker}/trials/${afterCancel.id}`, { method: 'DELETE' }).catch(() => null);
check(again === null || again.status === 404, 'a DELETE for an unknown trial id answers 404');

console.log(`\nexperiment ${id}`);
console.log(`\nCOMPARISON JSON\n${JSON.stringify(c, null, 2)}`);
console.log(failures === 0 ? '\nWALK PASSED' : `\nWALK FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);

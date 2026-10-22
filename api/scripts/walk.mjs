// The P1 walk (cards/P1.md section 8, gate 4) as a script, so the same steps run against the
// compose stack and against a bare host stack.
//
//   node scripts/walk.mjs [api-url] [model-id]      defaults: http://localhost:3000 model-b
//
// 1. POST /configs with the Hermes memory-off settings of DESIGN 10.1: 201 and a config_hash.
// 2. The same body again: 200 and the same id.
// 3. POST /trials/adhoc for det-06-ini; the trace has message, tool_call, tool_result, api_call,
//    a final_response, and grader_results[0].passed is true.
// 4. The same with mem-01-staging-db under a memory-seeded config: the trace has a memory_read
//    event and the system prompt contains "pg-stage-07".
// Exits non-zero on the first broken expectation. Prints the 2 trial ids.
const api = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const modelId = process.argv[3] ?? 'model-b';

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
  return { status: res.status, body: json };
}

const settings = (memory) => ({
  tools: ['shell', 'files'],
  memory,
  skills: { enabled: false, preload: [] },
  temperature: 0,
  max_steps: 15,
  max_output_tokens: 2048,
  timeout_seconds: 300,
  harness_options: {},
});

const off = { name: 'hermes memory off', harness_id: 'hermes', model_id: modelId, settings: settings({ mode: 'off' }) };
const seeded = { name: 'hermes memory seeded', harness_id: 'hermes', model_id: modelId, settings: settings({ mode: 'seeded', fixture: 'team-memory-v1' }) };

console.log(`walk against ${api} with model ${modelId}`);
const health = await call('GET', '/health');
check(health.status === 200, 'GET /health', JSON.stringify(health.body));

const first = await call('POST', '/configs', off);
check(first.status === 201 || first.status === 200, `POST /configs (memory off) -> ${first.status}`, JSON.stringify(first.body));
check(/^[0-9a-f]{64}$/.test(first.body.config_hash ?? ''), `config_hash ${first.body.config_hash}`);
const second = await call('POST', '/configs', off);
check(second.status === 200 && second.body.id === first.body.id, `same body again -> ${second.status}, same id ${second.body.id}`, JSON.stringify(second.body));
console.log('      (a 200 on the first call only means this config already existed)');

async function trial(configId, taskId) {
  const run = await call('POST', '/trials/adhoc', { config_id: configId, task_id: taskId });
  check(run.status === 201, `POST /trials/adhoc ${taskId} -> ${run.status}`, JSON.stringify(run.body).slice(0, 600));
  const id = run.body?.trial?.id;
  const trace = id ? (await call('GET', `/trials/${id}/trace`)).body : {};
  const t = run.body?.trial ?? {};
  console.log(`      trial ${id}: status=${t.status} passed=${t.passed} exit=${t.exit_reason} steps=${t.steps} tokens=${t.input_tokens}/${t.output_tokens} cost=${t.cost_usd} latency_ms=${t.latency_ms} error=${t.error_class ?? '-'} ${t.error_message ?? ''}`);
  // A-7 evidence: the trial's token totals come from Hermes's session counters; the events carry
  // the per-call numbers. If an auxiliary call (title, compression) were counted, the totals would exceed the sum.
  const calls = (trace.events ?? []).filter((e) => e.kind === 'api_call' && e.status === 'ok');
  const sum = (k) => calls.reduce((n, e) => n + (e[k] ?? 0), 0);
  console.log(`      api_call events: ${calls.length} ok, tokens ${sum('input_tokens')}/${sum('output_tokens')} (session totals above)`);
  return { id, trial: t, trace };
}

const det = await trial(first.body.id, 'det-06-ini');
const kinds = new Set((det.trace.events ?? []).map((e) => e.kind));
for (const k of ['message', 'tool_call', 'tool_result', 'api_call']) check(kinds.has(k), `det-06-ini trace has a ${k} event`);
check(typeof det.trace.final_response === 'string' && det.trace.final_response.length > 0, `final_response: ${JSON.stringify(det.trace.final_response)}`);
check(det.trace.grader_results?.[0]?.passed === true, 'grader_results[0].passed = true', JSON.stringify(det.trace.grader_results));

const seededConfig = await call('POST', '/configs', seeded);
check(seededConfig.status === 201 || seededConfig.status === 200, `POST /configs (memory seeded) -> ${seededConfig.status}`, JSON.stringify(seededConfig.body));
const mem = await trial(seededConfig.body.id, 'mem-01-staging-db');
check((mem.trace.events ?? []).some((e) => e.kind === 'memory_read'), 'mem-01 trace has a memory_read event');
check((mem.trace.system_prompt ?? '').includes('pg-stage-07'), 'the system prompt contains "pg-stage-07"');
check(mem.trace.grader_results?.[0]?.passed === true, 'mem-01 grader_results[0].passed = true', JSON.stringify(mem.trace.grader_results));

console.log(`\ntrial ids: ${det.id} (det-06-ini), ${mem.id} (mem-01-staging-db)`);
console.log(failures === 0 ? 'WALK PASSED' : `WALK FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);

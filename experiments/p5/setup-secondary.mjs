// P5 S5: the secondary experiment of DESIGN 10.3: Hermes with memory off, model A vs model B, N = 3 (the primary's N).
//
//   node experiments/p5/setup-secondary.mjs [api-url]      default api: http://127.0.0.1:3200
//
// Config A is model-a (anthropic/claude-haiku-5.5), config B is the primary experiment's memory-off config on model-b
// (same row: POST /configs answers 200 with the existing id). Everything else is identical to the primary.
// The hypothesis is committed with the draft, before any trial runs.
const api = (process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:3200').replace(/\/$/, '');

async function call(method, path, body) {
  const res = await fetch(`${api}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 800)}`);
  return { status: res.status, body: json };
}

const settings = {
  tools: ['shell', 'files'],
  memory: { mode: 'off' },
  skills: { enabled: false, preload: [] },
  temperature: 0,
  max_steps: 15,
  max_output_tokens: 2048,
  timeout_seconds: 300,
  harness_options: { providers_ignored: ['Darkbloom', 'Groq'] },
};
const a = await call('POST', '/configs', { name: 'hermes memory off, claude-haiku-5.5', harness_id: 'hermes', model_id: 'model-a', settings });
const b = await call('POST', '/configs', { name: 'hermes memory off', harness_id: 'hermes', model_id: 'model-b', settings });
console.log(`config A (model-a) ${a.status} id ${a.body.id} hash ${a.body.config_hash}`);
console.log(`config B (model-b) ${b.status} id ${b.body.id} hash ${b.body.config_hash}`);

const taskIds = (await call('GET', '/tasks')).body.map((t) => t.id).sort();
const hypothesis =
  'HS1: with memory off for both, the 5 non-judged memory_dependent tasks fail under both models (delta 0 there); the two models differ, if at all, on the other tasks.\n' +
  'HS2: the larger and dearer model (model-a) passes at least as many tasks as model-b in aggregate, at a higher cost per trial and with fewer calls per trial.\n' +
  'Caveat stated in advance: model-a is also the judge, so on the 5 judge-graded tasks it may be favoured (self-preference, DESIGN 13.2).';
const created = await call('POST', '/experiments', {
  name: 'P5 secondary: model-a vs model-b, hermes memory off',
  config_ids: [a.body.id, b.body.id],
  task_ids: taskIds,
  n_trials: 3,
  seed: 20261026,
  axis: 'model: claude-haiku-5.5 vs gpt-oss-20b, hermes memory off',
  hypothesis,
  phase: 'full',
});
console.log(`experiment ${created.body.id} status ${created.body.status}`);
const started = await call('POST', `/experiments/${created.body.id}/start`);
console.log(`started at ${new Date().toISOString()}: ${started.body.status} ${JSON.stringify(started.body.progress)}`);

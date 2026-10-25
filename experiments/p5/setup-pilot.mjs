// P5 S1: create the 2 configs of DESIGN 10.1 and the draft experiment (phase pilot, N = 3), then start it.
//
//   node experiments/p5/setup-pilot.mjs [api-url] [--no-start]      default api: http://127.0.0.1:3200
//
// The hypothesis is read from DESIGN.md 10.1 (H1 to H3, verbatim, lines between "H1:" and the blank line before
// "### 10.2"), so the stored text cannot drift from the document. Configs are created through the API; POST /configs
// answers 201 and then 200 with the same id for identical settings (D-3), so the script is safe to repeat.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const api = (process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:3200').replace(/\/$/, '');
const start = !process.argv.includes('--no-start');
const SEED = 20261025;
const MODEL_ID = 'model-b'; // openai/gpt-oss-20b, STATE.md P1

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
  if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 800)}`);
  return { status: res.status, body: json };
}

const design = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'DESIGN.md'), 'utf8').replace(/\r\n/g, '\n');
const from = design.indexOf('\nH1: on `memory_dependent`');
const to = design.indexOf('\n\n### 10.2');
if (from < 0 || to < 0) throw new Error('could not find H1 to H3 in DESIGN.md 10.1');
const hypothesis = design.slice(from + 1, to);

const settings = (memory) => ({
  tools: ['shell', 'files'],
  memory,
  skills: { enabled: false, preload: [] },
  temperature: 0,
  max_steps: 15,
  max_output_tokens: 2048,
  timeout_seconds: 300,
  harness_options: { providers_ignored: ['Darkbloom', 'Groq'] }, // DESIGN 13.5
});

const off = await call('POST', '/configs', { name: 'hermes memory off', harness_id: 'hermes', model_id: MODEL_ID, settings: settings({ mode: 'off' }) });
const seeded = await call('POST', '/configs', {
  name: 'hermes memory seeded',
  harness_id: 'hermes',
  model_id: MODEL_ID,
  settings: settings({ mode: 'seeded', fixture: 'team-memory-v1' }),
});
console.log(`config A (off)    ${off.status} id ${off.body.id} hash ${off.body.config_hash}`);
console.log(`config B (seeded) ${seeded.status} id ${seeded.body.id} hash ${seeded.body.config_hash}`);

const tasks = (await call('GET', '/tasks')).body;
const taskIds = tasks.map((t) => t.id).sort();
console.log(`${taskIds.length} tasks`);
if (taskIds.length !== 22) throw new Error(`expected 22 tasks, got ${taskIds.length}`);

const created = await call('POST', '/experiments', {
  name: 'P5 primary: hermes memory off vs seeded',
  config_ids: [off.body.id, seeded.body.id],
  task_ids: taskIds,
  n_trials: 3,
  seed: SEED,
  axis: 'hermes memory off vs seeded',
  hypothesis,
  phase: 'pilot',
});
console.log(`experiment ${created.body.id} status ${created.body.status} phase ${created.body.phase} n_trials ${created.body.n_trials} seed ${SEED}`);
console.log('hypothesis stored:\n' + created.body.hypothesis);

if (start) {
  const started = await call('POST', `/experiments/${created.body.id}/start`);
  console.log(`started at ${new Date().toISOString()}: status ${started.body.status}, progress ${JSON.stringify(started.body.progress)}`);
}

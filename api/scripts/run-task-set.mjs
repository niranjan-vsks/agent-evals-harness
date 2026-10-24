// Runs tasks once each through POST /trials/adhoc and prints a table (cards/P2.md slice S4).
//
//   node scripts/run-task-set.mjs [--api URL] [--model model-b] [--harness hermes] [--memory off|seeded|both]
//                                 [--tasks id,id,...] [--repeat N] [--out file.jsonl]
//                                 [--harness-options '{}']   default: {"providers_ignored":["Darkbloom","Groq"]}
//
// --memory off     every selected task under the memory-off config
// --memory seeded  only the tasks whose discriminates includes "memory", under the seeded config
// --memory both    off for every selected task, plus seeded for the memory-axis tasks (default)
// Rows are printed as they finish and appended to --out as JSON lines (trial id, task, config,
// passed, exit reason, steps, tokens, cost, latency, grader details). Settings are DESIGN 10.1.
import { appendFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const api = (args.api ?? 'http://localhost:3000').replace(/\/$/, '');
const modelId = args.model ?? 'model-b';
const harness = args.harness ?? 'hermes';
const memoryMode = args.memory ?? 'both';
const repeat = Number(args.repeat ?? 1);
if (!Number.isInteger(repeat) || repeat < 1) throw new Error(`--repeat must be a positive integer, got ${args.repeat}`);
if (!['off', 'seeded', 'both'].includes(memoryMode)) throw new Error(`--memory must be off, seeded or both, got ${memoryMode}`);

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

// Two OpenRouter providers of model-b fail Hermes's trials (DESIGN 13.5): Darkbloom answers HTTP 502 on some conversations and Groq rejects the model's tool calls. Left out unless told otherwise.
const harnessOptions = args['harness-options'] ? JSON.parse(args['harness-options']) : { providers_ignored: ['Darkbloom', 'Groq'] };
const settings = (memory) => ({
  tools: ['shell', 'files'],
  memory,
  skills: { enabled: false, preload: [] },
  temperature: 0,
  max_steps: 15,
  max_output_tokens: 2048,
  timeout_seconds: 300,
  harness_options: harnessOptions,
});

async function config(label, memory) {
  const res = await call('POST', '/configs', { name: `${harness} ${label}${args['harness-options'] ? ' ' + args['harness-options'] : ''}`, harness_id: harness, model_id: modelId, settings: settings(memory) });
  if (![200, 201].includes(res.status)) throw new Error(`POST /configs (${label}) -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

const all = (await call('GET', '/tasks')).body;
const wanted = args.tasks ? new Set(args.tasks.split(',')) : null;
const unknown = wanted ? [...wanted].filter((id) => !all.some((t) => t.id === id)) : [];
if (unknown.length) throw new Error(`unknown task id(s): ${unknown.join(', ')}`);
const tasks = all.filter((t) => !wanted || wanted.has(t.id)).sort((a, b) => a.id.localeCompare(b.id));
const offId = memoryMode === 'seeded' ? null : await config('memory off', { mode: 'off' });
const seededId = memoryMode === 'off' ? null : await config('memory seeded', { mode: 'seeded', fixture: 'team-memory-v1' });

const plan = [];
for (const t of tasks) {
  const onAxis = t.discriminates.includes('memory');
  for (let r = 0; r < repeat; r++) {
    if (offId) plan.push({ task: t, label: 'off', configId: offId });
    if (seededId && onAxis) plan.push({ task: t, label: 'seeded', configId: seededId });
  }
}

if (plan.length === 0) throw new Error('nothing to run: no selected task matches --memory');
console.log(`api ${api}  harness ${harness}  model ${modelId}  ${plan.length} trial(s)`);
console.log('task                 memory  passed  exit               steps  tokens in/out   cost USD  latency  trial');
let failed = 0;
for (const { task, label, configId } of plan) {
  const res = await call('POST', '/trials/adhoc', { config_id: configId, task_id: task.id });
  const t = res.body?.trial ?? {};
  const graders = res.body?.grader_results ?? [];
  const line = [
    task.id.padEnd(20),
    label.padEnd(7),
    String(t.passed ?? (res.status === 201 ? t.status : `HTTP ${res.status}`)).padEnd(7),
    String(t.exit_reason ?? t.error_class ?? '-').padEnd(18),
    String(t.steps ?? '-').padEnd(6),
    `${t.input_tokens ?? '-'}/${t.output_tokens ?? '-'}`.padEnd(15),
    String(t.cost_usd ?? '-').padEnd(9),
    `${t.latency_ms ?? '-'}`.padEnd(8),
    t.id ?? '-',
  ].join(' ');
  console.log(line);
  if (t.status !== 'done') {
    failed += 1;
    console.log(`   errored: ${t.error_class} ${t.error_message ?? JSON.stringify(res.body).slice(0, 300)}`);
  }
  if (args.out) {
    appendFileSync(
      args.out,
      JSON.stringify({ task_id: task.id, memory: label, config_id: configId, trial_id: t.id, status: t.status, passed: t.passed, exit_reason: t.exit_reason, steps: t.steps, input_tokens: t.input_tokens, output_tokens: t.output_tokens, cost_usd: t.cost_usd, latency_ms: t.latency_ms, error_class: t.error_class, error_message: t.error_message, graders }) + '\n',
    );
  }
}
console.log(failed === 0 ? 'ALL TRIALS SCORED' : `${failed} trial(s) did not finish as done`);
process.exit(failed === 0 ? 0 : 1);

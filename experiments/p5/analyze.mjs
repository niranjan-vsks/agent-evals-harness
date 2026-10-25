// P5 analysis of a committed export: the numbers DESIGN.md 10.4 and 12.2 quote, computed from the file and nothing else.
//
//   node experiments/p5/analyze.mjs experiments/results/<experiment-id>.json [--json out.json] [--reveal-judged]
//
// Needs the export made with ?traces=1. Prints, in order:
//   1. trial census (status, exit reason, error class, retried trials)
//   2. per config: trials, steps, input and output tokens per trial and per call, cost, latency
//   3. spend: the trials' cost_usd (price_snapshot x tokens), Hermes's own estimate, the judge's tokens at the judge's price
//   4. data-quality counters: scored trials whose last error event has no HTTP status, final responses that are Hermes's
//      substitute notices, memory-off trials that touched the memory fixture or /tasks
//   5. the per-task table of the stored comparison, and trajectory candidates (DESIGN 10.4, card section 10 question 2)
// Nothing here is a statistic: the intervals come from the comparison_run in the export, not from this script.
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('usage: analyze.mjs <export.json> [--json out.json]');
// The 30 labelled items are all the judge-graded trials, so the judged tasks' pass rates would unblind the labeler (DESIGN 8.2):
// rows of judge-excluded tasks are left out of the printed per-task table and of the trajectory candidates unless asked for.
const reveal = process.argv.includes('--reveal-judged');
const outJson = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const exp = JSON.parse(readFileSync(file, 'utf8'));
const JUDGE_PRICE = { input: 0.1, output: 0.5 }; // model-a, api/seed/models.json (USD per million tokens)

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const r = (x, d = 1) => (x === null || x === undefined ? 'n/a' : Number(x.toFixed(d)).toLocaleString('en-US', { maximumFractionDigits: d }));
const countBy = (xs, f) => xs.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});

const cfgName = Object.fromEntries(exp.configs.map((c) => [c.id, c.name]));
const category = Object.fromEntries(exp.tasks.map((t) => [t.task_id, t.category]));
const trials = exp.trials;
const events = (t) => t.trace?.events ?? [];
const out = { experiment_id: exp.experiment.id };

// 1. census
const census = {
  n: trials.length,
  status: countBy(trials, (t) => t.status),
  exit_reason: countBy(trials, (t) => t.exit_reason ?? 'none'),
  error_class: countBy(trials.filter((t) => t.error_class), (t) => t.error_class),
  retried: trials.filter((t) => t.attempt_count > 1).length,
  max_attempts: Math.max(...trials.map((t) => t.attempt_count)),
  rate_limited: trials.filter((t) => t.rate_limit_events > 0).length,
};
out.census = census;
console.log('1. census');
console.log(JSON.stringify(census, null, 1));

// 2. per config
const perConfig = {};
for (const c of exp.configs) {
  const ts = trials.filter((t) => t.config_id === c.id && t.status === 'done');
  const calls = sum(ts.map((t) => t.api_calls ?? 0));
  perConfig[c.name] = {
    config_id: c.id,
    config_hash: c.config_hash,
    trials_done: ts.length,
    steps_mean: mean(ts.map((t) => t.steps ?? 0)),
    api_calls_mean: mean(ts.map((t) => t.api_calls ?? 0)),
    input_tokens_per_trial: mean(ts.map((t) => t.input_tokens ?? 0)),
    output_tokens_per_trial: mean(ts.map((t) => t.output_tokens ?? 0)),
    input_tokens_per_call: calls ? sum(ts.map((t) => t.input_tokens ?? 0)) / calls : null,
    output_tokens_per_call: calls ? sum(ts.map((t) => t.output_tokens ?? 0)) / calls : null,
    input_tokens_total: sum(ts.map((t) => t.input_tokens ?? 0)),
    output_tokens_total: sum(ts.map((t) => t.output_tokens ?? 0)),
    cost_usd_mean: mean(ts.map((t) => t.cost_usd ?? 0)),
    cost_usd_total: sum(ts.map((t) => t.cost_usd ?? 0)),
    harness_cost_usd_total: sum(ts.map((t) => t.harness_cost_usd ?? 0)),
    // `input_tokens` leaves out tokens the provider served from its cache (`cache_read_tokens`) and `cost_usd` prices them at 0, so
    // cost_usd is a floor when cache reads exist; the ceiling prices them at the full input price (STATE.md P1, found 4).
    cache_read_tokens_total: sum(ts.map((t) => t.cache_read_tokens ?? 0)),
    prompt_tokens_per_trial_with_cache: mean(ts.map((t) => (t.input_tokens ?? 0) + (t.cache_read_tokens ?? 0))),
    cost_usd_ceiling_total: sum(ts.map((t) => (t.cost_usd ?? 0) + ((t.cache_read_tokens ?? 0) * (t.price_snapshot?.input_price_per_mtok ?? 0)) / 1e6)),
    latency_s_mean: mean(ts.map((t) => (t.latency_ms ?? 0) / 1000)),
  };
}
out.per_config = perConfig;
console.log('\n2. per config');
for (const [name, p] of Object.entries(perConfig)) {
  console.log(
    `${name}: ${p.trials_done} done, ${r(p.steps_mean)} steps, ${r(p.input_tokens_per_trial, 0)} in / ${r(p.output_tokens_per_trial, 0)} out per trial, ` +
      `${r(p.input_tokens_per_call, 0)} in / ${r(p.output_tokens_per_call, 0)} out per call, cost ${r(p.cost_usd_mean, 6)} per trial (${r(p.cost_usd_total, 4)} total), ` +
      `harness estimate ${r(p.harness_cost_usd_total, 4)}, cache reads ${r(p.cache_read_tokens_total, 0)} tokens (cost ceiling ${r(p.cost_usd_ceiling_total, 4)}), ${r(p.latency_s_mean)} s`,
  );
}

// 2b. where the tokens go (H3): split by memory-dependent and other tasks, and the cost of the memory block per call.
// The first api_call of a trial sees only the system prompt and the task prompt, so for the same task the difference
// of the two configs' first-call input tokens is the size of the memory block as the model's tokenizer counts it.
const firstCallIn = (t) => events(t).find((e) => e.kind === 'api_call' && e.status === 'ok')?.input_tokens ?? null;
const split = {};
for (const c of exp.configs) {
  for (const [label, keep] of [['memory_dependent', (t) => category[t.task_id] === 'memory_dependent'], ['other_tasks', (t) => category[t.task_id] !== 'memory_dependent']]) {
    const ts = trials.filter((t) => t.config_id === c.id && t.status === 'done' && keep(t));
    const calls = sum(ts.map((t) => t.api_calls ?? 0));
    split[`${c.name} / ${label}`] = {
      trials: ts.length,
      steps_mean: mean(ts.map((t) => t.steps ?? 0)),
      input_tokens_per_trial: mean(ts.map((t) => t.input_tokens ?? 0)),
      input_tokens_per_call: calls ? sum(ts.map((t) => t.input_tokens ?? 0)) / calls : null,
      cost_usd_per_trial: mean(ts.map((t) => t.cost_usd ?? 0)),
    };
  }
}
const aCfg = exp.configs[0].id;
const bCfg = exp.configs[1].id;
const firstDiffs = [];
for (const task of exp.tasks.map((t) => t.task_id)) {
  const fa = mean(trials.filter((t) => t.task_id === task && t.config_id === aCfg).map(firstCallIn).filter((x) => x !== null));
  const fb = mean(trials.filter((t) => t.task_id === task && t.config_id === bCfg).map(firstCallIn).filter((x) => x !== null));
  if (fa !== null && fb !== null) firstDiffs.push({ task, a: fa, b: fb, diff: fb - fa });
}
out.token_split = split;
out.memory_block_tokens_per_call = { n_tasks: firstDiffs.length, mean_first_call_diff_b_minus_a: mean(firstDiffs.map((d) => d.diff)), min: Math.min(...firstDiffs.map((d) => d.diff)), max: Math.max(...firstDiffs.map((d) => d.diff)) };
const sysLen = (cfg) => mean(trials.filter((t) => t.config_id === cfg).map((t) => t.trace?.system_prompt?.length ?? 0));
out.system_prompt_chars_mean = { a: sysLen(aCfg), b: sysLen(bCfg) };
console.log('\n2b. tokens by task kind, and the memory block per call');
for (const [k, v] of Object.entries(split)) console.log(`${k}: ${v.trials} trials, ${r(v.steps_mean)} steps, ${r(v.input_tokens_per_trial, 0)} in/trial, ${r(v.input_tokens_per_call, 0)} in/call, ${r(v.cost_usd_per_trial, 6)} USD/trial`);
console.log(`first-call input tokens, B minus A, per task: mean ${r(out.memory_block_tokens_per_call.mean_first_call_diff_b_minus_a, 0)} (min ${r(out.memory_block_tokens_per_call.min, 0)}, max ${r(out.memory_block_tokens_per_call.max, 0)}) over ${firstDiffs.length} tasks; system prompt ${r(out.system_prompt_chars_mean.a, 0)} chars (A) vs ${r(out.system_prompt_chars_mean.b, 0)} (B)`);

// 3. spend
const judgeIn = [];
const judgeOut = [];
for (const t of trials)
  for (const g of t.grader_results ?? []) {
    if (g.grader_type !== 'llm_judge') continue;
    const u = g.details?.usage;
    if (u) (judgeIn.push(u.input_tokens ?? 0), judgeOut.push(u.output_tokens ?? 0));
  }
const judgeUsd = (sum(judgeIn) * JUDGE_PRICE.input + sum(judgeOut) * JUDGE_PRICE.output) / 1e6;
const candidateUsd = sum(trials.map((t) => t.cost_usd ?? 0));
out.spend = {
  candidate_usd: candidateUsd,
  harness_estimate_usd: sum(trials.map((t) => t.harness_cost_usd ?? 0)),
  judge_calls_graded: judgeIn.length,
  judge_input_tokens: sum(judgeIn),
  judge_output_tokens: sum(judgeOut),
  judge_usd: judgeUsd,
  total_usd: candidateUsd + judgeUsd,
  note: 'failed or retried attempts record no tokens (STATE.md P3, found 5); the judge tokens include its own retries; model-b is priced at the registry row (Darkbloom), see DESIGN 13.5',
};
console.log('\n3. spend');
console.log(JSON.stringify(out.spend, null, 1));

// 4. data quality
const lastError = (t) => [...events(t)].reverse().find((e) => e.kind === 'error');
const noStatusErrors = trials.filter((t) => t.status === 'done' && t.exit_reason === 'agent_error' && !Number.isInteger(lastError(t)?.http_status));
const NOTICE = /^(No reply: |The model's reply was cut off)/;
const notices = trials.filter((t) => NOTICE.test(t.trace?.final_response ?? ''));
const toolArgs = (t) => events(t).filter((e) => e.kind === 'tool_call').map((e) => JSON.stringify(e.args ?? {}));
// The agent's shell is not confined (DESIGN 13.6): the trial directory above the workspace holds spec.json (the graders) and hermes_home.
// Paths are absolute in practice (/work/trials/<id>/1/spec.json), so match the file names, not "../".
const readsSpec = trials.filter((t) => toolArgs(t).some((a) => /spec\.json/.test(a)));
const readsTasksDir = trials.filter((t) => toolArgs(t).some((a) => /(^|[^\w])\/tasks\b|_hidden|expected\//.test(a)));
const readsHermesHome = trials.filter((t) => toolArgs(t).some((a) => /hermes_home/.test(a)));
const touchedTasksDir = [...new Set([...readsSpec, ...readsTasksDir])];
const offCfg = exp.configs.find((c) => c.settings?.memory?.mode === 'off');
const memoryOffReadMemory = trials.filter((t) => t.config_id === offCfg?.id && events(t).some((e) => e.kind === 'memory_read'));
// Hermes's own retries are `api_call` events with status retry or error and no tokens; they carry no HTTP status when the provider
// answered with an empty reply. They are in no trial's token or cost totals.
const nonOk = (t) => events(t).filter((e) => e.kind === 'api_call' && e.status !== 'ok');
const retryTrials = trials.filter((t) => nonOk(t).length > 0);
out.hermes_retries = {
  non_ok_api_call_events: sum(trials.map((t) => nonOk(t).length)),
  by_status: countBy(trials.flatMap(nonOk), (e) => `${e.status}/http ${e.http_status ?? 'none'}`),
  trials: retryTrials.length,
  trials_by_config: countBy(retryTrials, (t) => cfgName[t.config_id]),
  trials_that_ended_on_the_substitute_notice: notices.filter((t) => nonOk(t).length > 0).map((t) => ({ id: t.id, task_id: t.task_id, config: cfgName[t.config_id], non_ok_events: nonOk(t).length })),
  trials_with_retries_that_passed: retryTrials.filter((t) => t.passed).length,
};
console.log('\n4a. hermes retries');
console.log(JSON.stringify(out.hermes_retries, null, 1));
out.data_quality = {
  scored_agent_error_without_http_status: noStatusErrors.map((t) => ({ id: t.id, task_id: t.task_id, config: cfgName[t.config_id], error: lastError(t)?.message ?? null })),
  hermes_substitute_notice_as_final_response: notices.map((t) => ({ id: t.id, task_id: t.task_id, config: cfgName[t.config_id], text: t.trace.final_response.slice(0, 80) })),
  trials_whose_tool_calls_name_tasks_dir_or_spec: touchedTasksDir.map((t) => ({ id: t.id, task_id: t.task_id, config: cfgName[t.config_id], reads_spec_json: readsSpec.includes(t) })),
  trials_that_read_spec_json: readsSpec.length,
  trials_that_named_hermes_home: readsHermesHome.length,
  memory_off_trials_with_memory_read_event: memoryOffReadMemory.length,
  trials_without_trace: trials.filter((t) => t.status === 'done' && !t.trace).length,
};
console.log('\n4. data quality');
console.log(JSON.stringify(out.data_quality, null, 1));

// 5. the stored comparison and the trajectory candidates
const run = exp.comparison_runs?.[exp.comparison_runs.length - 1];
const cmp = run?.result;
if (cmp) {
  out.comparison_run_id = run.id;
  console.log(`\n5. comparison_run ${run.id} (stats ${cmp.stats_version}, seed ${cmp.aggregate?.seed})`);
  const ci = (b) => (b && b.ci_low !== null ? `[${r(b.ci_low, 3)}, ${r(b.ci_high, 3)}]` : 'no interval');
  console.log(`aggregate: A ${r(cmp.aggregate.p_a, 3)} B ${r(cmp.aggregate.p_b, 3)} delta ${r(cmp.aggregate.delta, 3)} ${ci(cmp.aggregate)} ${cmp.aggregate.verdict} min_detectable ${r(cmp.aggregate.min_detectable, 3)}`);
  for (const [k, b] of Object.entries(cmp.by_category ?? {})) if (b) console.log(`  ${k}: n_tasks ${b.n_tasks} A ${r(b.p_a, 3)} B ${r(b.p_b, 3)} delta ${r(b.delta, 3)} ${ci(b)} ${b.verdict}`);
  console.log(`sign test: A won ${cmp.sign_test.a_wins}, B won ${cmp.sign_test.b_wins}, tied ${cmp.sign_test.ties}, p ${r(cmp.sign_test.p_value, 4)}`);
  console.log('per task (task, category, rate A, rate B, delta, direction only):');
  for (const p of cmp.per_task.filter((q) => reveal || !q.judge_excluded)) console.log(`  ${p.task_id.padEnd(20)} ${String(p.category).padEnd(22)} ${r(p.rate_a, 2)} ${r(p.rate_b, 2)} ${r(p.delta, 2)}${p.judge_excluded ? ' (judge-excluded)' : ''}`);

  const cell = (task, cfg) => trials.filter((t) => t.task_id === task && t.config_id === cfg && t.status === 'done');
  const aId = cmp.config_a.id;
  const bId = cmp.config_b.id;
  if (!reveal) console.log('  (judge-graded tasks withheld until labels.jsonl is committed; --reveal-judged shows them)');
  const cand = { memory_dependent_off_failed_seeded_passed: [], memory_distractor: [], most_surprising_outside_memory: null };
  for (const p of cmp.per_task) {
    if (p.category === 'memory_dependent' && (reveal || !p.judge_excluded)) {
      const off = cell(p.task_id, offCfg.id).filter((t) => !t.passed);
      const on = cell(p.task_id, offCfg.id === aId ? bId : aId).filter((t) => t.passed && events(t).some((e) => e.kind === 'memory_read'));
      if (off.length && on.length) cand.memory_dependent_off_failed_seeded_passed.push({ task_id: p.task_id, off_failed: off.map((t) => t.id), seeded_passed_with_memory_read: on.map((t) => t.id) });
    }
    if (p.category === 'memory_distractor') {
      const worse = p.rate_a < p.rate_b ? aId : p.rate_b < p.rate_a ? bId : null;
      cand.memory_distractor.push({
        task_id: p.task_id,
        rate_a: p.rate_a,
        rate_b: p.rate_b,
        worse_config: worse ? cfgName[worse] : 'tied',
        failed_trials: trials.filter((t) => t.task_id === p.task_id && t.status === 'done' && !t.passed).map((t) => ({ id: t.id, config: cfgName[t.config_id] })),
      });
    }
  }
  const outside = cmp.per_task.filter((p) => p.category !== 'memory_dependent' && (reveal || !p.judge_excluded)).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  cand.most_surprising_outside_memory = outside[0] ?? null;
  out.trajectory_candidates = cand;
  console.log('\ntrajectory candidates (card section 10 question 2)');
  console.log(JSON.stringify(cand, null, 1));
}

if (outJson) writeFileSync(outJson, JSON.stringify(out, null, 2) + '\n');

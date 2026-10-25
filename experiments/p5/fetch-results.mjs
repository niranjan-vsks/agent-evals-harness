// P5 S4: persist the comparison, then download the export (with traces), compare.csv and trials csv into experiments/results/.
//
//   node experiments/p5/fetch-results.mjs <experiment-id> [api-url]
//
// Order matters: compare?persist=1 stores the comparison_run first, so export.json and compare.csv reuse that same row
// (the API reuses the newest row when the result is identical). Also checks gate 5 of cards/P5.md: the stored result
// equals a fresh GET compare?persist=0, field for field.
import { writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const id = process.argv[2];
const api = (process.argv[3] ?? 'http://127.0.0.1:3200').replace(/\/$/, '');
if (!id) throw new Error('usage: fetch-results.mjs <experiment-id> [api-url]');
const dir = new URL('../results/', import.meta.url);
const get = async (path) => {
  const res = await fetch(`${api}${path}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return text;
};

const persisted = JSON.parse(await get(`/experiments/${id}/compare?persist=1`));
console.log(`comparison_run ${persisted.comparison_run_id}`);
const exportText = await get(`/experiments/${id}/export.json?traces=1`);
writeFileSync(new URL(`${id}.json`, dir), exportText);
writeFileSync(new URL(`${id}-compare.csv`, dir), await get(`/experiments/${id}/compare.csv`));
writeFileSync(new URL(`${id}-trials.csv`, dir), await get(`/experiments/${id}/export.csv`));

const exp = JSON.parse(exportText);
const fresh = JSON.parse(await get(`/experiments/${id}/compare?persist=0`));
const stored = exp.comparison_runs.find((r) => r.id === exp.comparison_run_id)?.result;
const strip = (p) => {
  const { comparison_run_id, ...rest } = p;
  return rest;
};
console.log(`export.json: ${exportText.length} bytes, ${exp.trials.length} trials, ${exp.comparison_runs.length} comparison_run(s), comparison_run_id ${exp.comparison_run_id}`);
console.log(`gate 5: stored result equals a fresh compare?persist=0, field for field: ${isDeepStrictEqual(strip(stored), strip(fresh))}`);

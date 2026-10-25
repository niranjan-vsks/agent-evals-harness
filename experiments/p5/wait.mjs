// Poll GET /experiments/:id until it stops running, printing each change in the progress counts.
//
//   node experiments/p5/wait.mjs <experiment-id> [api-url]
//
// Exits 0 on completed, 2 on partial, 3 when paused or cancelled, 4 when the deadline (6 hours) passes.
// Reads progress only; it never calls /compare.
const id = process.argv[2];
const api = (process.argv[3] ?? 'http://127.0.0.1:3200').replace(/\/$/, '');
if (!id) throw new Error('usage: wait.mjs <experiment-id> [api-url]');
const t0 = Date.now();
let last = '';
for (;;) {
  let exp;
  try {
    exp = await (await fetch(`${api}/experiments/${id}`)).json();
  } catch (e) {
    console.log(`[${Math.round((Date.now() - t0) / 1000)}s] fetch failed: ${e.message}`);
    await new Promise((r) => setTimeout(r, 30_000));
    continue;
  }
  const p = exp.progress ?? {};
  const line = `status=${exp.status} pending=${p.pending} running=${p.running} done=${p.done} errored=${p.errored} cancelled=${p.cancelled} total=${p.total}${exp.paused ? ` PAUSED: ${exp.pause_reason}` : ''}`;
  if (line !== last) console.log(`[${new Date().toISOString()}] ${line}`);
  last = line;
  if (exp.paused) process.exit(3);
  if (exp.status === 'completed') process.exit(0);
  if (exp.status === 'partial') process.exit(2);
  if (exp.status === 'cancelled') process.exit(3);
  if (Date.now() - t0 > 6 * 3600_000) process.exit(4);
  await new Promise((r) => setTimeout(r, 30_000));
}

/**
 * A REAL http server standing in for the worker, so the scheduler is tested through the real WorkerClient
 * (P3 card section 6). Point WORKER_URL at `url`. Outcome by the SUFFIX of spec.task.id:
 *
 *   -ok     done, passed             -fail   done, passed false
 *   -429    the first run of a trial answers an errored result rate_limited; every later run succeeds
 *   -crash  always an errored result worker_crash
 *   -400    always an errored result config_invalid
 *   -bp     HTTP 429 {"detail":"worker at capacity"} the first `backpressureCount` runs of a trial, then success
 *   -slow   waits for the gate (closeGate/openGate) or `slowTimeoutMs`, then succeeds
 *
 * Anything else behaves like -ok.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { doneResult, MANIFEST } from '../src/test-support/app';
import { erroredResult } from '../src/trials/ingest';
import { TrialResult, TrialSpec } from '../src/worker-client/types';

export interface RecordedRequest {
  method: string;
  path: string;
}

export class FakeWorkerServer {
  url = '';
  requests: RecordedRequest[] = [];
  /** Every body POSTed to /trials/run, in arrival order. */
  runs: TrialSpec[] = [];
  /** Trial ids DELETEd while in flight (200) and otherwise (404). */
  cancelled: string[] = [];
  missed: string[] = [];
  /** How many times each -bp trial is refused before it succeeds. */
  backpressureCount = 1;
  slowTimeoutMs = 10_000;
  inFlight = 0;
  maxInFlight = 0;

  private server: Server | null = null;
  private readonly held = new Set<string>();
  private readonly seen429 = new Set<string>();
  private readonly bpRefused = new Map<string, number>();
  private gate: Promise<void> = Promise.resolve();
  private release: () => void = () => undefined;

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((ok) => this.server!.listen(0, '127.0.0.1', ok));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.openGate();
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((ok) => s.close(() => ok()));
  }

  reset(): void {
    this.requests = [];
    this.runs = [];
    this.cancelled = [];
    this.missed = [];
    this.backpressureCount = 1;
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.seen429.clear();
    this.bpRefused.clear();
    this.held.clear();
    this.openGate();
  }

  /** From now on -slow trials wait until openGate(). */
  closeGate(): void {
    this.gate = new Promise<void>((ok) => (this.release = ok));
  }

  openGate(): void {
    this.release();
  }

  runsFor(taskId: string): TrialSpec[] {
    return this.runs.filter((s) => s.task.id === taskId);
  }

  runsOfTrial(trialId: string): TrialSpec[] {
    return this.runs.filter((s) => s.trial_id === trialId);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    this.requests.push({ method: req.method ?? '', path });
    try {
      if (req.method === 'GET' && path === '/adapters') return this.json(res, 200, MANIFEST);
      if (req.method === 'POST' && /^\/adapters\/[^/]+\/validate$/.test(path)) return this.json(res, 200, { errors: [] });
      if (req.method === 'POST' && path === '/trials/run') return await this.run(req, res);
      const del = /^\/trials\/([^/]+)$/.exec(path);
      if (req.method === 'DELETE' && del) {
        const id = decodeURIComponent(del[1]);
        if (this.held.has(id)) {
          this.cancelled.push(id);
          return this.json(res, 200, { cancelled: true });
        }
        this.missed.push(id);
        return this.json(res, 404, { detail: 'no such trial' });
      }
      this.json(res, 404, { detail: 'not found' });
    } catch (e) {
      this.json(res, 500, { detail: String(e) });
    }
  }

  private async run(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const spec = JSON.parse(Buffer.concat(chunks).toString('utf8')) as TrialSpec;
    this.runs.push(spec);
    const id = spec.task.id;
    const trialId = spec.trial_id;

    if (id.endsWith('-bp')) {
      const n = this.bpRefused.get(trialId) ?? 0;
      if (n < this.backpressureCount) {
        this.bpRefused.set(trialId, n + 1);
        return this.json(res, 429, { detail: 'worker at capacity' });
      }
    }

    this.held.add(trialId);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (id.endsWith('-slow')) {
        await Promise.race([this.gate, new Promise<void>((ok) => setTimeout(ok, this.slowTimeoutMs).unref())]);
      }
      this.json(res, 200, this.outcome(spec));
    } finally {
      this.inFlight--;
      this.held.delete(trialId);
    }
  }

  private outcome(spec: TrialSpec): TrialResult {
    const id = spec.task.id;
    const err = (cls: 'rate_limited' | 'worker_crash' | 'config_invalid', message: string): TrialResult => ({
      ...erroredResult(cls, message),
      trial_id: spec.trial_id,
      attempt: spec.attempt,
    });
    if (id.endsWith('-fail')) return doneResult(spec, { passed: false });
    if (id.endsWith('-crash')) return err('worker_crash', 'scripted crash');
    if (id.endsWith('-400')) return err('config_invalid', 'scripted config_invalid');
    if (id.endsWith('-429') && !this.seen429.has(spec.trial_id)) {
      this.seen429.add(spec.trial_id);
      return err('rate_limited', 'scripted rate limit');
    }
    return doneResult(spec);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }
}

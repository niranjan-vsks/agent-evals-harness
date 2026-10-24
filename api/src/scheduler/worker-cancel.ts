import { Logger } from '@nestjs/common';

const log = new Logger('WorkerCancel');

/**
 * DELETE /trials/{id} on the worker for each id (P3 card section 6). WorkerClient has no cancel and is not ours to
 * extend, so this talks to the worker with fetch; the base URL default matches WorkerClient. A 404 means the worker
 * is not running that trial any more, which is the outcome we wanted. Never throws.
 */
export async function cancelOnWorker(trialIds: string[], timeoutMs = 5_000): Promise<void> {
  const base = (process.env.WORKER_URL ?? 'http://localhost:8000').replace(/\/$/, '');
  await Promise.allSettled(
    trialIds.map(async (id) => {
      try {
        const res = await fetch(`${base}/trials/${encodeURIComponent(id)}`, { method: 'DELETE', signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok && res.status !== 404) log.warn(`DELETE /trials/${id} answered HTTP ${res.status}`);
      } catch (e) {
        log.warn(`DELETE /trials/${id} failed: ${(e as Error).message}`);
      }
    }),
  );
}

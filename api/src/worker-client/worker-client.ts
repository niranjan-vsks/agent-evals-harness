import { Injectable } from '@nestjs/common';
import { SettingsJson, TrialResult, TrialSpec, WorkerManifest } from './types';

/** Thrown when the worker cannot be reached or answers with something that is not a TrialResult. */
export class WorkerUnavailableError extends Error {}

/**
 * Typed HTTP client for the worker. The only place the API talks to it.
 * The run timeout is the trial's own wall clock plus 120 s (DESIGN 2.3): the worker enforces
 * timeout_seconds itself (R-2), so this only trips when the worker is gone.
 */
@Injectable()
export class WorkerClient {
  private get baseUrl(): string {
    return (process.env.WORKER_URL ?? 'http://localhost:8000').replace(/\/$/, '');
  }

  private async request<T>(path: string, init: RequestInit & { timeoutMs: number }): Promise<T> {
    const { timeoutMs, ...rest } = init;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...rest,
        headers: { 'content-type': 'application/json', ...(rest.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new WorkerUnavailableError(`worker ${path}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      throw new WorkerUnavailableError(`worker ${path} answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }

  adapters(): Promise<WorkerManifest> {
    return this.request<WorkerManifest>('/adapters', { method: 'GET', timeoutMs: 15_000 });
  }

  async validate(adapterId: string, settings: SettingsJson): Promise<string[]> {
    const body = await this.request<{ errors: string[] }>(`/adapters/${encodeURIComponent(adapterId)}/validate`, {
      method: 'POST',
      body: JSON.stringify(settings),
      timeoutMs: 15_000,
    });
    return body.errors;
  }

  runTrial(spec: TrialSpec): Promise<TrialResult> {
    return this.request<TrialResult>('/trials/run', {
      method: 'POST',
      body: JSON.stringify(spec),
      timeoutMs: (spec.settings.timeout_seconds + 120) * 1000,
    });
  }
}

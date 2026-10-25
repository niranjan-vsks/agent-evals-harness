// fetch wrapper. Errors surface the API's message body (cards/P4.md section 6): Nest answers
// {statusCode, message, ...} where `message` is a string or an array, and the adapter refusals, schema issues and
// reproduce problems arrive as `reasons`, `issues` and `problems` string arrays next to it.
import type {
  ComparePayload,
  Config,
  CreateConfigBody,
  CreateConfigResult,
  CreateExperimentBody,
  Experiment,
  ExperimentDetail,
  Harness,
  Model,
  PilotPayload,
  Task,
  Trace,
  Trial,
  TrialRow,
  TrialsFilter,
} from './types';

export const DEFAULT_API_BASE: string = import.meta.env.VITE_API_BASE ?? '/api';

let base = DEFAULT_API_BASE;

/** The store calls this when the base URL changes; every request reads it at call time. */
export function setApiBase(value: string): void {
  base = value.replace(/\/+$/, '');
}

export function getApiBase(): string {
  return base;
}

export class ApiError extends Error {
  readonly status: number;
  /** Detail lines from `reasons`, `issues` and `problems`, in that order, plus the entries of an array `message`. */
  readonly reasons: string[];
  readonly body: unknown;

  constructor(status: number, message: string, reasons: string[], body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.reasons = reasons;
    this.body = body;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Turns a failed response into an ApiError that carries what the API said. Exported for tests. */
export function errorFromBody(status: number, statusText: string, text: string): ApiError {
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: keep the text */
  }
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    const msg = o.message;
    const message = typeof msg === 'string' ? msg : Array.isArray(msg) ? msg.join('; ') : typeof o.error === 'string' ? o.error : statusText;
    const reasons = [...strings(o.reasons), ...strings(o.issues), ...strings(o.problems), ...(Array.isArray(msg) ? strings(msg) : [])];
    return new ApiError(status, message || `HTTP ${status}`, reasons, body);
  }
  const plain = typeof body === 'string' && body.trim() ? body.trim().slice(0, 500) : statusText || `HTTP ${status}`;
  return new ApiError(status, plain, [], body);
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, init);
  } catch (e) {
    throw new ApiError(0, `cannot reach the API at ${base || '/'}: ${(e as Error).message}`, [], null);
  }
  if (!res.ok) throw errorFromBody(res.status, res.statusText, await res.text());
  return res;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await send(path, init)).json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

const query = (params: Record<string, string | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
};

const id = encodeURIComponent;

export const api = {
  listModels: () => request<Model[]>('/models'),
  listHarnesses: () => request<Harness[]>('/harnesses'),
  listTasks: () => request<Task[]>('/tasks'),

  listConfigs: () => request<Config[]>('/configs'),
  getConfig: (configId: string) => request<Config>(`/configs/${id(configId)}`),
  /** 201 created or 200 existing; the status tells which. A refusal throws an ApiError whose `reasons` are the adapter's. */
  async createConfig(body: CreateConfigBody): Promise<CreateConfigResult> {
    const res = await send('/configs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { created: res.status === 201, config: (await res.json()) as Config };
  },

  listExperiments: () => request<Experiment[]>('/experiments'),
  getExperiment: (expId: string) => request<ExperimentDetail>(`/experiments/${id(expId)}`),
  createExperiment: (body: CreateExperimentBody) => post<ExperimentDetail>('/experiments', body),
  startExperiment: (expId: string) => post<ExperimentDetail>(`/experiments/${id(expId)}/start`),
  extendExperiment: (expId: string, nTrials: number) => post<ExperimentDetail>(`/experiments/${id(expId)}/extend`, { n_trials: nTrials }),
  cancelExperiment: (expId: string) => post<ExperimentDetail>(`/experiments/${id(expId)}/cancel`),
  resumeExperiment: (expId: string) => post<ExperimentDetail>(`/experiments/${id(expId)}/resume`),
  reproduceExperiment: (expId: string) => post<ExperimentDetail>(`/experiments/${id(expId)}/reproduce`),
  listTrials: (expId: string, filter: TrialsFilter = {}) => request<TrialRow[]>(`/experiments/${id(expId)}/trials${query({ ...filter })}`),

  compare: (expId: string, a?: string, b?: string) => request<ComparePayload>(`/experiments/${id(expId)}/compare${query({ a, b })}`),
  pilot: (expId: string) => request<PilotPayload>(`/experiments/${id(expId)}/pilot`),

  getTrial: (trialId: string) => request<Trial>(`/trials/${id(trialId)}`),
  getTrace: (trialId: string) => request<Trace>(`/trials/${id(trialId)}/trace`),

  /** URLs for plain `<a href download>` links: the API sets Content-Disposition, nginx passes it through. */
  exportJsonUrl: (expId: string) => `${base}/experiments/${id(expId)}/export.json`,
  exportCsvUrl: (expId: string) => `${base}/experiments/${id(expId)}/export.csv`,
  compareCsvUrl: (expId: string, a?: string, b?: string) => `${base}/experiments/${id(expId)}/compare.csv${query({ a, b })}`,
};

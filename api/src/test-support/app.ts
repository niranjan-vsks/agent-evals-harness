import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsJson, TrialResult, TrialSpec, WorkerManifest } from '../worker-client/types';
import { WorkerClient } from '../worker-client/worker-client';

export const HERMES_VERSION = 'f4ac0bea1e';

export const MANIFEST: WorkerManifest = {
  adapters: [
    {
      id: 'hermes',
      version: HERMES_VERSION,
      capabilities: {
        tools: ['files', 'shell'],
        memory_modes: ['off', 'seeded'],
        memory_writes: true,
        skills: true,
        temperature: true,
        seed: false,
        system_prompt_capture: true,
      },
    },
  ],
  worker: { python: '3.14.0', platform: 'test', image_digest: null },
};

/** A scriptable stand-in for the worker, so the API is tested without Python. */
export class FakeWorker {
  manifest: WorkerManifest | Error = MANIFEST;
  validateErrors: string[] = [];
  validated: SettingsJson[] = [];
  runs: TrialSpec[] = [];
  run: (spec: TrialSpec) => TrialResult | Promise<TrialResult> = (spec) => doneResult(spec);

  async adapters(): Promise<WorkerManifest> {
    if (this.manifest instanceof Error) throw this.manifest;
    return this.manifest;
  }
  async validate(_id: string, settings: SettingsJson): Promise<string[]> {
    this.validated.push(settings);
    return this.validateErrors;
  }
  async runTrial(spec: TrialSpec): Promise<TrialResult> {
    this.runs.push(spec);
    return this.run(spec);
  }
}

export function doneResult(spec: TrialSpec, over: Partial<TrialResult> = {}, exit: 'completed' | 'timeout' | 'max_steps' = 'completed'): TrialResult {
  const passed = over.passed ?? exit === 'completed';
  return {
    trial_id: spec.trial_id,
    attempt: spec.attempt,
    status: 'done',
    harness: { id: spec.harness, version: HERMES_VERSION },
    outcome: {
      exit_reason: exit,
      final_response: exit === 'completed' ? 'FINAL: 8081' : null,
      steps: 2,
      usage: { input_tokens: 3000, output_tokens: 40, cache_read_tokens: 0, reasoning_tokens: 0, api_calls: 2 },
      harness_reported_cost_usd: 0,
      latency_ms: 1234,
    },
    passed,
    trace: {
      events: [
        { seq: 0, t_ms: 0, kind: 'message', role: 'system', content: 'You are Hermes', step: 1 },
        { seq: 1, t_ms: 1, kind: 'message', role: 'user', content: spec.task.prompt, step: 1 },
        { seq: 2, t_ms: 2, kind: 'api_call', step: 1, model: spec.model.slug, input_tokens: 1500, output_tokens: 20, latency_ms: 10, status: 'ok', http_status: 200 },
        { seq: 3, t_ms: 3, kind: 'tool_call', call_id: 'c1', step: 1, tool: 'shell', harness_tool: 'terminal', args: { command: 'cat config.ini' } },
        { seq: 4, t_ms: 4, kind: 'tool_result', call_id: 'c1', output: '{"output":"port = 8081"}', is_error: false, duration_ms: 5 },
        { seq: 5, t_ms: 5, kind: 'api_call', step: 2, model: spec.model.slug, input_tokens: 1500, output_tokens: 20, latency_ms: 10, status: 'ok', http_status: 200 },
        { seq: 6, t_ms: 6, kind: 'message', role: 'assistant', content: 'FINAL: 8081', step: 2 },
      ],
      system_prompt: 'You are Hermes',
      memory_initial: spec.memory_seed ?? {},
      memory_final: spec.memory_seed ?? {},
      skills_invoked: [],
      notes: [],
      final_response: exit === 'completed' ? 'FINAL: 8081' : null,
    },
    grader_results: [
      {
        grader_index: 0,
        grader_type: 'exact_match',
        passed,
        details: { extracted: '8081' },
        reasoning: null,
        judge_model_id: null,
        judge_prompt_hash: null,
        duration_ms: 1,
      },
    ],
    error_class: null,
    error_message: null,
    partial_trace: null,
    ...over,
  };
}

export async function createTestApp(worker: FakeWorker): Promise<{ app: INestApplication; prisma: PrismaService }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WorkerClient)
    .useValue(worker)
    .compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, prisma: app.get(PrismaService) };
}

/** A body for POST /configs; override pieces per test. */
export function configBody(over: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
  return {
    name: 'hermes memory off',
    harness_id: 'hermes',
    model_id: 'model-b',
    settings: {
      tools: ['shell', 'files'],
      memory: { mode: 'off' },
      skills: { enabled: false, preload: [] },
      temperature: 0,
      max_steps: 15,
      max_output_tokens: 2048,
      timeout_seconds: 300,
      harness_options: {},
      ...settings,
    },
    ...over,
  };
}

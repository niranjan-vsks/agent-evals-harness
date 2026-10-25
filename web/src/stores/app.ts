// Pinia holds state only for the API base URL and the list caches (cards/P4.md section 6).
import { defineStore } from 'pinia';
import { api, DEFAULT_API_BASE, setApiBase } from '../api/client';
import type { Config, Harness, Model, Task } from '../api/types';

const STORAGE_KEY = 'evals.apiBase';

function storedBase(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_API_BASE;
  } catch {
    return DEFAULT_API_BASE;
  }
}

export const useAppStore = defineStore('app', {
  state: () => ({
    apiBase: storedBase(),
    configs: null as Config[] | null,
    models: null as Model[] | null,
    harnesses: null as Harness[] | null,
    tasks: null as Task[] | null,
  }),
  actions: {
    /** Applies the base to the client. Called once at start and on every change. */
    applyBase(value?: string): void {
      if (value !== undefined) {
        this.apiBase = value.trim() || DEFAULT_API_BASE;
        try {
          localStorage.setItem(STORAGE_KEY, this.apiBase);
        } catch {
          /* private mode: the base lasts for this page load only */
        }
        this.configs = this.models = this.harnesses = this.tasks = null;
      }
      setApiBase(this.apiBase);
    },
    async loadConfigs(force = false): Promise<Config[]> {
      if (force || !this.configs) this.configs = await api.listConfigs();
      return this.configs;
    },
    async loadModels(force = false): Promise<Model[]> {
      if (force || !this.models) this.models = await api.listModels();
      return this.models;
    },
    async loadHarnesses(force = false): Promise<Harness[]> {
      if (force || !this.harnesses) this.harnesses = await api.listHarnesses();
      return this.harnesses;
    },
    async loadTasks(force = false): Promise<Task[]> {
      if (force || !this.tasks) this.tasks = await api.listTasks();
      return this.tasks;
    },
  },
});

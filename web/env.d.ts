/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

interface ImportMetaEnv {
  /** Overrides the API base URL (default `/api`, which nginx and the Vite dev server proxy to the API). */
  readonly VITE_API_BASE?: string;
}

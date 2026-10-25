import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// Dev: `/api/*` goes to the API on :3000 with the prefix stripped, which is what web/nginx.conf does in the container.
export default defineConfig({
  plugins: [vue()],
  // A per-checkout cache: parallel mirrors share one node_modules and must not share vite's cache inside it.
  cacheDir: '.vite-cache',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/__tests__/**/*.spec.ts'],
  },
});

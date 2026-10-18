import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Builds the static front-ends into dist/client, served by Workers Static Assets:
//   /        -> web/index.html        (landing page)
//   /u/      -> web/u/index.html      (public upload page; share token in the URL fragment)
//   /admin/  -> web/admin/index.html  (administrator dashboard, gated by the Worker)
export default defineConfig({
  root: resolve(import.meta.dirname, 'web'),
  publicDir: resolve(import.meta.dirname, 'web/public'),
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/client'),
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'web/index.html'),
        upload: resolve(import.meta.dirname, 'web/u/index.html'),
        admin: resolve(import.meta.dirname, 'web/admin/index.html'),
      },
    },
  },
  server: {
    proxy: { '/api': 'http://localhost:8787' },
  },
});

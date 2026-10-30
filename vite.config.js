import { defineConfig } from 'vite';

// `base: './'` keeps asset paths relative so the built app works from
// GitHub Pages, a sub-folder, or any static file server.
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});

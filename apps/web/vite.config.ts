import { defineConfig, type Plugin, transformWithEsbuild } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Vite plugin that compiles src/sw.ts → dist/sw.js during build.
 * Uses Vite's built-in esbuild transform — no extra dependencies needed.
 *
 * Only runs during `vite build` (apply: 'build'). In dev mode, the service
 * worker is not served — pwa.ts registration will silently fail, which is
 * intentional since SW caching interferes with HMR during development.
 */
function buildServiceWorker(): Plugin {
  return {
    name: 'build-service-worker',
    apply: 'build',
    async writeBundle(options) {
      const outDir = options.dir ?? path.resolve(__dirname, 'dist');
      const source = readFileSync(path.resolve(__dirname, 'src/sw.ts'), 'utf-8');
      const result = await transformWithEsbuild(source, 'sw.ts', {
        minify: true,
        target: 'es2020',
      });
      writeFileSync(path.resolve(outDir, 'sw.js'), result.code);
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), react(), buildServiceWorker()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    port: 5173,
    host: true,
  },
});

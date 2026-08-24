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

/**
 * Explicit vendor chunk groups.
 *
 * NOTE: this project builds with Rolldown (vite 8 / rolldown 1.x), so the option is
 * `output.advancedChunks.groups`; the legacy Rollup `output.manualChunks` is deprecated
 * on this bundler.
 *
 * ## Why this list is short
 *
 * What actually keeps the heavy libraries out of the initial load is route-level
 * `React.lazy` in `src/App.tsx` plus the dynamic `import('mermaid')` in
 * `src/components/MarkdownRenderer.tsx` — Rolldown emits a separate, non-preloaded
 * chunk for anything reachable only through a dynamic import.
 *
 * Adding a manual group for such a library is actively harmful: a group collapses all
 * matching modules into ONE chunk regardless of which dynamic boundary they sat behind,
 * so the chunk gets attached to the entry's *static* graph and ends up in
 * `index.html`'s `modulepreload` set. Measured on this codebase:
 *
 * | groups configured                    | eager JS (raw / gzip) | notes                                       |
 * | ------------------------------------ | --------------------- | ------------------------------------------- |
 * | mermaid + charts + flow + terminal…  | 3,036 kB / 908 kB     | all three preloaded; mermaid's own per-diagram splitting collapsed into one 2.7 MB chunk |
 * | terminal + markdown + react          | 965 kB / 286 kB       | `vendor-markdown` became preloaded instead  |
 * | terminal + react (this config)       | **719 kB / 211 kB**   | no heavy library in the eager set           |
 *
 * The same trap applies to *route* groups. Co-locating the `Project` shell with
 * `project-chat` to collapse their load waterfall — which is what this task originally
 * planned — produced one eager 1,199 kB / 343 kB gzip `route-project-chat` chunk, i.e.
 * the entire chat page downloaded on the login screen. That waterfall is instead
 * collapsed by starting both dynamic imports in parallel; see `src/App.tsx`.
 *
 * So `mermaid`, `recharts`, `@xyflow/react`, `react-markdown`, `remark-gfm` and
 * `prism-react-renderer` are deliberately NOT grouped — the bundler already isolates
 * them behind their routes, and grouping measurably regressed the initial load.
 * `apps/web/tests/playwright/lazy-route-chunks-audit.spec.ts` asserts none of them is
 * fetched on first paint, so a future group that reintroduces this fails CI.
 *
 * Only the top-level packages are matched; transitive dependencies are left to the
 * bundler because several (the `d3-*` family in particular) are shared between
 * `recharts` and `@xyflow/react`, and pinning a shared module into one group would drag
 * that whole group into the other route's load.
 *
 * - `vendor-terminal` — `@xterm/*` is reached only from the workspace route; the group
 *   gives it a stable, separately cacheable chunk name.
 * - `vendor-react` — reachable from the entry and therefore eager by design. Splitting
 *   it out means a deploy that changes only app code does not invalidate it.
 */
const VENDOR_CHUNK_GROUPS = [
  { name: 'vendor-terminal', packages: ['@xterm'] },
  { name: 'vendor-react', packages: ['react', 'react-dom', 'react-router', 'scheduler'] },
] as const;

/**
 * Matches `node_modules/<pkg>/` (including pnpm's nested `.pnpm/<id>/node_modules/`
 * layout) for any of `packages`.
 *
 * Anchoring on the separator stops `react` from also matching
 * `node_modules/react-markdown/`, and requiring the trailing separator stops `@xterm`
 * from matching a package merely prefixed with it.
 */
function nodeModulesGroupTest(packages: readonly string[]): RegExp {
  const alternatives = packages.map((pkg) => pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`[\\\\/]node_modules[\\\\/](?:${alternatives})[\\\\/]`);
}

export default defineConfig({
  plugins: [tailwindcss(), react(), buildServiceWorker()],
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        advancedChunks: {
          groups: VENDOR_CHUNK_GROUPS.map((group, index) => ({
            name: group.name,
            test: nodeModulesGroupTest(group.packages),
            // Earlier entries win, so the specific libraries are claimed before the
            // broad `vendor-react` group can absorb anything.
            priority: VENDOR_CHUNK_GROUPS.length - index,
          })),
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true,
    allowedHosts: true,
  },
});

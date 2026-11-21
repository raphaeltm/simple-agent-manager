import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@simple-agent-manager/providers': new URL(
        '../../packages/providers/src/index.ts',
        import.meta.url
      ).pathname,
      '@simple-agent-manager/shared': new URL('../../packages/shared/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    root: import.meta.dirname,
    include: ['**/*.test.ts'],
    // The live suite (real Caddy, frp and celld in Docker) has its own config:
    // pnpm selfhost:live-test.
    exclude: ['live/**', '**/node_modules/**'],
  },
});

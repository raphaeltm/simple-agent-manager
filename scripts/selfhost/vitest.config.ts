import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['**/*.test.ts'],
    // The live suite (real Caddy, frp and celld in Docker) has its own config:
    // pnpm selfhost:live-test.
    exclude: ['live/**', '**/node_modules/**'],
  },
});

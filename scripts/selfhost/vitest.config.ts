import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['**/*.test.ts'],
    // The live suite (real frp and Caddy) has its own config: pnpm selfhost:live-test.
    exclude: ['live/**', '**/node_modules/**'],
  },
});

import { defineConfig } from 'vitest/config';

/**
 * Vitest orchestrates from Node; the actual code runs as native workerd modules
 * in Miniflare with real D1 and DO SQLite. The normal Workers pool's dynamic
 * loader recursively crashes on Mastra's module graph before collecting tests.
 */
export default defineConfig({
  test: {
    include: ['tests/workers/sam-session-do.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});

import { defineConfig } from 'vitest/config';

/**
 * Live self-host suite: real frp binaries and real Caddy (Docker). Run with
 * `pnpm selfhost:live-test`; needs network access (frp release download, Docker image pull)
 * and a Linux Docker daemon that supports `--network host`.
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['**/*.live.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});

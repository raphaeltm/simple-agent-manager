import { defineConfig } from 'vitest/config';

/**
 * Hosted git conformance: the real git CLI against the HostedGitRepo Durable Object running in
 * Miniflare (tests/hosted-git/support/hosted-git-runtime.ts). Needs `git` on PATH.
 */
export default defineConfig({
  test: {
    include: ['tests/hosted-git/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

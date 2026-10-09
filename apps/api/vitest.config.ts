import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { coverageConfig } from '../../vitest.coverage';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': resolve(__dirname, 'tests/mocks/cloudflare-workers.ts'),
      '@cloudflare/containers': resolve(__dirname, 'tests/mocks/cloudflare-containers.ts'),
    },
  },
  test: {
    // Transform this Workers-only dependency so its runtime import uses the test alias.
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
    globals: true,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/workers/**'],
    coverage: coverageConfig(['src/**/*.ts'], {
      statements: 45,
      branches: 40,
      functions: 44,
      lines: 45,
    }),
  },
});

import { defineConfig } from 'vitest/config';

import { coverageConfig } from '../../vitest.coverage';

export default defineConfig({
  test: {
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

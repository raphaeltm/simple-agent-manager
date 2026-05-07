import { defineConfig } from 'vitest/config';

import { coverageConfig } from '../../vitest.coverage';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage: coverageConfig(['src/**/*.ts'], {
      statements: 71,
      branches: 72,
      functions: 78,
      lines: 72,
    }),
  },
});

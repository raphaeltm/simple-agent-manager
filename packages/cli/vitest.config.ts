import { defineConfig } from 'vitest/config';

import { coverageConfig } from '../../vitest.coverage';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage: coverageConfig(['src/**/*.ts'], {
      statements: 85,
      branches: 70,
      functions: 85,
      lines: 85,
    }),
  },
});

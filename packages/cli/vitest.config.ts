import { defineConfig } from 'vitest/config';

import { coverageConfig } from '../../vitest.coverage';

const coverage = coverageConfig(['src/**/*.ts'], {
  statements: 80,
  branches: 70,
  functions: 80,
  lines: 80,
});
coverage.exclude = [...coverage.exclude, 'src/bin.ts'];

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage,
  },
});

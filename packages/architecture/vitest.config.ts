import { defineConfig } from 'vitest/config';

import { coverageConfig } from '../../vitest.coverage';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: coverageConfig(['src/**/*.{ts,tsx}'], {
      statements: 75,
      branches: 60,
      functions: 75,
      lines: 80,
    }),
  },
});

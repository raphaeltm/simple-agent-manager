import { defineConfig } from 'vitest/config';

import { coverageConfig } from '../../vitest.coverage';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: coverageConfig(['src/**/*.{ts,tsx}'], {
      statements: 70,
      branches: 50,
      functions: 70,
      lines: 75,
    }),
  },
});

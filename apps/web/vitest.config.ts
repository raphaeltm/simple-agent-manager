import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

import { coverageConfig } from '../../vitest.coverage';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    coverage: coverageConfig(['src/**/*.{ts,tsx}'], {
      statements: 53,
      branches: 49,
      functions: 46,
      lines: 55,
    }),
  },
});

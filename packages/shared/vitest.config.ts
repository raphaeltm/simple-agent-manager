import codspeedPlugin from '@codspeed/vitest-plugin';
import { defineConfig } from 'vitest/config';

import { coverageConfig } from '../../vitest.coverage';

export default defineConfig({
  plugins: [codspeedPlugin()],
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    benchmark: {
      include: ['bench/**/*.bench.ts'],
    },
    coverage: coverageConfig(['src/**/*.ts'], {
      statements: 83,
      branches: 30,
      functions: 60,
      lines: 83,
    }),
  },
});

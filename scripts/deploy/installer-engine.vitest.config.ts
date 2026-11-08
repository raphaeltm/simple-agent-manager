import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'scripts/deploy/installer-engine*.test.ts',
      'scripts/deploy/installer-builder-proof.test.ts',
    ],
  },
});

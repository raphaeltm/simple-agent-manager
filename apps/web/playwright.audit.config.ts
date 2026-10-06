// Local audit-run config: the full visual-audit corpus minus specs that
// require staging credentials (staging-*.spec.ts throw without
// SAM_PLAYWRIGHT_* env vars) and the knowledge debug harness.
//
//   npx playwright test --config=playwright.audit.config.ts \
//     --project="iPhone SE (375x667)" --project="Desktop (1280x800)"
import { defineConfig } from '@playwright/test';

import baseConfig from './playwright.config';

export default defineConfig({
  ...baseConfig,
  testIgnore: ['**/staging-*.spec.ts', '**/knowledge-debug.spec.ts'],
});

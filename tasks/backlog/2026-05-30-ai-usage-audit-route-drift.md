# AI usage audit Playwright route drift

## Problem

The `apps/web/tests/playwright/ai-usage-audit.spec.ts` audit tests no longer find the expected usage dashboard content on `/settings/usage`.

## Evidence

- Command: `npx playwright test tests/playwright/agent-settings-audit.spec.ts tests/playwright/admin-ai-proxy-audit.spec.ts tests/playwright/ai-usage-audit.spec.ts --project="Desktop (1280x800)" --project="iPhone SE (375x667)"`
- Result: 78 passed, 16 failed.
- Passing: `agent-settings-audit.spec.ts` and `admin-ai-proxy-audit.spec.ts`.
- Failing: `ai-usage-audit.spec.ts` assertions looking for usage dashboard text such as `LLM Usage`, `No LLM usage yet`, `This Month`, cache counts, and pricing disclaimers.

## Impact

The failure appears unrelated to the Workers AI model deprecation cleanup. The test page or route fixture should be reviewed so the audit either navigates to the current usage surface or updates its expectations.


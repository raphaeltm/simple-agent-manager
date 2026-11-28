/**
 * The wire contract between SAM and the staging-only fake AI upstream Worker
 * (`ai-test-upstream-worker.ts`). Dependency-free so the deploy script that creates the Worker and
 * its AI Gateway custom provider (`scripts/deploy/fake-ai-upstream.ts`) can import it directly.
 */

/** Header the gateway's custom provider config sends on every call (non-secret). */
export const AI_TEST_UPSTREAM_GATE_HEADER = 'x-sam-test-upstream';
/**
 * The only value of `AI_TEST_UPSTREAM_GATE_HEADER` the Worker answers. Public by design: it keeps
 * stray callers out (they get 404); the Worker holds nothing a caller could take.
 */
export const AI_TEST_UPSTREAM_GATE_VALUE = 'sam-fake-ai-upstream-v1';
/** List-price USD cost the reply's usage should come to (header form, sent by the AI proxy). */
export const AI_TEST_UPSTREAM_COST_HEADER = 'x-sam-test-upstream-cost-usd';
/** The same as a query parameter, for hand-made calls. The header wins when both are present. */
export const AI_TEST_UPSTREAM_COST_QUERY = 'cost_usd';
/**
 * Highest cost one fake call may ask for, so a typo cannot produce an absurd usage block. The
 * admin setting `aiProxy.testUpstreamCostPerCallCents` takes its maximum from this, so every
 * value an admin can save is one the Worker accepts.
 */
export const AI_TEST_UPSTREAM_MAX_COST_USD = 100;

/**
 * Worker suites that run as native workerd modules (`vitest.sam-runtime.config.ts`)
 * instead of in the Workers pool (`vitest.workers.config.ts`), because the pool's
 * dynamic loader crashes on Mastra's module graph. `run-workers-tests.mjs` runs them
 * once, on shard 1. One list, so the two configs and the shard tests cannot disagree.
 */
export const NATIVE_RUNTIME_SUITES = [
  'tests/workers/sam-session-do.test.ts',
  'tests/workers/sam-grounding-runtime.test.ts',
  'tests/workers/sam-live-stream.test.ts',
  'tests/workers/smtp-client-workerd.test.ts',
];

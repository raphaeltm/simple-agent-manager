/** The vitest Workers pool forces no_handle_cross_request_promise_resolution.
 * Use Wrangler's local workerd to exercise the deployed request-lifetime contract.
 */
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';

let worker: Unstable_DevWorker;
beforeAll(async () => {
  worker = await unstable_dev('tests/fixtures/project-data-ensure-context-worker.ts', {
    config: resolve('tests/fixtures/project-data-ensure-context.wrangler.json'),
    local: true,
    persist: false,
    logLevel: 'none',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
  });
}, 60_000);
afterAll(async () => {
  await worker?.stop();
});

describe('ProjectData initialization across ended HTTP requests', () => {
  it('creates and persists a session after another request abandons its first ensure', async () => {
    const projectId = `request-context-${crypto.randomUUID()}`;
    const url = (step: string) =>
      `http://test/__test/project-data-ensure-context/${step}?projectId=${projectId}`;
    expect(await (await worker.fetch(url('abandon'))).json()).toEqual({
      abandoned: true,
      ensureCalls: 1,
    });
    // Separate real Workers invocations: resolving the old promise drops its continuation.
    expect(await (await worker.fetch(url('release'))).json()).toEqual({
      released: true,
      ensureCalls: 1,
    });
    const created = await worker.fetch(url('create'));
    const result = await created.json();
    expect(result).toMatchObject({ persisted: true, ensureCalls: 2, createCalls: 1 });
    expect(created.status).toBe(200);
    // Completed initialization is still cached, and a second durable session is created.
    const warm = await worker.fetch(url('create'));
    const warmResult = await warm.json();
    expect(warmResult).toMatchObject({ persisted: true, ensureCalls: 2, createCalls: 2 });
    expect(warmResult.sessionId).not.toBe(result.sessionId);
    expect(warm.status).toBe(200);
    // Real workerd RPCs share CPU with the full native shard; the fixture still
    // rejects a stranded initialization within its independent one-second deadline.
  }, 20_000);
});

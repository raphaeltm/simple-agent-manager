import { describe, expect, it } from 'vitest';

import {
  TrialCounter,
  TrialEventBus,
  TrialOrchestrator,
} from '../../../src/durable-objects/retired-trial';

/**
 * The anonymous-trial Durable Object classes stay exported only so existing namespaces keep
 * deploying (wrangler migrations v7-v9). Nothing binds them; anything that still reaches one must
 * get a terminal answer and must not touch storage or re-arm an alarm.
 */
describe.each([
  ['TrialCounter', TrialCounter],
  ['TrialEventBus', TrialEventBus],
  ['TrialOrchestrator', TrialOrchestrator],
])('retired %s tombstone', (_name, RetiredClass) => {
  function instance() {
    const touched: string[] = [];
    const storage = new Proxy(
      {},
      {
        get(_target, property) {
          touched.push(String(property));
          return () => undefined;
        },
      }
    );
    const ctx = { storage };
    return { object: new RetiredClass(ctx as never, {} as never), touched };
  }

  it('answers every request with 410 Gone', async () => {
    const { object, touched } = instance();
    const response = await object.fetch();
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ error: 'GONE' });
    expect(touched).toEqual([]);
  });

  it('lets a leftover alarm fire without storage access or re-arming', async () => {
    const { object, touched } = instance();
    await expect(object.alarm()).resolves.toBeUndefined();
    expect(touched).toEqual([]);
  });
});

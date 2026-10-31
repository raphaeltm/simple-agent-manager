import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/platform-config-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/platform-config-store')>()),
  resolveSetting: vi.fn(() => new Promise(() => undefined)),
  resolveSecret: vi.fn(() => new Promise(() => undefined)),
}));

import { createAuth } from '../../../src/auth';
import { __resetPlatformConfigCacheForTest } from '../../../src/services/platform-config';
import { resolveSecret, resolveSetting } from '../../../src/services/platform-config-store';
import { createEnv } from '../../helpers/platform-config-counting-fixture';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  __resetPlatformConfigCacheForTest();
});
afterEach(() => vi.useRealTimers());

describe('login configuration dependency boundary', () => {
  it('constructs all login providers while unrelated app, webhook and feedback reads stall', async () => {
    const { env } = createEnv();
    const result = createAuth(env).then(
      (auth) => ({ providers: Object.keys(auth.options.socialProviders ?? {}).sort() }),
      () => ({ error: 'blocked by unrelated configuration' })
    );
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await result).toEqual({ providers: ['github', 'gitlab', 'google'] });
    expect(resolveSetting).not.toHaveBeenCalled();
    expect(resolveSecret).not.toHaveBeenCalled();
  });
});

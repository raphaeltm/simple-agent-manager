import { describe, expect, it } from 'vitest';

import { ensureTomlMap } from '../deploy/sync-wrangler-config';

describe('sync-wrangler-config helpers', () => {
  it('returns the original TOML map so generated env sections are persisted', () => {
    const config = { env: {} };

    const envConfig = ensureTomlMap(config.env, 'tail worker env config');
    envConfig.staging = { name: 'sam-tail-worker-staging' };

    expect(config.env).toEqual({
      staging: { name: 'sam-tail-worker-staging' },
    });
  });

  it('rejects non-table values', () => {
    expect(() => ensureTomlMap([], 'tail worker env config')).toThrow(
      'tail worker env config must be a TOML table'
    );
  });
});

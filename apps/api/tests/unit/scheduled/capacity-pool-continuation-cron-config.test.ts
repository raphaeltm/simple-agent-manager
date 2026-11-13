import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

import { CAPACITY_POOL_CONTINUATION_CRON } from '../../../src/services/capacity-pool-refresh-defaults';
import { cronToNextFire } from '../../../src/services/cron-utils';

describe('deployed catalog continuation cadence', () => {
  it.each([undefined, 'staging'])(
    'registers one continuation tick and preserves existing sweeps in %s',
    (environment) => {
      const config = unstable_readConfig(
        {
          config: fileURLToPath(new URL('../../../wrangler.toml', import.meta.url)),
          env: environment,
        },
        { hideWarnings: true }
      );
      // Parse the deployment configuration through Wrangler itself: testing only a source
      // constant cannot prove Cloudflare will deliver that trigger to the entrypoint.
      expect(config.triggers.crons).toEqual([
        CAPACITY_POOL_CONTINUATION_CRON,
        '*/5 * * * *',
        '30 * * * *',
        '0 3 * * *',
      ]);
      expect(
        config.triggers.crons.filter((cron) => cron === CAPACITY_POOL_CONTINUATION_CRON)
      ).toHaveLength(1);
    }
  );

  it('delivers continuation ticks between consecutive five-minute operational sweeps', () => {
    const after = new Date('2026-11-12T11:02:00.000Z');
    const first = cronToNextFire(CAPACITY_POOL_CONTINUATION_CRON, 'UTC', after);
    const second = cronToNextFire(CAPACITY_POOL_CONTINUATION_CRON, 'UTC', new Date(first));
    expect(first).toBe('2026-11-12T11:03:00.000Z');
    expect(second).toBe('2026-11-12T11:04:00.000Z');
    expect(new Date(second).getTime() - new Date(first).getTime()).toBe(60_000);
  });
});

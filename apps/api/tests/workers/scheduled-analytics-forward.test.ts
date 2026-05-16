/**
 * Vertical slice test for analytics-forward scheduled job.
 *
 * The job delegates to runAnalyticsForward() which checks ANALYTICS_FORWARD_ENABLED.
 * In the test environment, this is unset, so forwarding should be disabled by default.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { runAnalyticsForwardJob } from '../../src/scheduled/analytics-forward';

describe('runAnalyticsForwardJob', () => {
  it('returns disabled result when ANALYTICS_FORWARD_ENABLED is not set', async () => {
    const result = await runAnalyticsForwardJob(env);

    expect(result.enabled).toBe(false);
    expect(result.eventsQueried).toBe(0);
    expect(result.segment.sent).toBe(0);
    expect(result.ga4.sent).toBe(0);
  });
});

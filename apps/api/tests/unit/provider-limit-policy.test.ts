import { describe, expect, it } from 'vitest';

import {
  newProviderLimitWait,
  parseProviderLimitWait,
  PROVIDER_LIMIT_POLICY,
} from '../../src/services/provider-limit-policy';

const now = Date.parse('2026-10-12T09:30:00Z');
function next(previous = null as ReturnType<typeof newProviderLimitWait> | null, overrides = {}) {
  return newProviderLimitWait({
    taskId: 'task',
    origin: 'callback',
    incidentId: 'workspace:agent',
    credentialKey: 'credential',
    previous,
    now,
    resetsAt: null,
    jitter: 0,
    ...overrides,
  });
}
describe('bounded provider-limit wait policy', () => {
  it('waits just beyond known reset and reports UTC', () => {
    const reset = now + 60_000;
    const wait = next(null, { resetsAt: reset });
    expect(wait.nextRetryAt).toBe(reset + PROVIDER_LIMIT_POLICY.resetGraceMs);
    expect(wait.phase).toBe('waiting');
    expect(wait.reason).toContain('09:31 UTC');
    expect(parseProviderLimitWait(JSON.stringify(wait))).toEqual(wait);
  });
  it('backs off an unknown reset and stops consecutive automatic retries', () => {
    let wait = next();
    expect(wait.nextRetryAt - now).toBe(PROVIDER_LIMIT_POLICY.unknownBackoffMs);
    for (let attempt = 1; attempt <= PROVIDER_LIMIT_POLICY.maxConsecutiveWaits; attempt++)
      wait = next(wait, { incidentId: `attempt-${attempt}` });
    expect(wait.phase).toBe('blocked');
    expect(wait.reason).toContain('budget exhausted');
  });
  it('blocks visibly if reset will outlive the snapshot, without extending TTL', () => {
    const wait = next(null, {
      resetsAt: now + 7 * 24 * 60 * 60_000,
      snapshotExpiresAt: now + 7 * 24 * 60 * 60_000,
    });
    expect(wait.phase).toBe('blocked');
    expect(wait.reason).toContain('fresh start after the limit resets');
  });
  it('does not switch credentials', () => {
    expect(next(next(), { credentialKey: 'other' }).phase).toBe('blocked');
  });
  it('uses independent durable schedule identities after consecutive budget resets', () => {
    const first = next();
    const later = next(null, { now: now + 1, incidentId: 'later-turn' });
    expect(first.attempts).toBe(later.attempts);
    expect(first.scheduleKey).not.toBe(later.scheduleKey);
  });
  it('rejects malformed persisted records', () => {
    expect(parseProviderLimitWait('{"phase":"waiting"}')).toBeNull();
  });
});

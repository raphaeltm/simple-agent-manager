/**
 * Unit tests for `services/trial/helpers.ts`.
 *
 * Covers:
 *   - env-var resolvers (missing / empty / invalid → DEFAULT_*)
 *   - currentMonthKey / nextMonthResetDate (UTC math across month/year borders)
 *   - shiftMonthKey (positive and negative deltas, cross-year)
 *   - parseGithubRepoUrl (happy path, .git suffix, trailing slash, rejects SSH/http/non-github)
 */
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import {
  currentMonthKey,
  DEFAULT_TRIAL_COUNTER_KEEP_MONTHS,
  DEFAULT_TRIAL_GITHUB_TIMEOUT_MS,
  DEFAULT_TRIAL_MONTHLY_CAP,
  DEFAULT_TRIAL_REPO_MAX_KB,
  DEFAULT_TRIAL_WAITLIST_PURGE_DAYS,
  DEFAULT_TRIAL_WORKSPACE_TTL_MS,
  nextMonthResetDate,
  parseGithubRepoUrl,
  resolveCounterKeepMonths,
  resolveGithubTimeoutMs,
  resolveMonthlyCap,
  resolveRepoMaxKb,
  resolveWaitlistPurgeDays,
  resolveWorkspaceTtlMs,
  shiftMonthKey,
} from '../../../src/services/trial/helpers';

function envWith(overrides: Partial<Env> = {}): Env {
  return { ...overrides } as Env;
}

describe('trial helpers — env-var resolvers', () => {
  it('resolveMonthlyCap: missing → DEFAULT', () => {
    expect(resolveMonthlyCap(envWith())).toBe(DEFAULT_TRIAL_MONTHLY_CAP);
  });

  it('resolveMonthlyCap: empty string → DEFAULT', () => {
    expect(resolveMonthlyCap(envWith({ TRIAL_MONTHLY_CAP: '' }))).toBe(
      DEFAULT_TRIAL_MONTHLY_CAP
    );
  });

  it('resolveMonthlyCap: valid numeric string → parsed', () => {
    expect(resolveMonthlyCap(envWith({ TRIAL_MONTHLY_CAP: '25' }))).toBe(25);
  });

  it('resolveMonthlyCap: 0 is respected (disables cap)', () => {
    expect(resolveMonthlyCap(envWith({ TRIAL_MONTHLY_CAP: '0' }))).toBe(0);
  });

  it('resolveMonthlyCap: junk → DEFAULT', () => {
    expect(resolveMonthlyCap(envWith({ TRIAL_MONTHLY_CAP: 'abc' }))).toBe(
      DEFAULT_TRIAL_MONTHLY_CAP
    );
  });

  it('resolveWorkspaceTtlMs: 0 is REJECTED → DEFAULT (TTL must be > 0)', () => {
    expect(resolveWorkspaceTtlMs(envWith({ TRIAL_WORKSPACE_TTL_MS: '0' }))).toBe(
      DEFAULT_TRIAL_WORKSPACE_TTL_MS
    );
  });

  it('resolveWorkspaceTtlMs: positive override is used', () => {
    expect(
      resolveWorkspaceTtlMs(envWith({ TRIAL_WORKSPACE_TTL_MS: '60000' }))
    ).toBe(60000);
  });

  it('resolveRepoMaxKb: DEFAULT when missing', () => {
    expect(resolveRepoMaxKb(envWith())).toBe(DEFAULT_TRIAL_REPO_MAX_KB);
  });

  it('resolveRepoMaxKb: override when valid', () => {
    expect(resolveRepoMaxKb(envWith({ TRIAL_REPO_MAX_KB: '1024' }))).toBe(1024);
  });

  it('resolveGithubTimeoutMs: DEFAULT when missing', () => {
    expect(resolveGithubTimeoutMs(envWith())).toBe(
      DEFAULT_TRIAL_GITHUB_TIMEOUT_MS
    );
  });

  it('resolveCounterKeepMonths: floors fractional overrides', () => {
    expect(
      resolveCounterKeepMonths(envWith({ TRIAL_COUNTER_KEEP_MONTHS: '3.9' }))
    ).toBe(3);
  });

  it('resolveCounterKeepMonths: DEFAULT when missing', () => {
    expect(resolveCounterKeepMonths(envWith())).toBe(
      DEFAULT_TRIAL_COUNTER_KEEP_MONTHS
    );
  });

  it('resolveWaitlistPurgeDays: DEFAULT when missing', () => {
    expect(resolveWaitlistPurgeDays(envWith())).toBe(
      DEFAULT_TRIAL_WAITLIST_PURGE_DAYS
    );
  });

  it('resolveWaitlistPurgeDays: negative or zero → DEFAULT', () => {
    expect(
      resolveWaitlistPurgeDays(envWith({ TRIAL_WAITLIST_PURGE_DAYS: '0' }))
    ).toBe(DEFAULT_TRIAL_WAITLIST_PURGE_DAYS);
    expect(
      resolveWaitlistPurgeDays(envWith({ TRIAL_WAITLIST_PURGE_DAYS: '-1' }))
    ).toBe(DEFAULT_TRIAL_WAITLIST_PURGE_DAYS);
  });
});

describe('trial helpers — month key math (UTC)', () => {
  it('currentMonthKey returns YYYY-MM for a given timestamp', () => {
    // 2026-04-18T12:00:00Z
    const t = Date.UTC(2026, 3, 18, 12, 0, 0);
    expect(currentMonthKey(t)).toBe('2026-04');
  });

  it('currentMonthKey zero-pads single-digit months', () => {
    const t = Date.UTC(2026, 0, 1, 0, 0, 0); // Jan
    expect(currentMonthKey(t)).toBe('2026-01');
  });

  it('currentMonthKey uses UTC (not local timezone)', () => {
    // 2026-04-30T23:30:00 UTC is still April.
    const t = Date.UTC(2026, 3, 30, 23, 30, 0);
    expect(currentMonthKey(t)).toBe('2026-04');
  });

  it('nextMonthResetDate rolls into next month', () => {
    const t = Date.UTC(2026, 3, 18, 12, 0, 0);
    expect(nextMonthResetDate(t)).toBe('2026-05-01');
  });

  it('nextMonthResetDate rolls into next year on December', () => {
    const t = Date.UTC(2026, 11, 25, 0, 0, 0); // 2026-12-25
    expect(nextMonthResetDate(t)).toBe('2027-01-01');
  });

  it('shiftMonthKey handles positive delta', () => {
    expect(shiftMonthKey('2026-04', 2)).toBe('2026-06');
  });

  it('shiftMonthKey handles negative delta across year boundary', () => {
    expect(shiftMonthKey('2026-02', -3)).toBe('2025-11');
  });

  it('shiftMonthKey delta=0 is identity', () => {
    expect(shiftMonthKey('2026-04', 0)).toBe('2026-04');
  });

  it('shiftMonthKey rejects malformed keys', () => {
    expect(() => shiftMonthKey('2026/04', 0)).toThrow();
    expect(() => shiftMonthKey('abc', 0)).toThrow();
  });
});

describe('trial helpers — parseGithubRepoUrl', () => {
  it('parses a canonical URL', () => {
    expect(parseGithubRepoUrl('https://github.com/owner/repo')).toEqual({
      owner: 'owner',
      name: 'repo',
      canonical: 'https://github.com/owner/repo',
    });
  });

  it('strips .git suffix', () => {
    expect(parseGithubRepoUrl('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      name: 'repo',
      canonical: 'https://github.com/owner/repo',
    });
  });

  it('strips trailing slash', () => {
    expect(parseGithubRepoUrl('https://github.com/owner/repo/')).toEqual({
      owner: 'owner',
      name: 'repo',
      canonical: 'https://github.com/owner/repo',
    });
  });

  it('handles names with dots and dashes', () => {
    const parsed = parseGithubRepoUrl('https://github.com/owner/my.repo-name_v2');
    expect(parsed).toEqual({
      owner: 'owner',
      name: 'my.repo-name_v2',
      canonical: 'https://github.com/owner/my.repo-name_v2',
    });
  });

  it('rejects SSH URLs', () => {
    expect(parseGithubRepoUrl('git@github.com:owner/repo.git')).toBeNull();
  });

  it('rejects HTTP (non-HTTPS) URLs', () => {
    expect(parseGithubRepoUrl('http://github.com/owner/repo')).toBeNull();
  });

  it('rejects non-github hosts', () => {
    expect(parseGithubRepoUrl('https://gitlab.com/owner/repo')).toBeNull();
  });

  it('rejects paths deeper than owner/repo', () => {
    expect(
      parseGithubRepoUrl('https://github.com/owner/repo/tree/main')
    ).toBeNull();
  });

  it('rejects empty strings', () => {
    expect(parseGithubRepoUrl('')).toBeNull();
  });

  it('rejects owner with leading or trailing hyphen', () => {
    expect(parseGithubRepoUrl('https://github.com/-owner/repo')).toBeNull();
    expect(parseGithubRepoUrl('https://github.com/owner-/repo')).toBeNull();
  });
});

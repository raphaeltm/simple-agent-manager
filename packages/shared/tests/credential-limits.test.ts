import { describe, expect, it } from 'vitest';

import type {
  CredentialLimitCredentialSummary,
  CredentialLimitWindowSummary,
} from '../src/types/credential-limits';

import {
  credentialIdFromReference,
  credentialLimitFamilyLabel,
  credentialLimitSummaryAsOf,
  credentialLimitWindowAsOf,
  credentialLimitWindowLabel,
  credentialLimitWindowSortMinutes,
  formatCredentialLimitWindowMinutes,
  worstCredentialLimitLevel,
} from '../src/credential-limits';

describe('credential limit helpers', () => {
  it('ranks the worst level across windows and ignores unknown values', () => {
    expect(worstCredentialLimitLevel([])).toBe('ok');
    expect(worstCredentialLimitLevel(['ok', 'warning', null, undefined])).toBe('warning');
    expect(worstCredentialLimitLevel(['critical', 'warning'])).toBe('critical');
    expect(worstCredentialLimitLevel(['ok', 'rejected', 'critical'])).toBe('rejected');
  });

  it('extracts composable credential ids and rejects other references', () => {
    expect(credentialIdFromReference('cc_credentials:01ABC')).toBe('01ABC');
    expect(credentialIdFromReference('cc_credentials:')).toBeNull();
    expect(credentialIdFromReference('platform_credentials:01ABC')).toBeNull();
    expect(credentialIdFromReference('credentials:01ABC')).toBeNull();
  });

  it('labels families from the window type prefix', () => {
    expect(credentialLimitFamilyLabel('claude.five_hour')).toBe('Claude');
    expect(credentialLimitFamilyLabel('codex.primary')).toBe('Codex');
    expect(credentialLimitFamilyLabel('opencode.weekly')).toBe('OpenCode');
    expect(credentialLimitFamilyLabel('anthropic.tokens')).toBe('Anthropic API');
    expect(credentialLimitFamilyLabel('openai.requests')).toBe('OpenAI API');
    expect(credentialLimitFamilyLabel('mystery.window')).toBe('mystery');
  });

  it('labels Codex windows by reported length, not by position', () => {
    // Team plan: 5h primary, weekly secondary.
    expect(credentialLimitWindowLabel('codex.primary', 300)).toBe('5h');
    expect(credentialLimitWindowLabel('codex.secondary', 10080)).toBe('Week');
    // Prolite plan: the weekly window is the primary window.
    expect(credentialLimitWindowLabel('codex.primary', 10080)).toBe('Week');
    expect(credentialLimitWindowLabel('codex.primary', null)).toBe('primary');
  });

  it('uses fixed labels for fixed-meaning windows', () => {
    expect(credentialLimitWindowLabel('claude.five_hour', null)).toBe('5h');
    expect(credentialLimitWindowLabel('claude.seven_day_opus', 10080)).toBe('Opus week');
    expect(credentialLimitWindowLabel('opencode.rolling', null)).toBe('Rolling');
    expect(credentialLimitWindowLabel('opencode.monthly', null)).toBe('Month');
    expect(credentialLimitWindowLabel('openai.project-tokens', null)).toBe('Project tokens');
  });

  it('formats window lengths', () => {
    expect(formatCredentialLimitWindowMinutes(45)).toBe('45m');
    expect(formatCredentialLimitWindowMinutes(300)).toBe('5h');
    expect(formatCredentialLimitWindowMinutes(1440)).toBe('1d');
    expect(formatCredentialLimitWindowMinutes(10080)).toBe('Week');
    expect(formatCredentialLimitWindowMinutes(43200)).toBe('30d');
    expect(formatCredentialLimitWindowMinutes(0)).toBe('Window');
  });

  it('orders windows by reported length, then nominal span, unknown last', () => {
    expect(credentialLimitWindowSortMinutes('opencode.rolling', null)).toBe(300);
    expect(credentialLimitWindowSortMinutes('opencode.weekly', null)).toBe(10080);
    expect(credentialLimitWindowSortMinutes('opencode.monthly', null)).toBe(43200);
    expect(credentialLimitWindowSortMinutes('claude.five_hour', undefined)).toBe(300);
    // Reported length wins over the nominal span.
    expect(credentialLimitWindowSortMinutes('opencode.rolling', 120)).toBe(120);
    // Positional and token-rate windows stay unknown without a reported length.
    expect(credentialLimitWindowSortMinutes('codex.primary', null)).toBeNull();
    expect(credentialLimitWindowSortMinutes('anthropic.tokens', null)).toBeNull();
  });
});

describe('credential limit windows as of now', () => {
  const NOW = Date.UTC(2026, 10, 5, 17, 45);
  const HOUR = 3_600_000;

  function window(overrides: Partial<CredentialLimitWindowSummary>): CredentialLimitWindowSummary {
    return {
      windowType: 'codex.primary',
      provider: 'openai',
      source: 'vm-agent.codex_rollout',
      status: 'allowed_warning',
      level: 'warning',
      utilizationPercent: 81,
      limitAmount: 100,
      remainingAmount: 19,
      windowMinutes: 300,
      resetsAt: NOW + HOUR,
      observedAt: NOW - HOUR,
      updatedAt: NOW - HOUR,
      ...overrides,
    };
  }

  it('reads a window whose reset passed after the sample as 0%, OK, and marks it', () => {
    const stale = window({ resetsAt: NOW - 2 * HOUR, observedAt: NOW - 3 * HOUR });
    expect(credentialLimitWindowAsOf(stale, NOW)).toEqual({
      ...stale,
      status: 'allowed',
      level: 'ok',
      utilizationPercent: 0,
      remainingAmount: 100,
      resetElapsed: true,
    });
  });

  it('clears a rejected window once its reset passed', () => {
    const rejected = window({
      status: 'rejected',
      level: 'rejected',
      utilizationPercent: null,
      limitAmount: null,
      remainingAmount: null,
      resetsAt: NOW - 1,
      observedAt: NOW - HOUR,
    });
    const current = credentialLimitWindowAsOf(rejected, NOW);
    expect(current.level).toBe('ok');
    expect(current.utilizationPercent).toBe(0);
    expect(current.remainingAmount).toBeNull();
  });

  it('keeps a window whose reset is still ahead, unknown, or older than the sample', () => {
    const ahead = window({});
    expect(credentialLimitWindowAsOf(ahead, NOW)).toBe(ahead);
    const unknown = window({ resetsAt: null });
    expect(credentialLimitWindowAsOf(unknown, NOW)).toBe(unknown);
    // Sampled after the stored reset time: the sample already describes the new window.
    const resampled = window({ resetsAt: NOW - 2 * HOUR, observedAt: NOW - HOUR });
    expect(credentialLimitWindowAsOf(resampled, NOW)).toBe(resampled);
  });

  it('recomputes the credential level from the current windows', () => {
    const summary: CredentialLimitCredentialSummary = {
      credentialReference: 'cc_credentials:team',
      credentialId: 'team',
      credentialName: 'Team seat',
      credentialSource: 'user',
      provider: 'openai',
      providerMode: 'oauth',
      agentType: 'openai-codex',
      level: 'rejected',
      observedAt: NOW - HOUR,
      windows: [
        window({ level: 'rejected', status: 'rejected', resetsAt: NOW - 1 }),
        window({ windowType: 'codex.secondary', level: 'warning', resetsAt: NOW + 4 * HOUR }),
      ],
    };
    const current = credentialLimitSummaryAsOf(summary, NOW);
    expect(current.level).toBe('warning');
    expect(current.windows.map((w) => w.utilizationPercent)).toEqual([0, 81]);
    // Nothing to change returns the same object, so memoized callers stay stable.
    expect(credentialLimitSummaryAsOf(current, NOW)).toBe(current);
  });
});

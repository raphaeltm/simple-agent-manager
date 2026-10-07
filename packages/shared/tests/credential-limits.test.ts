import { describe, expect, it } from 'vitest';

import {
  credentialIdFromReference,
  credentialLimitFamilyLabel,
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

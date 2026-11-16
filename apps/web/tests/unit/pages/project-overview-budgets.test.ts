import type { AgentProfile } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import type { ProfileUsage } from '../../../src/components/project-chat/profile-picker';
import {
  usageWindowName,
  usageWords,
} from '../../../src/components/project-chat/profile-picker/usage';
import type { UsageWindowReading } from '../../../src/components/project-chat/profile-picker/usage-windows';
import { budgetAccounts } from '../../../src/pages/project-overview/BudgetsSection';

function reading(
  label: string,
  left: number,
  resetIn: string | null = '1h 20m'
): UsageWindowReading {
  return {
    windowType: label,
    label,
    shortLabel: label,
    left,
    refused: false,
    resetIn,
    minutes: label === '5h' ? 300 : 10_080,
    resetElapsed: false,
  };
}

function usage(overrides: Partial<ProfileUsage>): ProfileUsage {
  return {
    state: 'ok',
    left: 90,
    color: 'green',
    resetIn: null,
    accountLabel: 'Personal Max',
    accountKey: 'cc:personal',
    accountId: 'cfg-personal',
    session: reading('5h', 90),
    week: reading('Week', 80),
    windows: [],
    urgent: false,
    ...overrides,
  };
}

function profile(id: string, name: string): AgentProfile {
  return { id, name, agentType: 'claude-code', model: null } as AgentProfile;
}

describe('usage words with named windows', () => {
  it('names the window in full instead of the composer’s short label', () => {
    const low = usage({
      state: 'low',
      left: 38,
      session: reading('5h', 38),
      week: reading('Week', 70),
    });
    expect(usageWords(low, { namedWindows: true })[0]?.text).toBe(
      '5-hour window · 38% left · resets 1h 20m'
    );
    // The composer keeps its terse form.
    expect(usageWords(low)[0]?.text).toBe('5h 38% left · resets 1h 20m');
  });

  it('names weekly and model windows', () => {
    expect(usageWindowName('Week')).toBe('Weekly window');
    expect(usageWindowName('Opus week')).toBe('Opus weekly window');
    expect(usageWindowName('Month')).toBe('Monthly window');
    expect(usageWindowName('Rolling')).toBe('Rolling window');
  });

  it('says nothing for a calm account', () => {
    expect(usageWords(usage({}), { namedWindows: true })).toEqual([]);
  });
});

describe('budgetAccounts', () => {
  it('shows one ring per account, however many profiles run on it', () => {
    const profiles = [
      profile('a', 'Opus Build'),
      profile('b', 'Sonnet Chat'),
      profile('c', 'Codex'),
    ];
    const usages = new Map<string, ProfileUsage>([
      ['a', usage({})],
      ['b', usage({})],
      ['c', usage({ accountLabel: 'Work Pro', accountKey: 'cc:work', accountId: 'cfg-work' })],
    ]);
    const { accounts, exceptions } = budgetAccounts(profiles, usages);
    expect(accounts.map((a) => [a.label, a.profiles.map((p) => p.name)])).toEqual([
      ['Personal Max', ['Opus Build', 'Sonnet Chat']],
      ['Work Pro', ['Codex']],
    ]);
    expect(exceptions).toEqual([]);
  });

  it('puts words only on exceptions: a low window named in full, a paused account, no account', () => {
    const profiles = [
      profile('a', 'Opus Build'),
      profile('b', 'Codex'),
      profile('c', 'Kimi'),
      profile('d', 'Gemma'),
    ];
    const usages = new Map<string, ProfileUsage>([
      [
        'a',
        usage({
          state: 'out',
          left: 6,
          session: reading('5h', 60),
          week: reading('Week', 6, '2d 4h'),
          urgent: true,
        }),
      ],
      [
        'b',
        usage({
          state: 'paused',
          accountLabel: 'Work Pro',
          accountKey: 'cc:work',
          accountId: 'cfg-work',
        }),
      ],
      ['c', usage({ state: 'none', accountLabel: null, accountKey: null, accountId: null })],
      ['d', usage({ state: 'platform', accountLabel: null, accountKey: null, accountId: null })],
    ]);
    const { accounts, exceptions } = budgetAccounts(profiles, usages);
    expect(accounts.map((a) => a.label)).toEqual(['Personal Max', 'SAM platform', 'Work Pro']);
    expect(exceptions.map((e) => e.text)).toEqual([
      'Personal Max: Weekly window · 6% left · resets 2d 4h',
      'Work Pro is paused',
      'No account connected for Kimi',
    ]);
  });

  it('leaves out profiles whose usage has not loaded', () => {
    const { accounts } = budgetAccounts([profile('a', 'Opus Build')], new Map());
    expect(accounts).toEqual([]);
  });
});

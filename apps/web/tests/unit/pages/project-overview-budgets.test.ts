import type { AgentProfile } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import type { ProfileUsage } from '../../../src/components/project-chat/profile-picker';
import {
  usageWindowName,
  usageWords,
} from '../../../src/components/project-chat/profile-picker/usage';
import type { UsageWindowReading } from '../../../src/components/project-chat/profile-picker/usage-windows';
import {
  budgetAccounts,
  budgetTileLabel,
} from '../../../src/pages/project-overview/BudgetsSection';

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
    const { accounts, noAccount } = budgetAccounts(profiles, usages);
    expect(accounts.map((a) => [a.label, a.profiles.map((p) => p.name)])).toEqual([
      ['Personal Max', ['Opus Build', 'Sonnet Chat']],
      ['Work Pro', ['Codex']],
    ]);
    // Calm accounts carry no status: just the ring and the name.
    expect(accounts.map((a) => a.status)).toEqual([null, null]);
    expect(noAccount).toEqual([]);
  });

  it('gives each exception one short status on its own tile, with the full words as its detail', () => {
    const profiles = [
      profile('a', 'Opus Build'),
      profile('b', 'Codex'),
      profile('c', 'Kimi'),
      profile('d', 'Gemma'),
      profile('e', 'Sonnet'),
    ];
    const usages = new Map<string, ProfileUsage>([
      [
        'a',
        usage({
          state: 'out',
          left: 0,
          color: 'red',
          resetIn: '2d 4h',
          session: reading('5h', 60),
          week: reading('Week', 0, '2d 4h'),
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
      [
        'e',
        usage({
          state: 'low',
          left: 13,
          accountLabel: 'Team Max',
          accountKey: 'cc:team',
          accountId: 'cfg-team',
          session: reading('5h', 70),
          week: reading('Week', 13, '2d 5h'),
        }),
      ],
    ]);
    const { accounts, noAccount } = budgetAccounts(profiles, usages);
    expect(accounts.map((a) => [a.label, a.status?.text ?? null])).toEqual([
      ['Personal Max', 'Out · 2d 4h'],
      ['SAM platform', null],
      ['Team Max', '13% left'],
      ['Work Pro', 'Paused'],
    ]);
    const team = accounts.find((a) => a.label === 'Team Max')!;
    // The week's health colours the short status; the detail names the window in full.
    expect(team.status?.color).not.toBeNull();
    expect(team.status?.detail).toBe('Weekly window · 13% left · resets 2d 5h');
    expect(budgetTileLabel(team)).toBe(
      'Team Max, Weekly window · 13% left · resets 2d 5h, used by Sonnet'
    );
    const personal = accounts.find((a) => a.label === 'Personal Max')!;
    expect(personal.status?.detail).toBe('Weekly window used up · back in 2d 4h');
    // The visible status is part of the accessible name (WCAG 2.5.3, label in name).
    expect(budgetTileLabel(personal)).toBe(
      'Personal Max, Out · 2d 4h, Weekly window used up · back in 2d 4h, used by Opus Build'
    );
    for (const account of accounts) {
      if (account.status) expect(budgetTileLabel(account)).toContain(account.status.text);
    }
    expect(noAccount).toEqual(['Kimi']);
  });

  it('takes the number and its colour from the same window: a tighter session stays neutral', () => {
    const { accounts } = budgetAccounts(
      [profile('a', 'Opus Build')],
      new Map([
        [
          'a',
          usage({
            state: 'low',
            left: 4,
            color: 'amber',
            session: reading('5h', 4),
            week: reading('Week', 40),
          }),
        ],
      ])
    );
    // 4% is the session's; the week's amber must not paint it.
    expect(accounts[0]?.status?.text).toBe('4% left');
    expect(accounts[0]?.status?.color).toBeNull();
  });

  it('keeps a low session alone neutral: only the week carries a colour', () => {
    const { accounts } = budgetAccounts(
      [profile('a', 'Opus Build')],
      new Map([
        [
          'a',
          usage({ state: 'low', left: 38, session: reading('5h', 38), week: reading('Week', 70) }),
        ],
      ])
    );
    expect(accounts[0]?.status).toEqual({
      text: '38% left',
      color: null,
      detail: '5-hour window · 38% left · resets 1h 20m',
    });
  });

  it('leaves out profiles whose usage has not loaded', () => {
    const { accounts } = budgetAccounts([profile('a', 'Opus Build')], new Map());
    expect(accounts).toEqual([]);
  });
});

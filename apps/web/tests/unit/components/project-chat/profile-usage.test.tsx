import type {
  AgentProfile,
  CredentialLimitCredentialSummary,
  CredentialLimitLevel,
  CredentialLimitWindowSummary,
  ProfilePickerState,
} from '@simple-agent-manager/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { ProfileBudget } from '../../../../src/components/agent-profiles/useProfileBudgets';
import { pickerSections } from '../../../../src/components/project-chat/profile-picker/model';
import { NewChatProfileCards } from '../../../../src/components/project-chat/profile-picker/NewChatProfileCards';
import { ProfilePickerSheet } from '../../../../src/components/project-chat/profile-picker/ProfilePickerSheet';
import { ProfileToControl } from '../../../../src/components/project-chat/profile-picker/ProfileToControl';
import { ProfileUsageNudge } from '../../../../src/components/project-chat/profile-picker/ProfileUsageNudge';
import {
  roomiestAccount,
  type RunAccount,
} from '../../../../src/components/project-chat/profile-picker/run-accounts';
import {
  type ProfileUsage,
  profileUsage,
  ringLeft,
  usageNotice,
  usageSpoken,
} from '../../../../src/components/project-chat/profile-picker/usage';
import { USAGE_COLORS } from '../../../../src/components/project-chat/profile-picker/usage-windows';

const NOW = Date.parse('2026-11-08T16:10:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

function window(
  windowType: string,
  utilizationPercent: number | null,
  level: CredentialLimitLevel,
  resetsInMs: number | null
): CredentialLimitWindowSummary {
  return {
    windowType,
    provider: 'anthropic',
    source: 'test',
    status: level === 'rejected' ? 'rejected' : level === 'ok' ? 'allowed' : 'allowed_warning',
    level,
    utilizationPercent,
    limitAmount: null,
    remainingAmount: null,
    windowMinutes: windowType.endsWith('five_hour') ? 300 : 10080,
    resetsAt: resetsInMs === null ? null : NOW + resetsInMs,
    observedAt: NOW - 4 * MIN,
    updatedAt: NOW - 4 * MIN,
  };
}

function account(
  id: string,
  label: string,
  windows: CredentialLimitWindowSummary[]
): ProfileBudget {
  const usage: CredentialLimitCredentialSummary = {
    credentialReference: `cc_credentials:${id}`,
    credentialId: id,
    credentialName: label,
    credentialSource: 'user',
    provider: 'anthropic',
    providerMode: 'direct',
    agentType: 'claude-code',
    level: 'ok',
    observedAt: NOW - 4 * MIN,
    windows,
  };
  return { kind: 'account', label, usage };
}

const ROOMY = account('samsam', 'Sam Sam', [
  window('claude.five_hour', 17, 'ok', HOUR),
  window('claude.seven_day', 9, 'ok', 100 * HOUR),
]);
const LOW = account('support', 'Sam Support', [
  window('claude.five_hour', 94, 'critical', 52 * MIN),
  window('claude.seven_day', 69, 'ok', 7 * HOUR),
]);
const OUT = account('social', 'Sam Social', [
  window('claude.five_hour', 100, 'rejected', 2 * HOUR + 10 * MIN),
  window('claude.seven_day', 56, 'ok', 4 * HOUR),
]);

function profile(id: string, overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id,
    projectId: 'p1',
    userId: 'u1',
    name: id,
    description: null,
    agentType: 'claude-code',
    model: 'claude-opus-5-5',
    effort: 'high',
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    runtime: null,
    devcontainerConfigName: null,
    taskMode: 'conversation',
    githubCliPolicy: null,
    agentModels: null,
    isBuiltin: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

describe('profileUsage', () => {
  it('reads what is left on the window that stops the profile first', () => {
    expect(profileUsage(ROOMY, NOW)).toMatchObject({
      state: 'ok',
      left: 83,
      resetIn: '1h',
      accountLabel: 'Sam Sam',
      accountKey: 'cc_credentials:samsam',
    });
    expect(profileUsage(LOW, NOW)).toMatchObject({ state: 'low', left: 6, resetIn: '52m' });
  });

  it('treats a refused window as out, with its reset', () => {
    expect(profileUsage(OUT, NOW)).toMatchObject({ state: 'out', left: 0, resetIn: '2h 10m' });
  });

  it('is back only when every refused window has reset', () => {
    const both = account('both', 'Both', [
      window('claude.five_hour', 100, 'rejected', HOUR),
      window('claude.seven_day', 100, 'rejected', 30 * HOUR),
    ]);
    expect(profileUsage(both, NOW)).toMatchObject({ state: 'out', resetIn: '1d 6h' });
    const unknown = account('unknown', 'Unknown', [
      window('claude.five_hour', 100, 'rejected', HOUR),
      window('claude.seven_day', 100, 'rejected', null),
    ]);
    // The week is the one used up, and its return is unknown.
    expect(usageNotice(profileUsage(unknown, NOW))).toBe('Week used up');
  });

  it('takes the countdown from the window the percentage is measured on', () => {
    // The provider warns early on the week; the 5h window is fuller and stops it first.
    const early = account('early', 'Early', [
      window('claude.five_hour', 80, 'ok', HOUR),
      window('claude.seven_day', 60, 'warning', 72 * HOUR),
    ]);
    expect(profileUsage(early, NOW)).toMatchObject({ state: 'low', left: 20, resetIn: '1h' });
  });

  it('counts a window whose reset passed since its sample as fresh', () => {
    const elapsed = account('old', 'Old', [window('claude.five_hour', 100, 'rejected', -MIN)]);
    expect(profileUsage(elapsed, NOW)).toMatchObject({ state: 'ok', left: 100 });
  });

  it('has no reading for platform, paused, no account and an unsampled account', () => {
    expect(profileUsage({ kind: 'platform' }, NOW).state).toBe('platform');
    expect(profileUsage({ kind: 'none' }, NOW).state).toBe('none');
    expect(profileUsage({ kind: 'paused', label: 'Old Max' }, NOW)).toMatchObject({
      state: 'paused',
      accountLabel: 'Old Max',
    });
    expect(profileUsage({ kind: 'account', label: 'Fresh', usage: null }, NOW).state).toBe(
      'unknown'
    );
    expect(profileUsage(undefined, NOW).state).toBe('unknown');
  });
});

describe('usage words', () => {
  it('stays quiet while both windows have more than half left, and speaks both', () => {
    const roomy = profileUsage(ROOMY, NOW);
    expect(usageNotice(roomy)).toBeNull();
    expect(usageSpoken(roomy)).toBe('5h 83% left, Week 91% left');
  });

  it('names each window at or below half, the session first, with its reset', () => {
    expect(usageNotice(profileUsage(LOW, NOW))).toBe(
      '5h 6% left · resets 52m · Week 31% left · resets 7h'
    );
    expect(usageNotice(profileUsage(OUT, NOW))).toBe(
      '5h used up · back in 2h 10m · Week 44% left · resets 4h'
    );
    expect(usageNotice(profileUsage({ kind: 'paused', label: 'Old Max' }, NOW))).toBe(
      'Old Max paused'
    );
    expect(usageNotice(profileUsage({ kind: 'none' }, NOW))).toBe('No account connected');
    expect(usageNotice(profileUsage({ kind: 'platform' }, NOW))).toBeNull();
  });
});

describe('usage ring and windows (approved 2026-11-13)', () => {
  it('splits the session window from the week and sorts the meters shortest first', () => {
    const usage = profileUsage(
      account('three', 'Team seat', [
        window('claude.seven_day_opus', 88, 'warning', 100 * HOUR),
        window('claude.five_hour', 12, 'ok', 3 * HOUR),
        window('claude.seven_day', 40, 'ok', 100 * HOUR),
      ]),
      NOW
    );
    expect(usage.session).toMatchObject({ label: '5h', left: 88 });
    // The tightest long window colours the ring: the Opus week, not the plain week.
    expect(usage.week).toMatchObject({ label: 'Opus week', left: 12 });
    expect(usage.windows.map((reading) => reading.shortLabel)).toEqual(['5h', 'Opus', 'Wk']);
    expect(usage.color).toBe(USAGE_COLORS.urgent);
    expect(ringLeft(usage)).toBe(88);
  });

  it('colours the ring by the week: green above half, amber to a quarter, red below', () => {
    const at = (weekUsed: number) =>
      profileUsage(
        account('w', 'W', [
          window('claude.five_hour', 10, 'ok', HOUR),
          window('claude.seven_day', weekUsed, 'ok', 50 * HOUR),
        ]),
        NOW
      ).color;
    expect(at(49)).toBe(USAGE_COLORS.calm);
    expect(at(50)).toBe(USAGE_COLORS.low);
    expect(at(75)).toBe(USAGE_COLORS.low);
    expect(at(76)).toBe(USAGE_COLORS.urgent);
  });

  it('a used-up 5h on a healthy week is an empty arc in the week’s colour', () => {
    const usage = profileUsage(
      account('session-out', 'Session out', [
        window('claude.five_hour', 100, 'rejected', HOUR),
        window('claude.seven_day', 20, 'ok', 50 * HOUR),
      ]),
      NOW
    );
    expect(usage.state).toBe('out');
    expect(ringLeft(usage)).toBe(0);
    expect(usage.color).toBe(USAGE_COLORS.calm);
    // Control: the same session with the week nearly gone is red.
    const tight = profileUsage(
      account('both', 'Both', [
        window('claude.five_hour', 100, 'rejected', HOUR),
        window('claude.seven_day', 80, 'ok', 50 * HOUR),
      ]),
      NOW
    );
    expect(tight.color).toBe(USAGE_COLORS.urgent);
  });

  it('a used-up week empties the arc whatever the session says', () => {
    const usage = profileUsage(
      account('week-out', 'Week out', [
        window('claude.five_hour', 30, 'ok', HOUR),
        window('claude.seven_day', 100, 'rejected', 52 * HOUR),
      ]),
      NOW
    );
    expect(usage.state).toBe('out');
    expect(ringLeft(usage)).toBe(0);
    expect(usageNotice(usage)).toBe('Week used up · back in 2d 4h');
  });

  it('a weekly-only account draws the week as the arc', () => {
    const usage = profileUsage(
      account('weekly', 'ChatGPT Pro', [
        { ...window('codex.primary', 94, 'critical', 52 * HOUR), windowMinutes: 10080 },
      ]),
      NOW
    );
    expect(usage.session).toBeNull();
    expect(usage.week).toMatchObject({ label: 'Week', left: 6 });
    expect(ringLeft(usage)).toBe(6);
    expect(usageNotice(usage)).toBe('Week 6% left · resets 2d 4h');
  });
});

describe('roomiestAccount', () => {
  const run = (id: string, budget: ProfileBudget): RunAccount => ({
    id,
    label: id,
    usage: profileUsage(budget, NOW),
  });
  const WEEK_NEARLY_GONE = account('tight', 'Tight', [
    window('claude.five_hour', 5, 'ok', HOUR),
    window('claude.seven_day', 90, 'critical', 30 * HOUR),
  ]);

  it('offers the account with the most room on the window that stops it first', () => {
    const accounts = [run('low', LOW), run('tight', WEEK_NEARLY_GONE), run('roomy', ROOMY)];
    expect(roomiestAccount(accounts, 'low')?.id).toBe('roomy');
  });

  it('never offers the current account, an out one, or one nearly out on its week', () => {
    const accounts = [run('roomy', ROOMY), run('out', OUT), run('tight', WEEK_NEARLY_GONE)];
    expect(roomiestAccount(accounts, 'roomy')).toBeNull();
    // Control: with the current account elsewhere, the roomy one is offered.
    expect(roomiestAccount(accounts, 'other')?.id).toBe('roomy');
  });

  it('does not offer an account with no reading', () => {
    const fresh = run('fresh', { kind: 'account', label: 'Fresh', usage: null });
    expect(roomiestAccount([fresh], 'low')).toBeNull();
  });
});

describe('pickerSections with exhausted profiles', () => {
  const profiles = [profile('a'), profile('out'), profile('b', { taskMode: 'task' }), profile('h')];
  const state: ProfilePickerState = {
    usage: [
      { profileId: 'out', lastUsedAt: '2026-11-08T10:00:00Z', chatCount: 3 },
      { profileId: 'a', lastUsedAt: '2026-11-08T09:00:00Z', chatCount: 1 },
    ],
    hiddenProfileIds: ['h'],
    usageWindowDays: 30,
  };

  it('moves out profiles from Recent into "Out for now", above hidden', () => {
    const sections = pickerSections(profiles, state, '', 3, new Set(['out', 'h']));
    expect(sections.map((section) => [section.id, section.items.map((p) => p.id)])).toEqual([
      ['recent', ['a']],
      ['build', ['b']],
      ['out', ['out']],
      ['hidden', ['h']],
    ]);
  });

  it('lists every match together while searching', () => {
    const sections = pickerSections(profiles, state, 'out', 3, new Set(['out']));
    expect(sections).toEqual([{ id: 'results', label: 'Results', items: [profiles[1]] }]);
  });
});

function usageMap(entries: Array<[string, ProfileBudget]>): ReadonlyMap<string, ProfileUsage> {
  return new Map(entries.map(([id, budget]) => [id, profileUsage(budget, NOW)]));
}

describe('picker surfaces with usage', () => {
  const opus = profile('opus', { name: 'Opus 5.5 Chat' });
  const social = profile('social', { name: 'SamSamC' });
  const claudiii = profile('claudiii', { name: 'Claudiii' });
  const usages = usageMap([
    ['opus', LOW],
    ['social', OUT],
    ['claudiii', ROOMY],
  ]);

  it('cards draw the ring and say only what matters', () => {
    render(
      <NewChatProfileCards
        profiles={[opus, social, claudiii]}
        pickerState={undefined}
        loading={false}
        selectedProfileId="opus"
        usages={usages}
        onSelect={vi.fn()}
        onShowAll={vi.fn()}
      />
    );
    const low = screen.getByRole('button', { name: /^Opus 5\.5 Chat/ });
    expect(low).toHaveAccessibleName(/5h 6% left · resets 52m · Week 31% left · resets 7h$/);
    expect(within(low).getByTestId('profile-usage-notice')).toHaveTextContent(
      '5h 6% left · resets 52m · Week 31% left · resets 7h'
    );
    expect(within(low).getByTestId('profile-usage-ring')).toHaveAttribute('data-usage-left', '6');
    const out = screen.getByRole('button', { name: /^SamSamC/ });
    expect(within(out).getByTestId('profile-usage-notice')).toHaveTextContent(
      '5h used up · back in 2h 10m'
    );
    // The used-up session still shows a dot, not an empty ring.
    expect(within(out).getByTestId('profile-usage-ring-empty')).toBeInTheDocument();
    const roomy = screen.getByRole('button', { name: /^Claudiii/ });
    expect(roomy).toHaveAccessibleName(/5h 83% left, Week 91% left$/);
    expect(within(roomy).queryByTestId('profile-usage-notice')).not.toBeInTheDocument();
    expect(within(roomy).getByTestId('profile-usage-ring')).toHaveAttribute(
      'data-usage-left',
      '83'
    );
  });

  it('cards render as before where usage is not loaded', () => {
    render(
      <NewChatProfileCards
        profiles={[opus, claudiii]}
        pickerState={undefined}
        loading={false}
        selectedProfileId={null}
        onSelect={vi.fn()}
        onShowAll={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /^Opus 5\.5 Chat/ })).toBeInTheDocument();
    expect(screen.queryByTestId('profile-usage-ring')).not.toBeInTheDocument();
  });

  it('the sheet folds exhausted profiles into "Out for now"', () => {
    render(
      <MemoryRouter>
        <ProfilePickerSheet
          open
          anchor={null}
          projectId="p1"
          profiles={[opus, social, claudiii]}
          selectedProfileId="opus"
          pickerState={undefined}
          usages={usages}
          hiddenUpdating={false}
          hiddenUpdateError={null}
          onSelect={vi.fn()}
          onSetHidden={vi.fn()}
          onClose={vi.fn()}
          onNewProfile={vi.fn()}
        />
      </MemoryRouter>
    );
    const sheet = screen.getByRole('dialog', { name: 'Choose a profile' });
    expect(within(sheet).getByRole('button', { name: /^Claudiii/ })).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: /^SamSamC/ })).not.toBeInTheDocument();
    const fold = within(sheet).getByRole('button', { name: 'Out for now (1)' });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(fold);
    expect(fold).toHaveAttribute('aria-expanded', 'true');
    const row = within(sheet).getByRole('button', { name: /^SamSamC/ });
    expect(row).toHaveTextContent('Outback in 2h 10m');
    // Rows show every window as a labelled meter in percent left.
    const lowRow = within(sheet).getByRole('button', { name: /^Opus 5\.5 Chat/ });
    expect(within(lowRow).getByTestId('usage-meters')).toHaveTextContent('5h6% leftWk31% left');
  });

  it('the To chip carries the ring and says what is left', () => {
    render(
      <ProfileToControl
        profile={opus}
        usage={usages.get('opus')}
        loading={false}
        disabled={false}
        onOpen={vi.fn()}
      />
    );
    const chip = screen.getByRole('button', { name: /^To Opus 5\.5 Chat/ });
    expect(chip).toHaveAccessibleName(
      'To Opus 5.5 Chat, 5h 6% left · resets 52m · Week 31% left · resets 7h, change profile'
    );
    expect(within(chip).getByTestId('profile-usage-ring')).toHaveAttribute('data-usage-left', '6');
  });

  it('the nudge names the limit and offers your roomiest account for this chat', () => {
    const onChooseAccount = vi.fn();
    const accounts: RunAccount[] = [
      { id: 'cfg-support', label: 'Sam Support', usage: profileUsage(LOW, NOW) },
      { id: 'cfg-samsam', label: 'Sam Sam', usage: profileUsage(ROOMY, NOW) },
    ];
    render(
      <ProfileUsageNudge
        usage={usages.get('opus')}
        profileUsage={usages.get('opus')}
        accounts={accounts}
        chosenAccount={null}
        onChooseAccount={onChooseAccount}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      '5h limit · 6% left on Sam Support · resets in 52m'
    );
    const offer = screen.getByRole('button', { name: 'Run on Sam Sam' });
    expect(within(offer).getByTestId('usage-meters')).toHaveTextContent('5h83% leftWk91% left');
    fireEvent.click(offer);
    expect(onChooseAccount).toHaveBeenCalledWith('cfg-samsam');
  });

  it('after choosing, one line says which account the chat runs on, with an undo', () => {
    const onChooseAccount = vi.fn();
    const samSam: RunAccount = {
      id: 'cfg-samsam',
      label: 'Sam Sam',
      usage: profileUsage(ROOMY, NOW),
    };
    render(
      <ProfileUsageNudge
        usage={samSam.usage}
        profileUsage={usages.get('opus')}
        accounts={[samSam]}
        chosenAccount={samSam}
        onChooseAccount={onChooseAccount}
      />
    );
    expect(screen.getByTestId('run-account-swapped')).toHaveTextContent(
      'This chat runs on Sam Sam instead of Sam Support'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use Sam Support again' }));
    expect(onChooseAccount).toHaveBeenCalledWith(null);
  });

  it('the nudge stays away while there is room', () => {
    const { container } = render(
      <ProfileUsageNudge
        usage={usages.get('claudiii')}
        profileUsage={usages.get('claudiii')}
        accounts={[]}
        chosenAccount={null}
        onChooseAccount={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

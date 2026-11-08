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
  type ProfileUsage,
  profileUsage,
  roomierProfile,
  usageNotice,
  usageSpoken,
} from '../../../../src/components/project-chat/profile-picker/usage';

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
    expect(usageNotice(profileUsage(unknown, NOW))).toBe('Out for now');
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
  it('stays quiet while there is room, and speaks the room for screen readers', () => {
    const roomy = profileUsage(ROOMY, NOW);
    expect(usageNotice(roomy)).toBeNull();
    expect(usageSpoken(roomy)).toBe('83% left');
  });

  it('names the reset when low, and the return when out', () => {
    expect(usageNotice(profileUsage(LOW, NOW))).toBe('6% left · resets 52m');
    expect(usageNotice(profileUsage(OUT, NOW))).toBe('Out · back in 2h 10m');
    expect(usageNotice(profileUsage({ kind: 'paused', label: 'Old Max' }, NOW))).toBe(
      'Old Max paused'
    );
    expect(usageNotice(profileUsage({ kind: 'none' }, NOW))).toBe('No account connected');
    expect(usageNotice(profileUsage({ kind: 'platform' }, NOW))).toBeNull();
  });
});

describe('roomierProfile', () => {
  const opus = profile('opus');
  const usages = new Map<string, ProfileUsage>([
    ['opus', profileUsage(LOW, NOW)],
    ['claudiii', profileUsage(ROOMY, NOW)],
    ['same-account', profileUsage(LOW, NOW)],
    ['other-model', profileUsage(ROOMY, NOW)],
    ['other-agent', profileUsage(ROOMY, NOW)],
  ]);
  const usageFor = (id: string) => usages.get(id);

  it('offers a same-agent, same-model profile on another account with room', () => {
    const candidates = [
      opus,
      profile('same-account'),
      profile('other-model', { model: 'claude-fable-5-1' }),
      profile('other-agent', { agentType: 'openai-codex' }),
      profile('claudiii'),
    ];
    expect(roomierProfile(opus, candidates, usageFor)?.profile.id).toBe('claudiii');
  });

  it('never offers another profile on the same account, however much room it shows', () => {
    // Same credential as the selected profile, but read with room (e.g. a fresher sample).
    const shared = new Map(usages);
    shared.set('twin', { ...profileUsage(ROOMY, NOW), accountKey: 'cc_credentials:support' });
    const candidates = [opus, profile('twin')];
    expect(roomierProfile(opus, candidates, (id) => shared.get(id))).toBeNull();
    // Control: the same profile on a different account is offered.
    shared.set('twin', profileUsage(ROOMY, NOW));
    expect(roomierProfile(opus, candidates, (id) => shared.get(id))?.profile.id).toBe('twin');
  });

  it('does not offer a profile that builds and opens PRs in place of a chat one', () => {
    const candidates = [opus, profile('claudiii', { taskMode: 'task' })];
    expect(roomierProfile(opus, candidates, usageFor)).toBeNull();
  });

  it('offers nothing when no other account has room for that model', () => {
    const candidates = [opus, profile('same-account'), profile('other-model', { model: 'x' })];
    expect(roomierProfile(opus, candidates, usageFor)).toBeNull();
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
    expect(low).toHaveAccessibleName(/6% left · resets 52m$/);
    expect(within(low).getByText('6% left · resets 52m')).toBeInTheDocument();
    expect(within(low).getByTestId('profile-usage-ring')).toHaveAttribute('data-usage-left', '6');
    const out = screen.getByRole('button', { name: /^SamSamC/ });
    expect(within(out).getByText('Out · back in 2h 10m')).toBeInTheDocument();
    const roomy = screen.getByRole('button', { name: /^Claudiii/ });
    expect(roomy).toHaveAccessibleName(/83% left$/);
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
    expect(within(sheet).getByRole('button', { name: /^Opus 5\.5 Chat/ })).toHaveTextContent(
      '6% leftresets 52m'
    );
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
    expect(chip).toHaveAccessibleName('To Opus 5.5 Chat, 6% left · resets 52m, change profile');
    expect(within(chip).getByTestId('profile-usage-ring')).toHaveAttribute('data-usage-left', '6');
  });

  it('the nudge offers the roomier profile and switches to it', () => {
    const onSwitch = vi.fn();
    render(
      <ProfileUsageNudge
        profile={opus}
        usage={usages.get('opus')}
        candidates={[opus, social, claudiii]}
        usageFor={(id) => usages.get(id)}
        onSwitch={onSwitch}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('6% left on Sam Support · resets in 52m');
    fireEvent.click(screen.getByRole('button', { name: 'Use Claudiii · 83% left' }));
    expect(onSwitch).toHaveBeenCalledWith('claudiii');
  });

  it('the nudge stays away while there is room', () => {
    const { container } = render(
      <ProfileUsageNudge
        profile={claudiii}
        usage={usages.get('claudiii')}
        candidates={[opus, claudiii]}
        usageFor={(id) => usages.get(id)}
        onSwitch={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

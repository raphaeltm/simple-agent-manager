/**
 * Choosing the account for one new chat, through the real composer (`ChatInput`) and the
 * real per-chat overrides state (`useComposerOverrides`) that submit reads. Only the account
 * list is faked (`useRunAccounts`); choosing, the ring following the choice, the nudge's
 * "Run on …", undo, and the request field the server receives all run for real (rule 62).
 */
import type {
  AgentProfile,
  CredentialLimitCredentialSummary,
  CredentialLimitLevel,
  CredentialLimitWindowSummary,
} from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProfileBudget } from '../../../src/components/agent-profiles/useProfileBudgets';
import type { RunAccount } from '../../../src/components/project-chat/profile-picker/run-accounts';
import {
  type ProfileUsage,
  profileUsage,
} from '../../../src/components/project-chat/profile-picker/usage';

const runAccounts = vi.hoisted(() => ({ current: null as RunAccount[] | null }));

vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simple-agent-manager/acp-client')>();
  return { ...actual, VoiceButton: () => null };
});
vi.mock('../../../src/components/project-chat/profile-picker/run-accounts', async (original) => ({
  ...(await original<
    typeof import('../../../src/components/project-chat/profile-picker/run-accounts')
  >()),
  useRunAccounts: () => runAccounts.current,
}));

const { ChatInput } = await import('../../../src/pages/project-chat/ChatInput');
const { useComposerOverrides } =
  await import('../../../src/pages/project-chat/useComposerOverrides');

Element.prototype.scrollIntoView = vi.fn();

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;

function window(
  windowType: string,
  used: number,
  level: CredentialLimitLevel,
  resetsIn: number
): CredentialLimitWindowSummary {
  return {
    windowType,
    provider: 'anthropic',
    source: 'test',
    status: level === 'rejected' ? 'rejected' : 'allowed',
    level,
    utilizationPercent: used,
    limitAmount: null,
    remainingAmount: null,
    windowMinutes: windowType.endsWith('five_hour') ? 300 : 10080,
    resetsAt: NOW + resetsIn,
    observedAt: NOW - MIN,
    updatedAt: NOW - MIN,
  };
}

function budget(id: string, label: string, windows: CredentialLimitWindowSummary[]): ProfileBudget {
  const usage: CredentialLimitCredentialSummary = {
    credentialReference: `cc_credentials:${id}`,
    credentialId: id,
    credentialName: label,
    credentialSource: 'user',
    provider: 'anthropic',
    providerMode: 'direct',
    agentType: 'claude-code',
    level: 'ok',
    observedAt: NOW - MIN,
    windows,
  };
  return { kind: 'account', accountId: `cfg-${id}`, label, usage };
}

// Personal Pro is weekly-only and nearly spent; Work Max has room on both windows.
const PERSONAL = budget('personal', 'Personal Pro', [
  window('claude.seven_day', 94, 'critical', 52 * HOUR),
]);
const WORK = budget('work', 'Work Max', [
  window('claude.five_hour', 72, 'ok', 52 * MIN),
  window('claude.seven_day', 31, 'ok', 96 * HOUR),
]);
const CODEX_PROFILE_ACCOUNT = budget('team', 'Team seat', [
  window('claude.five_hour', 10, 'ok', HOUR),
]);

function account(id: string, b: ProfileBudget): RunAccount {
  return { id: `cfg-${id}`, label: (b as { label: string }).label, usage: profileUsage(b, NOW) };
}

const profile: AgentProfile = {
  id: 'opus',
  projectId: 'p1',
  userId: 'u1',
  name: 'Opus Chat',
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
};

let submitFields: () => ReturnType<ReturnType<typeof useComposerOverrides>['agentOverrideFields']>;

function Harness({ usages }: Readonly<{ usages: ReadonlyMap<string, ProfileUsage> }>) {
  const overrides = useComposerOverrides('p1');
  submitFields = () => overrides.agentOverrideFields(profile, null);
  return (
    <ChatInput
      value=""
      onChange={vi.fn()}
      onSubmit={vi.fn()}
      submitting={false}
      error={null}
      placeholder="Ask"
      transcribeApiUrl="/t"
      projectId="p1"
      agents={[{ id: 'claude-code', name: 'Claude Code' } as never]}
      agentProfiles={[profile]}
      selectedProfileId="opus"
      onProfileChange={vi.fn()}
      profilePicker={{
        picker: { status: 'ready', state: undefined } as never,
        state: undefined,
        setHidden: vi.fn(),
        updating: false,
        updateError: null,
        refresh: vi.fn(),
      }}
      profileUsages={usages}
      profileSheet={{ open: false, anchor: null }}
      onOpenProfileSheet={vi.fn()}
      onCloseProfileSheet={vi.fn()}
      skills={[]}
      selectedSkillId={null}
      onSkillChange={vi.fn()}
      onUpdateProfile={vi.fn()}
      taskResourceReqs={overrides.taskResourceReqs}
      onTaskResourceReqsChange={overrides.setTaskResourceReqs}
      taskResourceErrors={overrides.taskResourceErrors}
      onTaskResourceErrorsClear={() => overrides.setTaskResourceErrors({})}
      agentOverrides={overrides.agentOverrides}
      onAgentOverridesChange={overrides.setAgentOverrides}
      profileWizard={{ open: false } as never}
      onOpenProfileWizard={vi.fn()}
      onCloseProfileWizard={vi.fn()}
      onUpdateProfileWizard={vi.fn()}
      onCreateProfileFromWizard={vi.fn()}
      suggestProfileName={() => 'x'}
    />
  );
}

function renderComposer(profileBudget: ProfileBudget = PERSONAL) {
  const usages = new Map([['opus', profileUsage(profileBudget, NOW)]]);
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Harness usages={usages} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function ring() {
  return within(screen.getByRole('button', { name: /^To Opus Chat/ })).getByTestId(
    'profile-usage-ring'
  );
}

describe('choosing the account for this chat', () => {
  beforeEach(() => {
    runAccounts.current = [account('personal', PERSONAL), account('work', WORK)];
  });

  it('runs on the profile’s account and sends nothing until one is chosen', () => {
    renderComposer();
    expect(
      screen.getByRole('button', { name: 'Runs on Personal Pro, change account' })
    ).toBeVisible();
    // Weekly-only: the arc is the week.
    expect(ring()).toHaveAttribute('data-usage-left', '6');
    expect(submitFields()).toEqual({});
  });

  it('choosing an account beside To changes the ring and the request', () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Runs on Personal Pro, change account' }));
    const list = screen.getByRole('radiogroup', { name: 'Account for this chat' });
    expect(within(list).getByRole('radio', { name: /Personal Pro/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    fireEvent.click(within(list).getByRole('radio', { name: /Work Max/ }));

    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Runs on Work Max, change account' })).toBeVisible();
    // The ring follows the chosen account: its 5h window (28% left).
    expect(ring()).toHaveAttribute('data-usage-left', '28');
    expect(submitFields()).toEqual({ agentConfigurationId: 'cfg-work' });
  });

  it('choosing the profile’s own account again sends nothing', () => {
    renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Runs on Personal Pro, change account' }));
    fireEvent.click(screen.getByRole('radio', { name: /Work Max/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Runs on Work Max, change account' }));
    fireEvent.click(screen.getByRole('radio', { name: /Personal Pro/ }));
    expect(submitFields()).toEqual({});
  });

  it('the nudge names the weekly limit and "Run on Work Max" sets the same choice; undo clears it', () => {
    renderComposer();
    expect(screen.getByTestId('profile-usage-nudge')).toHaveTextContent(
      'Weekly limit · 6% left on Personal Pro · resets in 2d 4h'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run on Work Max' }));

    expect(submitFields()).toEqual({ agentConfigurationId: 'cfg-work' });
    expect(screen.getByTestId('run-account-swapped')).toHaveTextContent(
      'This chat runs on Work Max instead of Personal Pro'
    );
    expect(screen.getByRole('button', { name: 'Runs on Work Max, change account' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Use Personal Pro again' }));
    expect(submitFields()).toEqual({});
    expect(screen.getByTestId('profile-usage-nudge')).toBeInTheDocument();
  });

  it('hides the control when there is only one account to run on', () => {
    runAccounts.current = [account('team', CODEX_PROFILE_ACCOUNT)];
    renderComposer(CODEX_PROFILE_ACCOUNT);
    // Liveness: the composer rendered with its To control.
    expect(screen.getByRole('button', { name: /^To Opus Chat/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /change account$/ })).not.toBeInTheDocument();
  });

  it('drops a chosen account that disappears (paused or removed) instead of sending it', () => {
    const { rerender } = renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Run on Work Max' }));
    expect(submitFields()).toEqual({ agentConfigurationId: 'cfg-work' });

    runAccounts.current = [account('personal', PERSONAL)];
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <Harness usages={new Map([['opus', profileUsage(PERSONAL, NOW)]])} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(submitFields()).toEqual({});
  });
});

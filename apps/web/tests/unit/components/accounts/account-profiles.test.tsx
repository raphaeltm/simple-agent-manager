/**
 * Personal profile pins in the UI, from the API rows to what the user sees:
 *
 *  - Settings → Agents: "Use in profiles…" on an account card (real page).
 *  - The profile editor's Account section (real section and hooks).
 *
 * Only the API module is mocked. Each mutation mock updates the rows the server
 * would return, so the assertions read the refetched UI.
 */
import type { CCProfileAttachmentItem, CCProfilePinCandidate } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AccountRows, accountRows, mergeRows } from './fixtures';

const mocks = vi.hoisted(() => ({
  getResolutionStatus: vi.fn(),
  listCCCredentials: vi.fn(),
  listCCConfigurations: vi.fn(),
  listCCAttachments: vi.fn(),
  listProfilePins: vi.fn(),
  listProfilePinCandidates: vi.fn(),
  createProfilePin: vi.fn(),
  deleteProfilePin: vi.fn(),
  listProjects: vi.fn(),
  getMyCredentialLimits: vi.fn(),
  listAgents: vi.fn(),
  getAgentSettings: vi.fn(),
  getProjectMembers: vi.fn(),
  listSkills: vi.fn(),
}));

vi.mock('../../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com', name: 'Test User' } }),
}));

vi.mock('../../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/api')>()),
  ...mocks,
}));

vi.mock('../../../../src/components/AgentSettingsCard', () => ({
  AgentSettingsCard: () => null,
}));

import { ProjectAccountsSection } from '../../../../src/components/accounts/ProjectAccountsSection';
import { ProfileAccountFormSection } from '../../../../src/components/agent-profiles/ProfileAccountFormSection';
import { ToastProvider } from '../../../../src/hooks/useToast';
import { SettingsAgents } from '../../../../src/pages/SettingsAgents';
import { QueryTestWrapper } from '../../../test-utils/query-test-utils';

const PROJECTS = [
  { id: 'p-web', name: 'Marketing site' },
  { id: 'p-api', name: 'Billing API' },
];

const WORK = {
  id: 'work',
  name: 'Work Max plan',
  kind: 'agent' as const,
  target: 'claude-code',
  credentialKind: 'oauth-token',
  isDefault: true,
};
const CLIENT = {
  id: 'client',
  name: 'Client API key',
  kind: 'agent' as const,
  target: 'claude-code',
  pins: ['p-api'],
};
const MAX = {
  id: 'max',
  name: 'Claude Max (personal)',
  kind: 'agent' as const,
  target: 'claude-code',
  credentialKind: 'oauth-token',
};
const PAUSED = {
  id: 'paused',
  name: 'Old Anthropic key',
  kind: 'agent' as const,
  target: 'claude-code',
  credentialActive: false,
};

const CANDIDATES: CCProfilePinCandidate[] = [
  {
    id: 'prof-global',
    name: 'Everyday',
    agentType: 'claude-code',
    projectId: null,
    projectName: null,
  },
  {
    id: 'prof-deep',
    name: 'Opus deep work',
    agentType: 'claude-code',
    projectId: 'p-web',
    projectName: 'Marketing site',
  },
  {
    id: 'prof-review',
    name: 'Reviewer',
    agentType: 'claude-code',
    projectId: 'p-api',
    projectName: 'Billing API',
  },
];

let rows: AccountRows = mergeRows();
let pins: CCProfileAttachmentItem[] = [];

function pinOn(profile: CCProfilePinCandidate, configurationId: string): CCProfileAttachmentItem {
  return {
    id: `pin-${profile.id}`,
    configurationId,
    agentProfileId: profile.id,
    profileName: profile.name,
    projectId: profile.projectId,
    projectName: profile.projectName,
    consumerKind: 'agent',
    consumerTarget: 'claude-code',
    isActive: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

function candidate(id: string): CCProfilePinCandidate {
  return CANDIDATES.find((profile) => profile.id === id)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = mergeRows(accountRows(WORK), accountRows(CLIENT), accountRows(MAX), accountRows(PAUSED));
  pins = [pinOn(candidate('prof-review'), 'cfg-client')];
  mocks.getResolutionStatus.mockResolvedValue({ consumers: [] });
  mocks.listCCCredentials.mockImplementation(() => Promise.resolve(rows.credentials));
  mocks.listCCConfigurations.mockImplementation(() => Promise.resolve(rows.configurations));
  mocks.listCCAttachments.mockImplementation(() => Promise.resolve(rows.attachments));
  mocks.listProfilePins.mockImplementation(() => Promise.resolve(pins));
  mocks.listProfilePinCandidates.mockResolvedValue({
    profiles: CANDIDATES,
    truncated: false,
    limit: 500,
  });
  mocks.createProfilePin.mockImplementation(
    ({ configurationId, profileId }: { configurationId: string; profileId: string }) => {
      pins = [
        ...pins.filter((pin) => pin.agentProfileId !== profileId),
        pinOn(candidate(profileId), configurationId),
      ];
      return Promise.resolve({ id: `pin-${profileId}` });
    }
  );
  mocks.deleteProfilePin.mockImplementation((id: string) => {
    pins = pins.filter((pin) => pin.id !== id);
    return Promise.resolve({ success: true });
  });
  mocks.listProjects.mockResolvedValue({ projects: PROJECTS, nextCursor: null });
  mocks.getMyCredentialLimits.mockResolvedValue({ credentials: [] });
  mocks.listAgents.mockResolvedValue({ agents: [] });
  mocks.getAgentSettings.mockResolvedValue(null);
  mocks.getProjectMembers.mockResolvedValue({
    members: [
      { userId: 'user-1', role: 'owner', status: 'active' },
      { userId: 'user-2', role: 'maintainer', status: 'active' },
    ],
  });
  mocks.listSkills.mockResolvedValue([]);
});

describe('Settings → Agents: use an account in profiles', () => {
  function renderPage() {
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/settings/agents']}>
          <SettingsAgents />
        </MemoryRouter>
      </ToastProvider>,
      { wrapper: QueryTestWrapper }
    );
  }

  it('runs two profiles on an unattached account, which then lists them', async () => {
    renderPage();
    const row = await screen.findByTestId('provider-row-claude-code');
    const max = within(row).getByTestId('account-card-cfg-max');
    expect(max).toHaveTextContent('Connected, but nothing uses it.');

    fireEvent.click(within(max).getByRole('button', { name: 'Actions for Claude Max (personal)' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use in profiles…' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Use Claude Max (personal) in profiles',
    });
    expect(mocks.listProfilePinCandidates).toHaveBeenCalledWith('claude-code');
    const option = (name: string) =>
      within(dialog).getByRole('checkbox', { name: new RegExp(name) });
    await within(dialog).findByRole('checkbox', { name: /Everyday/ });
    // Grouped by project, my global profiles first.
    expect(
      within(dialog)
        .getAllByRole('heading')
        .map((h) => h.textContent)
    ).toEqual([
      'Use Claude Max (personal) in profiles',
      'Your profiles · every project',
      'Marketing site',
      'Billing API',
    ]);
    expect(option('Everyday')).toHaveAccessibleName(/Uses your usual account/);
    expect(option('Reviewer')).toHaveAccessibleName(/Uses Client API key — checking replaces it/);

    fireEvent.click(option('Everyday'));
    fireEvent.click(option('Reviewer'));
    expect(dialog).toHaveTextContent('2 profiles now run on Claude Max (personal)');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.createProfilePin.mock.calls).toEqual([
      [{ configurationId: 'cfg-max', profileId: 'prof-global' }],
      [{ configurationId: 'cfg-max', profileId: 'prof-review' }],
    ]);

    // After the refetch the account is in use, and the card names its profiles.
    const card = await within(await screen.findByTestId('provider-row-claude-code')).findByTestId(
      'account-card-cfg-max'
    );
    const chips = await within(card).findByTestId('account-profile-pins');
    expect(chips).toHaveTextContent('Everyday');
    expect(within(chips).getByRole('link', { name: 'Reviewer' })).toHaveAttribute(
      'href',
      '/projects/p-api/profiles?edit=prof-review'
    );
    expect(card).not.toHaveTextContent('Connected, but nothing uses it.');
  });

  it('pins that arrive after the dialog opens are kept; only my toggles are saved', async () => {
    let releasePins!: () => void;
    mocks.listProfilePins.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePins = () => resolve([pinOn(candidate('prof-global'), 'cfg-max')]);
        })
    );
    renderPage();
    const row = await screen.findByTestId('provider-row-claude-code');
    const max = within(row).getByTestId('account-card-cfg-max');
    fireEvent.click(within(max).getByRole('button', { name: 'Actions for Claude Max (personal)' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use in profiles…' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Use Claude Max (personal) in profiles',
    });
    await within(dialog).findByRole('checkbox', { name: /Everyday/ });

    // My pin on Everyday loads only now, after the dialog opened.
    pins = [pinOn(candidate('prof-global'), 'cfg-max')];
    releasePins();
    await waitFor(() =>
      expect(within(dialog).getByRole('checkbox', { name: /Everyday/ })).toBeChecked()
    );

    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Opus deep work/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.createProfilePin.mock.calls).toEqual([
        [{ configurationId: 'cfg-max', profileId: 'prof-deep' }],
      ])
    );
    expect(mocks.deleteProfilePin).not.toHaveBeenCalled();
  });

  it('unchecking a profile puts it back on my usual account', async () => {
    renderPage();
    const row = await screen.findByTestId('provider-row-claude-code');
    const client = within(row).getByTestId('account-card-cfg-client');
    fireEvent.click(within(client).getByRole('button', { name: 'Actions for Client API key' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use in profiles…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Use Client API key in profiles' });
    const reviewer = await within(dialog).findByRole('checkbox', { name: /Reviewer/ });
    expect(reviewer).toBeChecked();
    fireEvent.click(reviewer);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocks.deleteProfilePin).toHaveBeenCalledWith('pin-prof-review'));
    expect(mocks.createProfilePin).not.toHaveBeenCalled();
  });
});

describe('Profile editor: Account section', () => {
  const profile = {
    id: 'prof-deep',
    projectId: 'p-web',
    agentType: 'claude-code',
  } as Parameters<typeof ProfileAccountFormSection>[0]['profile'];

  function renderSection() {
    render(
      <ToastProvider>
        <MemoryRouter>
          <ProfileAccountFormSection profile={profile} projectId="p-web" />
        </MemoryRouter>
      </ToastProvider>,
      { wrapper: QueryTestWrapper }
    );
    fireEvent.click(screen.getByRole('button', { name: /Account/ }));
  }

  it('picks an account for this profile, and the run then uses it', async () => {
    mocks.listSkills.mockResolvedValue([
      { id: 'sk-1', name: 'Port to Go', agentType: 'openai-codex' },
    ]);
    renderSection();

    const section = await screen.findByTestId('profile-account-section');
    expect(section).toHaveTextContent('Only you see this');
    expect(section).toHaveTextContent('Other members pick their own account for this profile.');
    expect(
      within(section).getByRole('radio', { name: /Use my usual account/ })
    ).toHaveAccessibleName(/Right now: Work Max plan/);
    expect(within(section).getByRole('radio', { name: /Use my usual account/ })).toBeChecked();
    await waitFor(() =>
      expect(section).toHaveTextContent(
        'Port to Go switches the agent, so runs started with it don’t use this Claude Code choice.'
      )
    );
    // A paused account is shown but cannot be chosen.
    expect(within(section).getByRole('radio', { name: /Old Anthropic key/ })).toBeDisabled();

    fireEvent.click(within(section).getByRole('radio', { name: /Claude Max \(personal\)/ }));

    await waitFor(() =>
      expect(mocks.createProfilePin).toHaveBeenCalledWith({
        configurationId: 'cfg-max',
        profileId: 'prof-deep',
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId('profile-account-outcome')).toHaveTextContent(
        'Runs Claude Code on Claude Max (personal).'
      )
    );
    expect(within(section).getByRole('radio', { name: /Claude Max \(personal\)/ })).toBeChecked();
  });

  it('going back to my usual account removes the pin', async () => {
    pins = [pinOn(candidate('prof-deep'), 'cfg-max')];
    renderSection();

    const usual = await screen.findByRole('radio', { name: /Use my usual account/ });
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Claude Max \(personal\)/ })).toBeChecked()
    );
    fireEvent.click(usual);

    await waitFor(() => expect(mocks.deleteProfilePin).toHaveBeenCalledWith('pin-prof-deep'));
    await waitFor(() =>
      expect(screen.getByTestId('profile-account-outcome')).toHaveTextContent(
        'Runs Claude Code on Work Max plan.'
      )
    );
  });

  it('shows the clicked account as chosen while the save is in flight', async () => {
    let release!: () => void;
    const created = mocks.createProfilePin.getMockImplementation()!;
    mocks.createProfilePin.mockImplementation(
      (input: { configurationId: string; profileId: string }) =>
        new Promise((resolve) => {
          release = () => resolve(created(input));
        })
    );
    renderSection();

    const section = await screen.findByTestId('profile-account-section');
    const usual = within(section).getByRole('radio', { name: /Use my usual account/ });
    const max = within(section).getByRole('radio', { name: /Claude Max \(personal\)/ });
    expect(usual).toBeChecked();

    fireEvent.click(max);

    // The save has not returned, yet the choice already shows.
    await waitFor(() => expect(mocks.createProfilePin).toHaveBeenCalled());
    expect(max).toBeChecked();
    expect(usual).not.toBeChecked();

    release();
    await waitFor(() =>
      expect(screen.getByTestId('profile-account-outcome')).toHaveTextContent(
        'Runs Claude Code on Claude Max (personal).'
      )
    );
    expect(within(section).getByRole('radio', { name: /Claude Max \(personal\)/ })).toBeChecked();
  });

  it('a failed save puts the selection back on the saved choice', async () => {
    let reject!: (err: Error) => void;
    mocks.createProfilePin.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        })
    );
    renderSection();

    const section = await screen.findByTestId('profile-account-section');
    const max = within(section).getByRole('radio', { name: /Claude Max \(personal\)/ });
    fireEvent.click(max);
    await waitFor(() => expect(max).toBeChecked());

    reject(new Error('Account is paused'));

    await waitFor(() =>
      expect(within(section).getByRole('radio', { name: /Use my usual account/ })).toBeChecked()
    );
    expect(
      within(section).getByRole('radio', { name: /Claude Max \(personal\)/ })
    ).not.toBeChecked();
    expect(await screen.findByText('Account is paused')).toBeInTheDocument();
  });

  it('a pin on a paused account stops the run and opens the breakdown', async () => {
    pins = [pinOn(candidate('prof-deep'), 'cfg-paused')];
    renderSection();

    const outcome = await screen.findByTestId('profile-account-outcome');
    await waitFor(() =>
      expect(outcome).toHaveTextContent(
        'Stops: the account chosen for this profile is paused. SAM won’t switch to another account.'
      )
    );
    const breakdown = screen.getByRole('list', { name: 'How SAM picks the account' });
    expect(breakdown).toBeVisible();
    expect(within(breakdown).getAllByRole('listitem')[0]).toHaveTextContent(
      /Your account for this profile.*Stops here.*“Old Anthropic key” is paused/
    );
    // The paused pin stays selected so the user can see and change it.
    expect(screen.getByRole('radio', { name: /Old Anthropic key/ })).toBeChecked();
  });

  it('waits for my pins before showing a choice, then surfaces a paused pin', async () => {
    let releasePins: (value: CCProfileAttachmentItem[]) => void = () => {};
    mocks.listProfilePins.mockImplementation(
      () =>
        new Promise<CCProfileAttachmentItem[]>((resolve) => {
          releasePins = resolve;
        })
    );
    renderSection();

    // Accounts are loaded, pins are not: no choice is shown yet, so "usual" is never
    // displayed as selected for a profile that actually has a pin.
    await waitFor(() => expect(mocks.listCCAttachments).toHaveBeenCalled());
    await waitFor(() => expect(mocks.listProfilePins).toHaveBeenCalled());
    expect(screen.getByText('Loading your accounts…')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Use my usual account/ })).toBeNull();

    releasePins([pinOn(candidate('prof-deep'), 'cfg-paused')]);

    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Old Anthropic key/ })).toBeChecked()
    );
    expect(screen.getByRole('list', { name: 'How SAM picks the account' })).toBeVisible();
  });

  it('in a single-person project, does not call the choice private', async () => {
    mocks.getProjectMembers.mockResolvedValue({
      members: [{ userId: 'user-1', role: 'owner', status: 'active' }],
    });
    renderSection();

    const section = await screen.findByTestId('profile-account-section');
    await waitFor(() => expect(mocks.getProjectMembers).toHaveBeenCalled());
    expect(section).toHaveTextContent('Which Claude Code account this profile runs on');
    expect(section).not.toHaveTextContent('Only you see this');
  });
});

describe('Project settings → Accounts: profiles that use their own account here', () => {
  it('lists my profile pins that override this project’s account', async () => {
    pins = [
      pinOn(candidate('prof-review'), 'cfg-max'),
      pinOn(candidate('prof-global'), 'cfg-client'),
      // Another project's profile is not listed here.
      pinOn(candidate('prof-deep'), 'cfg-max'),
    ];
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/projects/p-api/settings/accounts']}>
          <ProjectAccountsSection projectId="p-api" projectName="Billing API" />
        </MemoryRouter>
      </ToastProvider>,
      { wrapper: QueryTestWrapper }
    );

    const row = await screen.findByTestId('project-account-row-claude-code');
    await waitFor(() => expect(row).toHaveTextContent('2 of your profiles use their own account'));
    // The project itself still runs on its pinned account.
    const overrides = within(row).getByTestId('project-account-profile-overrides');
    expect(
      within(overrides)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual(['Everyday→Client API keyevery project', 'Reviewer→Claude Max (personal)']);
    expect(overrides).not.toHaveTextContent('Opus deep work');
  });
});

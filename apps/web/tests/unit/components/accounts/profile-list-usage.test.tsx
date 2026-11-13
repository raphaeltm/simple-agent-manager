/**
 * The profile list's Usage and Requests columns, from API rows to what the user
 * sees. Real ProfileList, real account hooks and resolution; only the API module
 * is mocked, with the row shapes the server returns.
 *
 * Three Claude profiles resolve to three different accounts through the three
 * tiers (my default, a project pin, my profile pin), so a list that showed the
 * wrong account's usage would show the wrong numbers.
 */
import type {
  AgentProfile,
  CCProfileAttachmentItem,
  CredentialLimitCredentialSummary,
  CredentialLimitWindowSummary,
} from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountRows, mergeRows, PROJECTS } from './fixtures';

const mocks = vi.hoisted(() => ({
  getResolutionStatus: vi.fn(),
  listCCCredentials: vi.fn(),
  listCCConfigurations: vi.fn(),
  listCCAttachments: vi.fn(),
  listProfilePins: vi.fn(),
  listProjects: vi.fn(),
  getMyCredentialLimits: vi.fn(),
}));

vi.mock('../../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com', name: 'Test User' } }),
}));

vi.mock('../../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/api')>()),
  ...mocks,
}));

import { ProfileList } from '../../../../src/components/agent-profiles/ProfileList';
import { QueryTestWrapper } from '../../../test-utils/query-test-utils';

const NOW = Date.now();
const HOUR = 3_600_000;

function profile(
  overrides: Partial<AgentProfile> & Pick<AgentProfile, 'id' | 'name'>
): AgentProfile {
  return {
    projectId: 'p-web',
    userId: 'user-1',
    description: null,
    agentType: 'claude-code',
    model: 'claude-opus-5-5',
    effort: 'auto',
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    resourceRequirementsJson: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    runtime: null,
    devcontainerConfigName: null,
    taskMode: 'conversation',
    githubCliPolicy: null,
    agentModels: null,
    isBuiltin: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

const PROFILES: AgentProfile[] = [
  // My default account (Work Max).
  profile({
    id: 'prof-everyday',
    name: 'Everyday',
    resourceRequirementsJson: JSON.stringify({ minVcpu: 4, minMemoryGb: 7.5 }),
  }),
  // The Billing API project pins the Client key.
  profile({ id: 'prof-review', name: 'Reviewer', projectId: 'p-api', runtime: 'cf-container' }),
  // My profile pin: Claude Max, even though Work Max is my default.
  profile({ id: 'prof-deep', name: 'Opus deep work', vmSizeOverride: 'medium' }),
];

function limitWindow(
  overrides: Partial<CredentialLimitWindowSummary> &
    Pick<CredentialLimitWindowSummary, 'windowType'>
): CredentialLimitWindowSummary {
  return {
    provider: 'anthropic',
    source: 'claude-acp.rate_limit',
    status: 'allowed',
    level: 'ok',
    utilizationPercent: 10,
    limitAmount: null,
    remainingAmount: null,
    windowMinutes: null,
    resetsAt: NOW + HOUR,
    observedAt: NOW - 60_000,
    updatedAt: NOW - 60_000,
    ...overrides,
  };
}

function usage(
  credentialId: string,
  windows: CredentialLimitWindowSummary[]
): CredentialLimitCredentialSummary {
  return {
    credentialReference: `cc_credentials:${credentialId}`,
    credentialId,
    credentialName: null,
    credentialSource: 'user',
    provider: 'anthropic',
    providerMode: 'oauth',
    agentType: 'claude-code',
    level: windows.some((w) => w.level === 'warning') ? 'warning' : 'ok',
    observedAt: Math.max(...windows.map((w) => w.observedAt)),
    windows,
  };
}

const LIMITS = [
  usage('cred-work', [
    limitWindow({ windowType: 'claude.five_hour', utilizationPercent: 72 }),
    limitWindow({ windowType: 'claude.seven_day', utilizationPercent: 31 }),
  ]),
  // Sampled at 81% three hours ago; the 5h window reset two hours ago.
  usage('cred-client', [
    limitWindow({
      windowType: 'claude.five_hour',
      utilizationPercent: 81,
      level: 'warning',
      status: 'allowed_warning',
      resetsAt: NOW - 2 * HOUR,
      observedAt: NOW - 3 * HOUR,
    }),
    limitWindow({
      windowType: 'claude.seven_day',
      utilizationPercent: 40,
      observedAt: NOW - 3 * HOUR,
    }),
  ]),
];

const PIN: CCProfileAttachmentItem = {
  id: 'pin-deep',
  configurationId: 'cfg-max',
  agentProfileId: 'prof-deep',
  profileName: 'Opus deep work',
  projectId: 'p-web',
  projectName: 'Marketing site',
  consumerKind: 'agent',
  consumerTarget: 'claude-code',
  isActive: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  const rows = mergeRows(
    accountRows({
      id: 'work',
      name: 'Work Max',
      kind: 'agent',
      target: 'claude-code',
      isDefault: true,
    }),
    accountRows({
      id: 'client',
      name: 'Client key',
      kind: 'agent',
      target: 'claude-code',
      pins: ['p-api'],
    }),
    accountRows({ id: 'max', name: 'Claude Max (personal)', kind: 'agent', target: 'claude-code' })
  );
  mocks.getResolutionStatus.mockResolvedValue({ consumers: [] });
  mocks.listCCCredentials.mockResolvedValue(rows.credentials);
  mocks.listCCConfigurations.mockResolvedValue(rows.configurations);
  mocks.listCCAttachments.mockResolvedValue(rows.attachments);
  mocks.listProfilePins.mockResolvedValue([PIN]);
  mocks.listProjects.mockResolvedValue({ projects: PROJECTS, nextCursor: null });
  mocks.getMyCredentialLimits.mockResolvedValue({ credentials: LIMITS, generatedAt: NOW });
});

function renderList() {
  render(
    <MemoryRouter>
      <ProfileList
        profiles={PROFILES}
        loading={false}
        error={null}
        onCreateProfile={vi.fn()}
        onUpdateProfile={vi.fn()}
        onDeleteProfile={vi.fn()}
        projectId="p-web"
      />
    </MemoryRouter>,
    { wrapper: QueryTestWrapper }
  );
}

function rowFor(name: string): HTMLElement {
  const row = screen
    .getAllByTestId('profile-row')
    .find((candidate) => within(candidate).queryByRole('button', { name }));
  if (!row) throw new Error(`No row for ${name}`);
  return row;
}

describe('Profile list usage and requests', () => {
  it('shows each profile the usage of the account it actually runs on', async () => {
    renderList();
    await waitFor(() => expect(screen.getAllByTestId('profile-usage-strip')).toHaveLength(2));

    // Liveness: the default-account profile shows Work Max's live sample, in percent left
    // (72% used), the same meters as the new-chat picker.
    const everyday = within(rowFor('Everyday')).getByTestId('profile-usage-strip');
    expect(everyday).toHaveTextContent('5h28%');
    expect(everyday).toHaveAccessibleName(/Everyday on Work Max/);

    // The project pin wins for Reviewer, and its 5h window reset after the sample.
    const reviewer = within(rowFor('Reviewer')).getByTestId('profile-usage-strip');
    expect(reviewer).toHaveAccessibleName(/Reviewer on Client key: OK/);
    expect(reviewer).toHaveTextContent('5h100%↻');
    // The stale sample (81% used) is not shown as 19% left.
    expect(reviewer).not.toHaveTextContent('19%');

    // My profile pin wins over my default: Claude Max has no samples yet.
    const deep = rowFor('Opus deep work');
    expect(within(deep).queryByTestId('profile-usage-strip')).toBeNull();
    expect(deep).toHaveTextContent('Claude Max (personal) · no usage yet');
  });

  it('opens the usage breakdown, which says the window reset', async () => {
    renderList();
    const reviewer = await waitFor(() =>
      within(rowFor('Reviewer')).getByTestId('profile-usage-strip')
    );
    fireEvent.click(reviewer);
    const details = await screen.findByTestId('credential-limit-details');
    const [fiveHour] = within(details).getAllByTestId('credential-limit-window');
    expect(fiveHour).toHaveTextContent('0% used');
    expect(fiveHour).toHaveTextContent('reset 2h ago · no sample since');
  });

  it('shows what each profile asks the scheduler for', async () => {
    renderList();
    expect(rowFor('Everyday')).toHaveTextContent('4 vCPU · 7.5 GB');
    expect(rowFor('Reviewer')).toHaveTextContent('Instant container');
    expect(rowFor('Opus deep work')).toHaveTextContent('Medium VM');
  });

  it('sorts by most room left when asked, keeping profiles without plan usage last', async () => {
    renderList();
    await waitFor(() => expect(screen.getAllByTestId('profile-usage-strip')).toHaveLength(2));
    const names = () =>
      screen
        .getAllByTestId('profile-row')
        .map((row) => within(row).getAllByRole('button')[0]?.textContent);
    expect(names()).toEqual(['Everyday', 'Reviewer', 'Opus deep work']);
    fireEvent.click(screen.getByRole('button', { name: 'Most room' }));
    // Reviewer: 60% left on the week (5h reset); Everyday: 28% left on the 5h.
    expect(names()).toEqual(['Reviewer', 'Everyday', 'Opus deep work']);
  });
});

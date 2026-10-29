import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateCCCredential: vi.fn(),
  deleteCCConfiguration: vi.fn(),
  deleteCCCredential: vi.fn(),
  listCCConfigurations: vi.fn(),
  listCCAttachments: vi.fn(),
  listCCCredentials: vi.fn(),
  listAgentCredentials: vi.fn(),
  deleteCCAttachment: vi.fn(),
  deleteCredential: vi.fn(),
  deleteAgentCredentialByKind: vi.fn(),
  deleteProjectAgentCredential: vi.fn(),
  deleteProjectCloudCredential: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com', name: 'Test User' } }),
}));

vi.mock('../../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/api')>()),
  updateCCCredential: mocks.updateCCCredential,
  deleteCCConfiguration: mocks.deleteCCConfiguration,
  deleteCCCredential: mocks.deleteCCCredential,
  listCCConfigurations: mocks.listCCConfigurations,
  listCCAttachments: mocks.listCCAttachments,
  listCCCredentials: mocks.listCCCredentials,
  listAgentCredentials: mocks.listAgentCredentials,
  deleteCCAttachment: mocks.deleteCCAttachment,
  deleteCredential: mocks.deleteCredential,
  deleteAgentCredentialByKind: mocks.deleteAgentCredentialByKind,
  deleteProjectAgentCredential: mocks.deleteProjectAgentCredential,
  deleteProjectCloudCredential: mocks.deleteProjectCloudCredential,
}));

vi.mock('../../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error, info: vi.fn() }),
}));

import {
  type AccountView,
  buildAccountsModel,
  defaultFallback,
  type ProviderAccounts,
} from '../../../../src/components/accounts/account-model';
import { AccountCard } from '../../../../src/components/accounts/AccountCard';
import { QueryTestWrapper } from '../../../test-utils/query-test-utils';
import { type AccountRows, accountRows, mergeRows, PROJECTS } from './fixtures';

function group(rows: AccountRows, kind: 'agent' | 'compute', id: string): ProviderAccounts {
  const model = buildAccountsModel({ ...rows, projects: PROJECTS, resolution: [], limits: [] });
  const found = (kind === 'agent' ? model.agents : model.clouds).find(
    (candidate) => candidate.provider.id === id
  );
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

function account(providerGroup: ProviderAccounts, label: string): AccountView {
  const found = providerGroup.accounts.find((candidate) => candidate.label === label);
  if (!found) throw new Error(`missing ${label}`);
  return found;
}

function renderCard(providerGroup: ProviderAccounts, view: AccountView, onReplace = vi.fn()) {
  render(
    <MemoryRouter>
      <AccountCard
        account={view}
        provider={providerGroup.provider}
        projectNames={new Map(PROJECTS.map((project) => [project.id, project.name]))}
        coveredCount={3}
        projectCount={PROJECTS.length}
        fallback={defaultFallback(providerGroup)}
        onReplace={onReplace}
      />
    </MemoryRouter>,
    { wrapper: QueryTestWrapper }
  );
  return { onReplace };
}

function openMenu(label: string) {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${label}` }));
}

function confirmDialog() {
  return screen.getByRole('dialog');
}

const CLAUDE = mergeRows(
  accountRows({
    id: 'work',
    name: 'Work Max plan',
    kind: 'agent',
    target: 'claude-code',
    credentialKind: 'oauth-token',
    isDefault: true,
  }),
  accountRows({
    id: 'acme',
    name: 'Acme API key',
    kind: 'agent',
    target: 'claude-code',
    pins: ['p-client'],
  }),
  accountRows({ id: 'spare', name: 'Old personal key', kind: 'agent', target: 'claude-code' })
);

describe('AccountCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const fn of Object.values(mocks)) {
      if ('mockResolvedValue' in fn) fn.mockResolvedValue(undefined);
    }
    mocks.listCCConfigurations.mockResolvedValue([]);
    mocks.listCCAttachments.mockResolvedValue([]);
    mocks.listCCCredentials.mockResolvedValue([]);
    mocks.listAgentCredentials.mockResolvedValue({ credentials: [] });
  });

  it('renames the account through the cc credential route', async () => {
    const claude = group(CLAUDE, 'agent', 'claude-code');
    renderCard(claude, account(claude, 'Work Max plan'));

    openMenu('Work Max plan');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: /name/i });
    fireEvent.change(input, { target: { value: '  Personal Max  ' } });
    fireEvent.submit(input);

    await waitFor(() =>
      expect(mocks.updateCCCredential).toHaveBeenCalledWith('cred-work', { name: 'Personal Max' })
    );
    expect(mocks.success).toHaveBeenCalledWith('Renamed to Personal Max');
  });

  it('shows where the default is used and offers Replace for it', () => {
    const claude = group(CLAUDE, 'agent', 'claude-code');
    const work = account(claude, 'Work Max plan');
    const { onReplace } = renderCard(claude, work);

    const card = screen.getByTestId('account-card-cfg-work');
    expect(within(card).getByText('Subscription')).toBeInTheDocument();
    expect(card).toHaveTextContent('Used by 3 of 4 projects');

    openMenu('Work Max plan');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Replace…' }));
    expect(onReplace).toHaveBeenCalledWith(work);
  });

  it('disconnects the default through the legacy route, then removes its records', async () => {
    const claude = group(CLAUDE, 'agent', 'claude-code');
    renderCard(claude, account(claude, 'Work Max plan'));

    openMenu('Work Max plan');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disconnect' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(mocks.deleteCCCredential).toHaveBeenCalledWith('cred-work'));
    expect(mocks.deleteAgentCredentialByKind).toHaveBeenCalledWith('claude-code', 'oauth-token');
    expect(mocks.deleteCCConfiguration).toHaveBeenCalledWith('cfg-work');
    // Legacy delete first: it is the validated path the runtime readers use.
    expect(mocks.deleteAgentCredentialByKind.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteCCConfiguration.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('keeps a disconnected default’s records when the server shows a project still uses it', async () => {
    // The cached view says nothing pins it; another tab pinned a project since.
    mocks.listCCAttachments.mockResolvedValue([
      { id: 'att-new-pin', configurationId: 'cfg-work', projectId: 'p-api', isActive: true },
    ]);
    const claude = group(CLAUDE, 'agent', 'claude-code');
    renderCard(claude, account(claude, 'Work Max plan'));

    openMenu('Work Max plan');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disconnect' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Work Max plan disconnected'));
    expect(mocks.deleteAgentCredentialByKind).toHaveBeenCalledWith('claude-code', 'oauth-token');
    expect(mocks.deleteCCConfiguration).not.toHaveBeenCalled();
    expect(mocks.deleteCCCredential).not.toHaveBeenCalled();
  });

  it('detaches a cloud default that has no legacy row', async () => {
    const { ApiClientError } = await import('../../../../src/lib/api');
    mocks.deleteCredential.mockRejectedValue(new ApiClientError('NOT_FOUND', 'Not found', 404));
    mocks.listCCAttachments
      .mockResolvedValueOnce([
        { id: 'att-hz-default', configurationId: 'cfg-hz', projectId: null, isActive: true },
        { id: 'att-other', configurationId: 'cfg-other', projectId: null, isActive: true },
      ])
      .mockResolvedValue([]);
    const rows = accountRows({
      id: 'hz',
      name: 'Hetzner — Personal',
      kind: 'compute',
      target: 'hetzner',
      isDefault: true,
    });
    const hetzner = group(rows, 'compute', 'hetzner');
    renderCard(hetzner, account(hetzner, 'Hetzner — Personal'));

    openMenu('Hetzner — Personal');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disconnect' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(mocks.deleteCCCredential).toHaveBeenCalledWith('cred-hz'));
    expect(mocks.deleteCCAttachment).toHaveBeenCalledTimes(1);
    expect(mocks.deleteCCAttachment).toHaveBeenCalledWith('att-hz-default');
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('disconnects a cloud default through the provider credential route', async () => {
    const rows = accountRows({
      id: 'hz',
      name: 'Hetzner — Personal',
      kind: 'compute',
      target: 'hetzner',
      isDefault: true,
    });
    const hetzner = group(rows, 'compute', 'hetzner');
    renderCard(hetzner, account(hetzner, 'Hetzner — Personal'));

    openMenu('Hetzner — Personal');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Disconnect' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(mocks.deleteCredential).toHaveBeenCalledWith('hetzner'));
    expect(mocks.deleteAgentCredentialByKind).not.toHaveBeenCalled();
  });

  it('moves a pinned project back to the default through the project route', async () => {
    const claude = group(CLAUDE, 'agent', 'claude-code');
    renderCard(claude, account(claude, 'Acme API key'));

    expect(screen.getByRole('link', { name: 'Acme client portal' })).toHaveAttribute(
      'href',
      '/projects/p-client/settings/accounts'
    );
    openMenu('Acme API key');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use default in Acme client portal' }));
    expect(confirmDialog()).toHaveTextContent(
      'Acme client portal will stop using Acme API key and use your default Claude Code account, Work Max plan.'
    );
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Use default' }));

    await waitFor(() =>
      expect(mocks.deleteProjectAgentCredential).toHaveBeenCalledWith(
        'p-client',
        'claude-code',
        'api-key'
      )
    );
    expect(mocks.deleteCCConfiguration).not.toHaveBeenCalled();
  });

  it('removes an unattached account: configuration first, then the unreferenced credential', async () => {
    const claude = group(CLAUDE, 'agent', 'claude-code');
    renderCard(claude, account(claude, 'Old personal key'));

    const card = screen.getByTestId('account-card-cfg-spare');
    expect(card).toHaveTextContent('Connected, but nothing uses it.');
    fireEvent.click(within(card).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(mocks.deleteCCCredential).toHaveBeenCalledWith('cred-spare'));
    expect(mocks.deleteCCConfiguration).toHaveBeenCalledWith('cfg-spare');
    expect(mocks.deleteCCConfiguration.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteCCCredential.mock.invocationCallOrder[0] ?? 0
    );
    expect(mocks.deleteAgentCredentialByKind).not.toHaveBeenCalled();
  });

  it('refuses to remove an account a project started using since the page loaded', async () => {
    mocks.listCCAttachments.mockResolvedValue([
      { id: 'att-pin', configurationId: 'cfg-spare', projectId: 'p-api', isActive: true },
    ]);
    const claude = group(CLAUDE, 'agent', 'claude-code');
    renderCard(claude, account(claude, 'Old personal key'));

    fireEvent.click(
      within(screen.getByTestId('account-card-cfg-spare')).getByRole('button', { name: 'Remove' })
    );
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        'A project started using this account. Refresh and try again.'
      )
    );
    expect(mocks.deleteCCConfiguration).not.toHaveBeenCalled();
  });

  it('also deletes the removed key’s inactive legacy copy so it cannot be promoted later', async () => {
    mocks.listAgentCredentials.mockResolvedValue({
      credentials: [
        { agentType: 'claude-code', credentialKind: 'api-key', isActive: false },
        { agentType: 'claude-code', credentialKind: 'oauth-token', isActive: true },
      ],
    });
    const claude = group(CLAUDE, 'agent', 'claude-code');
    renderCard(claude, account(claude, 'Old personal key'));

    fireEvent.click(
      within(screen.getByTestId('account-card-cfg-spare')).getByRole('button', { name: 'Remove' })
    );
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(mocks.deleteAgentCredentialByKind).toHaveBeenCalledWith('claude-code', 'api-key')
    );
  });

  it('leaves the legacy copy alone when the current default uses the same kind', async () => {
    mocks.listAgentCredentials.mockResolvedValue({
      credentials: [{ agentType: 'claude-code', credentialKind: 'api-key', isActive: false }],
    });
    mocks.listCCAttachments
      .mockResolvedValueOnce([]) // the in-use check for the removed account
      .mockResolvedValue([
        { id: 'att-d', configurationId: 'cfg-d', consumerTarget: 'claude-code', projectId: null },
      ]);
    mocks.listCCConfigurations.mockResolvedValue([{ id: 'cfg-d', credentialId: 'cred-d' }]);
    mocks.listCCCredentials.mockResolvedValue([{ id: 'cred-d', kind: 'api-key' }]);
    const claude = group(CLAUDE, 'agent', 'claude-code');
    renderCard(claude, account(claude, 'Old personal key'));

    fireEvent.click(
      within(screen.getByTestId('account-card-cfg-spare')).getByRole('button', { name: 'Remove' })
    );
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(mocks.success).toHaveBeenCalledWith('Old personal key removed'));
    expect(mocks.deleteAgentCredentialByKind).not.toHaveBeenCalled();
  });

  it('keeps a credential another configuration still uses', async () => {
    mocks.listCCConfigurations.mockResolvedValue([{ id: 'cfg-other', credentialId: 'cred-spare' }]);
    const claude = group(CLAUDE, 'agent', 'claude-code');
    renderCard(claude, account(claude, 'Old personal key'));

    fireEvent.click(
      within(screen.getByTestId('account-card-cfg-spare')).getByRole('button', { name: 'Remove' })
    );
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(mocks.deleteCCConfiguration).toHaveBeenCalledWith('cfg-spare'));
    expect(mocks.deleteCCCredential).not.toHaveBeenCalled();
  });

  it('reports a failed action and leaves the card in place', async () => {
    mocks.deleteCCConfiguration.mockRejectedValue(new Error('Configuration is locked'));
    const claude = group(CLAUDE, 'agent', 'claude-code');
    renderCard(claude, account(claude, 'Old personal key'));

    fireEvent.click(
      within(screen.getByTestId('account-card-cfg-spare')).getByRole('button', { name: 'Remove' })
    );
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Configuration is locked'));
    expect(mocks.success).not.toHaveBeenCalled();
    expect(screen.getByTestId('account-card-cfg-spare')).toBeInTheDocument();
  });
});

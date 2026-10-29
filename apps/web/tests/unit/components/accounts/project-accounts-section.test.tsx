import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountRows, mergeRows } from './fixtures';

const mocks = vi.hoisted(() => ({
  getResolutionStatus: vi.fn(),
  listCCCredentials: vi.fn(),
  listCCConfigurations: vi.fn(),
  listCCAttachments: vi.fn(),
  listProjects: vi.fn(),
  getMyCredentialLimits: vi.fn(),
  getAgentCredentialSetupConfig: vi.fn(),
  saveProjectAgentCredential: vi.fn(),
  saveAgentCredential: vi.fn(),
  deleteProjectAgentCredential: vi.fn(),
  updateCCCredential: vi.fn(),
}));

vi.mock('../../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com', name: 'Test User' } }),
}));

vi.mock('../../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/api')>()),
  ...mocks,
}));

vi.mock('../../../../src/components/CloudProviderConnectFlow', () => ({
  CloudProviderConnectFlow: ({ initialProvider }: { initialProvider?: string }) => (
    <div data-testid="cloud-connect-flow">{initialProvider ?? 'any'}</div>
  ),
}));

import { ProjectAccountsSection } from '../../../../src/components/accounts/ProjectAccountsSection';
import { ToastProvider } from '../../../../src/hooks/useToast';
import { QueryTestWrapper } from '../../../test-utils/query-test-utils';

const PROJECT = { id: 'p-client', name: 'Acme client portal' };

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function renderSection(search = '') {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={[`/projects/${PROJECT.id}/settings/accounts${search}`]}>
        <LocationProbe />
        <ProjectAccountsSection projectId={PROJECT.id} projectName={PROJECT.name} />
      </MemoryRouter>
    </ToastProvider>,
    { wrapper: QueryTestWrapper }
  );
}

let rows = mergeRows();

function serve(next: ReturnType<typeof mergeRows>) {
  rows = next;
}

const WORK = accountRows({
  id: 'work',
  name: 'Work Max plan',
  kind: 'agent',
  target: 'claude-code',
  credentialKind: 'oauth-token',
  isDefault: true,
});
const ACME = accountRows({
  id: 'acme',
  name: 'Acme API key',
  kind: 'agent',
  target: 'claude-code',
  pins: ['p-client'],
});

describe('ProjectAccountsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serve(mergeRows(WORK));
    mocks.getResolutionStatus.mockResolvedValue({ consumers: [] });
    mocks.listCCCredentials.mockImplementation(() => Promise.resolve(rows.credentials));
    mocks.listCCConfigurations.mockImplementation(() => Promise.resolve(rows.configurations));
    mocks.listCCAttachments.mockImplementation(() => Promise.resolve(rows.attachments));
    // The project is past the list cap; the section must still resolve it.
    mocks.listProjects.mockResolvedValue({ projects: [{ id: 'p-web', name: 'Marketing site' }] });
    mocks.getMyCredentialLimits.mockResolvedValue({ credentials: [] });
    mocks.getAgentCredentialSetupConfig.mockRejectedValue(new Error('gate unavailable'));
    mocks.saveProjectAgentCredential.mockResolvedValue({});
    mocks.deleteProjectAgentCredential.mockResolvedValue(undefined);
    mocks.updateCCCredential.mockResolvedValue({});
  });

  it('shows the project following your default, with the account card', async () => {
    renderSection();

    const row = await screen.findByTestId('project-account-row-claude-code');
    expect(row).toHaveTextContent('Your default');
    expect(row).toHaveTextContent('Work Max plan');
    fireEvent.click(within(row).getAllByRole('button')[0]!);
    expect(within(row).getByRole('button', { name: /Use my default/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(row).getByTestId('account-card-cfg-work')).toBeInTheDocument();
  });

  it('starts open on a pinned account and switches back to the default', async () => {
    serve(mergeRows(WORK, ACME));
    renderSection();

    const row = await screen.findByTestId('project-account-row-claude-code');
    expect(row).toHaveTextContent('Pinned for this project');
    expect(within(row).getByTestId('account-card-cfg-acme')).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: /Use my default/ }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(
      'Acme client portal will stop using Acme API key and use your default Claude Code account, Work Max plan.'
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use default' }));

    await waitFor(() =>
      expect(mocks.deleteProjectAgentCredential).toHaveBeenCalledWith(
        'p-client',
        'claude-code',
        'api-key'
      )
    );
  });

  it('connects an account only this project uses, then names it', async () => {
    renderSection();

    const row = await screen.findByTestId('project-account-row-claude-code');
    fireEvent.click(within(row).getAllByRole('button')[0]!);
    fireEvent.click(within(row).getByRole('button', { name: /Use another account here/ }));

    const sheet = await screen.findByRole('dialog', { name: 'Connect Claude Code' });
    expect(screen.getByTestId('location')).toHaveTextContent('?connect=claude-code');
    expect(sheet).toHaveTextContent(
      'Only Acme client portal will use this account. Your other projects keep your default.'
    );

    fireEvent.click(within(sheet).getByRole('radio', { name: /API key/ }));
    fireEvent.change(within(sheet).getByLabelText('API key'), {
      target: { value: 'sk-ant-client' },
    });
    // The save creates the project pin; serve the rows the API would now return.
    mocks.saveProjectAgentCredential.mockImplementation(() => {
      serve(
        mergeRows(
          WORK,
          accountRows({
            id: 'new',
            name: 'Claude Code API key',
            kind: 'agent',
            target: 'claude-code',
            pins: ['p-client'],
          })
        )
      );
      return Promise.resolve({});
    });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Use for this project' }));

    await waitFor(() =>
      expect(mocks.saveProjectAgentCredential).toHaveBeenCalledWith('p-client', {
        agentType: 'claude-code',
        credentialKind: 'api-key',
        credential: 'sk-ant-client',
      })
    );
    const nameStep = await screen.findByRole('dialog', { name: 'Name your account' });
    expect(nameStep).toHaveTextContent('Claude Code connected for Acme client portal.');
    const name = within(nameStep).getByLabelText('Name it so you can tell it apart later');
    expect(name).toHaveValue('Claude Code API key');
    fireEvent.click(within(nameStep).getByRole('button', { name: 'Client' }));
    fireEvent.click(within(nameStep).getByRole('button', { name: 'Done' }));

    await waitFor(() =>
      expect(mocks.updateCCCredential).toHaveBeenCalledWith('cred-new', { name: 'Client' })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('location')).toBeEmptyDOMElement();
  });

  it('skips naming without renaming', async () => {
    renderSection('?connect=claude-code&method=api-key');

    const sheet = await screen.findByRole('dialog', { name: 'Connect Claude Code' });
    mocks.saveProjectAgentCredential.mockImplementation(() => {
      serve(mergeRows(WORK, ACME));
      return Promise.resolve({});
    });
    fireEvent.change(within(sheet).getByLabelText('API key'), { target: { value: 'sk-ant-x' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Use for this project' }));

    const nameStep = await screen.findByRole('dialog', { name: 'Name your account' });
    fireEvent.click(within(nameStep).getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.updateCCCredential).not.toHaveBeenCalled();
  });

  it('opens the cloud connect step for this project from a deep link', async () => {
    renderSection('?connect=cloud:any');

    const sheet = await screen.findByRole('dialog', { name: 'Connect a cloud account' });
    fireEvent.click(within(sheet).getByRole('button', { name: /Hetzner/ }));
    expect(await within(sheet).findByTestId('cloud-connect-flow')).toHaveTextContent('hetzner');
    expect(screen.getByRole('dialog', { name: 'Connect Hetzner' })).toHaveTextContent(
      'Only Acme client portal will use this account.'
    );
  });

  it('lists agents with no account as quick-connect chips', async () => {
    renderSection();

    await screen.findByTestId('project-account-row-claude-code');
    expect(screen.queryByTestId('project-account-row-openai-codex')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Codex/ }));
    expect(await screen.findByRole('dialog', { name: /Connect .*Codex/ })).toBeInTheDocument();
  });
});

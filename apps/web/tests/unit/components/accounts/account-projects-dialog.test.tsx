/**
 * Settings → Agents: attach an account you already connected to one or more
 * projects. Rendered through the real page and `useAccountsData`, so each test
 * starts from the API rows and ends on what the refetched page shows.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AccountRows, accountRows, mergeRows } from './fixtures';

const mocks = vi.hoisted(() => ({
  getResolutionStatus: vi.fn(),
  listCCCredentials: vi.fn(),
  listCCConfigurations: vi.fn(),
  listCCAttachments: vi.fn(),
  listProjects: vi.fn(),
  getMyCredentialLimits: vi.fn(),
  listAgents: vi.fn(),
  getAgentSettings: vi.fn(),
  createCCAttachment: vi.fn(),
  deleteProjectAgentCredential: vi.fn(),
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

import { ToastProvider } from '../../../../src/hooks/useToast';
import { SettingsAgents } from '../../../../src/pages/SettingsAgents';
import { QueryTestWrapper } from '../../../test-utils/query-test-utils';

const PROJECTS = [
  { id: 'p-web', name: 'Marketing site' },
  { id: 'p-api', name: 'Billing API' },
  { id: 'p-client', name: 'Acme client portal' },
];

const WORK = {
  id: 'work',
  name: 'Work Max plan',
  kind: 'agent' as const,
  target: 'claude-code',
  credentialKind: 'oauth-token',
  isDefault: true,
};
const ACME = {
  id: 'acme',
  name: 'Acme API key',
  kind: 'agent' as const,
  target: 'claude-code',
  pins: ['p-client'],
};
const SAM = {
  id: 'sam',
  name: 'SAM Claude',
  kind: 'agent' as const,
  target: 'claude-code',
  credentialKind: 'oauth-token',
};

let rows: AccountRows = mergeRows();

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

async function claudeRow() {
  return screen.findByTestId('provider-row-claude-code');
}

describe('Settings → Agents: use an existing account in projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows = mergeRows(accountRows(WORK), accountRows(ACME), accountRows(SAM));
    mocks.getResolutionStatus.mockResolvedValue({ consumers: [] });
    mocks.listCCCredentials.mockImplementation(() => Promise.resolve(rows.credentials));
    mocks.listCCConfigurations.mockImplementation(() => Promise.resolve(rows.configurations));
    mocks.listCCAttachments.mockImplementation(() => Promise.resolve(rows.attachments));
    mocks.listProjects.mockResolvedValue({ projects: PROJECTS, nextCursor: null });
    mocks.getMyCredentialLimits.mockResolvedValue({ credentials: [] });
    mocks.listAgents.mockResolvedValue({ agents: [] });
    mocks.getAgentSettings.mockResolvedValue(null);
    mocks.deleteProjectAgentCredential.mockResolvedValue(undefined);
  });

  it('attaches an unattached account to two projects, and it moves to Pinned', async () => {
    // The server pins each project; serve the rows it would return afterwards.
    const pinned: string[] = [];
    mocks.createCCAttachment.mockImplementation(
      ({ projectId }: { configurationId: string; projectId: string }) => {
        pinned.push(projectId);
        rows = mergeRows(
          accountRows(WORK),
          accountRows(ACME),
          accountRows({ ...SAM, pins: pinned })
        );
        return Promise.resolve({ id: `att-${projectId}` });
      }
    );
    renderPage();

    const sam = within(await claudeRow()).getByTestId('account-card-cfg-sam');
    expect(sam).toHaveTextContent('Connected, but nothing uses it.');
    fireEvent.click(within(sam).getByRole('button', { name: 'Use in a project' }));

    const dialog = screen.getByRole('dialog', { name: 'Use SAM Claude in projects' });
    const option = (name: string) =>
      within(dialog).getByRole('checkbox', { name: new RegExp(name) });
    // Each project says what it runs today, so a switch away from a pin is visible.
    expect(option('Marketing site')).toHaveAccessibleName(/Uses your default, Work Max plan/);
    expect(option('Acme client portal')).toHaveAccessibleName(/Pinned to Acme API key/);
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.click(option('Marketing site'));
    fireEvent.click(option('Billing API'));
    expect(dialog).toHaveTextContent('2 projects now use SAM Claude');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.createCCAttachment.mock.calls).toEqual([
      [{ configurationId: 'cfg-sam', projectId: 'p-web' }],
      [{ configurationId: 'cfg-sam', projectId: 'p-api' }],
    ]);
    expect(mocks.deleteProjectAgentCredential).not.toHaveBeenCalled();

    // After the refetch the account sits in the Pinned lane, linked to both projects.
    const row = await claudeRow();
    const pinnedLane = within(row).getByRole('heading', { name: 'Pinned' }).parentElement!
      .parentElement!;
    const card = await within(pinnedLane).findByTestId('account-card-cfg-sam');
    expect(within(card).getByRole('link', { name: 'Marketing site' })).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Billing API' })).toBeInTheDocument();
    expect(within(row).queryByRole('heading', { name: 'Unattached' })).toBeNull();
  });

  it('moves a pinned account between projects from its menu', async () => {
    mocks.createCCAttachment.mockResolvedValue({ id: 'att-new' });
    renderPage();

    const acme = within(await claudeRow()).getByTestId('account-card-cfg-acme');
    fireEvent.click(within(acme).getByRole('button', { name: 'Actions for Acme API key' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use in projects…' }));

    const dialog = screen.getByRole('dialog', { name: 'Use Acme API key in projects' });
    const client = within(dialog).getByRole('checkbox', { name: /Acme client portal/ });
    expect(client).toBeChecked();
    expect(client).toHaveAccessibleName(/Uses this account/);
    fireEvent.click(client);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Billing API/ }));
    expect(dialog).toHaveTextContent(
      '1 project now uses Acme API key; 1 project moved back to your default'
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.deleteProjectAgentCredential).toHaveBeenCalledWith(
        'p-client',
        'claude-code',
        'api-key'
      )
    );
    expect(mocks.createCCAttachment).toHaveBeenCalledWith({
      configurationId: 'cfg-acme',
      projectId: 'p-api',
    });
    expect(mocks.createCCAttachment).toHaveBeenCalledTimes(1);
  });

  it('the pinned card’s Add project opens the same choice', async () => {
    renderPage();

    const acme = within(await claudeRow()).getByTestId('account-card-cfg-acme');
    fireEvent.click(within(acme).getByRole('button', { name: 'Add project' }));
    expect(
      screen.getByRole('dialog', { name: 'Use Acme API key in projects' })
    ).toBeInTheDocument();
  });

  it('offers no project choice for the default or a paused account', async () => {
    rows = mergeRows(
      accountRows(WORK),
      accountRows({ ...SAM, credentialActive: false }),
      accountRows({ ...ACME, pins: [] })
    );
    renderPage();

    const row = await claudeRow();
    const work = within(row).getByTestId('account-card-cfg-work');
    fireEvent.click(within(work).getByRole('button', { name: 'Actions for Work Max plan' }));
    expect(screen.queryByRole('menuitem', { name: 'Use in projects…' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();

    const paused = within(row).getByTestId('account-card-cfg-sam');
    expect(within(paused).queryByRole('button', { name: 'Use in a project' })).toBeNull();
    // The active unattached account beside it still offers the choice.
    const acme = within(row).getByTestId('account-card-cfg-acme');
    expect(within(acme).getByRole('button', { name: 'Use in a project' })).toBeInTheDocument();
  });

  it('keeps the dialog open and reports the failure when a pin is refused', async () => {
    mocks.createCCAttachment.mockRejectedValue(new Error('Project capability is required'));
    renderPage();

    const sam = within(await claudeRow()).getByTestId('account-card-cfg-sam');
    fireEvent.click(within(sam).getByRole('button', { name: 'Use in a project' }));
    const dialog = screen.getByRole('dialog', { name: 'Use SAM Claude in projects' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Billing API/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Project capability is required')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Use SAM Claude in projects' })).toBeInTheDocument();
  });

  it('filters a long project list', async () => {
    mocks.listProjects.mockResolvedValue({
      projects: Array.from({ length: 12 }, (_, index) => ({
        id: `p-${index}`,
        name: index === 7 ? 'Defang Global' : `Project ${index}`,
      })),
      nextCursor: null,
    });
    renderPage();

    const sam = within(await claudeRow()).getByTestId('account-card-cfg-sam');
    fireEvent.click(within(sam).getByRole('button', { name: 'Use in a project' }));
    const dialog = screen.getByRole('dialog', { name: 'Use SAM Claude in projects' });
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(12);
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'defang' } });
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(dialog).getByRole('checkbox', { name: /Defang Global/ })).toBeInTheDocument();
  });
});

import type { McpConnection } from '@simple-agent-manager/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listMcpConnections = vi.fn();
const createMcpConnection = vi.fn();
const updateMcpConnection = vi.fn();
const deleteMcpConnection = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('../../src/lib/api', () => ({
  listMcpConnections: (...args: unknown[]) => listMcpConnections(...args),
  createMcpConnection: (...args: unknown[]) => createMcpConnection(...args),
  updateMcpConnection: (...args: unknown[]) => updateMcpConnection(...args),
  deleteMcpConnection: (...args: unknown[]) => deleteMcpConnection(...args),
}));

vi.mock('../../src/hooks/useToast', () => ({
  useToast: () => ({ error: toastError, success: toastSuccess }),
}));

const { McpServersManager } = await import('../../src/components/mcp-servers/McpServersManager');
const { renderWithQuery } = await import('../test-utils/query-test-utils');

function makeConnection(overrides: Partial<McpConnection> = {}): McpConnection {
  return {
    id: 'conn-1',
    userId: 'user-1',
    projectId: null,
    name: 'zapier',
    urlHost: 'https://mcp.zapier.com',
    authType: 'bearer',
    hasToken: true,
    headerNames: [],
    enabled: true,
    createdAt: '2026-08-23T00:00:00Z',
    updatedAt: '2026-08-23T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listMcpConnections.mockResolvedValue([]);
});

describe('McpServersManager', () => {
  it('renders the empty state when there are no servers', async () => {
    renderWithQuery(<McpServersManager projectId={null} queryScope="user-1" />);

    expect(await screen.findByText(/No MCP servers yet/i)).toBeInTheDocument();
  });

  it('lists servers with their host and auth mode, and never the url or token', async () => {
    listMcpConnections.mockResolvedValue([
      makeConnection(),
      makeConnection({
        id: 'conn-2',
        name: 'composio',
        urlHost: 'https://backend.composio.dev',
        authType: 'none',
        hasToken: false,
      }),
    ]);

    const { container } = renderWithQuery(
      <McpServersManager projectId={null} queryScope="user-1" />
    );

    expect(await screen.findByText('zapier')).toBeInTheDocument();
    // The host and the auth label are separate spans: the host needs break-all for long
    // pre-signed subdomains, the label must not inherit it.
    expect(screen.getByText('https://mcp.zapier.com')).toBeInTheDocument();
    expect(screen.getByText(/· bearer token/)).toBeInTheDocument();
    expect(screen.getByText('https://backend.composio.dev')).toBeInTheDocument();
    expect(screen.getByText(/· no auth/)).toBeInTheDocument();

    // The API deliberately never returns these; the UI must not invent a place to show them.
    expect(container.textContent).not.toMatch(/\/api\/mcp\/s\//);
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it('submits a new bearer server and refreshes the list', async () => {
    const user = userEvent.setup();
    renderWithQuery(<McpServersManager projectId={null} queryScope="user-1" />);

    await user.click(await screen.findByRole('button', { name: /add/i }));
    await user.type(screen.getByLabelText(/^Name$/i), 'zapier');
    await user.type(screen.getByLabelText(/MCP endpoint URL/i), 'https://mcp.zapier.com/s/abc');
    await user.type(screen.getByLabelText(/Bearer token/i), 'secret-token');

    createMcpConnection.mockResolvedValue(makeConnection());
    listMcpConnections.mockResolvedValue([makeConnection()]);

    await user.click(screen.getByRole('button', { name: /add server/i }));

    await waitFor(() => {
      expect(createMcpConnection).toHaveBeenCalledWith(null, {
        name: 'zapier',
        url: 'https://mcp.zapier.com/s/abc',
        authType: 'bearer',
        token: 'secret-token',
      });
    });
    expect(await screen.findByText('zapier')).toBeInTheDocument();
  });

  it('omits the token field and the token payload when auth is none', async () => {
    const user = userEvent.setup();
    renderWithQuery(<McpServersManager projectId="proj-1" queryScope="user-1" />);

    await user.click(await screen.findByRole('button', { name: /add/i }));
    await user.selectOptions(screen.getByLabelText(/Authentication/i), 'none');

    expect(screen.queryByLabelText(/Bearer token/i)).toBeNull();

    await user.type(screen.getByLabelText(/^Name$/i), 'composio');
    await user.type(screen.getByLabelText(/MCP endpoint URL/i), 'https://presigned.example/mcp');

    createMcpConnection.mockResolvedValue(makeConnection({ name: 'composio', authType: 'none' }));
    await user.click(screen.getByRole('button', { name: /add server/i }));

    await waitFor(() => {
      expect(createMcpConnection).toHaveBeenCalledWith('proj-1', {
        name: 'composio',
        url: 'https://presigned.example/mcp',
        authType: 'none',
      });
    });
  });

  it('surfaces a server-side rejection instead of silently failing', async () => {
    const user = userEvent.setup();
    renderWithQuery(<McpServersManager projectId="proj-1" queryScope="user-1" />);

    await user.click(await screen.findByRole('button', { name: /add/i }));
    await user.type(screen.getByLabelText(/^Name$/i), 'sam-mcp');
    await user.type(screen.getByLabelText(/MCP endpoint URL/i), 'https://a.example/mcp');
    await user.type(screen.getByLabelText(/Bearer token/i), 't');

    createMcpConnection.mockRejectedValue(
      new Error('"sam-mcp" is reserved for SAM\'s own MCP endpoint')
    );
    await user.click(screen.getByRole('button', { name: /add server/i }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/reserved/i));
    });
  });

  it('toggles a server between enabled and disabled', async () => {
    const user = userEvent.setup();
    listMcpConnections.mockResolvedValue([makeConnection({ enabled: true })]);
    renderWithQuery(<McpServersManager projectId={null} queryScope="user-1" />);

    updateMcpConnection.mockResolvedValue(makeConnection({ enabled: false }));
    listMcpConnections.mockResolvedValue([makeConnection({ enabled: false })]);

    await user.click(await screen.findByRole('button', { name: /disable/i }));

    await waitFor(() => {
      expect(updateMcpConnection).toHaveBeenCalledWith(null, 'conn-1', { enabled: false });
    });
    expect(await screen.findByText('Disabled')).toBeInTheDocument();
  });

  it('requires an explicit confirmation before deleting, and cancelling deletes nothing', async () => {
    const user = userEvent.setup();
    listMcpConnections.mockResolvedValue([makeConnection()]);

    renderWithQuery(<McpServersManager projectId={null} queryScope="user-1" />);
    await user.click(await screen.findByRole('button', { name: /delete zapier/i }));

    // The shared ConfirmDialog, not window.confirm: this is a destructive action on a stored
    // credential and it must be dismissible and focus-trapped like the app's other ones.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/zapier/);
    expect(deleteMcpConnection).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deleteMcpConnection).not.toHaveBeenCalled();
  });

  it('deletes when the confirmation is accepted', async () => {
    const user = userEvent.setup();
    listMcpConnections.mockResolvedValue([makeConnection()]);
    renderWithQuery(<McpServersManager projectId={null} queryScope="user-1" />);

    await user.click(await screen.findByRole('button', { name: /delete zapier/i }));

    deleteMcpConnection.mockResolvedValue(undefined);
    listMcpConnections.mockResolvedValue([]);

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(deleteMcpConnection).toHaveBeenCalledWith(null, 'conn-1');
    });
    expect(await screen.findByText(/No MCP servers yet/i)).toBeInTheDocument();
  });

  it('hides write controls when the caller cannot write, but still lists servers', async () => {
    listMcpConnections.mockResolvedValue([makeConnection()]);
    renderWithQuery(<McpServersManager projectId="proj-1" queryScope="user-1" canWrite={false} />);

    // Positive liveness assertion beside the absence assertions (rule 62): a crashed render
    // would also satisfy "no buttons".
    expect(await screen.findByText('zapier')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^add$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /disable/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete zapier/i })).toBeNull();
  });

  it('shows which custom headers a server sends, never their values', async () => {
    listMcpConnections.mockResolvedValue([
      makeConnection({
        name: 'composio',
        authType: 'none',
        hasToken: false,
        headerNames: ['x-api-key', 'X-Org_Id'],
      }),
    ]);
    const { container } = renderWithQuery(
      <McpServersManager projectId={null} queryScope="user-1" />
    );

    expect(await screen.findByText('x-api-key, X-Org_Id')).toBeInTheDocument();
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it('adds a server authenticated only by a custom header (the Composio shape)', async () => {
    const user = userEvent.setup();
    renderWithQuery(<McpServersManager projectId="proj-1" queryScope="user-1" />);

    await user.click(await screen.findByRole('button', { name: /^add$/i }));
    await user.type(screen.getByLabelText(/^Name$/i), 'composio');
    await user.type(
      screen.getByLabelText(/MCP endpoint URL/i),
      'https://backend.composio.dev/v3/mcp/x'
    );
    await user.selectOptions(screen.getByLabelText(/Authentication/i), 'none');
    await user.click(screen.getByRole('button', { name: /add header/i }));
    await user.type(screen.getByLabelText('Header 1 name'), 'x-api-key');
    await user.type(screen.getByLabelText('x-api-key value'), 'ak_live_secret');

    createMcpConnection.mockResolvedValue(makeConnection({ name: 'composio' }));
    await user.click(screen.getByRole('button', { name: /add server/i }));

    await waitFor(() => {
      expect(createMcpConnection).toHaveBeenCalledWith('proj-1', {
        name: 'composio',
        url: 'https://backend.composio.dev/v3/mcp/x',
        authType: 'none',
        headers: [{ name: 'x-api-key', value: 'ak_live_secret' }],
      });
    });
  });

  it('removes an unsaved header row before it is ever sent', async () => {
    const user = userEvent.setup();
    renderWithQuery(<McpServersManager projectId={null} queryScope="user-1" />);

    await user.click(await screen.findByRole('button', { name: /^add$/i }));
    await user.click(screen.getByRole('button', { name: /add header/i }));
    await user.type(screen.getByLabelText('Header 1 name'), 'x-debug');
    await user.click(screen.getByRole('button', { name: /remove x-debug/i }));

    expect(screen.queryByLabelText('x-debug value')).toBeNull();
    await user.type(screen.getByLabelText(/^Name$/i), 'zapier');
    await user.type(screen.getByLabelText(/MCP endpoint URL/i), 'https://mcp.zapier.com/s/abc');
    await user.type(screen.getByLabelText(/Bearer token/i), 'secret-token');
    createMcpConnection.mockResolvedValue(makeConnection());
    await user.click(screen.getByRole('button', { name: /add server/i }));

    await waitFor(() => {
      expect(createMcpConnection).toHaveBeenCalledWith(null, {
        name: 'zapier',
        url: 'https://mcp.zapier.com/s/abc',
        authType: 'bearer',
        token: 'secret-token',
      });
    });
  });

  describe('editing a saved server', () => {
    const saved = makeConnection({
      name: 'composio',
      urlHost: 'https://backend.composio.dev',
      authType: 'none',
      hasToken: false,
      headerNames: ['x-api-key', 'x-org-id'],
    });

    async function openEditor() {
      const user = userEvent.setup();
      listMcpConnections.mockResolvedValue([saved]);
      renderWithQuery(<McpServersManager projectId="proj-1" queryScope="user-1" />);
      await user.click(await screen.findByRole('button', { name: /edit composio/i }));
      return user;
    }

    it('opens prefilled with names only, and keeps every secret that is not retyped', async () => {
      const user = await openEditor();

      const form = screen.getByRole('form', { name: /edit composio/i });
      expect(within(form).getByLabelText(/^Name$/i)).toHaveValue('composio');
      expect(within(form).getByLabelText(/MCP endpoint URL/i)).toHaveValue('');
      expect(within(form).getByLabelText('x-api-key value')).toHaveValue('');
      // No other form is offered while one is open.
      expect(screen.queryByRole('button', { name: /^add$/i })).toBeNull();

      updateMcpConnection.mockResolvedValue(saved);
      await user.click(within(form).getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(updateMcpConnection).toHaveBeenCalledWith('proj-1', 'conn-1', {
          name: 'composio',
          authType: 'none',
          headers: [{ name: 'x-api-key' }, { name: 'x-org-id' }],
        });
      });
      expect(toastSuccess).toHaveBeenCalledWith('MCP server updated');
    });

    it('rotates one header, removes another and adds a third in a single save', async () => {
      const user = await openEditor();
      const form = screen.getByRole('form', { name: /edit composio/i });

      await user.type(within(form).getByLabelText('x-api-key value'), 'ak_rotated');
      await user.click(within(form).getByRole('button', { name: /remove x-org-id/i }));
      await user.click(within(form).getByRole('button', { name: /add header/i }));
      await user.type(within(form).getByLabelText('Header 2 name'), 'x-team');
      await user.type(within(form).getByLabelText('x-team value'), 'platform');

      updateMcpConnection.mockResolvedValue(saved);
      await user.click(within(form).getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(updateMcpConnection).toHaveBeenCalledWith('proj-1', 'conn-1', {
          name: 'composio',
          authType: 'none',
          headers: [
            { name: 'x-api-key', value: 'ak_rotated' },
            { name: 'x-team', value: 'platform' },
          ],
        });
      });
    });

    it('requires a token when switching a tokenless server to bearer', async () => {
      const user = await openEditor();
      const form = screen.getByRole('form', { name: /edit composio/i });

      await user.selectOptions(within(form).getByLabelText(/Authentication/i), 'bearer');

      expect(within(form).getByLabelText(/Bearer token/i)).toBeRequired();
    });

    it('does not require retyping the saved token of a bearer server', async () => {
      const user = userEvent.setup();
      listMcpConnections.mockResolvedValue([makeConnection()]);
      renderWithQuery(<McpServersManager projectId={null} queryScope="user-1" />);
      await user.click(await screen.findByRole('button', { name: /edit zapier/i }));

      const form = screen.getByRole('form', { name: /edit zapier/i });
      expect(within(form).getByLabelText(/Bearer token/i)).not.toBeRequired();

      updateMcpConnection.mockResolvedValue(makeConnection());
      await user.click(within(form).getByRole('button', { name: /save changes/i }));
      await waitFor(() => {
        expect(updateMcpConnection).toHaveBeenCalledWith(null, 'conn-1', {
          name: 'zapier',
          authType: 'bearer',
          headers: [],
        });
      });
    });

    it('keeps the editor open with the typed values when the server rejects the save', async () => {
      const user = await openEditor();
      const form = screen.getByRole('form', { name: /edit composio/i });
      await user.type(within(form).getByLabelText('x-api-key value'), 'ak_rotated');

      updateMcpConnection.mockRejectedValue(
        new Error('Header "x-api-key" value must not contain line breaks')
      );
      await user.click(within(form).getByRole('button', { name: /save changes/i }));

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/x-api-key/))
      );
      expect(screen.getByRole('form', { name: /edit composio/i })).toBeInTheDocument();
      expect(screen.getByLabelText('x-api-key value')).toHaveValue('ak_rotated');
    });
  });

  it('reads the project endpoint when given a project id', async () => {
    renderWithQuery(<McpServersManager projectId="proj-42" queryScope="user-1" />);
    await waitFor(() => {
      expect(listMcpConnections).toHaveBeenCalledWith('proj-42');
    });
  });
});

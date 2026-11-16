import { screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithQuery } from '../../test-utils/query-test-utils';

const mocks = vi.hoisted(() => ({
  connectorSettings: vi.fn(),
  getCliVersion: vi.fn(),
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, isAuthenticated: true, isLoading: false }),
}));
vi.mock('../../../src/lib/api/connector', () => ({
  connectorSettings: mocks.connectorSettings,
  adminConnectorSettings: vi.fn(),
}));
vi.mock('../../../src/lib/api/cli', () => ({
  getCliVersion: mocks.getCliVersion,
  getCliDownloadUrl: (os: string, arch: string) =>
    `http://localhost:8787/api/cli/download?os=${os}&arch=${arch}`,
}));

import { Tools } from '../../../src/pages/Tools';
import { ToolsCli } from '../../../src/pages/ToolsCli';

function renderTools() {
  return renderWithQuery(
    <MemoryRouter>
      <Tools />
    </MemoryRouter>
  );
}

function cardLinks() {
  return within(screen.getByRole('list', { name: 'Tools' })).getAllByRole('link');
}

describe('Tools page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('links every tool to the place it is set up, with nothing marked coming soon', async () => {
    mocks.connectorSettings.mockResolvedValue({
      enabled: true,
      writeEnabled: true,
      url: 'http://x/connect/mcp',
    });
    renderTools();

    expect(await screen.findByText('SAM Connector')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Tools' })).toBeInTheDocument();
    const hrefs = cardLinks().map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([
      '/tools/cli',
      '/settings/access',
      '/settings/github',
      '/settings/mcp-servers',
    ]);
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/self-hosted runner/i)).not.toBeInTheDocument();
  });

  it('hides the Connector card when the installation has the Connector switched off', async () => {
    mocks.connectorSettings.mockResolvedValue({ enabled: false, writeEnabled: false, url: '' });
    renderTools();

    await waitFor(() => expect(mocks.connectorSettings).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('SAM Connector')).not.toBeInTheDocument());
    // Liveness: the rest of the page rendered.
    expect(cardLinks().map((link) => link.getAttribute('href'))).toEqual([
      '/tools/cli',
      '/settings/github',
      '/settings/mcp-servers',
    ]);
  });
});

describe('SAM CLI page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCliVersion.mockResolvedValue({
      available: true,
      version: '1.2.3',
      buildDate: '2026-11-01T00:00:00Z',
    });
  });

  it('signs in against this installation with the browser flow, not a pasted cookie', async () => {
    renderWithQuery(
      <MemoryRouter>
        <ToolsCli />
      </MemoryRouter>
    );

    expect(await screen.findByText('v1.2.3')).toBeInTheDocument();
    // API_URL falls back to the local API in tests; the point is that it is not the
    // maintainer's production instance.
    expect(screen.getByText('sam auth login --api-url http://localhost:8787')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('session-cookie');
    expect(document.body.textContent).not.toContain('api.simple-agent-manager.org');
    expect(screen.getByRole('link', { name: 'Settings → Access' })).toHaveAttribute(
      'href',
      '/settings/access'
    );
  });
});

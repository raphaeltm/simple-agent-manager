import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createCredential: vi.fn(),
  saveProjectCloudCredential: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  createCredential: mocks.createCredential,
  saveProjectCloudCredential: mocks.saveProjectCloudCredential,
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), addToast: vi.fn() }),
}));

import { CloudProviderConnectFlow } from '../../../src/components/CloudProviderConnectFlow';

/**
 * The provider picker button's accessible name is the label + description
 * ("Vultr" + "Global cloud, hourly billing"), so match with a substring regex.
 */
function selectVultr() {
  fireEvent.click(screen.getByRole('button', { name: /Vultr/ }));
}

function fillVultrToken(value = 'vultr-pat-xyz') {
  fireEvent.change(screen.getByLabelText(/Vultr API key/i), { target: { value } });
}

describe('CloudProviderConnectFlow — Vultr branch', () => {
  const onConnected = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCredential.mockResolvedValue({});
    mocks.saveProjectCloudCredential.mockResolvedValue({});
  });

  it('renders the single Vultr token field (not the GCP form) when Vultr is selected', () => {
    render(<CloudProviderConnectFlow onConnected={onConnected} />);

    selectVultr();

    // Vultr is a single-token provider — its token field renders, GCP's fields do not.
    expect(screen.getByLabelText(/Vultr API key/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/WIF pool ID/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/GCP project ID/i)).not.toBeInTheDocument();

    // isReady(vultr): the Connect action is gated on a non-empty token.
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    fillVultrToken();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('connect mode: submits a vultr token payload via createCredential (never a GCP object)', async () => {
    render(<CloudProviderConnectFlow onConnected={onConnected} />);

    selectVultr();
    fillVultrToken('vultr-pat-xyz');
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(mocks.createCredential).toHaveBeenCalledWith({ provider: 'vultr', token: 'vultr-pat-xyz' });
    });

    // Guard against a GCP-fallthrough refactor: the payload must NOT carry GCP/Scaleway fields.
    const payload = mocks.createCredential.mock.calls[0][0];
    expect(payload).not.toHaveProperty('gcpProjectId');
    expect(payload).not.toHaveProperty('wifPoolId');
    expect(payload).not.toHaveProperty('secretKey');

    // Connect mode goes through createCredential, never the project-scoped endpoint.
    expect(mocks.saveProjectCloudCredential).not.toHaveBeenCalled();
    expect(onConnected).toHaveBeenCalled();
  });

  it('project-override mode: submits the vultr payload via saveProjectCloudCredential', async () => {
    render(<CloudProviderConnectFlow projectId="proj-123" onConnected={onConnected} />);

    selectVultr();
    fillVultrToken('vultr-pat-project');
    // projectId makes mode default to 'project-override' → the action verb is "Save override".
    fireEvent.click(screen.getByRole('button', { name: 'Save override' }));

    await waitFor(() => {
      expect(mocks.saveProjectCloudCredential).toHaveBeenCalledWith('proj-123', {
        provider: 'vultr',
        token: 'vultr-pat-project',
      });
    });

    const payload = mocks.saveProjectCloudCredential.mock.calls[0][1];
    expect(payload).not.toHaveProperty('gcpProjectId');
    expect(payload).not.toHaveProperty('secretKey');

    expect(mocks.createCredential).not.toHaveBeenCalled();
    expect(onConnected).toHaveBeenCalled();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeploymentEnvironmentConfigResponse } from '../../../src/lib/api';

const mocks = vi.hoisted(() => ({
  getDeploymentEnvironmentConfig: vi.fn(),
  upsertDeploymentEnvironmentConfigVar: vi.fn(),
  deleteDeploymentEnvironmentConfigVar: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getDeploymentEnvironmentConfig: mocks.getDeploymentEnvironmentConfig,
  upsertDeploymentEnvironmentConfigVar: mocks.upsertDeploymentEnvironmentConfigVar,
  deleteDeploymentEnvironmentConfigVar: mocks.deleteDeploymentEnvironmentConfigVar,
}));

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => mockToast,
}));

import { DeploymentEnvironmentConfigPanel } from '../../../src/components/deployments/DeploymentEnvironmentConfigPanel';

const PROJECT_ID = 'proj-1';
const ENV_ID = 'env-1';

function makeConfig(
  overrides: Partial<DeploymentEnvironmentConfigResponse> = {}
): DeploymentEnvironmentConfigResponse {
  return {
    envVars: [],
    updatedAt: '2026-06-22T10:00:00.000Z',
    variableCount: 0,
    secretCount: 0,
    ...overrides,
  };
}

// A config holding one plaintext variable and one write-only secret. This is the
// canonical mixed state that proves the panel renders the build/secret boundary:
// variables expose their value, secrets never do.
const MIXED_CONFIG = makeConfig({
  envVars: [
    {
      key: 'PUBLIC_APP_DOMAIN',
      value: 'app.example.com',
      isSecret: false,
      hasValue: true,
      createdAt: '2026-06-22T10:00:00.000Z',
      updatedAt: '2026-06-22T10:00:00.000Z',
    },
    {
      key: 'DATABASE_URL',
      value: null,
      isSecret: true,
      hasValue: true,
      createdAt: '2026-06-22T10:00:00.000Z',
      updatedAt: '2026-06-22T10:00:00.000Z',
    },
  ],
  variableCount: 1,
  secretCount: 1,
});

describe('DeploymentEnvironmentConfigPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDeploymentEnvironmentConfig.mockResolvedValue(makeConfig());
  });

  it('renders nothing when closed and does not fetch', () => {
    const { container } = render(
      <DeploymentEnvironmentConfigPanel projectId={PROJECT_ID} environmentId={ENV_ID} open={false} />
    );
    expect(container).toBeEmptyDOMElement();
    expect(mocks.getDeploymentEnvironmentConfig).not.toHaveBeenCalled();
  });

  it('loads config on open and shows the empty state when nothing is set', async () => {
    render(
      <DeploymentEnvironmentConfigPanel projectId={PROJECT_ID} environmentId={ENV_ID} open={true} />
    );
    await waitFor(() => {
      expect(screen.getByText('No configuration set.')).toBeInTheDocument();
    });
    expect(mocks.getDeploymentEnvironmentConfig).toHaveBeenCalledWith(PROJECT_ID, ENV_ID);
  });

  it('shows variable values in plaintext but never renders secret values', async () => {
    mocks.getDeploymentEnvironmentConfig.mockResolvedValue(MIXED_CONFIG);
    render(
      <DeploymentEnvironmentConfigPanel projectId={PROJECT_ID} environmentId={ENV_ID} open={true} />
    );

    // Variable: plaintext value visible, labelled "Variable".
    await waitFor(() => {
      expect(screen.getByText('app.example.com')).toBeInTheDocument();
    });
    expect(screen.getByText('PUBLIC_APP_DOMAIN')).toBeInTheDocument();
    expect(screen.getByText('Variable')).toBeInTheDocument();

    // Secret: key + "Secret" badge + "Hidden after save", but NO value text.
    // "Secret" appears twice — the row badge AND the add-form checkbox label.
    expect(screen.getByText('DATABASE_URL')).toBeInTheDocument();
    expect(screen.getAllByText('Secret').length).toBe(2);
    expect(screen.getAllByText('Hidden after save').length).toBeGreaterThan(0);
  });

  it('adds a plaintext variable (isSecret false) via the add form', async () => {
    mocks.upsertDeploymentEnvironmentConfigVar.mockResolvedValue(
      makeConfig({
        envVars: [
          {
            key: 'NODE_ENV',
            value: 'production',
            isSecret: false,
            hasValue: true,
            createdAt: '2026-06-22T10:00:00.000Z',
            updatedAt: '2026-06-22T10:00:00.000Z',
          },
        ],
        variableCount: 1,
      })
    );

    render(
      <DeploymentEnvironmentConfigPanel projectId={PROJECT_ID} environmentId={ENV_ID} open={true} />
    );
    await waitFor(() => expect(screen.getByText('No configuration set.')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('DATABASE_URL'), {
      target: { value: 'NODE_ENV' },
    });
    fireEvent.change(screen.getByPlaceholderText('Value'), { target: { value: 'production' } });
    fireEvent.click(screen.getByText('Add'));

    await waitFor(() => {
      expect(mocks.upsertDeploymentEnvironmentConfigVar).toHaveBeenCalledWith(PROJECT_ID, ENV_ID, {
        key: 'NODE_ENV',
        value: 'production',
        isSecret: false,
      });
    });
    expect(mockToast.success).toHaveBeenCalledWith('Configuration added');
  });

  it('adds a secret (isSecret true) and masks the value input as a password field', async () => {
    mocks.upsertDeploymentEnvironmentConfigVar.mockResolvedValue(MIXED_CONFIG);

    render(
      <DeploymentEnvironmentConfigPanel projectId={PROJECT_ID} environmentId={ENV_ID} open={true} />
    );
    await waitFor(() => expect(screen.getByText('No configuration set.')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('DATABASE_URL'), {
      target: { value: 'STRIPE_KEY' },
    });
    // Toggle the Secret checkbox; the value input switches to a password field.
    fireEvent.click(screen.getByRole('checkbox'));
    const secretInput = screen.getByPlaceholderText('Hidden after save');
    expect(secretInput).toHaveAttribute('type', 'password');
    fireEvent.change(secretInput, { target: { value: 'sk_live_secret' } });

    fireEvent.click(screen.getByText('Add'));

    await waitFor(() => {
      expect(mocks.upsertDeploymentEnvironmentConfigVar).toHaveBeenCalledWith(PROJECT_ID, ENV_ID, {
        key: 'STRIPE_KEY',
        value: 'sk_live_secret',
        isSecret: true,
      });
    });
  });

  it('rejects an empty secret value without calling the API', async () => {
    render(
      <DeploymentEnvironmentConfigPanel projectId={PROJECT_ID} environmentId={ENV_ID} open={true} />
    );
    await waitFor(() => expect(screen.getByText('No configuration set.')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('DATABASE_URL'), { target: { value: 'TOKEN' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('Add'));

    await waitFor(() => {
      expect(screen.getByText('Secret value cannot be empty.')).toBeInTheDocument();
    });
    expect(mocks.upsertDeploymentEnvironmentConfigVar).not.toHaveBeenCalled();
  });

  it('rejects an invalid env key without calling the API', async () => {
    render(
      <DeploymentEnvironmentConfigPanel projectId={PROJECT_ID} environmentId={ENV_ID} open={true} />
    );
    await waitFor(() => expect(screen.getByText('No configuration set.')).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText('DATABASE_URL'), {
      target: { value: '1-bad-key' },
    });
    fireEvent.change(screen.getByPlaceholderText('Value'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Add'));

    await waitFor(() => {
      expect(screen.getByText(/Key must match/)).toBeInTheDocument();
    });
    expect(mocks.upsertDeploymentEnvironmentConfigVar).not.toHaveBeenCalled();
  });

  it('labels the submit button "Update" when the key already exists', async () => {
    mocks.getDeploymentEnvironmentConfig.mockResolvedValue(MIXED_CONFIG);
    render(
      <DeploymentEnvironmentConfigPanel projectId={PROJECT_ID} environmentId={ENV_ID} open={true} />
    );
    await waitFor(() => expect(screen.getByText('PUBLIC_APP_DOMAIN')).toBeInTheDocument());

    // Default label is "Add" for a fresh key.
    expect(screen.getByText('Add')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('DATABASE_URL'), {
      target: { value: 'PUBLIC_APP_DOMAIN' },
    });
    expect(screen.getByText('Update')).toBeInTheDocument();
  });

  it('deletes a variable without a confirm prompt', async () => {
    mocks.getDeploymentEnvironmentConfig.mockResolvedValue(MIXED_CONFIG);
    mocks.deleteDeploymentEnvironmentConfigVar.mockResolvedValue(
      makeConfig({
        envVars: MIXED_CONFIG.envVars.filter((v) => v.isSecret),
        secretCount: 1,
      })
    );
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <DeploymentEnvironmentConfigPanel projectId={PROJECT_ID} environmentId={ENV_ID} open={true} />
    );
    await waitFor(() => expect(screen.getByText('PUBLIC_APP_DOMAIN')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Delete PUBLIC_APP_DOMAIN'));

    await waitFor(() => {
      expect(mocks.deleteDeploymentEnvironmentConfigVar).toHaveBeenCalledWith(
        PROJECT_ID,
        ENV_ID,
        'PUBLIC_APP_DOMAIN'
      );
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('requires confirmation before deleting a secret', async () => {
    mocks.getDeploymentEnvironmentConfig.mockResolvedValue(MIXED_CONFIG);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(
      <DeploymentEnvironmentConfigPanel projectId={PROJECT_ID} environmentId={ENV_ID} open={true} />
    );
    await waitFor(() => expect(screen.getByText('DATABASE_URL')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Delete DATABASE_URL'));

    expect(confirmSpy).toHaveBeenCalledWith('Delete secret DATABASE_URL?');
    // Cancelled confirmation must not call the API.
    expect(mocks.deleteDeploymentEnvironmentConfigVar).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('surfaces a load error', async () => {
    mocks.getDeploymentEnvironmentConfig.mockRejectedValue(new Error('boom'));
    render(
      <DeploymentEnvironmentConfigPanel projectId={PROJECT_ID} environmentId={ENV_ID} open={true} />
    );
    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });
});

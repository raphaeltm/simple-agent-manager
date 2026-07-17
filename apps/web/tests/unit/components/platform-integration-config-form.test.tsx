import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PlatformIntegrationConfigForm } from '../../../src/components/PlatformIntegrationConfigForm';
import type { PlatformConfigStatus, PlatformIntegrationStatus } from '../../../src/lib/api';

function integration(
  fields: string[],
  overrides: Partial<PlatformIntegrationStatus> = {}
): PlatformIntegrationStatus {
  return {
    configured: false,
    source: 'unset',
    label: 'not configured',
    fields: Object.fromEntries(
      fields.map((field) => [
        field,
        { configured: false, source: 'unset', updatedAt: null, updatedBy: null },
      ])
    ),
    ...overrides,
  };
}

function makeStatus(
  infrastructure: PlatformIntegrationStatus = integration(['clientId', 'clientSecret'])
): PlatformConfigStatus {
  return {
    setupCompleted: true,
    setupForced: false,
    integrations: {
      githubOAuth: integration(['clientId', 'clientSecret']),
      githubApp: integration(['appId', 'appPrivateKey', 'appSlug']),
      githubWebhook: integration(['webhookSecret']),
      googleOAuth: integration(['clientId', 'clientSecret']),
      googleInfrastructureOAuth: infrastructure,
      gitlabOAuth: integration(['host', 'clientId', 'clientSecret']),
    },
  };
}

function renderForm(
  status: PlatformConfigStatus,
  mode: 'setup' | 'admin',
  onPrimary = vi.fn().mockResolvedValue(undefined)
) {
  render(
    <PlatformIntegrationConfigForm
      status={status}
      mode={mode}
      primaryLabel="Save integrations"
      onPrimary={onPrimary}
    />
  );
  return { onPrimary };
}

describe('PlatformIntegrationConfigForm Google infrastructure OAuth', () => {
  it('keeps infrastructure configuration off the first-run setup surface', () => {
    renderForm(makeStatus(), 'setup');

    expect(
      screen.queryByRole('heading', { name: 'Google infrastructure OAuth' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Google sign-in (OAuth)' })).toBeInTheDocument();
  });

  it('shows both static callbacks and submits an independent ID/secret pair', async () => {
    const { onPrimary } = renderForm(makeStatus(), 'admin');
    const section = screen.getByTestId('integration-google-infrastructure-oauth');

    expect(within(section).getByText(/\/auth\/google\/callback/)).toBeInTheDocument();
    expect(within(section).getByText(/\/api\/deployment\/gcp\/callback/)).toBeInTheDocument();
    expect(within(section).getByText(/never enables Google sign-in/)).toBeInTheDocument();

    fireEvent.change(within(section).getByLabelText('Client ID'), {
      target: { value: ' infra-client-id.apps.googleusercontent.com ' },
    });
    fireEvent.change(within(section).getByLabelText('Client secret'), {
      target: { value: ' infra-client-secret ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save integrations' }));

    await waitFor(() => {
      expect(onPrimary).toHaveBeenCalledWith({
        googleInfrastructure: {
          clientId: 'infra-client-id.apps.googleusercontent.com',
          clientSecret: 'infra-client-secret',
        },
      });
    });
    expect(onPrimary.mock.calls[0]?.[0]).not.toHaveProperty('google');
  });

  it('shows runtime audit metadata without rehydrating the secret', () => {
    const runtime = integration(['clientId', 'clientSecret'], {
      configured: true,
      source: 'runtime',
      label: 'set here',
      fields: {
        clientId: {
          configured: true,
          source: 'runtime',
          updatedAt: '2026-07-16T12:00:00.000Z',
          updatedBy: 'admin-user-id',
        },
        clientSecret: {
          configured: true,
          source: 'runtime',
          updatedAt: '2026-07-16T12:00:00.000Z',
          updatedBy: 'admin-user-id',
        },
      },
    });
    renderForm(makeStatus(runtime), 'admin');
    const section = screen.getByTestId('integration-google-infrastructure-oauth');

    expect(within(section).getByLabelText('Client ID')).toHaveValue('');
    expect(within(section).getByLabelText('Client secret')).toHaveValue('');
    expect(within(section).getByTestId('google-infrastructure-audit')).toHaveTextContent(
      'admin-user-id'
    );
    expect(section).not.toHaveTextContent('infra-client-secret');
    expect(
      within(section).getByRole('button', {
        name: 'Remove runtime infrastructure client',
      })
    ).toBeInTheDocument();
  });

  it('requires confirmation and submits explicit runtime removal only', async () => {
    const runtime = integration(['clientId', 'clientSecret'], {
      configured: true,
      source: 'runtime',
      label: 'set here',
      fields: {
        clientId: { configured: true, source: 'runtime' },
        clientSecret: { configured: true, source: 'runtime' },
      },
    });
    const { onPrimary } = renderForm(makeStatus(runtime), 'admin');
    const section = screen.getByTestId('integration-google-infrastructure-oauth');

    fireEvent.click(
      within(section).getByRole('button', {
        name: 'Remove runtime infrastructure client',
      })
    );

    const dialog = screen.getByRole('dialog', {
      name: 'Remove runtime Google infrastructure OAuth?',
    });
    expect(
      within(dialog).getByText(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/)
    ).toBeInTheDocument();
    expect(onPrimary).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove runtime client' }));

    await waitFor(() => {
      expect(onPrimary).toHaveBeenCalledWith({
        googleInfrastructure: { remove: true },
      });
    });
  });
});

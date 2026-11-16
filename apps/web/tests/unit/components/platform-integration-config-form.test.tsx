import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PlatformIntegrationConfigForm } from '../../../src/components/PlatformIntegrationConfigForm';
import type { FeedbackProjectStatus, PlatformConfigStatus } from '../../../src/lib/api';
import { integration, makeStatus } from '../../helpers/platform-config-fixtures';

function renderForm(
  status: PlatformConfigStatus,
  onPrimary = vi.fn().mockResolvedValue(undefined),
  feedbackProjects: Array<{ id: string; name: string; status?: string | null }> = []
) {
  render(
    <PlatformIntegrationConfigForm
      status={status}
      primaryLabel="Save integrations"
      onPrimary={onPrimary}
      feedbackProjects={feedbackProjects}
    />
  );
  return { onPrimary };
}

describe('PlatformIntegrationConfigForm Google infrastructure OAuth', () => {
  it('shows both static callbacks and submits an independent ID/secret pair', async () => {
    const { onPrimary } = renderForm(makeStatus());
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

  it('shows who changed a stored value without rehydrating the secret', () => {
    const stored = {
      configured: true,
      source: 'runtime' as const,
      label: 'stored in SAM',
      updatedAt: '2026-07-16T12:00:00.000Z',
      updatedBy: 'system_anonymous_trials',
      updatedByLabel: 'first-run setup (unauthenticated)',
    };
    const runtime = integration(['clientId', 'clientSecret'], {
      configured: true,
      source: 'runtime',
      label: 'stored in SAM',
      clearable: true,
      fields: { clientId: stored, clientSecret: stored },
    });
    renderForm(makeStatus(runtime));
    const section = screen.getByTestId('integration-google-infrastructure-oauth');

    expect(within(section).getByLabelText('Client ID')).toHaveValue('');
    expect(within(section).getByLabelText('Client secret')).toHaveValue('');
    // Both fields were written together, so the card says it once instead of per field.
    expect(within(section).getByTestId('platform-section-audit')).toHaveTextContent(
      'by first-run setup (unauthenticated)'
    );
    expect(within(section).queryAllByTestId('platform-field-audit')).toHaveLength(0);
    expect(within(section).getAllByText('stored in SAM').length).toBeGreaterThan(0);
    expect(section).not.toHaveTextContent('environment');
    expect(section).not.toHaveTextContent('infra-client-secret');
  });

  it('offers Clear only for integrations with stored values', () => {
    const envOnly = integration(['clientId', 'clientSecret'], {
      configured: true,
      source: 'environment',
      label: 'Worker environment fallback',
      clearable: false,
    });
    renderForm(makeStatus(envOnly));
    expect(screen.queryByRole('button', { name: /^Clear stored/ })).not.toBeInTheDocument();
    // Liveness: the section rendered and shows the env label.
    expect(
      within(screen.getByTestId('integration-google-infrastructure-oauth')).getByText(
        'Worker environment fallback'
      )
    ).toBeInTheDocument();
  });

  it('requires a destructive confirmation, then submits only the clear', async () => {
    const runtime = integration(['clientId', 'clientSecret'], {
      configured: true,
      source: 'runtime',
      label: 'stored in SAM',
      clearable: true,
    });
    const { onPrimary } = renderForm(makeStatus(runtime));
    const section = screen.getByTestId('integration-google-infrastructure-oauth');
    // A half-typed replacement must not ride along with the clear.
    fireEvent.change(within(section).getByLabelText('Client ID'), {
      target: { value: 'half-typed-client-id' },
    });

    fireEvent.click(
      within(section).getByRole('button', {
        name: 'Clear stored Google infrastructure OAuth values',
      })
    );
    const dialog = screen.getByRole('dialog', { name: 'Clear Google infrastructure OAuth?' });
    expect(within(dialog).getByText(/Worker environment values, if set/)).toBeInTheDocument();
    expect(onPrimary).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear stored values' }));

    await waitFor(() => {
      expect(onPrimary).toHaveBeenCalledWith({ clear: ['googleInfrastructureOAuth'] });
    });
    await waitFor(() => {
      expect(within(section).getByLabelText('Client ID')).toHaveValue('');
    });
  });

  it('shows a per-field line when stored fields were changed by different people', () => {
    const at = '2026-07-16T12:00:00.000Z';
    const runtime = integration(['clientId', 'clientSecret'], {
      configured: true,
      source: 'runtime',
      label: 'stored in SAM',
      clearable: true,
      fields: {
        clientId: {
          configured: true,
          source: 'runtime',
          label: 'stored in SAM',
          updatedAt: at,
          updatedBy: 'a',
          updatedByLabel: 'Ada <ada@example.com>',
        },
        clientSecret: {
          configured: true,
          source: 'runtime',
          label: 'stored in SAM',
          updatedAt: at,
          updatedBy: 'b',
          updatedByLabel: 'Bob <bob@example.com>',
        },
      },
    });
    renderForm(makeStatus(runtime));
    const section = screen.getByTestId('integration-google-infrastructure-oauth');
    expect(within(section).queryByTestId('platform-section-audit')).not.toBeInTheDocument();
    const audits = within(section).getAllByTestId('platform-field-audit');
    expect(audits).toHaveLength(2);
    expect(within(section).getByLabelText('Client ID')).toHaveAccessibleDescription(/Ada/);
  });

  it('keeps the dialog and typed values when the clear fails', async () => {
    const runtime = integration(['clientId', 'clientSecret'], {
      configured: true,
      source: 'runtime',
      label: 'stored in SAM',
      clearable: true,
    });
    const { onPrimary } = renderForm(makeStatus(runtime), vi.fn().mockResolvedValue(false));
    const section = screen.getByTestId('integration-google-infrastructure-oauth');
    fireEvent.change(within(section).getByLabelText('Client ID'), {
      target: { value: 'typed-client-id' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear stored Google infrastructure OAuth values' })
    );
    const dialog = screen.getByRole('dialog', { name: 'Clear Google infrastructure OAuth?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear stored values' }));

    await waitFor(() =>
      expect(onPrimary).toHaveBeenCalledWith({ clear: ['googleInfrastructureOAuth'] })
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Clearing failed');
    expect(
      screen.getByRole('dialog', { name: 'Clear Google infrastructure OAuth?' })
    ).toBeVisible();
    expect(within(section).getByLabelText('Client ID')).toHaveValue('typed-client-id');
  });

  it('cancelling the confirmation clears nothing', () => {
    const runtime = integration(['clientId', 'clientSecret'], {
      configured: true,
      source: 'runtime',
      label: 'stored in SAM',
      clearable: true,
    });
    const { onPrimary } = renderForm(makeStatus(runtime));
    fireEvent.click(
      screen.getByRole('button', { name: 'Clear stored Google infrastructure OAuth values' })
    );
    const dialog = screen.getByRole('dialog', { name: 'Clear Google infrastructure OAuth?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it('submits feedback project selection and explicit runtime removal', async () => {
    const feedbackProject: FeedbackProjectStatus = {
      configured: true,
      source: 'environment',
      label: 'Worker environment fallback',
      state: 'ready',
      projectId: 'feedback-project-1',
      project: { id: 'feedback-project-1', name: 'Platform Feedback', status: 'active' },
      message: 'Report Issue uses this project for new feedback.',
      fields: {
        projectId: {
          configured: true,
          source: 'environment',
          label: 'Worker environment fallback',
          updatedAt: null,
          updatedBy: null,
        },
      },
    };
    const { onPrimary } = renderForm(makeStatus(undefined, feedbackProject), undefined, [
      { id: 'feedback-project-1', name: 'Platform Feedback', status: 'active' },
      { id: 'feedback-project-2', name: 'Operator Feedback', status: 'active' },
    ]);

    fireEvent.change(screen.getByLabelText('Operations project'), {
      target: { value: 'feedback-project-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save integrations' }));

    await waitFor(() => {
      expect(onPrimary).toHaveBeenLastCalledWith({
        feedback: { projectId: 'feedback-project-2' },
      });
    });

    fireEvent.change(screen.getByLabelText('Operations project'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save integrations' }));

    await waitFor(() => {
      expect(onPrimary).toHaveBeenLastCalledWith({
        feedback: { remove: true },
      });
    });
  });
});

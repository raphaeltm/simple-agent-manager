import type {
  AgentModelCatalogResponse,
  ProjectAgentModelSettingsResponse,
} from '@simple-agent-manager/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectAgentModelsSection } from '../../../../src/components/project-settings/ProjectAgentModelsSection';
import { createTestQueryClient } from '../../../test-utils/query-test-utils';

const mocks = vi.hoisted(() => ({
  getAgentModelCatalog: vi.fn(),
  getProjectAgentModelSettings: vi.fn(),
  updateProjectAgentModelSettings: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'user-1' }));
vi.mock('../../../../src/hooks/useToast', () => ({ useToast: () => mocks.toast }));
vi.mock('../../../../src/lib/api/agent-models', () => ({
  getAgentModelCatalog: mocks.getAgentModelCatalog,
  getProjectAgentModelSettings: mocks.getProjectAgentModelSettings,
  updateProjectAgentModelSettings: mocks.updateProjectAgentModelSettings,
}));

const CATALOG: AgentModelCatalogResponse = {
  models: [
    {
      id: 'm-decision-1',
      name: 'clef-flash',
      author: 'cloudflare',
      description: 'Fast yes/no decisions.',
      category: 'decision',
      task: 'Text Generation',
      prices: [{ unit: 'per M input tokens', usd: 0.023 }],
      contextWindow: null,
      capabilities: [],
      beta: false,
      partner: false,
      infoUrl: null,
      termsUrl: null,
    },
  ],
  defaultModelIds: ['m-decision-1'],
  defaultCategories: ['decision'],
  fetchedAt: '2026-10-01T00:00:00Z',
};

function makeSettings(
  overrides: Partial<ProjectAgentModelSettingsResponse> = {}
): ProjectAgentModelSettingsResponse {
  return {
    featureEnabled: true,
    models: null,
    effectiveModelIds: ['m-decision-1'],
    effectiveSource: 'default',
    monthlyBudgetUsd: null,
    effectiveMonthlyBudgetUsd: 20,
    maxMonthlyBudgetUsd: 100,
    usage: {
      month: '2026-10',
      spentUsd: 2,
      reservedUsd: 0,
      callCount: 10,
      resetsAt: '2026-11-01T00:00:00Z',
      byModel: [
        {
          modelId: 'm-decision-1',
          callCount: 10,
          errorCount: 0,
          spentUsd: 2,
          lastCalledAt: '2026-10-20T00:00:00Z',
        },
      ],
    },
    canEdit: true,
    ...overrides,
  };
}

function renderSection(settings: ProjectAgentModelSettingsResponse) {
  mocks.getAgentModelCatalog.mockResolvedValue(CATALOG);
  mocks.getProjectAgentModelSettings.mockResolvedValue(settings);
  const queryClient = createTestQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectAgentModelsSection projectId="proj-1" />
    </QueryClientProvider>
  );
  return { queryClient };
}

describe('ProjectAgentModelsSection', () => {
  beforeEach(() => {
    mocks.getAgentModelCatalog.mockReset();
    mocks.getProjectAgentModelSettings.mockReset();
    mocks.updateProjectAgentModelSettings.mockReset();
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
  });

  it('shows budget usage, reset date, and the recommended-defaults summary', async () => {
    renderSection(makeSettings());

    expect(await screen.findByText('$2.00 of $20.00 used this month')).toBeInTheDocument();
    expect(screen.getByText(/resets Nov 1/)).toBeInTheDocument();
    expect(screen.getByText(/Using SAM's recommended defaults/)).toBeInTheDocument();
    // "clef-flash" legitimately appears twice (selection summary + used-this-month row).
    expect(screen.getAllByText(/clef-flash/).length).toBeGreaterThanOrEqual(2);
  });

  it('saves a new monthly budget with the right PUT body', async () => {
    mocks.updateProjectAgentModelSettings.mockResolvedValue(
      makeSettings({ monthlyBudgetUsd: 50, effectiveMonthlyBudgetUsd: 50 })
    );
    renderSection(makeSettings());
    await screen.findByText('$2.00 of $20.00 used this month');

    const input = screen.getByLabelText('Monthly limit (USD)');
    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mocks.updateProjectAgentModelSettings).toHaveBeenCalledWith('proj-1', {
        monthlyBudgetUsd: 50,
      })
    );
    expect(await screen.findByText('$2.00 of $50.00 used this month')).toBeInTheDocument();
    expect(mocks.toast.success).toHaveBeenCalledWith('Monthly limit saved');
  });

  it('rejects a budget above the installation max without calling the API', async () => {
    renderSection(makeSettings());
    await screen.findByText('$2.00 of $20.00 used this month');

    const input = screen.getByLabelText('Monthly limit (USD)');
    fireEvent.change(input, { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(mocks.updateProjectAgentModelSettings).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledWith('Enter an amount between $0 and $100.00.');
  });

  it('shows a needs-attention alert with a Raise-limit fix when the budget is fully used', async () => {
    renderSection(
      makeSettings({ usage: { ...makeSettings().usage, spentUsd: 20, reservedUsd: 0 } })
    );
    await screen.findByText(/limit is used up/);

    const input = screen.getByLabelText('Monthly limit (USD)') as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: 'Raise limit' }));
    expect(input).toHaveFocus();
  });

  it('resets the budget to the installation default', async () => {
    mocks.updateProjectAgentModelSettings.mockResolvedValue(makeSettings());
    renderSection(makeSettings({ monthlyBudgetUsd: 50, effectiveMonthlyBudgetUsd: 50 }));
    await screen.findByText('$2.00 of $50.00 used this month');

    fireEvent.click(screen.getByRole('button', { name: 'Use installation default' }));

    await waitFor(() =>
      expect(mocks.updateProjectAgentModelSettings).toHaveBeenCalledWith('proj-1', {
        monthlyBudgetUsd: null,
      })
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Using the installation default limit');
  });

  it('resets a custom model selection back to recommended defaults', async () => {
    mocks.updateProjectAgentModelSettings.mockResolvedValue(makeSettings());
    renderSection(makeSettings({ models: ['m-decision-1'], effectiveSource: 'project' }));
    await screen.findByText(/Using a custom selection/);

    fireEvent.click(screen.getByRole('button', { name: 'Reset to recommended' }));

    await waitFor(() =>
      expect(mocks.updateProjectAgentModelSettings).toHaveBeenCalledWith('proj-1', {
        models: null,
      })
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Reset to recommended models');
  });

  it('hides edit controls and shows a reason when the caller cannot edit', async () => {
    renderSection(makeSettings({ canEdit: false }));
    await screen.findByText('$2.00 of $20.00 used this month');

    expect(screen.queryByLabelText('Monthly limit (USD)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
    expect(screen.getByText('Only project owners and admins can change the limit.')).toBeInTheDocument();
    expect(
      screen.getByText('Only project owners and admins can change which models agents may call.')
    ).toBeInTheDocument();
  });

  it('shows a calm banner when the feature is turned off platform-wide, and disables every control even for an editor', async () => {
    // `canEdit: true` on purpose — a platform-level toggle must outrank a
    // project owner/admin's own edit permission.
    renderSection(makeSettings({ featureEnabled: false, canEdit: true }));

    expect(await screen.findByText('Turned off by your SAM administrator.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Monthly limit (USD)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
    // The per-control permission reason must not appear — it would
    // incorrectly imply a role problem when the real cause is the platform
    // toggle, which the banner above already explains.
    expect(screen.queryByText(/Only project owners and admins/)).not.toBeInTheDocument();
  });

  it('shows a retry affordance when loading settings fails', async () => {
    mocks.getAgentModelCatalog.mockResolvedValue(CATALOG);
    mocks.getProjectAgentModelSettings.mockRejectedValueOnce(new Error('boom'));
    const queryClient = createTestQueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <ProjectAgentModelsSection projectId="proj-1" />
      </QueryClientProvider>
    );

    expect(await screen.findByText(/Couldn.t load agent model settings/)).toBeInTheDocument();

    mocks.getProjectAgentModelSettings.mockResolvedValueOnce(makeSettings());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByText('$2.00 of $20.00 used this month');
  });
});

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
    defaultMonthlyBudgetUsd: 20,
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

  it('shows the "AI Models" heading, budget usage, reset date, and the recommended-models category summary', async () => {
    renderSection(makeSettings());

    expect(screen.getByRole('heading', { name: 'AI Models' })).toBeInTheDocument();
    expect(await screen.findByText('$2.00 of $20.00 used this month')).toBeInTheDocument();
    expect(screen.getByText(/resets Nov 1/)).toBeInTheDocument();
    expect(screen.getByText('Recommended · 1 model (Decision 1)')).toBeInTheDocument();
    // "clef-flash" appears once, in the "Used this month" list — the
    // selection summary is category-based and never names a specific model.
    expect(screen.getAllByText(/clef-flash/)).toHaveLength(1);
  });

  it('mentions run_ai_model exactly once, in the section subtitle', async () => {
    renderSection(makeSettings());
    await screen.findByText('$2.00 of $20.00 used this month');

    expect(
      screen.getAllByText((_, element) => element?.textContent === 'run_ai_model')
    ).toHaveLength(1);
  });

  it('the budget bar exposes progressbar semantics', async () => {
    renderSection(makeSettings());
    await screen.findByText('$2.00 of $20.00 used this month');

    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-valuenow', '10'); // $2 of $20 = 10%
  });

  it('shows the installation default inline when the project has no budget override', async () => {
    renderSection(makeSettings({ monthlyBudgetUsd: null, effectiveMonthlyBudgetUsd: 20 }));
    await screen.findByText('$2.00 of $20.00 used this month');

    expect(screen.getByText('Up to $100.00 · Default: $20.00')).toBeInTheDocument();
  });

  it('still shows the installation default when the project has its own budget override', async () => {
    renderSection(
      makeSettings({
        monthlyBudgetUsd: 30,
        effectiveMonthlyBudgetUsd: 30,
        maxMonthlyBudgetUsd: 50,
        defaultMonthlyBudgetUsd: 5,
      })
    );
    await screen.findByText('$2.00 of $30.00 used this month');

    expect(screen.getByText('Up to $50.00 · Default: $5.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use default ($5.00)' })).toBeInTheDocument();
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

  it('disables Save and shows a red "Up to $X" hint when the typed budget exceeds the max', async () => {
    renderSection(makeSettings());
    await screen.findByText('$2.00 of $20.00 used this month');

    const input = screen.getByLabelText('Monthly limit (USD)');
    fireEvent.change(input, { target: { value: '500' } });

    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeDisabled();
    const hint = screen.getByText(/Up to \$100\.00/);
    expect(hint).toHaveClass('text-danger');
    expect(mocks.updateProjectAgentModelSettings).not.toHaveBeenCalled();

    fireEvent.click(saveButton);
    expect(mocks.updateProjectAgentModelSettings).not.toHaveBeenCalled();
  });

  it('disables Save for an empty or negative budget value', async () => {
    renderSection(makeSettings());
    await screen.findByText('$2.00 of $20.00 used this month');

    const input = screen.getByLabelText('Monthly limit (USD)');
    const saveButton = screen.getByRole('button', { name: 'Save' });

    fireEvent.change(input, { target: { value: '' } });
    expect(saveButton).toBeDisabled();

    fireEvent.change(input, { target: { value: '-5' } });
    expect(saveButton).toBeDisabled();
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

    fireEvent.click(screen.getByRole('button', { name: 'Use default ($20.00)' }));

    await waitFor(() =>
      expect(mocks.updateProjectAgentModelSettings).toHaveBeenCalledWith('proj-1', {
        monthlyBudgetUsd: null,
      })
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Using the installation default limit');
  });

  it('resets a custom model selection back to recommended with "Use recommended"', async () => {
    mocks.updateProjectAgentModelSettings.mockResolvedValue(makeSettings());
    renderSection(makeSettings({ models: ['m-decision-1'], effectiveSource: 'project' }));
    await screen.findByText('Your selection · 1 model (Decision 1)');

    fireEvent.click(screen.getByRole('button', { name: 'Use recommended' }));

    await waitFor(() =>
      expect(mocks.updateProjectAgentModelSettings).toHaveBeenCalledWith('proj-1', {
        models: null,
      })
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Reset to recommended models');
  });

  it('opens the picker from "Choose models", and the action buttons do not jam on a narrow layout', async () => {
    renderSection(makeSettings({ models: ['m-decision-1'], effectiveSource: 'project' }));
    await screen.findByText('Your selection · 1 model (Decision 1)');

    const chooseButton = screen.getByRole('button', { name: 'Choose models' });
    const useRecommendedButton = screen.getByRole('button', { name: 'Use recommended' });
    const buttonRow = chooseButton.parentElement!;
    expect(buttonRow).toContainElement(useRecommendedButton);
    expect(buttonRow.className).toMatch(/\bgap-2\b/);
    expect(buttonRow.className).toMatch(/\bflex-wrap\b/);

    fireEvent.click(chooseButton);
    expect(await screen.findByText('Choose AI models')).toBeInTheDocument();
  });

  it('hides edit controls and shows a reason when the caller cannot edit', async () => {
    renderSection(makeSettings({ canEdit: false }));
    await screen.findByText('$2.00 of $20.00 used this month');

    expect(screen.queryByLabelText('Monthly limit (USD)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose models' })).not.toBeInTheDocument();
    expect(
      screen.getByText('Only project owners and admins can change the limit.')
    ).toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Choose models' })).not.toBeInTheDocument();
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

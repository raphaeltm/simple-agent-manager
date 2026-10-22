import type {
  AgentModelCatalogResponse,
  ProjectAgentModelSettingsResponse,
} from '@simple-agent-manager/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentModelAccessField } from '../../../../src/components/agent-models/AgentModelAccessField';
import { createTestQueryClient } from '../../../test-utils/query-test-utils';

const mocks = vi.hoisted(() => ({
  getAgentModelCatalog: vi.fn(),
  getProjectAgentModelSettings: vi.fn(),
}));

vi.mock('../../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'user-1' }));
vi.mock('../../../../src/lib/api/agent-models', () => ({
  getAgentModelCatalog: mocks.getAgentModelCatalog,
  getProjectAgentModelSettings: mocks.getProjectAgentModelSettings,
  updateProjectAgentModelSettings: vi.fn(),
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
    {
      id: 'm-decision-2',
      name: 'clef-omni',
      author: 'cloudflare',
      description: 'Broader decisions.',
      category: 'decision',
      task: 'Text Generation',
      prices: [{ unit: 'per M input tokens', usd: 0.04 }],
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

function makeProjectSettings(
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
      spentUsd: 0,
      reservedUsd: 0,
      callCount: 0,
      resetsAt: '2026-11-01T00:00:00Z',
      byModel: [],
    },
    canEdit: true,
    ...overrides,
  };
}

/** A thin controlled-field harness so tests can assert what `onChange` received without reimplementing state. */
function Harness({
  initialValue,
  fallbackProfile,
}: {
  initialValue: string[] | null;
  fallbackProfile?: { name: string; agentModels: string[] | null } | null;
}) {
  const [value, setValue] = useState<string[] | null>(initialValue);
  return (
    <AgentModelAccessField
      projectId="proj-1"
      ownerLabel={fallbackProfile === undefined ? 'profile' : 'skill'}
      value={value}
      onChange={setValue}
      fallbackProfile={fallbackProfile}
    />
  );
}

function renderField(props: Parameters<typeof Harness>[0]) {
  mocks.getAgentModelCatalog.mockResolvedValue(CATALOG);
  const queryClient = createTestQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <Harness {...props} />
    </QueryClientProvider>
  );
}

describe('AgentModelAccessField', () => {
  beforeEach(() => {
    mocks.getAgentModelCatalog.mockReset();
    mocks.getProjectAgentModelSettings.mockReset();
  });

  it('profile context: inherits SAM\'s recommended defaults when the project has no override', async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(makeProjectSettings({ models: null }));
    renderField({ initialValue: null });

    expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('inherit');
    expect(
      await screen.findByText(/Inherits from SAM's recommended defaults: 1 model — clef-flash/)
    ).toBeInTheDocument();
  });

  it("profile context: inherits the project's own selection when the project has one", async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(
      makeProjectSettings({ models: ['m-decision-2'], effectiveModelIds: ['m-decision-2'] })
    );
    renderField({ initialValue: null });

    expect(
      await screen.findByText(/Inherits from the project: 1 model — clef-omni/)
    ).toBeInTheDocument();
  });

  it('profile context: switching to Custom opens the picker, and Save sends an array to onChange', async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(
      makeProjectSettings({ models: ['m-decision-2'], effectiveModelIds: ['m-decision-2'] })
    );
    renderField({ initialValue: null });
    await screen.findByText(/Inherits from the project/);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } });

    // Seeded from the inherited selection: clef-omni starts on, clef-flash off.
    await screen.findByText('clef-flash');
    fireEvent.click(screen.getByRole('switch', { name: /turn on clef-flash/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('custom')
    );
    expect(
      await screen.findByText(/2 models — clef-omni, clef-flash/)
    ).toBeInTheDocument();
  });

  it('profile context: cancelling out of Custom does not commit a value — stays Inherit', async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(
      makeProjectSettings({ models: ['m-decision-2'], effectiveModelIds: ['m-decision-2'] })
    );
    renderField({ initialValue: null });
    await screen.findByText(/Inherits from the project/);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } });
    await screen.findByText('clef-flash');

    // Nothing toggled, so the footer's dismiss action reads "Close" (not
    // dirty) — same accessible name as the header's icon-only close button,
    // so disambiguate by picking the last match (footer is last in the DOM).
    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    fireEvent.click(closeButtons[closeButtons.length - 1]!);

    await waitFor(() =>
      expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('inherit')
    );
    expect(screen.getByText(/Inherits from the project/)).toBeInTheDocument();
  });

  it('switching an existing custom selection back to Inherit sends null', async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(makeProjectSettings({ models: null }));
    renderField({ initialValue: ['m-decision-2'] });

    expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('custom');
    expect(await screen.findByText('1 model — clef-omni')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'inherit' } });

    await waitFor(() =>
      expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('inherit')
    );
    expect(
      await screen.findByText(/Inherits from SAM's recommended defaults/)
    ).toBeInTheDocument();
  });

  it('a custom empty selection reads clearly, not as a bare count', async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(makeProjectSettings());
    renderField({ initialValue: [] });

    expect(await screen.findByText("No models — agents can't call any")).toBeInTheDocument();
  });

  it('skill context: inherits the chosen profile when that profile has its own override', async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(
      makeProjectSettings({ models: ['m-decision-1'], effectiveModelIds: ['m-decision-1'] })
    );
    renderField({
      initialValue: null,
      fallbackProfile: { name: 'Builder', agentModels: ['m-decision-2'] },
    });

    expect(await screen.findByText(/Inherits from profile "Builder": 1 model — clef-omni/)).toBeInTheDocument();
  });

  it('skill context: falls back to the project when the chosen profile has no override', async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(
      makeProjectSettings({ models: ['m-decision-2'], effectiveModelIds: ['m-decision-2'] })
    );
    renderField({
      initialValue: null,
      fallbackProfile: { name: 'Builder', agentModels: null },
    });

    expect(await screen.findByText(/Inherits from the project: 1 model — clef-omni/)).toBeInTheDocument();
  });

  it('skill context: falls back to recommended defaults when no profile is chosen and the project has none', async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(makeProjectSettings({ models: null }));
    renderField({ initialValue: null, fallbackProfile: null });

    expect(
      await screen.findByText(/Inherits from SAM's recommended defaults: 1 model — clef-flash/)
    ).toBeInTheDocument();
  });
});

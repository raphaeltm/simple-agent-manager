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

// Two "decision" models plus one "embeddings" model: a one-model selection
// always summarizes to "1 model: Decision 1" by category regardless of
// *which* decision model it is, so distinguishing scenarios by their
// displayed text requires at least one model in a different category.
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
    {
      id: 'm-embed-1',
      name: 'bge-base',
      author: 'baai',
      description: 'Turn text into vectors.',
      category: 'embeddings',
      task: 'Text Embeddings',
      prices: [{ unit: 'per M input tokens', usd: 0.01 }],
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

  it('profile context: select options read "Same as project" / "Choose models" — no "Inherit" jargon, nothing to truncate', async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(makeProjectSettings({ models: null }));
    renderField({ initialValue: null });

    const select = screen.getByRole<HTMLSelectElement>('combobox');
    expect(select.value).toBe('inherit');
    const options = Array.from(select.options).map((option) => option.text);
    expect(options).toEqual(['Same as project', 'Choose models']);
  });

  it("profile context: shows the project's recommended defaults as a category summary", async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(makeProjectSettings({ models: null }));
    renderField({ initialValue: null });

    expect(
      await screen.findByText("Uses the project's models: 1 model: Decision 1")
    ).toBeInTheDocument();
  });

  it("profile context: shows the project's own multi-category selection", async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(
      makeProjectSettings({
        models: ['m-decision-1', 'm-embed-1'],
        effectiveModelIds: ['m-decision-1', 'm-embed-1'],
      })
    );
    renderField({ initialValue: null });

    expect(
      await screen.findByText("Uses the project's models: 2 models: Decision 1 · Embeddings 1")
    ).toBeInTheDocument();
  });

  it('profile context: switching to Custom seeds from the inherited selection, and Save sends the combined array', async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(
      makeProjectSettings({ models: ['m-embed-1'], effectiveModelIds: ['m-embed-1'] })
    );
    renderField({ initialValue: null });
    await screen.findByText(/Uses the project's models/);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } });

    // Seeded from the inherited selection: bge-base starts on.
    await screen.findByText('bge-base');
    expect(screen.getByRole('switch', { name: /turn off bge-base/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    fireEvent.click(screen.getByRole('switch', { name: /turn on clef-flash/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('custom')
    );
    expect(await screen.findByText('2 models: Decision 1 · Embeddings 1')).toBeInTheDocument();
  });

  it('profile context: cancelling out of Custom does not commit a value — stays on "Same as project"', async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(
      makeProjectSettings({ models: ['m-embed-1'], effectiveModelIds: ['m-embed-1'] })
    );
    renderField({ initialValue: null });
    await screen.findByText(/Uses the project's models/);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } });
    await screen.findByText('bge-base');

    // Nothing toggled, so the footer's dismiss action reads "Close" (not
    // dirty) — same accessible name as the header's icon-only close button
    // in round 1, now disambiguated by its own distinct "Close model picker"
    // label (B3), so the plain "Close" query is unambiguous here.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() =>
      expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('inherit')
    );
    expect(screen.getByText(/Uses the project's models/)).toBeInTheDocument();
  });

  it('switching an existing custom selection back to "Same as project" sends null and refreshes the displayed summary', async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(
      makeProjectSettings({ models: ['m-embed-1'], effectiveModelIds: ['m-embed-1'] })
    );
    renderField({ initialValue: ['m-decision-2'] });

    expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('custom');
    expect(await screen.findByText('1 model: Decision 1')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'inherit' } });

    await waitFor(() =>
      expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('inherit')
    );
    // Distinct from the custom selection's text above — proves the display
    // actually switched to the project's value, not a leftover custom string.
    expect(
      await screen.findByText("Uses the project's models: 1 model: Embeddings 1")
    ).toBeInTheDocument();
  });

  it('a custom empty selection reads clearly, not as a bare count', async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(makeProjectSettings());
    renderField({ initialValue: [] });

    expect(
      await screen.findByText("No models. Agents using this profile can't call any.")
    ).toBeInTheDocument();
  });

  it('skill context: select options read "Same as profile" / "Choose models"', async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(makeProjectSettings());
    renderField({ initialValue: null, fallbackProfile: null });

    const select = screen.getByRole<HTMLSelectElement>('combobox');
    const options = Array.from(select.options).map((option) => option.text);
    expect(options).toEqual(['Same as profile', 'Choose models']);
  });

  it("skill context: the helper text always anchors to the project's own selection, even when the chosen profile has its own override", async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(
      makeProjectSettings({ models: ['m-embed-1'], effectiveModelIds: ['m-embed-1'] })
    );
    renderField({
      initialValue: null,
      fallbackProfile: { name: 'Builder', agentModels: ['m-decision-2'] },
    });

    expect(
      await screen.findByText(
        "Uses the profile's models, or the project's if the profile has none. Project: 1 model: Embeddings 1"
      )
    ).toBeInTheDocument();
  });

  it("skill context: switching to Custom seeds from the chosen profile's own override, not the project", async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(
      makeProjectSettings({ models: ['m-embed-1'], effectiveModelIds: ['m-embed-1'] })
    );
    renderField({
      initialValue: null,
      fallbackProfile: { name: 'Builder', agentModels: ['m-decision-2'] },
    });
    await screen.findByText(/Uses the profile's models/);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } });
    await screen.findByText('clef-omni');

    expect(screen.getByRole('switch', { name: /turn off clef-omni/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('switch', { name: /turn on bge-base/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('skill context: switching to Custom seeds from the project when the chosen profile has no override', async () => {
    mocks.getProjectAgentModelSettings.mockResolvedValue(
      makeProjectSettings({ models: ['m-embed-1'], effectiveModelIds: ['m-embed-1'] })
    );
    renderField({
      initialValue: null,
      fallbackProfile: { name: 'Builder', agentModels: null },
    });
    await screen.findByText(/Uses the profile's models/);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } });
    await screen.findByText('bge-base');

    expect(screen.getByRole('switch', { name: /turn off bge-base/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});

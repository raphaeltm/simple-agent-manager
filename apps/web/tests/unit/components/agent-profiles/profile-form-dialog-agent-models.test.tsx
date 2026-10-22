import type { AgentModelCatalogResponse, AgentProfile } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfileFormDialog } from '../../../../src/components/agent-profiles/ProfileFormDialog';
import { QueryTestWrapper } from '../../../test-utils/query-test-utils';

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
vi.mock('../../../../src/components/agent-profiles/ProfileRuntimeSection', () => ({
  ProfileRuntimeSection: () => <div data-testid="runtime-section" />,
}));
vi.mock('../../../../src/components/ModelSelect', () => ({
  ModelSelect: ({ value }: { value: string }) => <div data-testid="model-select">{value}</div>,
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
  // Only clef-flash is on by default, so a test can toggle clef-omni (which
  // starts off) to produce a genuine, observable change.
  defaultModelIds: ['m-decision-1'],
  defaultCategories: ['decision'],
  fetchedAt: '2026-10-01T00:00:00Z',
};

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'prof_1',
    projectId: 'proj_1',
    userId: 'user_1',
    name: 'Fast Implementer',
    description: null,
    agentType: 'claude-code',
    model: null,
    effort: 'auto',
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    resourceRequirementsJson: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    runtime: null,
    devcontainerConfigName: null,
    taskMode: null,
    githubCliPolicy: null,
    agentModels: null,
    isBuiltin: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function expandAiModelsSection() {
  fireEvent.click(screen.getByRole('button', { name: /AI Models/ }));
}

describe('ProfileFormDialog — AI model calls field', () => {
  beforeEach(() => {
    mocks.getAgentModelCatalog.mockReset().mockResolvedValue(CATALOG);
    mocks.getProjectAgentModelSettings.mockReset().mockResolvedValue({
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
    });
  });

  it('create mode: submits agentModels: null by default (inherit the project)', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <QueryTestWrapper>
        <ProfileFormDialog isOpen onClose={vi.fn()} onSave={onSave} projectId="proj_1" />
      </QueryTestWrapper>
    );

    fireEvent.change(screen.getByPlaceholderText('e.g. Fast Implementer'), {
      target: { value: 'New Profile' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Profile' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ agentModels: null }))
    );
  });

  it('switching to a custom selection and picking a model submits the array', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <QueryTestWrapper>
        <ProfileFormDialog isOpen onClose={vi.fn()} onSave={onSave} projectId="proj_1" />
      </QueryTestWrapper>
    );
    fireEvent.change(screen.getByPlaceholderText('e.g. Fast Implementer'), {
      target: { value: 'New Profile' },
    });

    expandAiModelsSection();
    await screen.findByText(/Inherits from SAM's recommended defaults/);
    fireEvent.change(screen.getByRole('combobox', { name: /AI models this profile can call/i }), {
      target: { value: 'custom' },
    });

    // clef-flash (m-decision-1) is already on (it's the inherited default);
    // toggle clef-omni on too so the draft is genuinely dirty.
    await screen.findByText('clef-omni');
    fireEvent.click(screen.getByRole('switch', { name: /turn on clef-omni/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Wait for the picker itself to actually unmount before interacting with
    // what's beneath it — `handleSave` is async, so the picker is still
    // present (and its background-hide of the dialog still active) for at
    // least one microtask after the click returns.
    await waitFor(() => expect(screen.queryByText('Choose callable models')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Create Profile' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ agentModels: expect.arrayContaining(['m-decision-1', 'm-decision-2']) })
      )
    );
  });

  it('edit mode: loads an existing custom selection and switching to inherit submits null', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <QueryTestWrapper>
        <ProfileFormDialog
          isOpen
          onClose={vi.fn()}
          onSave={onSave}
          projectId="proj_1"
          profile={makeProfile({ agentModels: ['m-decision-1'] })}
        />
      </QueryTestWrapper>
    );

    expandAiModelsSection();
    const select = await screen.findByRole<HTMLSelectElement>('combobox', {
      name: /AI models this profile can call/i,
    });
    expect(select.value).toBe('custom');

    fireEvent.change(select, { target: { value: 'inherit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ agentModels: null }))
    );
  });
});

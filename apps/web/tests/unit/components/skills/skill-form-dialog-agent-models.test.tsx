import type { AgentModelCatalogResponse, AgentProfile } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SkillFormDialog } from '../../../../src/components/skills/SkillFormDialog';
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
vi.mock('../../../../src/components/skills/SkillRuntimeSection', () => ({
  SkillRuntimeSection: () => <div data-testid="skill-runtime-section" />,
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

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'prof_1',
    projectId: 'proj_1',
    userId: 'user_1',
    name: 'Builder',
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

describe('SkillFormDialog — AI model calls field', () => {
  beforeEach(() => {
    mocks.getAgentModelCatalog.mockReset().mockResolvedValue(CATALOG);
    mocks.getProjectAgentModelSettings.mockReset().mockResolvedValue({
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
        spentUsd: 0,
        reservedUsd: 0,
        callCount: 0,
        resetsAt: '2026-11-01T00:00:00Z',
        byModel: [],
      },
      canEdit: true,
    });
  });

  it('create mode: submits agentModels: null by default (inherit)', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <QueryTestWrapper>
        <SkillFormDialog
          isOpen
          onClose={vi.fn()}
          onSave={onSave}
          profiles={[]}
          projectId="proj_1"
        />
      </QueryTestWrapper>
    );

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Skill' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Skill' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ agentModels: null }))
    );
  });

  it('switching to a custom selection submits the array, and follows the chosen default profile when inheriting', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const profile = makeProfile({ agentModels: ['m-decision-2'] });
    render(
      <QueryTestWrapper>
        <SkillFormDialog
          isOpen
          onClose={vi.fn()}
          onSave={onSave}
          profiles={[profile]}
          projectId="proj_1"
        />
      </QueryTestWrapper>
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Skill' } });

    // Choosing the default profile changes what "Inherit" resolves to. The
    // label wraps extra helper text too, so match it with a regex rather
    // than an exact string.
    fireEvent.change(screen.getByLabelText(/Default Profile/), {
      target: { value: profile.id },
    });
    expect(
      await screen.findByText(
        "Uses the profile's choice, or the project's if the profile has none. Project's choice: 1 model (Decision 1)"
      )
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: /AI models this skill can call/i }), {
      target: { value: 'custom' },
    });
    await screen.findByText('clef-flash');
    fireEvent.click(screen.getByRole('switch', { name: /turn on clef-flash/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByText('Choose AI models')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Create Skill' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          agentModels: expect.arrayContaining(['m-decision-1', 'm-decision-2']),
        })
      )
    );
  });

  it('B1: a background refetch that hands in a new `skill` object of the same id must not wipe in-progress Name or AI-models edits', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const skillV1 = {
      id: 'skill_1',
      projectId: 'proj_1',
      name: 'Refactor',
      description: 'Refactors code',
      defaultProfileId: null,
      systemPromptAppend: null,
      vmSizeOverride: null,
      taskMode: 'task' as const,
      resourceRequirementsJson: null,
      agentModels: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const { rerender } = render(
      <QueryTestWrapper>
        <SkillFormDialog
          isOpen
          onClose={vi.fn()}
          onSave={onSave}
          profiles={[]}
          projectId="proj_1"
          skill={skillV1}
        />
      </QueryTestWrapper>
    );

    // User is mid-edit: renames, and switches AI models to a custom
    // selection that it then Saves inside the nested picker.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed by user' } });
    fireEvent.change(screen.getByRole('combobox', { name: /AI models this skill can call/i }), {
      target: { value: 'custom' },
    });
    // The picker seeds from the inherited defaults (clef-flash on) once they load.
    await screen.findByRole('switch', { name: /turn off clef-flash/i });
    fireEvent.click(screen.getByRole('switch', { name: /turn on clef-omni/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('2 models (Decision 2)');

    expect(screen.getByLabelText('Name')).toHaveValue('Renamed by user');

    // Background refetch of the skills list resolves: a BRAND NEW `skill`
    // object, same id, same content — exactly what `SkillList`'s
    // `skills.find(...)` returns after any refetch, even one that changed
    // nothing the user is editing.
    const skillV2 = { ...skillV1 };
    rerender(
      <QueryTestWrapper>
        <SkillFormDialog
          isOpen
          onClose={vi.fn()}
          onSave={onSave}
          profiles={[]}
          projectId="proj_1"
          skill={skillV2}
        />
      </QueryTestWrapper>
    );

    expect(screen.getByLabelText('Name')).toHaveValue('Renamed by user');
    expect(screen.getByText('2 models (Decision 2)')).toBeInTheDocument();
  });
});

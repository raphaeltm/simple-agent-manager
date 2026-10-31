import type { AgentProfile } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfileFormDialog } from '../../../../src/components/agent-profiles/ProfileFormDialog';
import { QueryTestWrapper } from '../../../test-utils/query-test-utils';
import {
  makeTestProjectModelSettings,
  TEST_MODEL_CATALOG,
} from '../agent-models/agent-model-test-fixtures';

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
    mocks.getAgentModelCatalog.mockReset().mockResolvedValue(TEST_MODEL_CATALOG);
    mocks.getProjectAgentModelSettings
      .mockReset()
      .mockResolvedValue(makeTestProjectModelSettings());
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
    await screen.findByText(/The project's choice/);
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
    await waitFor(() => expect(screen.queryByText('Choose AI models')).not.toBeInTheDocument());

    // The picker title can disappear before its focus/aria-hidden cleanup finishes.
    fireEvent.click(await screen.findByRole('button', { name: 'Create Profile' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          agentModels: expect.arrayContaining(['m-decision-1', 'm-decision-2']),
        })
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

  it('the collapsed accordion summary reads "Same as project" when inherited', async () => {
    render(
      <QueryTestWrapper>
        <ProfileFormDialog
          isOpen
          onClose={vi.fn()}
          onSave={vi.fn()}
          projectId="proj_1"
          profile={makeProfile({ agentModels: null })}
        />
      </QueryTestWrapper>
    );
    // Scoped to the accordion toggle button specifically: the collapsed
    // section's own (CSS-hidden but still DOM-present) "Same as project"
    // `<option>` would otherwise also match a plain text query.
    expect(
      await screen.findByRole('button', { name: /AI Models.*Same as project/ })
    ).toBeInTheDocument();
  });

  it('the collapsed accordion summary reads "Custom: N models" for a custom selection', async () => {
    // A different profile id so `ProfileFormDialog`'s populate effect (keyed
    // on `[isOpen, profileId]`, deliberately not on the whole `profile`
    // object — see its own comment) actually re-seeds for this render.
    render(
      <QueryTestWrapper>
        <ProfileFormDialog
          isOpen
          onClose={vi.fn()}
          onSave={vi.fn()}
          projectId="proj_1"
          profile={makeProfile({ id: 'prof_2', agentModels: ['m-decision-1', 'm-decision-2'] })}
        />
      </QueryTestWrapper>
    );
    expect(await screen.findByText('Custom: 2 models')).toBeInTheDocument();
  });
});

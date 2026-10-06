import type {
  AgentInfo,
  AgentSettingsResponse,
  ModelCatalogResponse,
} from '@simple-agent-manager/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSettingsCard } from '../../../src/components/AgentSettingsCard';
import { getAgentModelCatalog } from '../../../src/lib/api/agents';

vi.mock('../../../src/lib/api/agents', () => ({
  getAgentModelCatalog: vi.fn(),
}));

function makeClaudeAgent(): AgentInfo {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Claude Code agent',
    supportsAcp: true,
    configured: true,
  } as AgentInfo;
}

function makeOpenCodeAgent(): AgentInfo {
  return {
    id: 'opencode',
    name: 'OpenCode',
    description: 'OpenCode agent',
    supportsAcp: true,
    configured: true,
  } as AgentInfo;
}

function makeOpenCodeSettings(
  overrides: Partial<AgentSettingsResponse> = {}
): AgentSettingsResponse {
  return {
    agentType: 'opencode',
    model: null,
    permissionMode: null,
    allowedTools: null,
    deniedTools: null,
    additionalEnv: null,
    opencodeProvider: null,
    opencodeBaseUrl: null,
    providerMode: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  } as AgentSettingsResponse;
}

function dynamicOpenCodeCatalog(): ModelCatalogResponse {
  return {
    agentType: 'opencode',
    source: 'dynamic',
    updatedAt: '2026-06-27T00:00:00.000Z',
    groups: [
      {
        label: 'OpenCode Zen',
        models: [
          {
            id: 'opencode/claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            group: 'OpenCode Zen',
          },
        ],
      },
      {
        label: 'OpenCode Go',
        models: [
          {
            id: 'opencode-go/glm-5.2',
            name: 'GLM-5.2',
            group: 'OpenCode Go',
          },
        ],
      },
    ],
  };
}

describe('AgentSettingsCard OpenCode model catalog', () => {
  beforeEach(() => {
    vi.mocked(getAgentModelCatalog).mockReset();
  });

  it('uses the API-backed model select narrowed to OpenCode Go when Go is selected', async () => {
    const user = userEvent.setup();
    vi.mocked(getAgentModelCatalog).mockResolvedValue(dynamicOpenCodeCatalog());

    render(
      <AgentSettingsCard
        agent={makeOpenCodeAgent()}
        settings={makeOpenCodeSettings({ opencodeProvider: 'opencode-go' })}
        onSave={vi.fn()}
        onReset={vi.fn()}
      />
    );

    await waitFor(() => expect(getAgentModelCatalog).toHaveBeenCalledWith('opencode'));
    await user.click(screen.getByTestId('model-input-opencode'));

    expect(screen.getByText('GLM-5.2')).toBeInTheDocument();
    expect(screen.getByText('opencode-go/glm-5.2')).toBeInTheDocument();
    expect(screen.queryByText('Claude Sonnet 4.6')).not.toBeInTheDocument();
  });

  it('shows the Zen balance note only for the opencode-zen provider', async () => {
    vi.mocked(getAgentModelCatalog).mockResolvedValue(dynamicOpenCodeCatalog());
    const { unmount } = render(
      <AgentSettingsCard
        agent={makeOpenCodeAgent()}
        settings={makeOpenCodeSettings({ opencodeProvider: 'opencode-zen' })}
        onSave={vi.fn()}
        onReset={vi.fn()}
      />
    );
    const note = screen.getByTestId('opencode-zen-balance-note');
    expect(note).toHaveTextContent('OpenCode console');
    expect(note.querySelector('a')).toHaveAttribute('href', 'https://opencode.ai/zen');
    unmount();

    render(
      <AgentSettingsCard
        agent={makeOpenCodeAgent()}
        settings={makeOpenCodeSettings({ opencodeProvider: 'opencode-go' })}
        onSave={vi.fn()}
        onReset={vi.fn()}
      />
    );
    expect(screen.queryByTestId('opencode-zen-balance-note')).toBeNull();
  });

  it('keeps custom OpenCode providers as freeform model input', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);

    render(
      <AgentSettingsCard
        agent={makeOpenCodeAgent()}
        settings={makeOpenCodeSettings({ opencodeProvider: 'custom' })}
        onSave={onSave}
        onReset={vi.fn()}
      />
    );

    expect(screen.queryByRole('combobox', { name: /model/i })).not.toBeInTheDocument();
    await user.type(screen.getByTestId('model-input-opencode'), 'custom-model');

    expect(screen.getByTestId('model-input-opencode')).toHaveValue('custom-model');
    expect(getAgentModelCatalog).not.toHaveBeenCalled();
  });
});

describe('AgentSettingsCard permission mode default', () => {
  function radio(mode: string): HTMLInputElement {
    return screen.getByTestId(`permission-mode-claude-code-${mode}`) as HTMLInputElement;
  }

  it('selects Bypass Permissions when no mode is saved, with nothing pending to save', () => {
    render(
      <AgentSettingsCard
        agent={makeClaudeAgent()}
        settings={makeOpenCodeSettings({ agentType: 'claude-code' })}
        onSave={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(radio('bypassPermissions').checked).toBe(true);
    expect(radio('default').checked).toBe(false);
    expect(screen.getByRole('radio', { name: 'Manual' })).toBe(radio('default'));
    expect(screen.getByRole('alert')).toHaveTextContent('disables all safety prompts');
    expect(screen.getByTestId('save-settings-claude-code')).toBeDisabled();
  });

  it('saves the default mode explicitly when other settings change', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentSettingsCard
        agent={makeClaudeAgent()}
        settings={makeOpenCodeSettings({ agentType: 'claude-code' })}
        onSave={onSave}
        onReset={vi.fn()}
      />
    );

    await user.type(screen.getByTestId('model-input-claude-code'), 'claude-opus-5');
    await user.click(screen.getByTestId('save-settings-claude-code'));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith('claude-code', {
        model: 'claude-opus-5',
        permissionMode: 'bypassPermissions',
        providerMode: null,
      })
    );
  });

  it('keeps a saved Manual choice selected instead of the default', () => {
    render(
      <AgentSettingsCard
        agent={makeClaudeAgent()}
        settings={makeOpenCodeSettings({ agentType: 'claude-code', permissionMode: 'default' })}
        onSave={vi.fn()}
        onReset={vi.fn()}
      />
    );

    expect(radio('default').checked).toBe(true);
    expect(radio('bypassPermissions').checked).toBe(false);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('returns the selection to Bypass Permissions on reset', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn().mockResolvedValue(undefined);
    render(
      <AgentSettingsCard
        agent={makeClaudeAgent()}
        settings={makeOpenCodeSettings({ agentType: 'claude-code', permissionMode: 'plan' })}
        onSave={vi.fn()}
        onReset={onReset}
      />
    );
    expect(radio('plan').checked).toBe(true);

    await user.click(screen.getByTestId('reset-settings-claude-code'));

    await waitFor(() => expect(radio('bypassPermissions').checked).toBe(true));
    expect(onReset).toHaveBeenCalledWith('claude-code');
  });
});

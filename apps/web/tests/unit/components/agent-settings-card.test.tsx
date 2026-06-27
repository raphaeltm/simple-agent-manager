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
    opencodeProviderName: null,
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

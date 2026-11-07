import type { ModelCatalogResponse } from '@simple-agent-manager/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelSelect } from '../../../src/components/ModelSelect';
import { getAgentModelCatalog } from '../../../src/lib/api/agents';

vi.mock('../../../src/lib/api/agents', () => ({
  getAgentModelCatalog: vi.fn(),
}));

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

describe('ModelSelect dynamic catalog', () => {
  beforeEach(() => {
    vi.mocked(getAgentModelCatalog).mockReset();
  });

  it('loads dynamic OpenCode models and filters them by provider prefix', async () => {
    const user = userEvent.setup();
    vi.mocked(getAgentModelCatalog).mockResolvedValue(dynamicOpenCodeCatalog());

    render(
      <ModelSelect
        agentType="opencode"
        value=""
        onChange={vi.fn()}
        useDynamicCatalog
        modelProviderFilter={['opencode-go']}
        data-testid="model-input"
      />
    );

    await waitFor(() => expect(getAgentModelCatalog).toHaveBeenCalledWith('opencode'));
    await user.click(screen.getByTestId('model-input'));

    expect(screen.getByText('GLM-5.2')).toBeInTheDocument();
    expect(screen.getByText('opencode-go/glm-5.2')).toBeInTheDocument();
    expect(screen.queryByText('Claude Sonnet 4.6')).not.toBeInTheDocument();
  });

  it('uses static fallback models when the dynamic catalog request fails', async () => {
    const user = userEvent.setup();
    vi.mocked(getAgentModelCatalog).mockRejectedValue(new Error('catalog unavailable'));

    render(
      <ModelSelect
        agentType="opencode"
        value=""
        onChange={vi.fn()}
        useDynamicCatalog
        modelProviderFilter={['opencode-go']}
        data-testid="model-input"
      />
    );

    await waitFor(() => expect(getAgentModelCatalog).toHaveBeenCalledWith('opencode'));
    await user.click(screen.getByTestId('model-input'));

    expect(screen.getByText('GLM-5.2')).toBeInTheDocument();
    expect(screen.getByText('opencode-go/glm-5.2')).toBeInTheDocument();
  });

  it('renders a freeform input when static catalog fallback is disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    function ControlledModelSelect() {
      const [value, setValue] = useState('');
      return (
        <ModelSelect
          agentType="opencode"
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
          allowStaticCatalog={false}
          data-testid="model-input"
        />
      );
    }

    render(<ControlledModelSelect />);

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await user.type(screen.getByTestId('model-input'), 'custom-model');

    expect(onChange).toHaveBeenLastCalledWith('custom-model');
    expect(getAgentModelCatalog).not.toHaveBeenCalled();
  });
});

describe('ModelSelect list position', () => {
  it('follows the input when a scrolling ancestor moves it', async () => {
    const user = userEvent.setup();
    render(
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        <ModelSelect id="m" agentType="claude-code" value="" onChange={() => undefined} />
      </div>
    );
    const input = screen.getByRole('combobox');
    const container = input.parentElement!.parentElement!;
    let top = 300;
    container.getBoundingClientRect = () =>
      ({ top, bottom: top + 44, left: 10, right: 210, width: 200, height: 44 }) as DOMRect;

    await user.click(input);
    const list = await screen.findByRole('listbox');
    expect(list.style.top).toBe('348px');

    // The panel scrolls by 120px; the open list must move with the input, not stay put.
    top = 180;
    screen.getByTestId('scroller').dispatchEvent(new Event('scroll'));
    await waitFor(() => expect(screen.getByRole('listbox').style.top).toBe('228px'));
  });
});

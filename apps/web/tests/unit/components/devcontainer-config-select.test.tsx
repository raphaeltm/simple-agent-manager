import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DevcontainerConfigSelect } from '../../../src/components/devcontainer/DevcontainerConfigSelect';

// Mock the hook
const mockUseDevcontainerConfigs = vi.hoisted(() => vi.fn());

vi.mock('../../../src/hooks/useDevcontainerConfigs', () => ({
  useDevcontainerConfigs: mockUseDevcontainerConfigs,
}));

function defaultHookReturn(overrides: Record<string, unknown> = {}) {
  return {
    configs: [],
    defaultConfigExists: false,
    loading: false,
    error: null,
    truncated: false,
    unsupported: false,
    refresh: vi.fn(),
    ...overrides,
  };
}

describe('DevcontainerConfigSelect', () => {
  it('renders Auto-detect as the first option', () => {
    mockUseDevcontainerConfigs.mockReturnValue(defaultHookReturn());

    render(
      <DevcontainerConfigSelect
        projectId="proj-1"
        value=""
        onChange={() => {}}
      />,
    );

    const select = screen.getByRole('combobox', { name: /devcontainer config/i });
    expect(select).toBeInTheDocument();

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('Auto-detect');
    expect(options[0]).toHaveValue('');
  });

  it('renders discovered named configs', () => {
    mockUseDevcontainerConfigs.mockReturnValue(defaultHookReturn({
      configs: [
        { name: 'node', path: '.devcontainer/node/devcontainer.json' },
        { name: 'python', path: '.devcontainer/python/devcontainer.json' },
      ],
    }));

    render(
      <DevcontainerConfigSelect
        projectId="proj-1"
        value=""
        onChange={() => {}}
      />,
    );

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3); // Auto-detect + 2 configs
    expect(options[1]).toHaveTextContent('node');
    expect(options[1]).toHaveValue('node');
    expect(options[2]).toHaveTextContent('python');
    expect(options[2]).toHaveValue('python');
  });

  it('shows saved value not in discovery as "(saved, not found)"', () => {
    mockUseDevcontainerConfigs.mockReturnValue(defaultHookReturn({
      configs: [
        { name: 'node', path: '.devcontainer/node/devcontainer.json' },
      ],
    }));

    render(
      <DevcontainerConfigSelect
        projectId="proj-1"
        value="old-config"
        onChange={() => {}}
      />,
    );

    const options = screen.getAllByRole('option');
    // Auto-detect + node + old-config (saved, not found)
    expect(options).toHaveLength(3);
    expect(options[2]).toHaveTextContent('old-config (saved, not found)');
    expect(options[2]).toHaveValue('old-config');
  });

  it('does not show "(saved, not found)" for a value found in configs', () => {
    mockUseDevcontainerConfigs.mockReturnValue(defaultHookReturn({
      configs: [
        { name: 'node', path: '.devcontainer/node/devcontainer.json' },
      ],
    }));

    render(
      <DevcontainerConfigSelect
        projectId="proj-1"
        value="node"
        onChange={() => {}}
      />,
    );

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2); // Auto-detect + node
    expect(screen.queryByText(/saved, not found/)).not.toBeInTheDocument();
  });

  it('calls onChange when a config is selected', () => {
    const onChange = vi.fn();
    mockUseDevcontainerConfigs.mockReturnValue(defaultHookReturn({
      configs: [
        { name: 'python', path: '.devcontainer/python/devcontainer.json' },
      ],
    }));

    render(
      <DevcontainerConfigSelect
        projectId="proj-1"
        value=""
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: /devcontainer config/i }), {
      target: { value: 'python' },
    });

    expect(onChange).toHaveBeenCalledWith('python');
  });

  it('shows loading indicator', () => {
    mockUseDevcontainerConfigs.mockReturnValue(defaultHookReturn({ loading: true }));

    render(
      <DevcontainerConfigSelect
        projectId="proj-1"
        value=""
        onChange={() => {}}
      />,
    );

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows error indicator on discovery failure', () => {
    mockUseDevcontainerConfigs.mockReturnValue(defaultHookReturn({
      error: 'Network error',
    }));

    render(
      <DevcontainerConfigSelect
        projectId="proj-1"
        value=""
        onChange={() => {}}
      />,
    );

    expect(screen.getByText('Discovery failed')).toBeInTheDocument();
  });

  it('is disabled when disabled prop is true', () => {
    mockUseDevcontainerConfigs.mockReturnValue(defaultHookReturn());

    render(
      <DevcontainerConfigSelect
        projectId="proj-1"
        value=""
        onChange={() => {}}
        disabled
      />,
    );

    expect(screen.getByRole('combobox', { name: /devcontainer config/i })).toBeDisabled();
  });

  it('still shows Auto-detect when discovery fails', () => {
    mockUseDevcontainerConfigs.mockReturnValue(defaultHookReturn({
      error: 'Failed',
      configs: [],
    }));

    render(
      <DevcontainerConfigSelect
        projectId="proj-1"
        value=""
        onChange={() => {}}
      />,
    );

    // Auto-detect should always be available
    expect(screen.getByRole('option', { name: 'Auto-detect' })).toBeInTheDocument();
  });
});

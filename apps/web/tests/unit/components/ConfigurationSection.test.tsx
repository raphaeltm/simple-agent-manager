import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createCCConfiguration: vi.fn(),
  deleteCCConfiguration: vi.fn(),
  updateCCConfiguration: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  createCCConfiguration: mocks.createCCConfiguration,
  deleteCCConfiguration: mocks.deleteCCConfiguration,
  updateCCConfiguration: mocks.updateCCConfiguration,
}));

import { ConfigurationSection } from '../../../src/components/settings-credentials/ConfigurationSection';
import type {
  CCConfigurationListItem,
  CCCredentialListItem,
} from '../../../src/lib/api/composable-credentials';

const credential: CCCredentialListItem = {
  id: 'cred-1',
  name: 'Shared Codex auth.json',
  kind: 'auth-json',
  isActive: true,
  createdAt: '2026-06-16T00:00:00.000Z',
  updatedAt: '2026-06-16T00:00:00.000Z',
};

const configuration: CCConfigurationListItem = {
  id: 'cfg-1',
  name: 'Codex default',
  consumerKind: 'agent',
  consumerTarget: 'openai-codex',
  credentialId: credential.id,
  settingsJson: null,
  isActive: true,
  createdAt: '2026-06-16T00:00:00.000Z',
  updatedAt: '2026-06-16T00:00:00.000Z',
};

function renderSection(props: Partial<React.ComponentProps<typeof ConfigurationSection>> = {}) {
  const onMutation =
    props.onMutation ??
    (async (action: () => Promise<unknown>) => {
      await action();
    });

  return render(
    <ConfigurationSection
      configurations={[configuration]}
      credentials={[credential]}
      onMutation={onMutation}
      onCreated={vi.fn()}
      {...props}
    />
  );
}

describe('ConfigurationSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCCConfiguration.mockResolvedValue({ id: 'cfg-new' });
    mocks.updateCCConfiguration.mockResolvedValue({ success: true });
    mocks.deleteCCConfiguration.mockResolvedValue({ success: true });
  });

  it('updates an existing configuration from the inline edit form', async () => {
    const onMutation = vi.fn(async (action: () => Promise<unknown>) => {
      await action();
    });
    renderSection({ onMutation });

    fireEvent.click(screen.getByRole('button', { name: 'Edit configuration Codex default' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Codex staging override' },
    });
    fireEvent.click(screen.getByLabelText('Active'));
    fireEvent.change(screen.getByLabelText('Credential'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mocks.updateCCConfiguration).toHaveBeenCalledWith('cfg-1', {
        name: 'Codex staging override',
        credentialId: null,
        isActive: false,
      });
    });
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  it('creates and deletes configurations through explicit controls', async () => {
    const onCreated = vi.fn();
    const onMutation = vi.fn(async (action: () => Promise<unknown>) => {
      await action();
    });
    vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
    renderSection({ onCreated, onMutation });

    fireEvent.click(screen.getByRole('button', { name: '+ Add configuration' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Claude project config' } });
    fireEvent.change(screen.getByLabelText('Credential'), { target: { value: 'cred-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mocks.createCCConfiguration).toHaveBeenCalledWith({
        name: 'Claude project config',
        consumerKind: 'agent',
        consumerTarget: 'claude-code',
        credentialId: 'cred-1',
      });
    });
    expect(onCreated).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete configuration Codex default' }));
    await waitFor(() => {
      expect(mocks.deleteCCConfiguration).toHaveBeenCalledWith('cfg-1');
    });
  });
});

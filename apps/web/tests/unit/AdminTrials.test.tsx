import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchAdminTrialsConfig: vi.fn(),
  updateAdminTrialsConfig: vi.fn(),
}));

vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/api')>()),
  fetchAdminTrialsConfig: mocks.fetchAdminTrialsConfig,
  updateAdminTrialsConfig: mocks.updateAdminTrialsConfig,
}));

import { AdminTrials } from '../../src/pages/AdminTrials';

describe('AdminTrials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchAdminTrialsConfig.mockResolvedValue({
      enabled: true,
      kvKey: 'trials:enabled',
      cacheTtlMs: 30000,
    });
    mocks.updateAdminTrialsConfig.mockResolvedValue({
      enabled: false,
      kvKey: 'trials:enabled',
      cacheTtlMs: 30000,
    });
  });

  it('renders the current trial state and diagnostics', async () => {
    render(<AdminTrials />);

    expect(await screen.findByText('Accepting trials')).toBeInTheDocument();
    expect(screen.getByText('trials:enabled')).toBeInTheDocument();
    expect(screen.getByText('30 sec')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pause trials/i })).toBeInTheDocument();
  });

  it('toggles trials through the admin API', async () => {
    render(<AdminTrials />);

    fireEvent.click(await screen.findByRole('button', { name: /pause trials/i }));

    await waitFor(() => {
      expect(mocks.updateAdminTrialsConfig).toHaveBeenCalledWith(false);
    });
    expect(await screen.findByText('Trials paused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resume trials/i })).toBeInTheDocument();
  });

  it('shows an error when loading fails', async () => {
    mocks.fetchAdminTrialsConfig.mockRejectedValue(new Error('no kv access'));

    render(<AdminTrials />);

    expect(await screen.findByRole('alert')).toHaveTextContent('no kv access');
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UpCloudCredentialForm } from '../../../src/components/UpCloudCredentialForm';
const mocks = vi.hoisted(() => ({
  createCredential: vi.fn(),
  deleteCredential: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('../../../src/lib/api', () => ({
  createCredential: mocks.createCredential,
  deleteCredential: mocks.deleteCredential,
}));
vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: mocks.success, warning: mocks.warning }),
}));
describe('UpCloudCredentialForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCredential.mockResolvedValue({
      provider: 'upcloud',
      validation: { valid: true, message: 'ok' },
    });
  });
  it('submits the exact structured credential payload', async () => {
    render(<UpCloudCredentialForm onUpdate={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('API Username'), { target: { value: 'api-user' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(mocks.createCredential).toHaveBeenCalledWith({
        provider: 'upcloud',
        username: 'api-user',
        password: 'secret',
      })
    );
  });
  it('disconnects the UpCloud credential', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mocks.deleteCredential.mockResolvedValue(undefined);
    render(
      <UpCloudCredentialForm
        credential={
          {
            id: 'c',
            userId: 'u',
            provider: 'upcloud',
            connected: true,
            createdAt: '2026-01-01',
            validation: undefined,
          } as never
        }
        onUpdate={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect UpCloud account' }));
    await waitFor(() => expect(mocks.deleteCredential).toHaveBeenCalledWith('upcloud'));
  });
});

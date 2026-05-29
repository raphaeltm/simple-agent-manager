import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authState: { isAuthenticated: true, isLoading: false },
  approveDeviceCode: vi.fn(),
  signInSocial: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => mocks.authState,
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  approveDeviceCode: mocks.approveDeviceCode,
}));

vi.mock('../../../src/lib/auth', () => ({
  authClient: { signIn: { social: mocks.signInSocial } },
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: mocks.toastSuccess, error: vi.fn() }),
}));

import { DeviceAuth } from '../../../src/pages/DeviceAuth';

function renderDevice(path = '/device?code=ABCD-1234') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/device" element={<DeviceAuth />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('DeviceAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authState = { isAuthenticated: true, isLoading: false };
    mocks.approveDeviceCode.mockResolvedValue({ success: true });
  });

  it('prefills the user code from the query string', () => {
    renderDevice('/device?code=WXYZ-9876');

    expect(screen.getByDisplayValue('WXYZ-9876')).toBeInTheDocument();
  });

  it('approves the code for an authenticated user', async () => {
    renderDevice();

    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));

    await waitFor(() => expect(mocks.approveDeviceCode).toHaveBeenCalledWith('ABCD-1234'));
    expect(await screen.findByText('CLI authorized')).toBeInTheDocument();
  });

  it('redirects unauthenticated users to GitHub login preserving the code', async () => {
    mocks.authState = { isAuthenticated: false, isLoading: false };
    renderDevice('/device?code=LMNO-2222');

    fireEvent.click(screen.getByRole('button', { name: 'Log in to approve' }));

    await waitFor(() => expect(mocks.signInSocial).toHaveBeenCalledWith({
      provider: 'github',
      callbackURL: 'http://localhost:3000/device?code=LMNO-2222',
    }));
  });
});

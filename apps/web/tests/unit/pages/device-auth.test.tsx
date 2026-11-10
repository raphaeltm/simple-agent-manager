import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authState: { isAuthenticated: true, isLoading: false },
  approveDeviceCode: vi.fn(),
  signInSocial: vi.fn(),
  sendSignInCode: vi.fn(),
  signInWithEmailCode: vi.fn(),
  loginProviders: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('../../../src/lib/api/setup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/setup')>()),
  fetchLoginProviders: mocks.loginProviders,
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
  sendSignInCode: mocks.sendSignInCode,
  signInWithEmailCode: mocks.signInWithEmailCode,
}));

vi.mock('../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: mocks.toastSuccess, error: vi.fn() }),
}));

import { DeviceAuth } from '../../../src/pages/DeviceAuth';

/** The login-provider lookup is a TanStack query, so every render needs a fresh client. */
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

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
    mocks.loginProviders.mockResolvedValue({
      github: true,
      google: false,
      gitlab: false,
      email: false,
    });
    window.sessionStorage.clear();
    window.localStorage.clear();
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

    fireEvent.click(await screen.findByRole('button', { name: 'Log in with GitHub' }));

    await waitFor(() =>
      expect(mocks.signInSocial).toHaveBeenCalledWith({
        provider: 'github',
        callbackURL: 'http://localhost:3000/device?code=LMNO-2222',
      })
    );
  });

  it('shows a neutral pending state, not a guessed GitHub button, until providers load', async () => {
    mocks.authState = { isAuthenticated: false, isLoading: false };
    mocks.loginProviders.mockReturnValue(new Promise(() => {}));
    renderDevice();

    expect(screen.getByDisplayValue('ABCD-1234')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading sign-in options' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Log in with GitHub/ })).not.toBeInTheDocument();
  });

  it('lets an email-only owner sign in by code and comes back to the same code', async () => {
    // An installer instance with no OAuth app: email is the only way in.
    mocks.authState = { isAuthenticated: false, isLoading: false };
    mocks.loginProviders.mockResolvedValue({
      github: false,
      google: false,
      gitlab: false,
      email: true,
    });
    mocks.sendSignInCode.mockResolvedValue(undefined);
    mocks.signInWithEmailCode.mockResolvedValue(undefined);
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, origin: 'http://localhost' });
    renderDevice();

    const emailField = await screen.findByPlaceholderText('you@example.com');
    expect(screen.queryByRole('button', { name: /Log in with GitHub/ })).not.toBeInTheDocument();
    fireEvent.change(emailField, { target: { value: 'owner@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Email me a sign-in code/ }));
    fireEvent.change(await screen.findByPlaceholderText('123456'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Sign in/ }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/device?code=ABCD-1234'));
    expect(mocks.signInWithEmailCode).toHaveBeenCalledWith('owner@example.com', '123456');
    vi.unstubAllGlobals();
  });
});

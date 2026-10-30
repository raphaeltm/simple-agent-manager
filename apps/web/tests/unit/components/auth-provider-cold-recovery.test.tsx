import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '../../../src/components/AuthProvider';
import { ProtectedRoute } from '../../../src/components/ProtectedRoute';

const mocks = vi.hoisted(() => ({ session: vi.fn(), revoke: vi.fn(), cleanup: vi.fn() }));
vi.mock('../../../src/lib/auth', () => ({ useSession: mocks.session, signOut: vi.fn() }));
vi.mock('../../../src/hooks/useQueryCachePersistence', () => ({
  useQueryCachePersistence: () => false,
  discardPersistedQueryCache: vi.fn(),
}));
vi.mock('../../../src/lib/terminal-cleanup', () => ({
  broadcastAuthRevocation: mocks.revoke,
  cleanupTerminalSecrets: mocks.cleanup,
  initAuthBroadcastListener: vi.fn(),
  resetAuthRevoked: vi.fn(),
  teardownAuthBroadcastListener: vi.fn(),
}));
const authenticated = {
  user: { id: 'user-a', name: 'A', email: 'a@example.test', role: 'user', status: 'active' },
};
function tree() {
  return (
    <MemoryRouter initialEntries={['/private']}>
      <AuthProvider>
        <Routes>
          <Route path="/private" element={<ProtectedRoute>Private content</ProtectedRoute>} />
          <Route path="/" element={<div>Public content</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}
beforeEach(() => vi.clearAllMocks());

it('does not revoke other tabs when a cold verification failure later recovers', async () => {
  mocks.session.mockReturnValue({ data: null, isPending: false, error: new Error('Unavailable') });
  const view = render(tree());
  expect(screen.getByRole('alert')).toHaveTextContent('Could not verify your session');
  mocks.session.mockReturnValue({ data: authenticated, isPending: false, error: null });
  view.rerender(tree());
  await screen.findByText('Private content');
  expect(mocks.revoke).not.toHaveBeenCalled();
  expect(mocks.cleanup).not.toHaveBeenCalled();
});

it('keeps verification progress visible during a cold retry without exposing private content', async () => {
  mocks.session.mockReturnValue({ data: null, isPending: false, error: new Error('Unavailable') });
  const view = render(tree());
  expect(screen.getByRole('alert')).toBeInTheDocument();
  mocks.session.mockReturnValue({ data: null, isPending: true, error: null });
  view.rerender(tree());
  expect(screen.getByRole('status', { name: 'Verifying your session' })).toBeInTheDocument();
  expect(screen.queryByText('Private content')).not.toBeInTheDocument();
});

it('still revokes and clears terminal state after confirmed signout or account switch', async () => {
  mocks.session.mockReturnValue({ data: authenticated, isPending: false, error: null });
  const view = render(tree());
  await screen.findByText('Private content');
  mocks.session.mockReturnValue({
    data: { user: { ...authenticated.user, id: 'user-b' } },
    isPending: false,
    error: null,
  });
  view.rerender(tree());
  await waitFor(() => expect(mocks.revoke).toHaveBeenCalledTimes(1));
  mocks.session.mockReturnValue({ data: null, isPending: false, error: null });
  view.rerender(tree());
  await waitFor(() => expect(mocks.revoke).toHaveBeenCalledTimes(2));
  expect(mocks.cleanup).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Private content')).not.toBeInTheDocument();
});

function VerificationState() {
  const { sessionError } = useAuth();
  return sessionError ? <div role="alert">{sessionError}</div> : <div>Signed out</div>;
}

it('shows the retry error if verification fails after a confirmed signed-out state', () => {
  mocks.session.mockReturnValue({ data: null, isPending: false, error: null });
  const view = render(
    <AuthProvider>
      <VerificationState />
    </AuthProvider>
  );
  expect(screen.getByText('Signed out')).toBeInTheDocument();
  mocks.session.mockReturnValue({ data: null, isPending: true, error: null });
  view.rerender(
    <AuthProvider>
      <VerificationState />
    </AuthProvider>
  );
  expect(screen.getByRole('status', { name: 'Verifying your session' })).toBeInTheDocument();
  mocks.session.mockReturnValue({ data: null, isPending: false, error: new Error('Unavailable') });
  view.rerender(
    <AuthProvider>
      <VerificationState />
    </AuthProvider>
  );
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Session verification is temporarily unavailable'
  );
  expect(mocks.revoke).not.toHaveBeenCalled();
});

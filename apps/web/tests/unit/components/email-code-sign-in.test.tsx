import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { EmailCodeSignIn } from '../../../src/components/EmailCodeSignIn';

const auth = vi.hoisted(() => ({ send: vi.fn(), signIn: vi.fn() }));
vi.mock('../../../src/lib/auth', () => ({
  sendSignInCode: auth.send,
  signInWithEmailCode: auth.signIn,
}));

beforeEach(() => {
  window.sessionStorage.clear();
  auth.send.mockReset();
  auth.signIn.mockReset();
  auth.send.mockResolvedValue(undefined);
  auth.signIn.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

async function requestCode(address: string) {
  fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
    target: { value: address },
  });
  fireEvent.click(screen.getByRole('button', { name: /Email me a sign-in code/ }));
  await screen.findByPlaceholderText('123456');
}

// A phone browser can reload the tab while the visitor reads the code in their mail app.
it('comes back to the code step for the same address after the page reloads', async () => {
  const first = render(<EmailCodeSignIn primary onSignedIn={vi.fn()} />);
  await requestCode('Owner@Example.com');
  first.unmount();

  const onSignedIn = vi.fn();
  render(<EmailCodeSignIn primary onSignedIn={onSignedIn} />);
  // Liveness and the restored state: the code field, for the address the code went to.
  expect(screen.getByPlaceholderText('123456')).toBeInTheDocument();
  expect(screen.getByText('owner@example.com')).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: /^Sign in/ }));
  await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  expect(auth.signIn).toHaveBeenCalledWith('owner@example.com', '123456');
  // Signed in: nothing is left to restore.
  expect(window.sessionStorage.length).toBe(0);
});

it('starts from the address step once the code has expired', async () => {
  const first = render(<EmailCodeSignIn primary onSignedIn={vi.fn()} />);
  await requestCode('owner@example.com');
  first.unmount();

  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000);
  render(<EmailCodeSignIn primary onSignedIn={vi.fn()} />);
  expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
  expect(screen.queryByPlaceholderText('123456')).not.toBeInTheDocument();
});

it('forgets the address when the visitor chooses a different one', async () => {
  const first = render(<EmailCodeSignIn primary onSignedIn={vi.fn()} />);
  await requestCode('owner@example.com');
  fireEvent.click(screen.getByRole('button', { name: 'Use a different email' }));
  first.unmount();

  render(<EmailCodeSignIn primary onSignedIn={vi.fn()} />);
  expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
});

it('sends the code once on arrival from setup, even when React mounts twice', async () => {
  render(
    <StrictMode>
      <EmailCodeSignIn initialEmail="owner@example.com" sendOnMount primary onSignedIn={vi.fn()} />
    </StrictMode>
  );
  await screen.findByPlaceholderText('123456');
  expect(auth.send).toHaveBeenCalledTimes(1);
  expect(auth.send).toHaveBeenCalledWith('owner@example.com');
});

it('does not send another code on arrival when one is already on its way', async () => {
  const first = render(<EmailCodeSignIn primary onSignedIn={vi.fn()} />);
  await requestCode('owner@example.com');
  first.unmount();
  auth.send.mockClear();

  render(
    <EmailCodeSignIn initialEmail="owner@example.com" sendOnMount primary onSignedIn={vi.fn()} />
  );
  expect(screen.getByPlaceholderText('123456')).toBeInTheDocument();
  expect(auth.send).not.toHaveBeenCalled();
});

it('sends the owner a code on arrival from setup even if this tab had a code for another address', async () => {
  const first = render(<EmailCodeSignIn primary onSignedIn={vi.fn()} />);
  await requestCode('someone-else@example.com');
  first.unmount();
  auth.send.mockClear();

  render(
    <EmailCodeSignIn initialEmail="owner@example.com" sendOnMount primary onSignedIn={vi.fn()} />
  );
  await waitFor(() => expect(auth.send).toHaveBeenCalledWith('owner@example.com'));
  expect(screen.getByText('owner@example.com')).toBeInTheDocument();
});

it('keeps the address fixed while a new code is being sent', async () => {
  render(<EmailCodeSignIn primary onSignedIn={vi.fn()} />);
  await requestCode('owner@example.com');
  let finishResend: () => void = () => {};
  auth.send.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishResend = resolve;
      })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send a new code' }));
  // Mid-resend: switching address would ask for a code that was never requested.
  expect(screen.getByRole('button', { name: 'Use a different email' })).toBeDisabled();
  finishResend();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Use a different email' })).toBeEnabled()
  );
});

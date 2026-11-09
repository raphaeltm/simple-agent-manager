import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { EmailCodeSignIn } from '../../../src/components/EmailCodeSignIn';

const auth = vi.hoisted(() => ({ send: vi.fn(), signIn: vi.fn() }));
vi.mock('../../../src/lib/auth', () => ({
  sendSignInCode: auth.send,
  signInWithEmailCode: auth.signIn,
}));

beforeEach(() => {
  window.sessionStorage.clear();
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

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginSheet } from '../../../../src/components/trial/LoginSheet';

// useIsMobile is a side-effecting hook; stub it so we can control viewport.
vi.mock('../../../../src/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

describe('LoginSheet', () => {
  beforeEach(() => {
    // jsdom doesn't implement window.location.origin assignments; it's read-only
    // in recent jsdom but we only read it — it defaults to "http://localhost".
  });

  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <LoginSheet isOpen={false} onClose={() => {}} trialId="trial-1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders dialog with title when open', () => {
    render(<LoginSheet isOpen onClose={() => {}} trialId="trial-1" />);
    expect(screen.getByRole('dialog', { name: /sign in to continue/i })).toBeInTheDocument();
    expect(screen.getByTestId('trial-login-github')).toBeInTheDocument();
  });

  it('builds the claim return URL and exposes it on the CTA', () => {
    render(<LoginSheet isOpen onClose={() => {}} trialId="trial-1" />);
    const cta = screen.getByTestId('trial-login-github');
    expect(cta.getAttribute('data-return-to')).toMatch(
      /^http:\/\/localhost(:\d+)?\/try\/trial-1\?claim=1$/,
    );
  });

  it('url-encodes the trial id', () => {
    render(<LoginSheet isOpen onClose={() => {}} trialId="weird id/with=chars" />);
    const cta = screen.getByTestId('trial-login-github');
    expect(cta.getAttribute('data-return-to')).toContain(
      encodeURIComponent('weird id/with=chars'),
    );
  });

  it('invokes onSignIn override with the constructed return URL', async () => {
    const onSignIn = vi.fn().mockResolvedValue(undefined);
    render(
      <LoginSheet isOpen onClose={() => {}} trialId="trial-1" onSignIn={onSignIn} />,
    );

    fireEvent.click(screen.getByTestId('trial-login-github'));
    await waitFor(() => expect(onSignIn).toHaveBeenCalledTimes(1));
    expect(onSignIn).toHaveBeenCalledWith(
      expect.stringMatching(/\/try\/trial-1\?claim=1$/),
    );
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<LoginSheet isOpen onClose={onClose} trialId="trial-1" />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<LoginSheet isOpen onClose={onClose} trialId="trial-1" />);
    fireEvent.click(screen.getByTestId('trial-login-sheet-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the close button is pressed', () => {
    const onClose = vi.fn();
    render(<LoginSheet isOpen onClose={onClose} trialId="trial-1" />);
    fireEvent.click(screen.getByTestId('trial-login-sheet-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('focuses the primary CTA on open for keyboard users', async () => {
    render(<LoginSheet isOpen onClose={() => {}} trialId="trial-1" />);
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('trial-login-github'));
    });
  });

  it('locks body scroll while open and releases on close', () => {
    const { rerender } = render(
      <LoginSheet isOpen onClose={() => {}} trialId="trial-1" />,
    );
    expect(document.body.style.overflow).toBe('hidden');

    rerender(<LoginSheet isOpen={false} onClose={() => {}} trialId="trial-1" />);
    expect(document.body.style.overflow).toBe('');
  });

  it('traps focus between the primary CTA and close button', async () => {
    render(<LoginSheet isOpen onClose={() => {}} trialId="trial-1" />);
    const primary = screen.getByTestId('trial-login-github');
    const close = screen.getByTestId('trial-login-sheet-close');

    await waitFor(() => expect(document.activeElement).toBe(primary));

    // Shift+Tab from primary → close
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);

    // Tab from close → primary
    close.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(primary);
  });
});

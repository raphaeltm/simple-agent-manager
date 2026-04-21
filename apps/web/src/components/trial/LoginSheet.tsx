/**
 * LoginSheet — bottom-sheet / modal that gates the first chat message behind
 * GitHub sign-in during the trial onboarding flow.
 *
 * Mobile (≤767px): slides up from the bottom of the viewport.
 * Desktop: centered modal overlay.
 *
 * The GitHub CTA uses BetterAuth's `signIn.social` with a `callbackURL` that
 * resolves to `/try/:trialId?claim=1` on the app origin, so after OAuth the
 * visitor lands back on TryDiscovery with the claim query param set —
 * triggering {@link useTrialClaim}.
 *
 * Accessibility:
 * - `role="dialog" aria-modal="true"` announces the gate
 * - Focus trap cycles between primary CTA and close button
 * - Esc closes
 * - Click-outside (backdrop) closes
 * - `prefers-reduced-motion` disables the slide-up animation
 */
import { useEffect, useRef } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import { authClient } from '../../lib/auth';

interface LoginSheetProps {
  isOpen: boolean;
  onClose: () => void;
  /** The trial ID used to build the `?claim=1` return-to URL. */
  trialId: string;
  /**
   * Optional override for the OAuth kick-off. Exposed for testing so we can
   * assert the callbackURL without executing a real redirect.
   */
  onSignIn?: (returnTo: string) => void | Promise<void>;
}

async function defaultSignIn(returnTo: string): Promise<void> {
  await authClient.signIn.social({
    provider: 'github',
    callbackURL: returnTo,
  });
}

export function LoginSheet({ isOpen, onClose, trialId, onSignIn }: LoginSheetProps) {
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLDivElement>(null);
  const primaryCtaRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Esc to close + focus management.
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      // Focus trap: cycle between primary CTA and close button on Tab.
      if (e.key === 'Tab') {
        const primary = primaryCtaRef.current;
        const close = closeButtonRef.current;
        if (!primary || !close) return;
        if (e.shiftKey && document.activeElement === primary) {
          e.preventDefault();
          close.focus();
        } else if (!e.shiftKey && document.activeElement === close) {
          e.preventDefault();
          primary.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    // Initial focus on the primary CTA so keyboard + screen-reader users land
    // on the main action, not the close button.
    primaryCtaRef.current?.focus();

    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Lock body scroll while open (matches Dialog primitive behavior).
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const returnTo = `${window.location.origin}/try/${encodeURIComponent(trialId)}?claim=1`;

  const handleSignIn = async () => {
    try {
      if (onSignIn) {
        await onSignIn(returnTo);
      } else {
        await defaultSignIn(returnTo);
      }
    } catch (err) {
      // Surface error via console so it shows up in bug reports; the sheet
      // stays open so the user can retry.
      // eslint-disable-next-line no-console -- user-visible failure path
      console.error('Trial LoginSheet: GitHub sign-in failed', err);
    }
  };

  const panelBase =
    'fixed bg-surface border border-border-default shadow-overlay flex flex-col';
  const panelLayout = isMobile
    ? // Bottom sheet on mobile — slides up from the bottom edge.
      'left-0 right-0 bottom-0 rounded-t-2xl px-5 pt-4 pb-6 max-h-[92dvh] animate-[sam-player-slide-in_180ms_ease-out]'
    : // Centered modal on desktop.
      'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-2xl px-6 py-6 w-full max-w-md';

  return (
    <div
      className="fixed inset-0 z-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trial-login-sheet-title"
      data-testid="trial-login-sheet"
    >
      {/* Backdrop — click to dismiss. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- backdrop; Esc handler above */}
      <div
        className="absolute inset-0 bg-overlay"
        data-testid="trial-login-sheet-backdrop"
        onClick={onClose}
      />
      <div ref={panelRef} className={`${panelBase} ${panelLayout}`}>
        {/* Drag-indicator bar on mobile — purely decorative. */}
        {isMobile && (
          <div
            aria-hidden="true"
            className="mx-auto mb-3 h-1 w-10 rounded-full bg-border-default"
          />
        )}
        <div className="flex items-start justify-between gap-4 mb-3">
          <h2 id="trial-login-sheet-title" className="text-lg font-semibold text-fg-primary">
            Sign in to continue
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="trial-login-sheet-close"
            className="
              flex items-center justify-center
              min-h-11 min-w-11 -m-2 rounded-lg
              text-fg-muted hover:text-fg-primary hover:bg-surface-hover
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent
              transition-colors
            "
          >
            {isMobile ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M6 18L18 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        </div>

        <p className="text-sm text-fg-muted mb-5">
          We&rsquo;ll save this trial to your account so you can keep exploring.
        </p>

        <button
          ref={primaryCtaRef}
          type="button"
          onClick={handleSignIn}
          data-testid="trial-login-github"
          data-return-to={returnTo}
          className="
            inline-flex items-center justify-center gap-2
            min-h-14 px-5 rounded-lg
            bg-fg-default text-surface font-semibold
            hover:opacity-90
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
            transition-opacity
          "
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.92.58.11.79-.25.79-.56v-2.05c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.27-1.68-1.27-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.25 3.33.95.1-.74.4-1.25.72-1.53-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.17 1.18A11 11 0 0112 6.8c.98.01 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.41-5.26 5.69.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0023.5 12C23.5 5.73 18.27.5 12 .5z" />
          </svg>
          Continue with GitHub
        </button>
      </div>
    </div>
  );
}

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { useSetupStatus } from '../../hooks/useSetupStatus';
import { useAuth } from '../AuthProvider';

interface OnboardingContextValue {
  /** True when setup is incomplete and the user hasn't dismissed */
  needsOnboarding: boolean;
  /** True when the full-screen overlay should be visible */
  showOverlay: boolean;
  /** Open the onboarding overlay (resume or restart) */
  openOnboarding: () => void;
  /** Dismiss the overlay — persists to localStorage */
  dismissOnboarding: () => void;
  /** Still loading the initial setup check */
  loading: boolean;
}

const OnboardingContext = createContext<OnboardingContextValue>({
  needsOnboarding: false,
  showOverlay: false,
  openOnboarding: () => {},
  dismissOnboarding: () => {},
  loading: true,
});

export function useOnboarding() {
  return useContext(OnboardingContext);
}

function getStorageKey(userId: string): string {
  return `sam-onboarding-wizard-dismissed-${userId}`;
}

/**
 * Whether the current URL forces the onboarding overlay open (`?onboarding`).
 * Read synchronously so the overlay can render on the first paint instead of
 * waiting on the background credential-status fetch.
 */
function isOnboardingForced(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('onboarding');
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;

  // Shared with `ChoosePathWizard`, which `AppShell` mounts alongside this provider
  // on every authenticated page. Both used to issue the same three requests
  // independently; now they read one cache entry each.
  const queryScope = useQueryScope();
  const { isComplete: setupComplete, loading } = useSetupStatus(queryScope);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    // ?onboarding forces the overlay open, overriding a persisted dismissal
    // (without clearing the stored flag — see openOnboarding / checkStatus).
    if (isOnboardingForced()) return false;
    if (!userId) return false;
    return localStorage.getItem(getStorageKey(userId)) === 'true';
  });
  // Open synchronously when forced so the overlay paints immediately rather
  // than waiting on the background credential-status fetch.
  const [overlayOpen, setOverlayOpen] = useState<boolean>(() => isOnboardingForced());

  // Overlay policy, previously interleaved with the fetch above. It must run once
  // the status is known, and must not re-open an overlay the user dismissed.
  useEffect(() => {
    if (loading) return;

    // ?onboarding forces the overlay open (for testing / re-running) and resets the
    // dismissed flag so a user who previously dismissed can always re-view it. The
    // overlay is already open synchronously from initial state in that case; this
    // keeps it open now that the status has resolved.
    if (isOnboardingForced()) {
      setOverlayOpen(true);
      setDismissed(false);
      return;
    }

    if (setupComplete) {
      setDismissed(true);
      if (userId) localStorage.setItem(getStorageKey(userId), 'true');
      return;
    }

    if (!localStorage.getItem(getStorageKey(userId ?? ''))) {
      // First visit with incomplete setup — auto-show the overlay.
      setOverlayOpen(true);
    }
  }, [loading, setupComplete, userId]);

  const needsOnboarding = !setupComplete && !loading;

  const openOnboarding = useCallback(() => {
    setOverlayOpen(true);
    setDismissed(false);
    // Don't clear localStorage — just force it open for this session
  }, []);

  const dismissOnboarding = useCallback(() => {
    setOverlayOpen(false);
    setDismissed(true);
    if (userId) localStorage.setItem(getStorageKey(userId), 'true');
  }, [userId]);

  // Show overlay when explicitly opened (forced via ?onboarding, the "Complete
  // Setup" button, or auto-shown on first visit) and not dismissed. Crucially
  // this is NOT gated on `loading`: the overlay's visibility must not wait on
  // the background credential-status fetch (which can take several seconds).
  const showOverlay = overlayOpen && !dismissed;

  const value = useMemo<OnboardingContextValue>(
    () => ({ needsOnboarding, showOverlay, openOnboarding, dismissOnboarding, loading }),
    [needsOnboarding, showOverlay, openOnboarding, dismissOnboarding, loading]
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

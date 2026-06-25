import { createContext, type ReactNode,useCallback, useContext, useEffect, useState } from 'react';

import {
  listAgentCredentials,
  listCredentials,
  listGitHubInstallations,
} from '../../lib/api';
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

// ---------------------------------------------------------------------------
// Extracted hook: fetches credential / installation / agent status
// ---------------------------------------------------------------------------

interface OnboardingStatus {
  loading: boolean;
  setupComplete: boolean;
}

function useOnboardingStatus(userId: string | undefined): OnboardingStatus {
  const [loading, setLoading] = useState(true);
  const [setupComplete, setSetupComplete] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function checkStatus() {
      try {
        const [credResult, installResult, agentResult] = await Promise.allSettled([
          listCredentials(),
          listGitHubInstallations(),
          listAgentCredentials(),
        ]);
        if (controller.signal.aborted) return;

        const credentials = credResult.status === 'fulfilled' ? credResult.value : [];
        const installations = installResult.status === 'fulfilled' ? installResult.value : [];
        const agentCreds = agentResult.status === 'fulfilled' ? agentResult.value : { credentials: [] };

        const hasCloud = credentials.some(
          (c) => c.provider === 'hetzner' || c.provider === 'scaleway'
        );
        const hasGitHub = installations.length > 0;
        const hasAgent = agentCreds.credentials.some((c) => c.isActive);

        // Onboarding is "complete" only when the user has configured their OWN
        // agent, cloud, and GitHub. Platform availability (SAM-managed AI tokens /
        // SAM-managed infrastructure) must NOT auto-complete onboarding — choosing
        // to route through SAM is itself a decision the user makes inside onboarding.
        setSetupComplete(hasAgent && hasCloud && hasGitHub);
      } catch {
        // Non-critical
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    checkStatus();
    return () => controller.abort();
  }, [userId]);

  return { loading, setupComplete };
}

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;

  // Network fetch for setup status (separated concern)
  const { loading, setupComplete } = useOnboardingStatus(userId);

  // Dismissal / overlay state
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

  // Derive overlay decisions from fetch results (separated from the fetch itself)
  useEffect(() => {
    if (loading) return;
    if (isOnboardingForced()) {
      setOverlayOpen(true);
      setDismissed(false);
    } else if (setupComplete) {
      setDismissed(true);
      if (userId) localStorage.setItem(getStorageKey(userId), 'true');
    } else if (!localStorage.getItem(getStorageKey(userId ?? ''))) {
      // First visit with incomplete setup — auto-show the overlay
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

  return (
    <OnboardingContext.Provider
      value={{ needsOnboarding, showOverlay, openOnboarding, dismissOnboarding, loading }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}

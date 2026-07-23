import { hasByocComputeCredential } from '@simple-agent-manager/shared';
import { createContext, type ReactNode,useCallback, useContext, useEffect, useMemo, useState } from 'react';

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

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;

  const [loading, setLoading] = useState(true);
  const [setupComplete, setSetupComplete] = useState(false);
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

        const hasCloud = hasByocComputeCredential(credentials);
        const hasGitHub = installations.length > 0;
        const hasAgent = agentCreds.credentials.some((c) => c.isActive);

        // Onboarding is "complete" only when the user has configured their OWN
        // agent, cloud, and GitHub. Platform availability (SAM-managed AI tokens /
        // SAM-managed infrastructure) must NOT auto-complete onboarding — choosing
        // to route through SAM is itself a decision the user makes inside onboarding.
        const isComplete = hasAgent && hasCloud && hasGitHub;
        setSetupComplete(isComplete);

        // ?onboarding URL param forces the overlay open (for testing / re-running).
        // Reset the dismissed flag so users who previously dismissed can always
        // re-view onboarding on demand. (The overlay is already open synchronously
        // from initial state in this case; this keeps it open after the fetch.)
        if (isOnboardingForced()) {
          setOverlayOpen(true);
          setDismissed(false);
        } else if (isComplete) {
          setDismissed(true);
          if (userId) localStorage.setItem(getStorageKey(userId), 'true');
        } else if (!localStorage.getItem(getStorageKey(userId ?? ''))) {
          // First visit with incomplete setup — auto-show the overlay
          setOverlayOpen(true);
        }
      } catch {
        // Non-critical
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    checkStatus();
    return () => controller.abort();
  }, [userId]);

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

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

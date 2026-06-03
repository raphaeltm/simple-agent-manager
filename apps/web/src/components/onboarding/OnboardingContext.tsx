import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import {
  getTrialStatus,
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

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;

  const [loading, setLoading] = useState(true);
  const [setupComplete, setSetupComplete] = useState(false);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (!userId) return false;
    return localStorage.getItem(getStorageKey(userId)) === 'true';
  });
  const [overlayOpen, setOverlayOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function checkStatus() {
      try {
        const [credResult, installResult, agentResult, trialResult] = await Promise.allSettled([
          listCredentials(),
          listGitHubInstallations(),
          listAgentCredentials(),
          getTrialStatus(),
        ]);
        if (controller.signal.aborted) return;

        const credentials = credResult.status === 'fulfilled' ? credResult.value : [];
        const installations = installResult.status === 'fulfilled' ? installResult.value : [];
        const agentCreds = agentResult.status === 'fulfilled' ? agentResult.value : { credentials: [] };
        const trialStatus = trialResult.status === 'fulfilled' ? trialResult.value : null;

        const hasCloud = credentials.some(
          (c) => c.provider === 'hetzner' || c.provider === 'scaleway'
        );
        const hasGitHub = installations.length > 0;
        const hasAgent = agentCreds.credentials.some((c) => c.isActive);
        const trialAvailable = trialStatus?.available ?? false;

        const isComplete = (hasAgent || trialAvailable) && (hasCloud || trialAvailable) && hasGitHub;
        setSetupComplete(isComplete);

        if (isComplete) {
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
    // Clear dismissed so it opens fresh
    if (userId) localStorage.removeItem(getStorageKey(userId));
    setDismissed(false);
  }, [userId]);

  const dismissOnboarding = useCallback(() => {
    setOverlayOpen(false);
    setDismissed(true);
    if (userId) localStorage.setItem(getStorageKey(userId), 'true');
  }, [userId]);

  const showOverlay = overlayOpen && !dismissed && !setupComplete && !loading;

  return (
    <OnboardingContext.Provider
      value={{ needsOnboarding, showOverlay, openOnboarding, dismissOnboarding, loading }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@simple-agent-manager/ui';
import { listCredentials, listGitHubInstallations, listAgentCredentials } from '../../lib/api';
import { useAuth } from '../AuthProvider';
import { StepAgentKey } from './StepAgentKey';
import { StepCloudProvider } from './StepCloudProvider';
import { StepGitHub } from './StepGitHub';
import { StepHowItWorks } from './StepHowItWorks';

type WizardStep = 'agent' | 'cloud' | 'github' | 'how-it-works';

const STEPS: { id: WizardStep; label: string }[] = [
  { id: 'agent', label: 'AI Agent' },
  { id: 'cloud', label: 'Cloud' },
  { id: 'github', label: 'GitHub' },
  { id: 'how-it-works', label: 'How it works' },
];

function getStorageKey(userId: string): string {
  return `sam-onboarding-wizard-dismissed-${userId}`;
}

interface SetupStatus {
  hasAgent: boolean;
  hasCloud: boolean;
  hasGitHub: boolean;
}

export function OnboardingWizard() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [currentStep, setCurrentStep] = useState<WizardStep>('agent');
  const [status, setStatus] = useState<SetupStatus>({ hasAgent: false, hasCloud: false, hasGitHub: false });

  const userId = user?.id;

  // Check dismissal state
  useEffect(() => {
    if (!userId) return;
    const stored = localStorage.getItem(getStorageKey(userId));
    setDismissed(stored === 'true');
  }, [userId]);

  // Check setup status
  const checkStatus = useCallback(async () => {
    try {
      const [credentials, installations, agentCreds] = await Promise.all([
        listCredentials(),
        listGitHubInstallations(),
        listAgentCredentials(),
      ]);

      const hasCloud = credentials.some((c) => c.provider === 'hetzner' || c.provider === 'scaleway');
      const hasGitHub = installations.length > 0;
      const hasAgent = agentCreds.credentials.some((c) => c.isActive);

      setStatus({ hasAgent, hasCloud, hasGitHub });

      // If all complete, auto-dismiss
      if (hasAgent && hasCloud && hasGitHub) {
        setDismissed(true);
        if (userId) localStorage.setItem(getStorageKey(userId), 'true');
        return;
      }

      // Start at the first incomplete step
      if (!hasAgent) setCurrentStep('agent');
      else if (!hasCloud) setCurrentStep('cloud');
      else if (!hasGitHub) setCurrentStep('github');
      else setCurrentStep('how-it-works');
    } catch {
      // Silently fail — onboarding is non-critical
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const handleDismiss = () => {
    if (userId) localStorage.setItem(getStorageKey(userId), 'true');
    setDismissed(true);
  };

  const advanceStep = (from: WizardStep) => {
    const idx = STEPS.findIndex((s) => s.id === from);
    const next = STEPS[idx + 1];
    if (next) {
      setCurrentStep(next.id);
    }
    // Refresh status after credential steps
    if (from !== 'how-it-works') {
      void checkStatus();
    }
  };

  const handleStepComplete = (step: WizardStep) => {
    if (step === 'how-it-works') {
      handleDismiss();
    } else {
      advanceStep(step);
    }
  };

  const handleStepSkip = (step: WizardStep) => {
    advanceStep(step);
  };

  if (loading || dismissed === null || dismissed) return null;

  const currentIdx = STEPS.findIndex((s) => s.id === currentStep);

  return (
    <div data-testid="onboarding-wizard" aria-label="Account setup">
    <Card className="p-0 mb-6 overflow-hidden">
      {/* Step indicator */}
      <div role="tablist" aria-label="Setup steps" className="flex border-b border-border-default">
        {STEPS.map((step, idx) => {
          const isActive = step.id === currentStep;
          const isPast = idx < currentIdx;
          const isStepComplete =
            (step.id === 'agent' && status.hasAgent) ||
            (step.id === 'cloud' && status.hasCloud) ||
            (step.id === 'github' && status.hasGitHub);

          return (
            <button
              key={step.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`onboarding-step-${step.id}`}
              onClick={() => setCurrentStep(step.id)}
              className={`flex-1 py-3 px-2 text-xs font-medium text-center border-none cursor-pointer transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                isActive
                  ? 'bg-surface text-accent border-b-2 border-b-accent'
                  : isPast || isStepComplete
                    ? 'bg-inset text-fg-muted'
                    : 'bg-inset text-fg-muted/50'
              }`}
            >
              {isStepComplete && <span className="mr-1 text-success" aria-hidden="true">{'\u2713'}</span>}
              {step.label}
            </button>
          );
        })}
      </div>

      {/* Dismiss link */}
      <div className="flex justify-end px-4 pt-2">
        <button
          type="button"
          onClick={handleDismiss}
          className="text-xs text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Don&apos;t show again
        </button>
      </div>

      {/* Step content */}
      <div className="p-4 pt-2" id={`onboarding-step-${currentStep}`} role="tabpanel">
        {currentStep === 'agent' && (
          <StepAgentKey
            isComplete={status.hasAgent}
            onComplete={() => handleStepComplete('agent')}
            onSkip={() => handleStepSkip('agent')}
          />
        )}
        {currentStep === 'cloud' && (
          <StepCloudProvider
            isComplete={status.hasCloud}
            onComplete={() => handleStepComplete('cloud')}
            onSkip={() => handleStepSkip('cloud')}
          />
        )}
        {currentStep === 'github' && (
          <StepGitHub
            isComplete={status.hasGitHub}
            onComplete={() => handleStepComplete('github')}
            onSkip={() => handleStepSkip('github')}
          />
        )}
        {currentStep === 'how-it-works' && (
          <StepHowItWorks onComplete={() => handleStepComplete('how-it-works')} />
        )}
      </div>
    </Card>
    </div>
  );
}

import { Button,Card } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { listCredentials, listGitHubInstallations, listWorkspaces } from '../lib/api';
import { useAuth } from './AuthProvider';

interface OnboardingStep {
  id: string;
  label: string;
  complete: boolean;
  path: string;
}

function getStorageKey(userId: string): string {
  return `sam-onboarding-dismissed-${userId}`;
}

export function OnboardingChecklist() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [steps, setSteps] = useState<OnboardingStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(true);

  const userId = user?.id;

  useEffect(() => {
    if (!userId) return;
    const stored = localStorage.getItem(getStorageKey(userId));
    setDismissed(stored === 'true');
  }, [userId]);

  const checkSetup = useCallback(async () => {
    try {
      const [credentials, installations, workspaces] = await Promise.all([
        listCredentials(),
        listGitHubInstallations(),
        listWorkspaces(),
      ]);

      const hasCloudProvider = credentials.some((c) => c.provider === 'hetzner' || c.provider === 'scaleway');
      const hasGitHubApp = installations.length > 0;
      const hasWorkspace = workspaces.length > 0;

      setSteps([
        {
          id: 'cloud-provider',
          label: 'Add a cloud provider API token',
          complete: hasCloudProvider,
          path: '/settings/cloud-provider',
        },
        {
          id: 'github',
          label: 'Install the GitHub App',
          complete: hasGitHubApp,
          path: '/settings/github',
        },
        {
          id: 'workspace',
          label: 'Create your first workspace',
          complete: hasWorkspace,
          path: '/workspaces/new',
        },
      ]);
    } catch {
      // Silently fail -- onboarding is non-critical
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkSetup();
  }, [checkSetup]);

  const handleDismiss = () => {
    if (userId) {
      localStorage.setItem(getStorageKey(userId), 'true');
    }
    setDismissed(true);
  };

  if (loading || dismissed) return null;

  const completedCount = steps.filter((s) => s.complete).length;
  const allComplete = completedCount === steps.length;

  if (allComplete) return null;

  return (
    <Card className="p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="m-0 text-base font-semibold text-fg-primary">
          Get Started
        </h3>
        <Button variant="ghost" size="sm" onClick={handleDismiss}>
          Dismiss
        </Button>
      </div>

      {/* Progress bar */}
      <div className="h-1 rounded-sm bg-border-default mb-3 overflow-hidden">
        <div
          className="h-full bg-accent rounded-sm transition-[width] duration-300 ease-in-out"
          style={{ width: `${(completedCount / steps.length) * 100}%` }}
          role="progressbar"
          aria-valuenow={completedCount}
          aria-valuemin={0}
          aria-valuemax={steps.length}
        />
      </div>

      <p className="m-0 mb-3 text-sm text-fg-muted">
        {completedCount} of {steps.length} steps completed
      </p>

      <ul className="list-none m-0 p-0 grid gap-2">
        {steps.map((step) => (
          <li key={step.id}>
            <button
              onClick={() => !step.complete && navigate(step.path)}
              disabled={step.complete}
              className={`flex items-center gap-2 w-full p-2 border-none rounded-sm text-left text-base ${
                step.complete
                  ? 'bg-transparent text-fg-muted cursor-default line-through'
                  : 'bg-inset text-fg-primary cursor-pointer no-underline'
              }`}
            >
              <span
                className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs ${
                  step.complete
                    ? 'bg-accent text-white border-none'
                    : 'bg-transparent border-2 border-border-default'
                }`}
              >
                {step.complete ? '\u2713' : ''}
              </span>
              {step.label}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

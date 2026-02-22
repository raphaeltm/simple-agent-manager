import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Button } from '@simple-agent-manager/ui';
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

      const hasHetznerToken = credentials.some((c) => c.provider === 'hetzner');
      const hasGitHubApp = installations.length > 0;
      const hasWorkspace = workspaces.length > 0;

      setSteps([
        {
          id: 'hetzner',
          label: 'Add your Hetzner Cloud API token',
          complete: hasHetznerToken,
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
      // Silently fail — onboarding is non-critical
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
    <Card style={{ padding: 'var(--sam-space-4)', marginBottom: 'var(--sam-space-6)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sam-space-3)' }}>
        <h3 style={{
          margin: 0,
          fontSize: 'var(--sam-type-card-title-size)',
          fontWeight: 'var(--sam-type-card-title-weight)' as unknown as number,
          color: 'var(--sam-color-fg-primary)',
        }}>
          Get Started
        </h3>
        <Button variant="ghost" size="sm" onClick={handleDismiss}>
          Dismiss
        </Button>
      </div>

      {/* Progress bar */}
      <div style={{
        height: 4,
        borderRadius: 2,
        background: 'var(--sam-color-border-default)',
        marginBottom: 'var(--sam-space-3)',
        overflow: 'hidden',
      }}>
        <div
          style={{
            height: '100%',
            width: `${(completedCount / steps.length) * 100}%`,
            background: 'var(--sam-color-accent)',
            borderRadius: 2,
            transition: 'width 0.3s ease',
          }}
          role="progressbar"
          aria-valuenow={completedCount}
          aria-valuemin={0}
          aria-valuemax={steps.length}
        />
      </div>

      <p style={{ margin: '0 0 var(--sam-space-3)', fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)' }}>
        {completedCount} of {steps.length} steps completed
      </p>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--sam-space-2)' }}>
        {steps.map((step) => (
          <li key={step.id}>
            <button
              onClick={() => !step.complete && navigate(step.path)}
              disabled={step.complete}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--sam-space-2)',
                width: '100%',
                padding: 'var(--sam-space-2)',
                border: 'none',
                borderRadius: 'var(--sam-radius-sm)',
                background: step.complete ? 'transparent' : 'var(--sam-color-bg-inset)',
                color: step.complete ? 'var(--sam-color-fg-muted)' : 'var(--sam-color-fg-primary)',
                cursor: step.complete ? 'default' : 'pointer',
                textDecoration: step.complete ? 'line-through' : 'none',
                textAlign: 'left',
                fontSize: 'var(--sam-type-body-size)',
              }}
            >
              <span style={{
                flexShrink: 0,
                width: 20,
                height: 20,
                borderRadius: '50%',
                border: step.complete ? 'none' : '2px solid var(--sam-color-border-default)',
                background: step.complete ? 'var(--sam-color-accent)' : 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'white',
                fontSize: '0.75rem',
              }}>
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

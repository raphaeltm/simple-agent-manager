import { useState } from 'react';
import { Button, Alert } from '@simple-agent-manager/ui';
import { getGitHubInstallUrl } from '../../lib/api';

interface StepGitHubProps {
  onComplete: () => void;
  onSkip: () => void;
  isComplete: boolean;
}

export function StepGitHub({ onComplete, onSkip, isComplete }: StepGitHubProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isComplete) {
    return (
      <div className="text-center py-6">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-success/10 mb-3">
          <span className="text-success text-xl">{'\u2713'}</span>
        </div>
        <p className="sam-type-body text-fg-primary font-medium m-0 mb-1">GitHub App installed</p>
        <p className="sam-type-caption text-fg-muted m-0">SAM can access your repositories.</p>
        <div className="mt-4">
          <Button variant="primary" size="md" onClick={onComplete}>Continue</Button>
        </div>
      </div>
    );
  }

  const handleInstall = async () => {
    setLoading(true);
    setError(null);
    try {
      const { url } = await getGitHubInstallUrl();
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get install URL');
      setLoading(false);
    }
  };

  return (
    <div>
      <h3 className="sam-type-section-heading text-fg-primary m-0 mb-1">Connect your code</h3>
      <p className="sam-type-body text-fg-muted m-0 mb-4">
        SAM needs access to your repositories to clone them into workspaces. Install the GitHub App to grant access.
      </p>

      {error && (
        <div className="mb-3">
          <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      <div className="border border-border-default rounded-md p-4 mb-4 bg-inset">
        <p className="sam-type-body text-fg-primary m-0 mb-2 font-medium">What this does:</p>
        <ul className="m-0 pl-5 text-sm text-fg-muted list-disc grid gap-1">
          <li>Lets SAM clone your repos into cloud workspaces</li>
          <li>Enables branch creation and PR management</li>
          <li>You choose which repos to grant access to</li>
        </ul>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onSkip}
          className="text-sm text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Skip this step
        </button>
        <Button
          variant="primary"
          size="md"
          onClick={handleInstall}
          disabled={loading}
        >
          {loading ? 'Redirecting...' : 'Install GitHub App'}
        </Button>
      </div>
    </div>
  );
}

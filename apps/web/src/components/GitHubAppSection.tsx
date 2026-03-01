import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listGitHubInstallations, getGitHubInstallUrl, listRepositories } from '../lib/api';
import { Button, Alert, Spinner } from '@simple-agent-manager/ui';
import type { GitHubInstallation } from '@simple-agent-manager/shared';

/**
 * GitHub App section for settings page.
 * Shows installation status, connected accounts, and accessible repositories.
 */
export function GitHubAppSection() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [repoCount, setRepoCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);

  const loadInstallations = useCallback(async () => {
    try {
      setError(null);
      const data = await listGitHubInstallations();
      setInstallations(data);

      // Load repo count if there are installations
      if (data.length > 0) {
        try {
          const repos = await listRepositories();
          setRepoCount(Array.isArray(repos) ? repos.length : 0);
        } catch {
          // Non-critical, don't show error
          setRepoCount(null);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load installations');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadInstallUrl = useCallback(async () => {
    try {
      const { url } = await getGitHubInstallUrl();
      setInstallUrl(url);
    } catch (err) {
      console.error('Failed to get install URL:', err);
    }
  }, []);

  useEffect(() => {
    loadInstallations();
    loadInstallUrl();
  }, [loadInstallations, loadInstallUrl]);

  // Show feedback message if redirected from GitHub App installation
  useEffect(() => {
    const status = searchParams.get('github_app');
    if (status === 'installed') {
      setShowSuccess(true);
    } else if (status === 'error') {
      const reason = searchParams.get('reason') || 'Unknown error';
      setError(`GitHub App installation failed: ${reason}`);
    }
    if (status) {
      // Clean up the URL params without triggering navigation
      const newParams = new URLSearchParams(searchParams);
      newParams.delete('github_app');
      newParams.delete('reason');
      setSearchParams(newParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const handleInstallClick = () => {
    if (installUrl) {
      window.location.href = installUrl;
    }
  };

  if (loading && installations.length === 0) {
    return (
      <div className="flex justify-center p-4">
        <Spinner size="md" />
      </div>
    );
  }

  if (error) {
    return <Alert variant="error">{error}</Alert>;
  }

  if (installations.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {showSuccess && (
          <Alert variant="info" onDismiss={() => setShowSuccess(false)}>
            GitHub App installation completed. It may take a moment for the installation to appear.
          </Alert>
        )}
        <p className="text-fg-muted">
          Install the GitHub App to access your repositories for workspace creation.
        </p>
        <div>
          <Button onClick={handleInstallClick} disabled={!installUrl}>
            <svg className="h-5 w-5 mr-2" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.167 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
            </svg>
            Install GitHub App
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {showSuccess && (
        <Alert variant="success" onDismiss={() => setShowSuccess(false)}>
          GitHub App installed successfully!
        </Alert>
      )}

      <div className="flex items-center justify-between p-4 bg-success-tint border border-success/30 rounded-md">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 bg-success-tint rounded-full flex items-center justify-center">
            <svg className="h-5 w-5 text-success-fg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p className="font-medium text-success-fg">Connected</p>
            <p className="text-sm text-fg-muted">
              {installations.length} account{installations.length > 1 ? 's' : ''}
              {repoCount !== null && ` \u00b7 ${repoCount} repositor${repoCount === 1 ? 'y' : 'ies'} accessible`}
            </p>
          </div>
        </div>
        <button
          onClick={handleInstallClick}
          className="py-1 px-3 text-sm text-accent bg-transparent border-none cursor-pointer"
        >
          Add More
        </button>
      </div>

      <div className="border border-border-default rounded-md overflow-hidden">
        {installations.map((inst, i) => (
          <div
            key={inst.id}
            className={`py-3 px-4 flex items-center justify-between ${i > 0 ? 'border-t border-border-default' : ''}`}
          >
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 bg-inset rounded-full flex items-center justify-center">
                {inst.accountType === 'organization' ? (
                  <svg className="h-4 w-4 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4 text-fg-muted" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.167 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
                  </svg>
                )}
              </div>
              <div>
                <p className="font-medium text-sm text-fg-primary">{inst.accountName}</p>
                <p className="text-xs text-fg-muted capitalize">{inst.accountType}</p>
              </div>
            </div>
            <span className="text-xs text-fg-muted">
              Installed {new Date(inst.createdAt).toLocaleDateString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

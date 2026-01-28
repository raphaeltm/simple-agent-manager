import { useState, useEffect, useCallback } from 'react';
import { listGitHubInstallations, getGitHubInstallUrl } from '../lib/api';
import type { GitHubInstallation } from '@simple-agent-manager/shared';

/**
 * GitHub App section for settings page.
 */
export function GitHubAppSection() {
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState<string | null>(null);

  const loadInstallations = useCallback(async () => {
    try {
      setError(null);
      const data = await listGitHubInstallations();
      setInstallations(data);
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

  const handleInstallClick = () => {
    if (installUrl) {
      window.location.href = installUrl;
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
        {error}
      </div>
    );
  }

  if (installations.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-gray-600">
          Install the GitHub App to access your repositories for workspace creation.
        </p>
        <button
          onClick={handleInstallClick}
          disabled={!installUrl}
          className="px-4 py-2 bg-gray-900 text-white rounded-md hover:bg-gray-800 disabled:opacity-50 flex items-center space-x-2"
        >
          <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.167 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
          </svg>
          <span>Install GitHub App</span>
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between p-4 bg-green-50 border border-green-200 rounded-lg">
        <div className="flex items-center space-x-3">
          <div className="h-10 w-10 bg-green-100 rounded-full flex items-center justify-center">
            <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <p className="font-medium text-green-900">Connected</p>
            <p className="text-sm text-green-700">
              {installations.length} installation{installations.length > 1 ? 's' : ''}
            </p>
          </div>
        </div>
        <button
          onClick={handleInstallClick}
          className="px-3 py-1 text-sm text-blue-600 hover:text-blue-800"
        >
          Add More
        </button>
      </div>

      <ul className="divide-y divide-gray-200 border border-gray-200 rounded-lg">
        {installations.map((inst) => (
          <li key={inst.id} className="p-3 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="h-8 w-8 bg-gray-100 rounded-full flex items-center justify-center">
                <svg className="h-4 w-4 text-gray-600" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.167 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
                </svg>
              </div>
              <div>
                <p className="font-medium text-sm">{inst.accountName}</p>
                <p className="text-xs text-gray-500 capitalize">{inst.accountType}</p>
              </div>
            </div>
            <span className="text-xs text-gray-400">
              {new Date(inst.createdAt).toLocaleDateString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

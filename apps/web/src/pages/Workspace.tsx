import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Terminal } from '@simple-agent-manager/terminal';
import { UserMenu } from '../components/UserMenu';
import { StatusBadge } from '../components/StatusBadge';
import { getWorkspace, getTerminalToken, stopWorkspace, restartWorkspace } from '../lib/api';
import type { WorkspaceResponse } from '@simple-agent-manager/shared';

/**
 * Workspace detail page with terminal access.
 */
export function Workspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [terminalLoading, setTerminalLoading] = useState(false);

  useEffect(() => {
    if (!id) return;

    const loadWorkspace = async () => {
      try {
        setError(null);
        const data = await getWorkspace(id);
        setWorkspace(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load workspace');
      } finally {
        setLoading(false);
      }
    };

    loadWorkspace();

    // Poll for updates if in transitional state
    const interval = setInterval(async () => {
      if (workspace?.status === 'creating' || workspace?.status === 'stopping') {
        try {
          const data = await getWorkspace(id);
          setWorkspace(data);
        } catch {
          // Ignore polling errors
        }
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [id, workspace?.status]);

  // Fetch terminal token and build WebSocket URL when workspace is running
  useEffect(() => {
    if (!id || !workspace || workspace.status !== 'running' || !workspace.url) {
      setWsUrl(null);
      return;
    }

    const fetchTerminalToken = async () => {
      if (!workspace.url) {
        setError('Workspace URL not available');
        return;
      }

      try {
        setTerminalLoading(true);
        const { token } = await getTerminalToken(id);

        // Build WebSocket URL from workspace URL
        const url = new URL(workspace.url);
        const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const terminalWsUrl = `${wsProtocol}//${url.host}/ws?token=${encodeURIComponent(token)}`;
        setWsUrl(terminalWsUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to get terminal token');
      } finally {
        setTerminalLoading(false);
      }
    };

    fetchTerminalToken();
  }, [id, workspace?.status, workspace?.url]);

  // Handle terminal activity - refresh workspace data to update shutdownDeadline
  const handleTerminalActivity = useCallback(() => {
    if (!id) return;
    // Refresh workspace to get updated shutdownDeadline
    getWorkspace(id)
      .then(setWorkspace)
      .catch(() => {
        // Ignore errors during activity refresh
      });
  }, [id]);

  const handleOpenTerminal = async () => {
    if (!workspace || !id) return;

    try {
      setActionLoading(true);
      const { token } = await getTerminalToken(id);

      // Open workspace URL with token
      if (workspace.url) {
        const terminalUrl = `${workspace.url}?token=${encodeURIComponent(token)}`;
        window.open(terminalUrl, '_blank');
      } else {
        setError('Workspace URL not available');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get terminal token');
    } finally {
      setActionLoading(false);
    }
  };

  const handleStop = async () => {
    if (!id) return;

    try {
      setActionLoading(true);
      await stopWorkspace(id);
      setWorkspace((prev) => prev ? { ...prev, status: 'stopping' } : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop workspace');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRestart = async () => {
    if (!id) return;

    try {
      setActionLoading(true);
      await restartWorkspace(id);
      setWorkspace((prev) => prev ? { ...prev, status: 'creating' } : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restart workspace');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error && !workspace) {
    return (
      <div className="min-h-screen bg-gray-50">
        <header className="bg-white shadow-sm">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <button
                onClick={() => navigate('/dashboard')}
                className="text-gray-600 hover:text-gray-900"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <h1 className="text-xl font-semibold text-gray-900">Workspace</h1>
            </div>
            <UserMenu />
          </div>
        </header>
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
            <p className="text-red-600">{error}</p>
            <button
              onClick={() => navigate('/dashboard')}
              className="mt-4 text-blue-600 hover:text-blue-800"
            >
              Back to Dashboard
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <button
              onClick={() => navigate('/dashboard')}
              className="text-gray-600 hover:text-gray-900"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h1 className="text-xl font-semibold text-gray-900">{workspace?.name}</h1>
            {workspace && <StatusBadge status={workspace.status} />}
          </div>
          <UserMenu />
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Error banner */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-600 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-800 hover:text-red-900">
              Dismiss
            </button>
          </div>
        )}

        {/* Workspace details */}
        <div className="bg-white rounded-lg shadow">
          <div className="p-6">
            {/* Info section */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              <div>
                <h3 className="text-sm font-medium text-gray-500">Repository</h3>
                <p className="mt-1 text-sm text-gray-900">{workspace?.repository}</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-gray-500">Branch</h3>
                <p className="mt-1 text-sm text-gray-900">{workspace?.branch}</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-gray-500">VM Size</h3>
                <p className="mt-1 text-sm text-gray-900">{workspace?.vmSize}</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-gray-500">Location</h3>
                <p className="mt-1 text-sm text-gray-900">{workspace?.vmLocation}</p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-gray-500">Created</h3>
                <p className="mt-1 text-sm text-gray-900">
                  {workspace?.createdAt && new Date(workspace.createdAt).toLocaleString()}
                </p>
              </div>
              <div>
                <h3 className="text-sm font-medium text-gray-500">Last Activity</h3>
                <p className="mt-1 text-sm text-gray-900">
                  {workspace?.lastActivityAt
                    ? new Date(workspace.lastActivityAt).toLocaleString()
                    : 'No activity recorded'}
                </p>
              </div>
            </div>

            {/* Error message */}
            {workspace?.errorMessage && (
              <div className="mb-6 p-4 bg-red-50 rounded-lg">
                <h3 className="text-sm font-medium text-red-800">Error</h3>
                <p className="mt-1 text-sm text-red-600">{workspace.errorMessage}</p>
              </div>
            )}

            {/* Terminal section */}
            <div className="border-t border-gray-200 pt-6">
              {workspace?.status === 'running' ? (
                wsUrl ? (
                  <div className="bg-gray-900 rounded-lg overflow-hidden" style={{ height: '500px' }}>
                    <Terminal
                      wsUrl={wsUrl}
                      shutdownDeadline={workspace.shutdownDeadline}
                      onActivity={handleTerminalActivity}
                      className="h-full"
                    />
                  </div>
                ) : terminalLoading ? (
                  <div className="bg-gray-900 rounded-lg p-8 text-center">
                    <svg className="mx-auto h-12 w-12 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    <h3 className="mt-4 text-lg font-medium text-white">Connecting to Terminal</h3>
                    <p className="mt-2 text-gray-400">
                      Establishing secure connection...
                    </p>
                    <div className="mt-6 flex justify-center">
                      <svg className="animate-spin h-8 w-8 text-green-400" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    </div>
                  </div>
                ) : (
                  <div className="bg-gray-900 rounded-lg p-8 text-center">
                    <svg className="mx-auto h-12 w-12 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <h3 className="mt-4 text-lg font-medium text-white">Connection Failed</h3>
                    <p className="mt-2 text-gray-400">
                      Unable to connect to terminal. Please try again.
                    </p>
                    <button
                      onClick={handleOpenTerminal}
                      disabled={actionLoading}
                      className="mt-6 inline-flex items-center px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {actionLoading ? 'Connecting...' : 'Open in New Tab'}
                    </button>
                  </div>
                )
              ) : workspace?.status === 'creating' ? (
                <div className="bg-gray-900 rounded-lg p-8 text-center">
                  <svg className="mx-auto h-12 w-12 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <h3 className="mt-4 text-lg font-medium text-white">Creating Workspace</h3>
                  <p className="mt-2 text-gray-400">
                    Your workspace is being created. This may take a few minutes.
                  </p>
                  <div className="mt-6 flex justify-center">
                    <svg className="animate-spin h-8 w-8 text-blue-400" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  </div>
                </div>
              ) : workspace?.status === 'stopping' ? (
                <div className="bg-gray-900 rounded-lg p-8 text-center">
                  <svg className="mx-auto h-12 w-12 text-yellow-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <h3 className="mt-4 text-lg font-medium text-white">Stopping Workspace</h3>
                  <p className="mt-2 text-gray-400">
                    Your workspace is being stopped.
                  </p>
                  <div className="mt-6 flex justify-center">
                    <svg className="animate-spin h-8 w-8 text-yellow-400" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  </div>
                </div>
              ) : workspace?.status === 'stopped' ? (
                <div className="bg-gray-900 rounded-lg p-8 text-center">
                  <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <h3 className="mt-4 text-lg font-medium text-white">Workspace Stopped</h3>
                  <p className="mt-2 text-gray-400">
                    This workspace has been stopped. Restart it to access the terminal.
                  </p>
                  <button
                    onClick={handleRestart}
                    disabled={actionLoading}
                    className="mt-6 inline-flex items-center px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {actionLoading ? 'Restarting...' : 'Restart Workspace'}
                  </button>
                </div>
              ) : workspace?.status === 'error' ? (
                <div className="bg-gray-900 rounded-lg p-8 text-center">
                  <svg className="mx-auto h-12 w-12 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <h3 className="mt-4 text-lg font-medium text-white">Workspace Error</h3>
                  <p className="mt-2 text-gray-400">
                    An error occurred with this workspace.
                  </p>
                </div>
              ) : null}
            </div>

            {/* Actions */}
            <div className="mt-6 flex justify-between items-center border-t border-gray-200 pt-6">
              <button
                onClick={() => navigate('/dashboard')}
                className="px-4 py-2 text-gray-600 hover:text-gray-900"
              >
                Back to Dashboard
              </button>

              <div className="flex space-x-3">
                {workspace?.status === 'running' && (
                  <button
                    onClick={handleStop}
                    disabled={actionLoading}
                    className="px-4 py-2 text-orange-600 border border-orange-300 rounded-md hover:bg-orange-50 disabled:opacity-50"
                  >
                    Stop Workspace
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

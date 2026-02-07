import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserMenu } from '../components/UserMenu';
import { HetznerTokenForm } from '../components/HetznerTokenForm';
import { GitHubAppSection } from '../components/GitHubAppSection';
import { AgentKeysSection } from '../components/AgentKeysSection';
import { listCredentials } from '../lib/api';
import {
  createComplianceRun,
  createExceptionRequest,
  createMigrationWorkItem,
  getActiveUiStandard,
} from '../lib/ui-governance';
import type { CredentialResponse } from '@simple-agent-manager/shared';

/**
 * Settings page with credentials management.
 */
export function Settings() {
  const navigate = useNavigate();
  const [credentials, setCredentials] = useState<CredentialResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [migrationStandardId, setMigrationStandardId] = useState('');
  const [migrationSurface, setMigrationSurface] = useState<'control-plane' | 'agent-ui'>('control-plane');
  const [migrationTargetRef, setMigrationTargetRef] = useState('');
  const [migrationPriority, setMigrationPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [migrationOwner, setMigrationOwner] = useState('');
  const [migrationNotes, setMigrationNotes] = useState('');
  const [migrationSubmitting, setMigrationSubmitting] = useState(false);
  const [migrationMessage, setMigrationMessage] = useState<string | null>(null);
  const [complianceChangeRef, setComplianceChangeRef] = useState('');
  const [complianceAuthorType, setComplianceAuthorType] = useState<'human' | 'agent'>('agent');
  const [complianceSubmitting, setComplianceSubmitting] = useState(false);
  const [complianceMessage, setComplianceMessage] = useState<string | null>(null);
  const [exceptionScope, setExceptionScope] = useState('');
  const [exceptionRationale, setExceptionRationale] = useState('');
  const [exceptionRequestedBy, setExceptionRequestedBy] = useState('');
  const [exceptionExpirationDate, setExceptionExpirationDate] = useState('');
  const [exceptionSubmitting, setExceptionSubmitting] = useState(false);
  const [exceptionMessage, setExceptionMessage] = useState<string | null>(null);

  const loadCredentials = useCallback(async () => {
    try {
      setError(null);
      const [data, activeStandard] = await Promise.all([
        listCredentials(),
        getActiveUiStandard().catch(() => null),
      ]);
      setCredentials(data);
      if (activeStandard?.id) {
        setMigrationStandardId(activeStandard.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load credentials');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  const hetznerCredential = credentials.find((c) => c.provider === 'hetzner');

  const handleCreateMigrationItem = async (event: React.FormEvent) => {
    event.preventDefault();
    setMigrationSubmitting(true);
    setMigrationMessage(null);
    try {
      const result = await createMigrationWorkItem({
        standardId: migrationStandardId,
        surface: migrationSurface,
        targetRef: migrationTargetRef,
        priority: migrationPriority,
        status: 'backlog',
        owner: migrationOwner,
        notes: migrationNotes || undefined,
      });
      setMigrationMessage(`Migration item created: ${String((result as { id?: string }).id || 'created')}`);
      setMigrationTargetRef('');
      setMigrationNotes('');
    } catch (err) {
      setMigrationMessage(err instanceof Error ? err.message : 'Failed to create migration item');
    } finally {
      setMigrationSubmitting(false);
    }
  };

  const handleCreateComplianceRun = async (event: React.FormEvent) => {
    event.preventDefault();
    setComplianceSubmitting(true);
    setComplianceMessage(null);
    try {
      const result = await createComplianceRun({
        standardId: migrationStandardId,
        checklistVersion: 'v1',
        authorType: complianceAuthorType,
        changeRef: complianceChangeRef,
      });
      setComplianceMessage(`Compliance run submitted: ${String((result as { id?: string }).id || 'created')}`);
      setComplianceChangeRef('');
    } catch (err) {
      setComplianceMessage(err instanceof Error ? err.message : 'Failed to submit compliance run');
    } finally {
      setComplianceSubmitting(false);
    }
  };

  const handleCreateException = async (event: React.FormEvent) => {
    event.preventDefault();
    setExceptionSubmitting(true);
    setExceptionMessage(null);
    try {
      const result = await createExceptionRequest({
        standardId: migrationStandardId,
        requestedBy: exceptionRequestedBy,
        rationale: exceptionRationale,
        scope: exceptionScope,
        expirationDate: exceptionExpirationDate,
      });
      setExceptionMessage(`Exception request submitted: ${String((result as { id?: string }).id || 'created')}`);
      setExceptionScope('');
      setExceptionRationale('');
      setExceptionRequestedBy('');
      setExceptionExpirationDate('');
    } catch (err) {
      setExceptionMessage(err instanceof Error ? err.message : 'Failed to submit exception');
    } finally {
      setExceptionSubmitting(false);
    }
  };

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
            <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
          </div>
          <UserMenu />
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
            {error}
          </div>
        )}

        <div className="space-y-6">
          {/* Hetzner Cloud section */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center space-x-3 mb-4">
              <div className="h-10 w-10 bg-red-100 rounded-lg flex items-center justify-center">
                <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-medium text-gray-900">Hetzner Cloud</h2>
                <p className="text-sm text-gray-500">
                  Connect your Hetzner Cloud account to create workspaces
                </p>
              </div>
            </div>

            {loading ? (
              <div className="flex justify-center py-4">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
              </div>
            ) : (
              <HetznerTokenForm
                credential={hetznerCredential}
                onUpdate={loadCredentials}
              />
            )}
          </div>

          {/* GitHub App section */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center space-x-3 mb-4">
              <div className="h-10 w-10 bg-gray-900 rounded-lg flex items-center justify-center">
                <svg className="h-6 w-6 text-white" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.167 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-medium text-gray-900">GitHub App</h2>
                <p className="text-sm text-gray-500">
                  Install the GitHub App to access your repositories
                </p>
              </div>
            </div>

            <GitHubAppSection />
          </div>

          {/* Agent API Keys section */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center space-x-3 mb-4">
              <div className="h-10 w-10 bg-purple-100 rounded-lg flex items-center justify-center">
                <svg className="h-6 w-6 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-medium text-gray-900">Agent API Keys</h2>
                <p className="text-sm text-gray-500">
                  Add API keys for AI coding agents. Keys are stored encrypted and used across all your workspaces.
                </p>
              </div>
            </div>

            <AgentKeysSection />
          </div>

          {/* Migration work item management */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="mb-4">
              <h2 className="text-lg font-medium text-gray-900">UI Migration Work Items</h2>
              <p className="text-sm text-gray-500">
                Track migration tasks from legacy screens to shared UI standards.
              </p>
            </div>

            {migrationMessage && (
              <div className="mb-4 p-3 bg-gray-100 rounded text-sm text-gray-700">
                {migrationMessage}
              </div>
            )}

            <form onSubmit={handleCreateMigrationItem} className="space-y-4">
              <div>
                <label htmlFor="migration-standard-id" className="block text-sm font-medium text-gray-700">
                  UI Standard ID
                </label>
                <input
                  id="migration-standard-id"
                  type="text"
                  value={migrationStandardId}
                  onChange={(e) => setMigrationStandardId(e.target.value)}
                  required
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="migration-surface" className="block text-sm font-medium text-gray-700">
                    Surface
                  </label>
                  <select
                    id="migration-surface"
                    value={migrationSurface}
                    onChange={(e) => setMigrationSurface(e.target.value as 'control-plane' | 'agent-ui')}
                    className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                  >
                    <option value="control-plane">Control Plane</option>
                    <option value="agent-ui">Agent UI</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="migration-priority" className="block text-sm font-medium text-gray-700">
                    Priority
                  </label>
                  <select
                    id="migration-priority"
                    value={migrationPriority}
                    onChange={(e) => setMigrationPriority(e.target.value as 'high' | 'medium' | 'low')}
                    className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                  >
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="migration-target" className="block text-sm font-medium text-gray-700">
                  Target Screen or Flow
                </label>
                <input
                  id="migration-target"
                  type="text"
                  value={migrationTargetRef}
                  onChange={(e) => setMigrationTargetRef(e.target.value)}
                  placeholder="dashboard/workspace-card"
                  required
                />
              </div>

              <div>
                <label htmlFor="migration-owner" className="block text-sm font-medium text-gray-700">
                  Owner
                </label>
                <input
                  id="migration-owner"
                  type="text"
                  value={migrationOwner}
                  onChange={(e) => setMigrationOwner(e.target.value)}
                  placeholder="frontend-team"
                  required
                />
              </div>

              <div>
                <label htmlFor="migration-notes" className="block text-sm font-medium text-gray-700">
                  Notes
                </label>
                <textarea
                  id="migration-notes"
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                  value={migrationNotes}
                  onChange={(e) => setMigrationNotes(e.target.value)}
                  rows={3}
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={migrationSubmitting}
                  className="px-4 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
                  style={{ minHeight: '56px' }}
                >
                  {migrationSubmitting ? 'Creating...' : 'Create Migration Item'}
                </button>
              </div>
            </form>
          </div>

          {/* Compliance and exception controls */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="mb-4">
              <h2 className="text-lg font-medium text-gray-900">Compliance & Exceptions</h2>
              <p className="text-sm text-gray-500">
                Submit compliance runs and standards exceptions for UI pull requests.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <form onSubmit={handleCreateComplianceRun} className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-900">Create Compliance Run</h3>
                {complianceMessage && (
                  <div className="p-3 bg-gray-100 rounded text-sm text-gray-700">{complianceMessage}</div>
                )}
                <div>
                  <label htmlFor="compliance-change-ref" className="block text-sm font-medium text-gray-700">
                    Change Reference (PR or Commit)
                  </label>
                  <input
                    id="compliance-change-ref"
                    type="text"
                    value={complianceChangeRef}
                    onChange={(e) => setComplianceChangeRef(e.target.value)}
                    placeholder="PR-123"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="compliance-author-type" className="block text-sm font-medium text-gray-700">
                    Author Type
                  </label>
                  <select
                    id="compliance-author-type"
                    value={complianceAuthorType}
                    onChange={(e) => setComplianceAuthorType(e.target.value as 'human' | 'agent')}
                    className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                  >
                    <option value="agent">Agent</option>
                    <option value="human">Human</option>
                  </select>
                </div>
                <button
                  type="submit"
                  disabled={complianceSubmitting}
                  className="px-4 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
                  style={{ minHeight: '56px' }}
                >
                  {complianceSubmitting ? 'Submitting...' : 'Submit Compliance Run'}
                </button>
              </form>

              <form onSubmit={handleCreateException} className="space-y-4">
                <h3 className="text-sm font-semibold text-gray-900">Request Exception</h3>
                {exceptionMessage && (
                  <div className="p-3 bg-gray-100 rounded text-sm text-gray-700">{exceptionMessage}</div>
                )}
                <div>
                  <label htmlFor="exception-scope" className="block text-sm font-medium text-gray-700">
                    Scope
                  </label>
                  <input
                    id="exception-scope"
                    type="text"
                    value={exceptionScope}
                    onChange={(e) => setExceptionScope(e.target.value)}
                    placeholder="landing/hero-cta"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="exception-rationale" className="block text-sm font-medium text-gray-700">
                    Rationale
                  </label>
                  <textarea
                    id="exception-rationale"
                    className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                    value={exceptionRationale}
                    onChange={(e) => setExceptionRationale(e.target.value)}
                    required
                    rows={3}
                  />
                </div>
                <div>
                  <label htmlFor="exception-requested-by" className="block text-sm font-medium text-gray-700">
                    Requested By
                  </label>
                  <input
                    id="exception-requested-by"
                    type="text"
                    value={exceptionRequestedBy}
                    onChange={(e) => setExceptionRequestedBy(e.target.value)}
                    placeholder="frontend-lead"
                    required
                  />
                </div>
                <div>
                  <label htmlFor="exception-expiration" className="block text-sm font-medium text-gray-700">
                    Expiration Date
                  </label>
                  <input
                    id="exception-expiration"
                    type="date"
                    value={exceptionExpirationDate}
                    onChange={(e) => setExceptionExpirationDate(e.target.value)}
                    required
                  />
                </div>
                <button
                  type="submit"
                  disabled={exceptionSubmitting}
                  className="px-4 py-3 bg-gray-900 text-white rounded-md hover:bg-gray-700 disabled:opacity-50"
                  style={{ minHeight: '56px' }}
                >
                  {exceptionSubmitting ? 'Submitting...' : 'Submit Exception Request'}
                </button>
              </form>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

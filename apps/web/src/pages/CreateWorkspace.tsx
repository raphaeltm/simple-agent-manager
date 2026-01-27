import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserMenu } from '../components/UserMenu';
import { RepoSelector } from '../components/RepoSelector';
import {
  createWorkspace,
  listGitHubInstallations,
  listCredentials,
} from '../lib/api';
import type { GitHubInstallation } from '@cloud-ai-workspaces/shared';

const VM_SIZES = [
  { value: 'small', label: 'Small', description: '2 vCPUs, 4GB RAM' },
  { value: 'medium', label: 'Medium', description: '4 vCPUs, 8GB RAM' },
  { value: 'large', label: 'Large', description: '8 vCPUs, 16GB RAM' },
];

const VM_LOCATIONS = [
  { value: 'nbg1', label: 'Nuremberg, DE' },
  { value: 'fsn1', label: 'Falkenstein, DE' },
  { value: 'hel1', label: 'Helsinki, FI' },
];

/**
 * Create workspace page with form.
 */
export function CreateWorkspace() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkingPrereqs, setCheckingPrereqs] = useState(true);
  const [hasHetzner, setHasHetzner] = useState(false);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);

  // Form state
  const [name, setName] = useState('');
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('main');
  const [installationId, setInstallationId] = useState('');
  const [vmSize, setVmSize] = useState('medium');
  const [vmLocation, setVmLocation] = useState('nbg1');

  useEffect(() => {
    checkPrerequisites();
  }, []);

  const checkPrerequisites = async () => {
    try {
      const [creds, installs] = await Promise.all([
        listCredentials(),
        listGitHubInstallations(),
      ]);

      setHasHetzner(creds.some((c) => c.provider === 'hetzner'));
      setInstallations(installs);

      const firstInstall = installs[0];
      if (firstInstall) {
        setInstallationId(firstInstall.id);
      }
    } catch (err) {
      console.error('Failed to check prerequisites:', err);
    } finally {
      setCheckingPrereqs(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // Extract repository from URL if needed
      let repo = repository;
      if (repository.startsWith('https://github.com/')) {
        repo = repository.replace('https://github.com/', '').replace(/\.git$/, '');
      }

      const workspace = await createWorkspace({
        name,
        repository: repo,
        branch,
        installationId,
        vmSize: vmSize as any,
        vmLocation: vmLocation as any,
      });

      navigate(`/workspaces/${workspace.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace');
    } finally {
      setLoading(false);
    }
  };

  if (checkingPrereqs) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const canCreate = hasHetzner && installations.length > 0;

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
            <h1 className="text-xl font-semibold text-gray-900">Create Workspace</h1>
          </div>
          <UserMenu />
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {!canCreate ? (
          <div className="bg-white rounded-lg shadow p-6">
            <div className="text-center py-8">
              <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <h3 className="mt-4 text-lg font-medium text-gray-900">Setup Required</h3>
              <p className="mt-2 text-gray-500">
                Before creating a workspace, please complete the following:
              </p>
              <ul className="mt-4 text-left max-w-xs mx-auto space-y-2">
                <li className={`flex items-center space-x-2 ${hasHetzner ? 'text-green-600' : 'text-gray-500'}`}>
                  {hasHetzner ? (
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                  <span>Connect Hetzner Cloud account</span>
                </li>
                <li className={`flex items-center space-x-2 ${installations.length > 0 ? 'text-green-600' : 'text-gray-500'}`}>
                  {installations.length > 0 ? (
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                  <span>Install GitHub App</span>
                </li>
              </ul>
              <button
                onClick={() => navigate('/settings')}
                className="mt-6 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
              >
                Go to Settings
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow p-6 space-y-6">
            {error && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
                {error}
              </div>
            )}

            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                Workspace Name
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-project"
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                required
                maxLength={64}
              />
            </div>

            <div>
              <label htmlFor="repository" className="block text-sm font-medium text-gray-700">
                Repository
              </label>
              <RepoSelector
                id="repository"
                value={repository}
                onChange={setRepository}
                required
              />
            </div>

            <div>
              <label htmlFor="branch" className="block text-sm font-medium text-gray-700">
                Branch
              </label>
              <input
                id="branch"
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="main"
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {installations.length > 1 && (
              <div>
                <label htmlFor="installation" className="block text-sm font-medium text-gray-700">
                  GitHub Account
                </label>
                <select
                  id="installation"
                  value={installationId}
                  onChange={(e) => setInstallationId(e.target.value)}
                  className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                >
                  {installations.map((inst) => (
                    <option key={inst.id} value={inst.id}>
                      {inst.accountName} ({inst.accountType})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                VM Size
              </label>
              <div className="grid grid-cols-3 gap-3">
                {VM_SIZES.map((size) => (
                  <button
                    key={size.value}
                    type="button"
                    onClick={() => setVmSize(size.value)}
                    className={`p-3 border rounded-lg text-left transition-colors ${
                      vmSize === size.value
                        ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-500'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="font-medium">{size.label}</div>
                    <div className="text-xs text-gray-500">{size.description}</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label htmlFor="location" className="block text-sm font-medium text-gray-700">
                Location
              </label>
              <select
                id="location"
                value={vmLocation}
                onChange={(e) => setVmLocation(e.target.value)}
                className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              >
                {VM_LOCATIONS.map((loc) => (
                  <option key={loc.value} value={loc.value}>
                    {loc.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex justify-end space-x-3 pt-4">
              <button
                type="button"
                onClick={() => navigate('/dashboard')}
                className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading || !name || !repository}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Creating...' : 'Create Workspace'}
              </button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}

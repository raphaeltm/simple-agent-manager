import { useState } from 'react';
import { createCredential, deleteCredential } from '../lib/api';
import type { CredentialResponse } from '@cloud-ai-workspaces/shared';

interface HetznerTokenFormProps {
  credential?: CredentialResponse | null;
  onUpdate: () => void;
}

/**
 * Form for adding/updating/deleting Hetzner API token.
 */
export function HetznerTokenForm({ credential, onUpdate }: HetznerTokenFormProps) {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await createCredential({ provider: 'hetzner', token });
      setToken('');
      setShowForm(false);
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save token');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to disconnect your Hetzner account?')) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await deleteCredential('hetzner');
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete token');
    } finally {
      setLoading(false);
    }
  };

  if (credential && !showForm) {
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
                Added: {new Date(credential.createdAt).toLocaleDateString()}
              </p>
            </div>
          </div>
          <div className="space-x-2">
            <button
              onClick={() => setShowForm(true)}
              className="px-3 py-1 text-sm text-blue-600 hover:text-blue-800"
            >
              Update
            </button>
            <button
              onClick={handleDelete}
              disabled={loading}
              className="px-3 py-1 text-sm text-red-600 hover:text-red-800 disabled:opacity-50"
            >
              {loading ? 'Removing...' : 'Disconnect'}
            </button>
          </div>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="hetzner-token" className="block text-sm font-medium text-gray-700">
          Hetzner API Token
        </label>
        <input
          id="hetzner-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Enter your Hetzner Cloud API token"
          className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
          required
        />
        <p className="mt-1 text-xs text-gray-500">
          Get your API token from{' '}
          <a
            href="https://console.hetzner.cloud/projects"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:text-blue-800"
          >
            Hetzner Cloud Console
          </a>
          {' '}&gt; Your Project &gt; Security &gt; API Tokens
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex space-x-3">
        <button
          type="submit"
          disabled={loading || !token}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Saving...' : credential ? 'Update Token' : 'Connect'}
        </button>
        {showForm && (
          <button
            type="button"
            onClick={() => setShowForm(false)}
            className="px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

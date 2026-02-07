import { useState } from 'react';
import type { AgentInfo, AgentCredentialInfo, AgentType } from '@simple-agent-manager/shared';

interface AgentKeyCardProps {
  agent: AgentInfo;
  credential?: AgentCredentialInfo | null;
  onSave: (agentType: AgentType, apiKey: string) => Promise<void>;
  onDelete: (agentType: AgentType) => Promise<void>;
}

/**
 * Card for managing a single agent's API key.
 * Shows connection status, masked key, and save/remove actions.
 */
export function AgentKeyCard({ agent, credential, onSave, onDelete }: AgentKeyCardProps) {
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await onSave(agent.id, apiKey);
      setApiKey('');
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save API key');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Remove the ${agent.name} API key? You won't be able to use this agent until you add a new key.`)) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      await onDelete(agent.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove API key');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-medium text-gray-900">{agent.name}</h3>
          <p className="text-xs text-gray-500">{agent.description}</p>
        </div>
        {credential ? (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
            Connected
          </span>
        ) : (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
            Not Configured
          </span>
        )}
      </div>

      {credential && !showForm && (
        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-md">
            <span className="text-sm text-gray-600 font-mono">{credential.maskedKey}</span>
            <div className="flex space-x-2">
              <button
                onClick={() => setShowForm(true)}
                className="text-xs text-blue-600 hover:text-blue-800"
              >
                Update
              </button>
              <button
                onClick={handleDelete}
                disabled={loading}
                className="text-xs text-red-600 hover:text-red-800 disabled:opacity-50"
              >
                {loading ? 'Removing...' : 'Remove'}
              </button>
            </div>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}

      {(!credential || showForm) && (
        <form onSubmit={handleSave} className="space-y-3">
          <div>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={`Enter your ${agent.name} API key`}
              className="block w-full px-3 py-2 text-sm border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              required
            />
            <p className="mt-1 text-xs text-gray-500">
              Get your API key from{' '}
              <a
                href={agent.credentialHelpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-800"
              >
                {agent.name} Console
              </a>
            </p>
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <div className="flex space-x-2">
            <button
              type="submit"
              disabled={loading || !apiKey}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Saving...' : credential ? 'Update Key' : 'Save Key'}
            </button>
            {showForm && (
              <button
                type="button"
                onClick={() => { setShowForm(false); setError(null); setApiKey(''); }}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * Connections settings page — replaces the former Agents tab.
 * Shows resolution status overview + guided Connect flow.
 */
import { useState } from 'react';

import { ConnectFlow } from '../components/ConnectFlow';
import { ConnectionsOverview } from '../components/ConnectionsOverview';

export function SettingsConnections() {
  const [showConnect, setShowConnect] = useState(false);
  const [connectAgentId, setConnectAgentId] = useState<string | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);

  const handleConnect = (consumerId: string, consumerKind: 'agent' | 'compute') => {
    if (consumerKind === 'agent') {
      setConnectAgentId(consumerId);
      setShowConnect(true);
    }
    // Compute consumers deep-link to cloud provider settings (handled by ConnectionsOverview)
  };

  const handleConnected = () => {
    setShowConnect(false);
    setConnectAgentId(undefined);
    setRefreshKey((k) => k + 1);
  };

  return (
    <div className="glass-surface rounded-lg p-4 flex flex-col gap-4">
      <div>
        <h2 className="sam-type-section-heading m-0 text-fg-primary">
          Connections
        </h2>
        <p className="m-0 mt-1 text-xs text-fg-muted">
          How each AI agent and cloud provider resolves credentials for your account.
          Click &ldquo;Connect&rdquo; to set up or change a credential.
        </p>
      </div>

      {showConnect ? (
        <ConnectFlow
          initialAgentId={connectAgentId}
          onConnected={handleConnected}
          onCancel={() => {
            setShowConnect(false);
            setConnectAgentId(undefined);
          }}
        />
      ) : (
        <>
          <ConnectionsOverview key={refreshKey} onConnect={handleConnect} />
          <button
            type="button"
            onClick={() => setShowConnect(true)}
            className="self-start text-xs text-accent font-medium bg-transparent border-none cursor-pointer px-0 py-1 hover:underline"
          >
            + Connect an agent
          </button>
        </>
      )}
    </div>
  );
}

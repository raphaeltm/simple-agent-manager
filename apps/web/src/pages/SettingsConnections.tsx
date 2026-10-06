/**
 * Connections settings page — replaces the former Agents tab.
 * Shows resolution status overview + guided Connect flow.
 */
import type { CCConsumerResolutionStatus, CredentialKind } from '@simple-agent-manager/shared';
import { useState } from 'react';

import { CloudProviderConnectFlow } from '../components/CloudProviderConnectFlow';
import { ConnectFlow } from '../components/ConnectFlow';
import { ConnectionsOverview } from '../components/ConnectionsOverview';
import { useToast } from '../hooks/useToast';
import { deleteAgentCredentialByKind, deleteCredential } from '../lib/api';

export function SettingsConnections() {
  const toast = useToast();
  const [showConnect, setShowConnect] = useState(false);
  const [connectAgentId, setConnectAgentId] = useState<string | undefined>();
  const [connectAuthMethod, setConnectAuthMethod] = useState<CredentialKind | undefined>();
  const [connectMode, setConnectMode] = useState<'connect' | 'replace'>('connect');
  const [showCloudConnect, setShowCloudConnect] = useState(false);
  const [connectProviderId, setConnectProviderId] = useState<string | undefined>();
  const [cloudConnectMode, setCloudConnectMode] = useState<'connect' | 'replace'>('connect');
  const [refreshKey, setRefreshKey] = useState(0);

  const handleConnect = (consumerId: string, consumerKind: 'agent' | 'compute') => {
    if (consumerKind === 'agent') {
      setConnectAgentId(consumerId);
      setConnectAuthMethod(undefined);
      setConnectMode('connect');
      setShowConnect(true);
      setShowCloudConnect(false);
      return;
    }
    setConnectProviderId(consumerId);
    setCloudConnectMode('connect');
    setShowCloudConnect(true);
    setShowConnect(false);
  };

  const handleConnected = () => {
    setShowConnect(false);
    setConnectAgentId(undefined);
    setConnectAuthMethod(undefined);
    setConnectMode('connect');
    setShowCloudConnect(false);
    setConnectProviderId(undefined);
    setCloudConnectMode('connect');
    setRefreshKey((k) => k + 1);
  };

  const handleReplace = (consumer: CCConsumerResolutionStatus) => {
    if (consumer.consumerKind === 'compute') {
      setConnectProviderId(consumer.consumerId);
      setCloudConnectMode('replace');
      setShowCloudConnect(true);
      setShowConnect(false);
      return;
    }
    setConnectAgentId(consumer.consumerId);
    setConnectAuthMethod(toLegacyCredentialKind(consumer.credentialKind));
    setConnectMode('replace');
    setShowConnect(true);
    setShowCloudConnect(false);
  };

  const handleDisconnect = async (consumer: CCConsumerResolutionStatus) => {
    if (consumer.consumerKind === 'compute') {
      if (!confirm(`Disconnect ${consumer.consumerName}?`)) return;
      try {
        await deleteCredential(consumer.consumerId);
        toast.success(`${consumer.consumerName} disconnected`);
        setRefreshKey((k) => k + 1);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to disconnect credential');
      }
      return;
    }

    const credentialKind = toLegacyCredentialKind(consumer.credentialKind);
    if (!credentialKind) {
      toast.error('This connection does not expose a removable user credential.');
      return;
    }
    if (!confirm(`Disconnect ${consumer.consumerName}?`)) return;

    try {
      await deleteAgentCredentialByKind(consumer.consumerId, credentialKind);
      toast.success(`${consumer.consumerName} disconnected`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to disconnect credential');
    }
  };

  const handleValidate = (consumer: CCConsumerResolutionStatus) => {
    const validation = consumer.validation;
    if (!validation) {
      toast.info('No local validation is available for this credential type.');
      return;
    }
    if (validation.status === 'invalid') {
      toast.error(validation.message ?? 'Credential validation failed');
      return;
    }
    if (validation.status === 'warning') {
      toast.warning(
        validation.warnings?.join(' ') ?? validation.message ?? 'Credential validated with warnings'
      );
      return;
    }
    toast.success(validation.message ?? 'Credential format is valid');
  };

  return (
    <div className="glass-surface rounded-lg p-4 flex flex-col gap-4">
      <div>
        <h2 className="sam-type-section-heading m-0 text-fg-primary">Connections</h2>
        <p className="m-0 mt-1 text-xs text-fg-muted">
          How each AI agent and cloud provider resolves credentials for your account. Use row
          actions to replace, disconnect, validate, or make a credential the default.
        </p>
      </div>

      {showCloudConnect ? (
        <CloudProviderConnectFlow
          initialProvider={connectProviderId}
          mode={cloudConnectMode}
          onConnected={handleConnected}
          onCancel={() => {
            setShowCloudConnect(false);
            setConnectProviderId(undefined);
            setCloudConnectMode('connect');
          }}
        />
      ) : showConnect ? (
        <ConnectFlow
          initialAgentId={connectAgentId}
          initialAuthMethod={connectAuthMethod}
          mode={connectMode}
          onConnected={handleConnected}
          onCancel={() => {
            setShowConnect(false);
            setConnectAgentId(undefined);
            setConnectAuthMethod(undefined);
            setConnectMode('connect');
          }}
        />
      ) : (
        <>
          <ConnectionsOverview
            key={refreshKey}
            onConnect={handleConnect}
            onReplace={handleReplace}
            onDisconnect={(consumer) => void handleDisconnect(consumer)}
            onValidate={handleValidate}
          />
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

function toLegacyCredentialKind(kind: string | null | undefined): CredentialKind | undefined {
  if (kind === 'api-key' || kind === 'oauth-token') return kind;
  if (kind === 'auth-json') return 'oauth-token';
  return undefined;
}

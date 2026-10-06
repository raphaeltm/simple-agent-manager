import type { CCConsumerResolutionStatus, CredentialKind } from '@simple-agent-manager/shared';
import { useState } from 'react';

import { useToast } from '../../hooks/useToast';
import { deleteProjectAgentCredential, deleteProjectCloudCredential } from '../../lib/api';
import { CloudProviderConnectFlow } from '../CloudProviderConnectFlow';
import { ConnectFlow } from '../ConnectFlow';
import { ConnectionsOverview } from '../ConnectionsOverview';

interface ProjectConnectionsSectionProps {
  projectId: string;
  onUpdated: () => void;
}

export function ProjectConnectionsSection({ projectId, onUpdated }: ProjectConnectionsSectionProps) {
  const toast = useToast();
  const [showConnect, setShowConnect] = useState(false);
  const [connectAgentId, setConnectAgentId] = useState<string | undefined>();
  const [connectAuthMethod, setConnectAuthMethod] = useState<CredentialKind | undefined>();
  const [connectMode, setConnectMode] = useState<'connect' | 'replace' | 'project-override'>(
    'project-override'
  );
  const [showCloudConnect, setShowCloudConnect] = useState(false);
  const [connectProviderId, setConnectProviderId] = useState<string | undefined>();
  const [cloudConnectMode, setCloudConnectMode] = useState<
    'connect' | 'replace' | 'project-override'
  >('project-override');
  const [refreshKey, setRefreshKey] = useState(0);

  const resetConnectFlow = () => {
    setShowConnect(false);
    setConnectAgentId(undefined);
    setConnectAuthMethod(undefined);
    setConnectMode('project-override');
    setShowCloudConnect(false);
    setConnectProviderId(undefined);
    setCloudConnectMode('project-override');
  };

  const handleConnect = (consumerId: string, consumerKind: 'agent' | 'compute') => {
    if (consumerKind === 'compute') {
      setConnectProviderId(consumerId);
      setCloudConnectMode('project-override');
      setShowCloudConnect(true);
      setShowConnect(false);
      return;
    }

    setConnectAgentId(consumerId);
    setConnectAuthMethod(undefined);
    setConnectMode('project-override');
    setShowConnect(true);
    setShowCloudConnect(false);
  };

  const handleConnected = () => {
    resetConnectFlow();
    setRefreshKey((k) => k + 1);
    onUpdated();
  };

  const openProjectOverride = (consumer: CCConsumerResolutionStatus) => {
    if (consumer.consumerKind === 'compute') {
      setConnectProviderId(consumer.consumerId);
      setCloudConnectMode(consumer.source === 'project-attachment' ? 'replace' : 'project-override');
      setShowCloudConnect(true);
      setShowConnect(false);
      return;
    }
    setConnectAgentId(consumer.consumerId);
    setConnectAuthMethod(toLegacyCredentialKind(consumer.credentialKind));
    setConnectMode(consumer.source === 'project-attachment' ? 'replace' : 'project-override');
    setShowConnect(true);
    setShowCloudConnect(false);
  };

  const handleDisconnect = async (consumer: CCConsumerResolutionStatus) => {
    if (consumer.consumerKind === 'compute') {
      if (!confirm(`Remove the ${consumer.consumerName} project override?`)) return;
      try {
        await deleteProjectCloudCredential(projectId, consumer.consumerId);
        toast.success(`${consumer.consumerName} project override removed`);
        setRefreshKey((k) => k + 1);
        onUpdated();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to remove project override');
      }
      return;
    }

    const credentialKind = toLegacyCredentialKind(consumer.credentialKind);
    if (!credentialKind) {
      toast.error('This project override does not expose a removable credential.');
      return;
    }
    if (!confirm(`Remove the ${consumer.consumerName} project override?`)) return;

    try {
      await deleteProjectAgentCredential(projectId, consumer.consumerId, credentialKind);
      toast.success(`${consumer.consumerName} project override removed`);
      setRefreshKey((k) => k + 1);
      onUpdated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove project override');
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
    <section className="glass-surface rounded-lg p-4 grid gap-3">
      <div>
        <h2 className="sam-type-section-heading m-0 text-fg-primary">Connections</h2>
        <p className="m-0 mt-1 text-xs text-fg-muted">
          How each agent and cloud provider resolves credentials for this project. Badges show
          whether a credential comes from a project override, your user default, or the SAM
          platform.
        </p>
      </div>

      {showCloudConnect ? (
        <CloudProviderConnectFlow
          projectId={projectId}
          initialProvider={connectProviderId}
          mode={cloudConnectMode}
          onConnected={handleConnected}
          onCancel={resetConnectFlow}
        />
      ) : showConnect ? (
        <ConnectFlow
          projectId={projectId}
          initialAgentId={connectAgentId}
          initialAuthMethod={connectAuthMethod}
          mode={connectMode}
          onConnected={handleConnected}
          onCancel={resetConnectFlow}
        />
      ) : (
        <>
          <ConnectionsOverview
            key={refreshKey}
            projectId={projectId}
            onConnect={handleConnect}
            onReplace={openProjectOverride}
            onProjectOverride={openProjectOverride}
            onDisconnect={(consumer) => void handleDisconnect(consumer)}
            onValidate={handleValidate}
          />
          <button
            type="button"
            onClick={() => setShowConnect(true)}
            className="self-start text-xs text-accent font-medium bg-transparent border-none cursor-pointer px-0 py-1 hover:underline"
          >
            + Connect an agent for this project
          </button>
        </>
      )}
    </section>
  );
}

function toLegacyCredentialKind(kind: string | null | undefined): CredentialKind | undefined {
  if (kind === 'api-key' || kind === 'oauth-token') return kind;
  if (kind === 'auth-json') return 'oauth-token';
  return undefined;
}

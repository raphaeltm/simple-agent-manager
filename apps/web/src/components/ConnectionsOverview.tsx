/**
 * Connections overview — read-only view of how each agent and cloud provider
 * currently resolves for the authenticated user, optionally scoped to a project.
 *
 * Fetches GET /api/credentials/resolution-status and renders status rows with
 * resolution badges (project override / your default / SAM platform / halted / unresolved).
 */
import type { CCConsumerResolutionStatus } from '@simple-agent-manager/shared';
import { Alert, Spinner } from '@simple-agent-manager/ui';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';

import { getResolutionStatus } from '../lib/api';
import { ResolutionBadge } from './ResolutionBadge';

interface ConnectionsOverviewProps {
  projectId?: string;
  onConnect?: (consumerId: string, consumerKind: 'agent' | 'compute') => void;
  onReplace?: (consumer: CCConsumerResolutionStatus) => void;
  onDisconnect?: (consumer: CCConsumerResolutionStatus) => void;
  onProjectOverride?: (consumer: CCConsumerResolutionStatus) => void;
  onValidate?: (consumer: CCConsumerResolutionStatus) => void;
}

export function ConnectionsOverview({
  projectId,
  onConnect,
  onReplace,
  onDisconnect,
  onProjectOverride,
  onValidate,
}: ConnectionsOverviewProps) {
  const [consumers, setConsumers] = useState<CCConsumerResolutionStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await getResolutionStatus(projectId);
      setConsumers(data.consumers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load resolution status');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex justify-center p-4">
        <Spinner size="md" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="error">
        {error}
        <button
          onClick={() => void load()}
          className="ml-2 text-inherit underline bg-transparent border-none cursor-pointer text-[length:inherit]"
        >
          Retry
        </button>
      </Alert>
    );
  }

  const agents = consumers.filter((c) => c.consumerKind === 'agent');
  const compute = consumers.filter((c) => c.consumerKind === 'compute');

  return (
    <div className="flex flex-col gap-4">
      {/* Agents */}
      <div className="flex flex-col gap-1">
        <h3 className="sam-type-card-title m-0 text-fg-primary">AI Agents</h3>
        <div className="border border-border-default rounded-md overflow-hidden">
          {agents.map((c, idx) => (
            <ConnectionRow
              key={c.consumerId}
              consumer={c}
              isLast={idx === agents.length - 1}
              onConnect={onConnect}
              onReplace={onReplace}
              onDisconnect={onDisconnect}
              onProjectOverride={onProjectOverride}
              onValidate={onValidate}
              projectScoped={projectId != null}
            />
          ))}
          {agents.length === 0 && (
            <div className="p-3 text-xs text-fg-muted">No agents available.</div>
          )}
        </div>
      </div>

      {/* Cloud Providers */}
      <div className="flex flex-col gap-1">
        <h3 className="sam-type-card-title m-0 text-fg-primary">Cloud Providers</h3>
        <div className="border border-border-default rounded-md overflow-hidden">
          {compute.map((c, idx) => (
            <ConnectionRow
              key={c.consumerId}
              consumer={c}
              isLast={idx === compute.length - 1}
              onConnect={onConnect}
              deepLinkPath="/settings/cloud-provider"
            />
          ))}
          {compute.length === 0 && (
            <div className="p-3 text-xs text-fg-muted">No cloud providers available.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConnectionRow({
  consumer,
  isLast,
  onConnect,
  onReplace,
  onDisconnect,
  onProjectOverride,
  onValidate,
  deepLinkPath,
  projectScoped,
}: {
  consumer: CCConsumerResolutionStatus;
  isLast: boolean;
  onConnect?: (consumerId: string, consumerKind: 'agent' | 'compute') => void;
  onReplace?: (consumer: CCConsumerResolutionStatus) => void;
  onDisconnect?: (consumer: CCConsumerResolutionStatus) => void;
  onProjectOverride?: (consumer: CCConsumerResolutionStatus) => void;
  onValidate?: (consumer: CCConsumerResolutionStatus) => void;
  deepLinkPath?: string;
  projectScoped?: boolean;
}) {
  const isConfigured = consumer.source !== 'unresolved' && consumer.source !== 'halted';
  const isAgent = consumer.consumerKind === 'agent';
  const hasTenantSource =
    consumer.source === 'user-attachment' || consumer.source === 'project-attachment';
  const canDisconnect =
    isAgent &&
    hasTenantSource &&
    (!projectScoped || consumer.source === 'project-attachment') &&
    onDisconnect;
  const canReplace = isAgent && hasTenantSource && onReplace;
  const canProjectOverride =
    isAgent && projectScoped && consumer.source !== 'project-attachment' && onProjectOverride;
  const canMakeDefault = isAgent && !projectScoped && !hasTenantSource && onConnect;
  const canValidate =
    isAgent && onValidate && (consumer.validation || consumer.consumerId === 'openai-codex');

  return (
    <div
      className={`grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center ${
        !isLast ? 'border-b border-border-default' : ''
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-medium text-fg-primary truncate">
            {consumer.consumerName}
          </div>
          <ResolutionBadge source={consumer.source} />
        </div>
        <div className="mt-0.5 text-xs text-fg-muted break-words">{getStatusText(consumer)}</div>
        {consumer.validation?.status === 'invalid' && (
          <div className="mt-1 text-xs text-danger break-words">{consumer.validation.message}</div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 sm:justify-end">
        {canReplace && (
          <RowButton onClick={() => onReplace?.(consumer)}>
            {consumer.source === 'project-attachment' ? 'Replace override' : 'Replace default'}
          </RowButton>
        )}
        {canProjectOverride && (
          <RowButton onClick={() => onProjectOverride?.(consumer)}>Project override</RowButton>
        )}
        {canMakeDefault && (
          <RowButton onClick={() => onConnect?.(consumer.consumerId, consumer.consumerKind)}>
            Make default
          </RowButton>
        )}
        {canValidate && <RowButton onClick={() => onValidate?.(consumer)}>Validate</RowButton>}
        {canDisconnect && (
          <RowButton danger onClick={() => onDisconnect?.(consumer)}>
            {consumer.source === 'project-attachment' ? 'Remove override' : 'Disconnect'}
          </RowButton>
        )}
        {!isConfigured && !deepLinkPath && onConnect && !canMakeDefault && !canProjectOverride && (
          <RowButton onClick={() => onConnect(consumer.consumerId, consumer.consumerKind)}>
            {projectScoped ? 'Project override' : 'Connect'}
          </RowButton>
        )}
        {deepLinkPath && !isConfigured && (
          <a
            href={deepLinkPath}
            className="text-xs text-accent font-medium no-underline px-2 py-1 rounded-sm hover:bg-accent-tint transition-colors whitespace-nowrap"
          >
            Configure
          </a>
        )}
      </div>
    </div>
  );
}

function RowButton({
  children,
  danger,
  onClick,
}: {
  children: ReactNode;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs font-medium bg-transparent border-none cursor-pointer px-2 py-1 rounded-sm transition-colors whitespace-nowrap ${
        danger
          ? 'text-danger hover:bg-[color-mix(in_srgb,var(--sam-color-danger)_10%,transparent)]'
          : 'text-accent hover:bg-accent-tint'
      }`}
    >
      {children}
    </button>
  );
}

function getStatusText(consumer: CCConsumerResolutionStatus): string {
  if (consumer.statusReason) {
    const reason = STATUS_REASON_LABELS[consumer.statusReason] ?? 'Broken credential configuration';
    return reason;
  }

  if (consumer.source === 'platform' || consumer.source === 'platform-proxy') {
    return consumer.source === 'platform-proxy'
      ? 'SAM platform proxy is active.'
      : 'SAM platform credential is active.';
  }

  if (consumer.source === 'halted') {
    return 'A disabled project override is blocking fallback.';
  }

  if (consumer.source === 'unresolved') {
    return 'No credential source is configured.';
  }

  const kind = consumer.credentialKind
    ? ` · ${KIND_LABELS[consumer.credentialKind] ?? consumer.credentialKind}`
    : '';
  const config = consumer.configurationName ? ` via ${consumer.configurationName}` : '';
  return `${consumer.credentialName ?? 'Credential'}${kind}${config}`;
}

const KIND_LABELS: Record<string, string> = {
  'api-key': 'API key',
  'oauth-token': 'OAuth token',
  'auth-json': 'Codex auth.json',
  'openai-compatible': 'OpenAI-compatible',
  'cloud-provider': 'Cloud provider',
};

const STATUS_REASON_LABELS: Record<string, string> = {
  'configuration-missing': 'Broken configuration: missing configuration row.',
  'configuration-inactive': 'Broken configuration: configuration is inactive.',
  'credential-missing': 'Broken configuration: credential is missing.',
  'credential-inactive': 'Broken configuration: credential is inactive.',
  'invalid-auth-json': 'Codex auth.json is invalid.',
};

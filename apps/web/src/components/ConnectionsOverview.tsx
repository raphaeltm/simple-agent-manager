/**
 * Connections overview — read-only view of how each agent and cloud provider
 * currently resolves for the authenticated user, optionally scoped to a project.
 *
 * Fetches GET /api/credentials/resolution-status and renders status rows with
 * resolution badges (project override / your default / SAM platform / halted / unresolved).
 */
import type { CCConsumerResolutionStatus } from '@simple-agent-manager/shared';
import { Alert, Spinner } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useState } from 'react';

import { getResolutionStatus } from '../lib/api';
import { ResolutionBadge } from './ResolutionBadge';

interface ConnectionsOverviewProps {
  projectId?: string;
  onConnect?: (consumerId: string, consumerKind: 'agent' | 'compute') => void;
}

export function ConnectionsOverview({ projectId, onConnect }: ConnectionsOverviewProps) {
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
  deepLinkPath,
}: {
  consumer: CCConsumerResolutionStatus;
  isLast: boolean;
  onConnect?: (consumerId: string, consumerKind: 'agent' | 'compute') => void;
  deepLinkPath?: string;
}) {
  const isConfigured = consumer.source !== 'unresolved' && consumer.source !== 'halted';

  return (
    <div
      className={`flex items-center gap-3 px-3 py-2.5 ${
        !isLast ? 'border-b border-border-default' : ''
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-fg-primary truncate">
          {consumer.consumerName}
        </div>
        {consumer.maskedLabel && (
          <div className="text-xs text-fg-muted truncate font-mono">
            {consumer.maskedLabel}
          </div>
        )}
      </div>

      <ResolutionBadge source={consumer.source} />

      {!isConfigured && !deepLinkPath && onConnect && (
        <button
          onClick={() => onConnect(consumer.consumerId, consumer.consumerKind)}
          className="text-xs text-accent font-medium bg-transparent border-none cursor-pointer px-2 py-1 rounded-sm hover:bg-accent-tint transition-colors whitespace-nowrap"
        >
          Connect
        </button>
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
  );
}

import { StatusBadge } from '@simple-agent-manager/ui';
import { ChevronRight, GitBranch, Globe, Server } from 'lucide-react';
import { Link } from 'react-router';

import type { DeploymentEnvironment } from '../../lib/api';
import {
  deriveServiceState,
  environmentBadgeStatus,
  serviceStateBadge,
  serviceStateLabel,
} from './deployment-status';

export function DeploymentEnvironmentSummaryCard({ env }: { env: DeploymentEnvironment }) {
  const serviceState = deriveServiceState(env);
  const release = env.latestRelease;
  const routeCount = env.routeHostnames.length;

  return (
    <Link
      to={env.id}
      className="glass-surface rounded-lg p-4 grid gap-3 no-underline text-fg-primary transition-colors hover:border-fg-muted focus-visible:outline-2 focus-visible:outline-accent"
    >
      <div className="flex items-center justify-between gap-3 min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <h2 className="sam-type-section-heading m-0 truncate max-w-[180px] sm:max-w-[280px]">
            {env.name}
          </h2>
          <StatusBadge status={environmentBadgeStatus(env.status)} label={env.status} />
        </div>
        <ChevronRight size={18} className="shrink-0 text-fg-muted" />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge
          status={serviceStateBadge(serviceState)}
          label={serviceStateLabel(serviceState)}
        />
        <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
          <GitBranch size={13} className="shrink-0" />
          {release ? `v${release.version} · ${release.status}` : 'No release'}
        </span>
      </div>

      <div className="flex items-center gap-4 flex-wrap text-xs text-fg-muted">
        <span className="inline-flex items-center gap-1 min-w-0">
          <Globe size={13} className="shrink-0" />
          {routeCount === 0 ? 'No routes' : `${routeCount} route${routeCount === 1 ? '' : 's'}`}
        </span>
        <span className="inline-flex items-center gap-1 min-w-0">
          <Server size={13} className="shrink-0" />
          {env.node ? (
            <span className="truncate max-w-[160px]">{env.node.name}</span>
          ) : (
            'No node'
          )}
        </span>
        {env.node && (
          <StatusBadge status={env.node.healthStatus || 'stale'} />
        )}
      </div>
    </Link>
  );
}

import type {
  CapacityPoolScope,
  SafeEffectiveCapacityPoolSummary,
} from '@simple-agent-manager/shared';
import { Link } from 'react-router';

import { knownProviderLocation, providerDisplayName } from '../../lib/compute-pool-offering-fields';
import { joinNatural } from './machine-labels';
import { TEXT_LINK_CLASS } from './styles';

const PRIMARY_LINK =
  'inline-flex min-h-9 items-center justify-center rounded-md border border-transparent bg-accent px-3 text-sm font-semibold text-fg-on-accent';

function locationName(provider: string, location: string): string {
  return knownProviderLocation(provider, location)?.name ?? location;
}

/** "Hetzner cx23, cx33 or cx43 in Falkenstein or Helsinki" from the safe summary. */
export function sharedMachinesPhrase(shared: SafeEffectiveCapacityPoolSummary): string | null {
  const offerings = shared.nativeOfferings ?? [];
  if (offerings.length === 0) return null;
  const providers = [
    ...new Set(offerings.map((offering) => providerDisplayName(offering.provider))),
  ];
  const types = [...new Set(offerings.map((offering) => offering.providerInstanceType))];
  const regions = [
    ...new Set(offerings.map((offering) => locationName(offering.provider, offering.location))),
  ];
  const where = regions.length > 4 ? `${regions.length} regions` : joinNatural(regions, 'or');
  return `${joinNatural(providers, 'and')} ${joinNatural(types, 'or')} in ${where}`;
}

interface ComputePoolEmptyStateProps {
  scope: CapacityPoolScope;
  projectId: string | null;
  shared: SafeEffectiveCapacityPoolSummary | undefined;
}

/**
 * Shown when this scope has no pool. If the installation still provides machines, say
 * so: work runs on them, so a personal cloud account is optional, not required.
 */
export function ComputePoolEmptyState({ scope, projectId, shared }: ComputePoolEmptyStateProps) {
  const sharedReady =
    shared?.scope === 'installation' &&
    shared.state === 'configured-ready' &&
    shared.availableCandidateCount > 0;
  const machines = sharedReady && shared ? sharedMachinesPhrase(shared) : null;

  if (scope === 'installation') {
    return (
      <div className="grid gap-3 rounded-md border border-border-default bg-inset p-4">
        <p className="m-0 font-medium text-fg-primary">No platform cloud account yet</p>
        <p className="m-0 text-sm text-fg-muted">
          Add a platform cloud credential so SAM can offer shared machines to people who do not have
          their own.
        </p>
        <Link to="/admin/credentials" className={`${PRIMARY_LINK} justify-self-start`}>
          Add a platform credential
        </Link>
      </div>
    );
  }

  const isProject = scope === 'project' && projectId;
  const connectHref = isProject
    ? `/projects/${projectId}/settings/connections`
    : '/settings/cloud-provider';
  const title = sharedReady
    ? isProject
      ? 'This project uses shared machines'
      : "You're using shared machines"
    : isProject
      ? 'No machines for this project yet'
      : 'No machines yet';
  const body = sharedReady
    ? `This installation provides the machines${machines ? ` (${machines})` : ''}. ${
        isProject
          ? 'Connect a cloud account to this project to give it machines of its own.'
          : 'Connect your own cloud account to choose your own machine types and regions.'
      }`
    : isProject
      ? 'Connect a cloud account to this project, or set up your personal compute pool.'
      : 'Connect a cloud account so SAM can start machines for your agents.';

  return (
    <div className="grid gap-3 rounded-md border border-border-default bg-inset p-4">
      <p className="m-0 font-medium text-fg-primary">{title}</p>
      <p className="m-0 text-sm text-fg-muted [overflow-wrap:anywhere]">{body}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link to={connectHref} className={PRIMARY_LINK}>
          {isProject ? 'Connect a cloud account to this project' : 'Connect a cloud account'}
        </Link>
        {isProject && (
          <Link to="/settings/infrastructure" className={`text-sm ${TEXT_LINK_CLASS}`}>
            Set up your personal pool
          </Link>
        )}
      </div>
    </div>
  );
}

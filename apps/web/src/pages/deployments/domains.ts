/**
 * Custom domains in words: each domain's state, the problems worth surfacing, and the
 * address people actually visit.
 */
import type { DeploymentCustomDomain, DeploymentEnvironment } from '../../lib/api';
import type { Tone } from './format';
import type { Problem } from './model';

/**
 * A domain that has never passed a DNS check is still being set up: the record usually
 * takes a while to appear, so a failed first check is "waiting", not a problem.
 */
function neverVerified(domain: DeploymentCustomDomain): boolean {
  return domain.verifiedAt === null && domain.verificationStatus !== 'verified';
}

export function domainProblems(domains: DeploymentCustomDomain[]): Problem[] {
  return domains
    .filter(
      (domain) =>
        domain.desiredState !== 'deactivating' &&
        (domain.cnameTarget === null ||
          (!neverVerified(domain) &&
            (domain.verificationStatus === 'failed' || domain.routeTargetChanged)))
    )
    .map((domain) => ({
      id: `domain-${domain.id}`,
      tone: 'warning' as const,
      title: `${domain.hostname} doesn't point here`,
      body:
        domain.cnameTarget === null
          ? 'The part of the app it was attached to is gone from the latest version.'
          : 'Its DNS record points somewhere else. Update the record, then check again.',
      fixes: ['domains' as const],
    }));
}

/** Plain words for a custom domain's state. */
export function domainState(domain: DeploymentCustomDomain): { label: string; tone: Tone } {
  if (domain.desiredState === 'deactivating') return { label: 'Removing', tone: 'muted' };
  if (domain.servingStatus === 'active') return { label: 'Working', tone: 'success' };
  if (domain.servingStatus === 'inactive_environment_stopped')
    return { label: 'Paused', tone: 'muted' };
  if (domain.servingStatus === 'activating' || domain.routingStatus === 'activating')
    return { label: 'Turning on', tone: 'info' };
  if (domain.cnameTarget === null) return { label: 'Not attached', tone: 'warning' };
  if (neverVerified(domain)) return { label: 'Waiting for DNS', tone: 'info' };
  if (domain.verificationStatus === 'failed' || domain.routeTargetChanged)
    return { label: 'Points elsewhere', tone: 'warning' };
  return { label: 'Waiting for DNS', tone: 'info' };
}

const KEPT_DOMAIN = new Set(['active', 'activating', 'inactive_environment_stopped']);

/**
 * The address people use: their own domain when it is set up, else the one SAM made. With the
 * environment's full domain list (the environment page) the domain's serving state decides;
 * without it (the list page), the routed hostnames the environment list returns do.
 */
export function primaryAddress(
  env: DeploymentEnvironment,
  domains?: DeploymentCustomDomain[]
): { hostname: string; custom: boolean } | null {
  const own = domains
    ? domains.find(
        (domain) => domain.desiredState !== 'deactivating' && KEPT_DOMAIN.has(domain.servingStatus)
      )?.hostname
    : env.customDomainHostnames?.[0];
  if (own) return { hostname: own, custom: true };
  const generated = env.routeHostnames[0];
  return generated ? { hostname: generated, custom: false } : null;
}

/**
 * PROTOTYPE plain-words model shared by both takes.
 *
 * Today the pages show three overlapping states per environment (lifecycle `active`,
 * service `Serving`, node `Healthy`) that can contradict each other: a green `active`
 * next to a red `Not serving`. This module reduces everything to ONE health, one
 * sentence, and a list of problems that each name the fix.
 *
 * It reads only signals production sends today:
 * - environment status, and the node's observed apply status + applied version
 *   (`packages/vm-agent/internal/deploy/types.go`: applied, applying, failed, reverted,
 *   failed-initial), its error, and per-service state;
 * - the deployment server's heartbeat health;
 * - release rows and custom-domain rows.
 * `observedDeployment.deployStatus` (the six-dimension model in `deploy/status.go`) is read
 * when present, in the agent's own vocabulary, but no agent sends it yet.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';

import { objectRecord, serviceRecords } from '../../components/deployments/deployment-status';
import type { DeploymentCustomDomain, DeploymentEnvironment } from '../../lib/api';
import { formatTimeFromNow } from '../../lib/time-utils';
import type { ReleaseRecord } from './data';

export type Health = 'live' | 'trouble' | 'deploying' | 'starting' | 'pausing' | 'paused' | 'down' | 'new';

export type Tone = 'success' | 'info' | 'warning' | 'danger' | 'muted';

export interface HealthInfo {
  health: Health;
  /** Short label for a pill or the hero. */
  label: string;
  /** One plain sentence that says what is going on. */
  sentence: string;
  tone: Tone;
  /** The version the server is running right now, if any. */
  liveVersion: number | null;
}

export type Fix = 'ask-agent' | 'redeploy' | 'logs' | 'server' | 'domains' | 'start' | 'pause' | 'access';

/** Fixes that hand the problem to an agent; pointless while agents may not deploy here. */
export const ASKS_AGENT: ReadonlySet<Fix> = new Set<Fix>(['ask-agent', 'redeploy']);

export interface Problem {
  id: string;
  tone: 'danger' | 'warning';
  title: string;
  body: string;
  /** Raw error text, shown on request rather than as the headline. */
  detail?: string;
  fixes: Fix[];
}

export const TONE_COLOR: Record<Tone, string> = {
  success: 'var(--sam-color-success-fg)',
  info: 'var(--sam-color-info-fg)',
  warning: 'var(--sam-color-warning-fg)',
  danger: 'var(--sam-color-danger-fg)',
  muted: 'var(--sam-color-fg-muted)',
};

export const tint = (color: string, percent = 14) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const time = new Date(iso).getTime();
  return Number.isNaN(time) ? iso : formatTimeFromNow(time);
}

/** "3 hours", "25 minutes", "2 days": how long since a moment, for "hasn't … for X". */
export function since(iso: string | null | undefined): string {
  if (!iso) return 'a while';
  const minutes = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  return `${Math.round(hours / 24)} days`;
}

const FAILED_RELEASE = new Set(['failed', 'reverted']);

/** Placement errors can be capacity, a server limit, quota or a credential, so stay neutral. */
export const PLACEMENT_BODY =
  "No server was created, so nothing ran. The reason is below. If the cloud was out of room, deploying again usually works; a limit or a credential needs fixing first.";
const IN_FLIGHT_RELEASE = new Set(['created', 'applying']);

/**
 * What went wrong when the failure did not come from the app itself. The API records these
 * as free text on `observedErrorMessage`, so they are told apart by their fixed prefixes:
 * - placement: `Deployment node placement failed: …` / `… stopped before a server was created: …`
 *   (`markDeploymentReleasePlacementFailed`, `recordStrandedDeploymentReleasePlacement`);
 * - pause: `Stop failed …` (`markEnvironmentStopFailed`, deployment-environment-lifecycle.ts);
 * - start: anything else on an `error` environment with no server linked
 *   (`markEnvironmentStartFailed` clears the node). A deploy failure leaves the server linked.
 * NEEDS API: a typed failure kind instead of matching text.
 */
export type FailureKind = 'placement' | 'pause' | 'start';

export function failureKind(env: DeploymentEnvironment): FailureKind | null {
  const error = env.observedDeployment.errorMessage;
  if (!error) return null;
  if (/^Deployment node placement/i.test(error)) return 'placement';
  if (/^Stop failed/i.test(error)) return 'pause';
  if (env.status === 'error' && !env.nodeId && env.observedDeployment.status === 'failed') return 'start';
  return null;
}

/** The newest version never reached a server: there are no steps or logs, only a retry. */
export function placementFailed(env: DeploymentEnvironment): boolean {
  return Boolean(env.latestRelease) && failureKind(env) === 'placement';
}

/**
 * The server's heartbeat state as one of three facts. `stale` and `unhealthy` both mean
 * "no check-in": `unhealthy` is the longer silence, past twice the stale window
 * (`deriveNodeHealth`, apps/api/src/services/node-health.ts). Neither says anything about
 * memory or CPU.
 */
export function serverSilent(env: DeploymentEnvironment): boolean {
  const node = env.node;
  // A server still being created has not had a chance to check in yet.
  if (!node || node.status === 'pending' || node.status === 'creating') return false;
  return node.healthStatus === 'stale' || node.healthStatus === 'unhealthy';
}

/**
 * The version that is serving visitors right now. Only an `active` environment serves,
 * and only `applied` or `reverted` mean a version is up: during `applying` the node has
 * already stopped the previous version (deploy/engine.go tears it down to free ports), and
 * `failed` after a revert attempt means the previous version did not come back either.
 */
export function liveVersionOf(env: DeploymentEnvironment): number | null {
  // Heartbeats only update `active` and `starting` environments and tell the server to retire
  // every other one (`node-lifecycle.ts`), so an `error` or stopped environment's observed
  // version is frozen, not live.
  if (env.status !== 'active') return null;
  const observed = env.observedDeployment;
  const applied = typeof observed.appliedSeq === 'number' && observed.appliedSeq > 0 ? observed.appliedSeq : null;
  if (observed.status === 'applied' || observed.status === 'reverted') return applied;
  if (observed.status === null && env.latestRelease?.status === 'applied') return env.latestRelease.version;
  return null;
}

/**
 * Start resets the latest release to `created` and keeps the environment `starting` until the
 * server applies it (`markEnvironmentStarting`), and an agent can deploy into an `error`
 * environment, so a deploy can be under way in all three statuses.
 */
const DEPLOYABLE = new Set(['active', 'starting', 'error']);

function isDeploying(env: DeploymentEnvironment): boolean {
  if (!DEPLOYABLE.has(env.status)) return false;
  return env.observedDeployment.status === 'applying' || IN_FLIGHT_RELEASE.has(env.latestRelease?.status ?? '');
}

/** Start re-applies the LATEST release on a fresh server (deployment-environment-lifecycle.ts). */
export function versionOnStart(env: DeploymentEnvironment): { version: number; failedBefore: boolean } | null {
  const release = env.latestRelease;
  return release ? { version: release.version, failedBefore: FAILED_RELEASE.has(release.status) } : null;
}

export function describeHealth(env: DeploymentEnvironment): HealthInfo {
  const live = liveVersionOf(env);
  const release = env.latestRelease;
  const base = { liveVersion: live };

  if (env.status === 'stopped') {
    const next = versionOnStart(env);
    return {
      ...base,
      health: 'paused',
      label: 'Paused',
      tone: 'muted',
      sentence: !next
        ? 'Not running. Settings and saved data are kept.'
        : next.failedBefore
          ? `Not running. Starting tries version ${next.version} again, which didn't start last time.`
          : `Not running. Starting brings version ${next.version} back with its saved data.`,
    };
  }
  if (env.status === 'stopping') {
    return { ...base, health: 'pausing', label: 'Pausing', tone: 'muted', sentence: 'Stopping the app and detaching its disks.' };
  }
  if (env.status === 'starting') {
    return {
      ...base,
      health: 'starting',
      label: 'Starting',
      tone: 'info',
      sentence: release ? `Getting a server ready for version ${release.version}.` : 'Getting a server ready.',
    };
  }
  if (!release) {
    return { ...base, health: 'new', label: 'Not deployed yet', tone: 'muted', sentence: 'Nothing runs here until an agent deploys to it.' };
  }
  if (isDeploying(env)) {
    return {
      ...base,
      health: 'deploying',
      label: `Deploying v${release.version}`,
      tone: 'info',
      sentence:
        env.observedDeployment.appliedSeq && release.version > 1
          ? `Version ${release.version} is starting. The app is offline until it's up.`
          : `Version ${release.version} is starting for the first time.`,
    };
  }
  if (!live) {
    const kind = failureKind(env);
    const observed = env.observedDeployment.status;
    if (kind === 'pause') {
      return {
        ...base,
        health: 'down',
        label: "Pause didn't finish",
        tone: 'danger',
        sentence: 'SAM stopped partway, so the app may still be running.',
      };
    }
    return {
      ...base,
      health: 'down',
      label: 'Down',
      tone: 'danger',
      sentence:
        kind === 'placement'
          ? `SAM couldn't get a server for version ${release.version}, so nothing is running.`
          : kind === 'start'
            ? `Starting didn't finish, so nothing is running.`
            : observed === 'failed' && env.observedDeployment.appliedSeq
              ? `Version ${release.version} didn't start, and the previous version didn't come back.`
              : FAILED_RELEASE.has(release.status) || observed === 'failed-initial'
                ? `Version ${release.version} didn't start, and nothing else is running.`
                : "The app isn't running.",
    };
  }
  const first = describeProblems(env)[0];
  if (first) {
    return { ...base, health: 'trouble', label: 'Needs attention', tone: 'warning', sentence: `Running version ${live}. ${first.title}.` };
  }
  return { ...base, health: 'live', label: 'Live', tone: 'success', sentence: `Running version ${live}.` };
}

export function describeProblems(env: DeploymentEnvironment): Problem[] {
  if (env.status === 'stopped' || env.status === 'stopping') return [];
  const problems: Problem[] = [];
  const release = env.latestRelease;
  const live = liveVersionOf(env);
  const observed = env.observedDeployment;
  const error = observed.errorMessage ?? undefined;
  const status = objectRecord(observed.deployStatus) ?? {};
  const kind = failureKind(env);

  if (release && kind === 'placement') {
    problems.push({
      id: 'placement',
      tone: 'danger',
      title: `SAM couldn't get a server for version ${release.version}`,
      body: PLACEMENT_BODY,
      detail: error,
      fixes: ['redeploy'],
    });
  } else if (kind === 'pause') {
    problems.push({
      id: 'pause-failed',
      tone: 'danger',
      title: "Pausing didn't finish",
      body: 'The app may still be running, and its disks may still be attached. Pause again to finish.',
      detail: error,
      fixes: ['pause', 'server'],
    });
  } else if (release && kind === 'start') {
    problems.push({
      id: 'start-failed',
      tone: 'danger',
      title: "Starting didn't finish",
      body: `SAM couldn't put version ${release.version} back on a server. Starting again usually works.`,
      detail: error,
      fixes: ['start'],
    });
  } else if (release && FAILED_RELEASE.has(release.status) && !isDeploying(env)) {
    problems.push({
      id: 'release-failed',
      tone: live ? 'warning' : 'danger',
      title: `Version ${release.version} didn't start`,
      body: live
        ? `Version ${live} came back and is serving visitors. Fix the problem and deploy again.`
        : 'Nothing is running. Fix the problem and deploy again.',
      detail: error,
      fixes: ['ask-agent', 'logs'],
    });
  }
  if (serverSilent(env)) {
    problems.push({
      id: 'server-silent',
      tone: 'danger',
      title: `The server hasn't checked in for ${since(env.node?.lastHeartbeatAt)}`,
      body: "Your app may still be up, but SAM can't see it or deploy to it until the server reconnects.",
      detail: env.node?.errorMessage ?? undefined,
      fixes: ['server'],
    });
  }
  if (live) {
    const down = serviceRecords(observed.services).filter(
      (service) => service.status !== 'running' || service.health === 'unhealthy'
    );
    if (down.length > 0) {
      problems.push({
        id: 'services',
        tone: 'danger',
        title: down.length === 1 ? `${String(down[0]?.name ?? 'A service')} isn't running properly` : `${down.length} parts of the app aren't running properly`,
        body: 'The logs usually say why.',
        fixes: ['logs', 'ask-agent'],
      });
    }
  }
  // The six-dimension status (deploy/status.go). Not sent by any agent yet; read when present.
  if (status.routeCertState === 'failed') {
    problems.push({ id: 'https-failed', tone: 'danger', title: "HTTPS isn't working", body: 'Visitors see a security warning. A DNS record pointing elsewhere is the usual cause.', fixes: ['domains', 'logs'] });
  } else if (status.routeCertState === 'pending') {
    problems.push({ id: 'https-pending', tone: 'warning', title: "HTTPS isn't ready yet", body: 'Certificates usually arrive a few minutes after a new address goes live.', fixes: ['logs'] });
  }
  if (status.diskPressure === 'high' || status.diskPressure === 'critical') {
    problems.push({ id: 'disk-full', tone: status.diskPressure === 'critical' ? 'danger' : 'warning', title: "The server's disk is almost full", body: 'When it fills up the app stops writing data.', fixes: ['server', 'ask-agent'] });
  }
  if (status.providerManageability === 'management-degraded') {
    problems.push({ id: 'provider', tone: 'warning', title: "SAM lost access to this server's cloud account", body: 'Pausing or deleting may not finish until the cloud credential works again.', fixes: ['server'] });
  }
  return problems;
}

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
          (!neverVerified(domain) && (domain.verificationStatus === 'failed' || domain.routeTargetChanged)))
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
  if (domain.servingStatus === 'inactive_environment_stopped') return { label: 'Paused', tone: 'muted' };
  if (domain.servingStatus === 'activating' || domain.routingStatus === 'activating') return { label: 'Turning on', tone: 'info' };
  if (domain.cnameTarget === null) return { label: 'Not attached', tone: 'warning' };
  if (neverVerified(domain)) return { label: 'Waiting for DNS', tone: 'info' };
  if (domain.verificationStatus === 'failed' || domain.routeTargetChanged) return { label: 'Points elsewhere', tone: 'warning' };
  return { label: 'Waiting for DNS', tone: 'info' };
}

export function agentAccess(env: DeploymentEnvironment, profiles: AgentProfile[]) {
  const policy = env.agentPolicy;
  const names = policy.allowedDeployProfileIds.map(
    (id) => profiles.find((profile) => profile.id === id)?.name ?? 'a removed profile'
  );
  if (!policy.agentDeployEnabled) {
    return { on: false, mode: 'off' as const, names, sentence: "Agents can't deploy here" };
  }
  if (names.length === 0) {
    return { on: true, mode: 'any' as const, names, sentence: 'Any agent in this project can deploy' };
  }
  return {
    on: true,
    mode: 'some' as const,
    names,
    sentence: names.length === 1 ? `Only ${names[0]} can deploy` : `Only ${names.length} agent profiles can deploy`,
  };
}

/** Whether "Ask an agent" can lead anywhere: deploys must be on for the environment. */
export function canAskAgent(env: DeploymentEnvironment): boolean {
  return env.agentPolicy.agentDeployEnabled && (env.status === 'active' || env.status === 'error');
}

export function profileNameOf(id: string | null | undefined, profiles: AgentProfile[]): string | null {
  if (!id) return null;
  return profiles.find((profile) => profile.id === id)?.name ?? null;
}

/**
 * What a release did, in words, relative to what runs now. Only the newest release can be
 * deploying; an older one still `created` was replaced before any server picked it up.
 */
export function releaseOutcome(
  release: ReleaseRecord,
  env: DeploymentEnvironment
): { label: string; tone: Tone } {
  const live = liveVersionOf(env);
  const newest = release.id === env.latestRelease?.id;
  if (release.version === live) return { label: 'Live', tone: 'success' };
  if (newest && env.status === 'stopped') return { label: 'Comes back on start', tone: 'muted' };
  if (newest && isDeploying(env)) return { label: 'Deploying', tone: 'info' };
  if (FAILED_RELEASE.has(release.status)) return { label: "Didn't start", tone: 'danger' };
  if (IN_FLIGHT_RELEASE.has(release.status)) return { label: 'Skipped', tone: 'muted' };
  // The newest version ran, but the server can't confirm it still does (a pause that
  // stopped partway, for one).
  if (newest && release.status === 'applied') return { label: 'May still be running', tone: 'muted' };
  return { label: 'Replaced', tone: 'muted' };
}

const KEPT_DOMAIN = new Set(['active', 'activating', 'inactive_environment_stopped']);

/** The address people use: their own domain when it is set up, else the one SAM made. */
export function primaryAddress(
  env: DeploymentEnvironment,
  domains: DeploymentCustomDomain[] | undefined
): { hostname: string; custom: boolean } | null {
  const own = domains?.find((domain) => domain.desiredState !== 'deactivating' && KEPT_DOMAIN.has(domain.servingStatus));
  if (own) return { hostname: own.hostname, custom: true };
  const generated = env.routeHostnames[0];
  return generated ? { hostname: generated, custom: false } : null;
}

/** Whether visiting the address should work right now. During a deploy it does not. */
export function isAnswering(health: Health): boolean {
  return health === 'live' || health === 'trouble';
}

const HEALTH_ORDER: Record<Health, number> = { down: 0, trouble: 1, deploying: 2, starting: 3, live: 4, pausing: 5, new: 6, paused: 7 };

/** Problems first, then what is running, then what is not. Name breaks ties. */
export function sortForAttention(envs: DeploymentEnvironment[]): DeploymentEnvironment[] {
  return [...envs].sort((a, b) => {
    const order = HEALTH_ORDER[describeHealth(a).health] - HEALTH_ORDER[describeHealth(b).health];
    return order !== 0 ? order : a.name.localeCompare(b.name);
  });
}

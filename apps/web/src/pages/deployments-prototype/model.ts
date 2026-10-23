/**
 * PROTOTYPE plain-words model shared by both takes.
 *
 * Today the pages show three overlapping states per environment (lifecycle `active`,
 * service `Serving`, node `Healthy`) that can contradict each other: a green `active`
 * next to a red `Not serving`. This module reduces everything to ONE health, one
 * sentence, and a list of problems that each name the fix.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';

import { objectRecord } from '../../components/deployments/deployment-status';
import type { DeploymentCustomDomain, DeploymentEnvironment } from '../../lib/api';
import { formatTimeFromNow } from '../../lib/time-utils';
import type { ReleaseRecord } from './data';

export type Health =
  | 'live'
  | 'trouble'
  | 'deploying'
  | 'starting'
  | 'pausing'
  | 'paused'
  | 'down'
  | 'new';

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

export type Fix = 'ask-agent' | 'logs' | 'server' | 'domains' | 'start' | 'access';

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

export const tint = (color: string, percent = 14) =>
  `color-mix(in srgb, ${color} ${percent}%, transparent)`;

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

/** The version the server runs right now. Null while paused or before the first success. */
export function liveVersionOf(env: DeploymentEnvironment): number | null {
  if (env.status === 'stopped' || env.status === 'stopping') return null;
  const applied = env.observedDeployment.appliedSeq;
  if (typeof applied === 'number' && applied > 0) return applied;
  return env.latestRelease?.status === 'applied' ? env.latestRelease.version : null;
}

/** The newest version that ever ran here: what comes back when a paused app starts. */
export function lastGoodVersion(env: DeploymentEnvironment, releases?: ReleaseRecord[]): number | null {
  const fromHistory = releases?.find((release) => release.status === 'applied')?.version;
  if (fromHistory !== undefined) return fromHistory;
  return env.latestRelease?.status === 'applied' ? env.latestRelease.version : null;
}

const FAILED_RELEASE = new Set(['failed', 'reverted']);

export function describeHealth(env: DeploymentEnvironment): HealthInfo {
  const live = liveVersionOf(env);
  const release = env.latestRelease;
  const base = { liveVersion: live };

  if (env.status === 'stopped') {
    const last = lastGoodVersion(env);
    return {
      ...base,
      health: 'paused',
      label: 'Paused',
      tone: 'muted',
      sentence: last
        ? `Not running. Version ${last}, its settings and its data come back when you start it.`
        : 'Not running. Settings and saved data are kept.',
    };
  }
  if (env.status === 'stopping') {
    return { ...base, health: 'pausing', label: 'Pausing', tone: 'muted', sentence: 'Shutting the app down and freeing its server.' };
  }
  if (env.status === 'starting') {
    return {
      ...base,
      health: 'starting',
      label: 'Starting',
      tone: 'info',
      sentence: release
        ? `Getting a server ready and bringing version ${release.version} back.`
        : 'Getting a server ready.',
    };
  }
  if (!release) {
    return {
      ...base,
      health: 'new',
      label: 'Not deployed yet',
      tone: 'muted',
      sentence: 'Nothing runs here until an agent deploys to it.',
    };
  }
  if ((release.status === 'applying' || release.status === 'created') && release.version !== live) {
    return {
      ...base,
      health: 'deploying',
      label: `Deploying v${release.version}`,
      tone: 'info',
      sentence: live
        ? `Version ${live} stays live until version ${release.version} is ready.`
        : `Deploying version ${release.version} for the first time.`,
    };
  }
  // "Down" only when nothing runs. A failed deploy over a working version is not an
  // outage: today's page calls that "Not serving", which is the contradiction we fix.
  if (!live) {
    return {
      ...base,
      health: 'down',
      label: 'Down',
      tone: 'danger',
      sentence: FAILED_RELEASE.has(release.status)
        ? `Version ${release.version} didn't start, and no earlier version is running.`
        : "The app isn't running.",
    };
  }
  const first = describeProblems(env)[0];
  if (first) {
    return { ...base, health: 'trouble', label: 'Needs attention', tone: 'warning', sentence: `Running version ${live}. ${first.title}.` };
  }
  return { ...base, health: 'live', label: 'Live', tone: 'success', sentence: `Running version ${live}.` };
}

function pct(value: unknown): string | null {
  const n = Number(value);
  return Number.isFinite(n) ? `${Math.round(n)}%` : null;
}

export function describeProblems(env: DeploymentEnvironment): Problem[] {
  if (env.status === 'stopped' || env.status === 'stopping') return [];
  const problems: Problem[] = [];
  const release = env.latestRelease;
  const live = liveVersionOf(env);
  const status = objectRecord(env.observedDeployment.deployStatus) ?? {};
  const disk = objectRecord(objectRecord(env.observedDeployment.diskTelemetry)?.rootDisk);
  const nodeHealth = (status.nodeHealth as string | undefined) ?? env.node?.healthStatus;
  const error = env.observedDeployment.errorMessage ?? undefined;

  if (release && FAILED_RELEASE.has(release.status)) {
    problems.push({
      id: 'release-failed',
      tone: live ? 'warning' : 'danger',
      title: `Version ${release.version} didn't start`,
      body: live
        ? `Visitors still get version ${live}. Fix the problem and deploy again.`
        : 'Nothing is live yet. Fix the problem and deploy again.',
      detail: error,
      fixes: ['ask-agent', 'logs'],
    });
  } else if (env.status === 'error' && error) {
    problems.push({
      id: 'placement',
      tone: 'danger',
      title: "SAM couldn't get a server for this app",
      body: 'Deploying again, or pausing and starting again, usually sorts it out.',
      detail: error,
      fixes: ['ask-agent', 'logs'],
    });
  }
  if (nodeHealth === 'stale') {
    problems.push({
      id: 'server-silent',
      tone: 'danger',
      title: `The server hasn't checked in for ${since(env.node?.lastHeartbeatAt)}`,
      body: "Your app may still be up, but SAM can't watch it or deploy to it until the server reconnects.",
      detail: env.node?.errorMessage ?? undefined,
      fixes: ['server', 'logs'],
    });
  } else if (nodeHealth === 'unhealthy') {
    problems.push({
      id: 'server-struggling',
      tone: 'warning',
      title: 'The server is struggling',
      body: 'It is short on memory or CPU, so the app may be slow.',
      fixes: ['server'],
    });
  }
  if (status.appHealth === 'unhealthy' && !problems.some((p) => p.id === 'release-failed')) {
    problems.push({
      id: 'app-unhealthy',
      tone: 'danger',
      title: 'The app is running but not answering properly',
      body: 'Its health check is failing. The logs usually say why.',
      fixes: ['logs', 'ask-agent'],
    });
  }
  if (status.routeCertState === 'pending') {
    problems.push({
      id: 'https-pending',
      tone: 'warning',
      title: "HTTPS isn't ready yet",
      body: 'Certificates usually arrive a few minutes after a new address goes live.',
      fixes: ['logs'],
    });
  } else if (status.routeCertState === 'error') {
    problems.push({
      id: 'https-failed',
      tone: 'danger',
      title: "HTTPS couldn't be set up",
      body: 'Visitors will see a security warning. This is usually a DNS record pointing somewhere else.',
      fixes: ['domains', 'logs'],
    });
  }
  if (status.diskPressure === 'high' || status.diskPressure === 'critical') {
    const used = pct(disk?.usedPercent);
    problems.push({
      id: 'disk-full',
      tone: status.diskPressure === 'critical' ? 'danger' : 'warning',
      title: used ? `The server's disk is ${used} full` : "The server's disk is almost full",
      body: 'When it fills up the app stops writing data. Clear old files or give the app a bigger disk.',
      fixes: ['ask-agent', 'server'],
    });
  }
  if (status.configDrift === 'drifted') {
    problems.push({
      id: 'settings-changed',
      tone: 'warning',
      title: 'Settings changed since the last deploy',
      body: 'The app still uses the old values. Deploy again to pick up the new ones.',
      fixes: ['ask-agent'],
    });
  }
  if (status.providerManageability === 'unmanageable') {
    problems.push({
      id: 'provider',
      tone: 'warning',
      title: "Your cloud provider won't let SAM manage this server",
      body: 'Pausing or deleting may not finish. Check the server in your cloud account.',
      fixes: ['server'],
    });
  }
  return problems;
}

export function domainProblems(domains: DeploymentCustomDomain[]): Problem[] {
  return domains
    .filter(
      (domain) =>
        domain.desiredState !== 'deactivating' &&
        (domain.verificationStatus === 'failed' || domain.routeTargetChanged || domain.cnameTarget === null)
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
  if (domain.servingStatus === 'activating' || domain.routingStatus === 'activating')
    return { label: 'Turning on', tone: 'info' };
  if (domain.cnameTarget === null) return { label: 'Not attached', tone: 'warning' };
  if (domain.verificationStatus === 'failed' || domain.routeTargetChanged)
    return { label: 'Points elsewhere', tone: 'warning' };
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

export function profileNameOf(id: string | null | undefined, profiles: AgentProfile[]): string | null {
  if (!id) return null;
  return profiles.find((profile) => profile.id === id)?.name ?? null;
}

/** What a release did, in words, relative to what runs now (or what a paused app brings back). */
export function releaseOutcome(
  release: ReleaseRecord,
  live: number | null,
  pausedVersion: number | null = null
): { label: string; tone: Tone } {
  if (release.version === live) return { label: 'Live', tone: 'success' };
  if (release.version === pausedVersion) return { label: 'Paused', tone: 'muted' };
  if (FAILED_RELEASE.has(release.status)) return { label: "Didn't start", tone: 'danger' };
  if (release.status === 'applying' || release.status === 'created')
    return { label: 'Deploying', tone: 'info' };
  return { label: 'Replaced', tone: 'muted' };
}

const KEPT_DOMAIN = new Set(['active', 'activating', 'inactive_environment_stopped']);

/** The address people use: their own domain when it is set up, else the one SAM made. */
export function primaryAddress(
  env: DeploymentEnvironment,
  domains: DeploymentCustomDomain[] | undefined
): { hostname: string; custom: boolean } | null {
  const own = domains?.find(
    (domain) => domain.desiredState !== 'deactivating' && KEPT_DOMAIN.has(domain.servingStatus)
  );
  if (own) return { hostname: own.hostname, custom: true };
  const generated = env.routeHostnames[0];
  return generated ? { hostname: generated, custom: false } : null;
}

/** Whether visiting the address should work right now. */
export function isAnswering(health: Health): boolean {
  return health === 'live' || health === 'trouble' || health === 'deploying';
}

const HEALTH_ORDER: Record<Health, number> = {
  down: 0,
  trouble: 1,
  deploying: 2,
  starting: 3,
  live: 4,
  pausing: 5,
  new: 6,
  paused: 7,
};

/** Problems first, then what is running, then what is not. Name breaks ties. */
export function sortForAttention(envs: DeploymentEnvironment[]): DeploymentEnvironment[] {
  return [...envs].sort((a, b) => {
    const order = HEALTH_ORDER[describeHealth(a).health] - HEALTH_ORDER[describeHealth(b).health];
    return order !== 0 ? order : a.name.localeCompare(b.name);
  });
}

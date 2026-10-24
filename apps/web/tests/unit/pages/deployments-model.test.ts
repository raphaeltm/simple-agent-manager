import {
  DEPLOYMENT_PLACEMENT_ERROR_PREFIX,
  DEPLOYMENT_STOP_ERROR_PREFIX,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import type {
  DeploymentCustomDomain,
  DeploymentEnvironment,
  DeploymentReleaseSummary,
} from '../../../src/lib/api';
import { domainProblems, domainState } from '../../../src/pages/deployments/domains';
import {
  describeHealth,
  describeProblems,
  failureKind,
  liveVersionOf,
  releaseOutcome,
  serverSilent,
  versionOnStart,
} from '../../../src/pages/deployments/model';

const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function release(version: number, status: string, id = `rel-${version}`): DeploymentReleaseSummary {
  return { id, environmentId: 'env-1', version, status, createdBy: 'user-1', createdAt: ago(HOUR) };
}

type EnvOverrides = Partial<Omit<DeploymentEnvironment, 'observedDeployment' | 'node'>> & {
  observed?: Partial<DeploymentEnvironment['observedDeployment']>;
  node?: Partial<NonNullable<DeploymentEnvironment['node']>> | null;
};

function env(overrides: EnvOverrides = {}): DeploymentEnvironment {
  const { observed, node, ...rest } = overrides;
  return {
    id: 'env-1',
    projectId: 'proj-1',
    name: 'staging',
    status: 'active',
    nodeId: 'node-1',
    provider: 'hetzner',
    location: 'nbg1',
    createdAt: ago(10 * HOUR),
    updatedAt: ago(HOUR),
    secretsUpdatedAt: null,
    agentPolicy: {
      agentDeployEnabled: true,
      agentDeployEnabledBy: 'user-1',
      agentDeployEnabledAt: ago(10 * HOUR),
      agentDeployDisabledAt: null,
      allowedDeployProfileIds: [],
    },
    latestRelease: release(42, 'applied'),
    routeHostnames: ['r1-web-3000-env-1.apps.example.com'],
    ...rest,
    observedDeployment: {
      appliedSeq: 42,
      status: 'applied',
      errorMessage: null,
      services: [{ name: 'web', status: 'running', health: 'healthy' }],
      deployStatus: null,
      diskTelemetry: null,
      observedAt: ago(60_000),
      ...observed,
    },
    node:
      node === null
        ? null
        : ({
            id: 'node-1',
            name: 'deploy-staging-01',
            status: 'running',
            healthStatus: 'healthy',
            lastHeartbeatAt: ago(60_000),
            ...node,
          } as DeploymentEnvironment['node']),
  };
}

describe('liveVersionOf', () => {
  it('is the applied version while the environment is active and the node reports it up', () => {
    expect(liveVersionOf(env())).toBe(42);
    expect(liveVersionOf(env({ observed: { status: 'reverted', appliedSeq: 42 } }))).toBe(42);
  });

  it('is nothing while a deploy applies: the old version is already stopped', () => {
    expect(liveVersionOf(env({ observed: { status: 'applying', appliedSeq: 43 } }))).toBeNull();
  });

  it('is nothing when the revert failed too, although the old version number is still reported', () => {
    expect(liveVersionOf(env({ observed: { status: 'failed', appliedSeq: 42 } }))).toBeNull();
  });

  it('is nothing for error and stopped environments, whose observed fields are frozen', () => {
    // Heartbeats only update active/starting environments and retire the rest.
    expect(liveVersionOf(env({ status: 'error' }))).toBeNull();
    expect(liveVersionOf(env({ status: 'stopped' }))).toBeNull();
  });
});

describe('describeHealth', () => {
  it('says a live app is running its version', () => {
    expect(describeHealth(env())).toMatchObject({
      health: 'live',
      sentence: 'Running version 42.',
    });
  });

  it('calls a failed deploy over a working version "Needs attention", not "Down"', () => {
    const info = describeHealth(
      env({
        latestRelease: release(43, 'failed'),
        observed: { status: 'reverted', appliedSeq: 42 },
      })
    );
    expect(info).toMatchObject({
      health: 'trouble',
      label: 'Needs attention',
      liveVersion: 42,
      tone: 'warning',
    });
    // The problem list says what went wrong; the status says only what runs.
    expect(info.sentence).toBe('Running version 42.');
    expect(describeProblems(env({ latestRelease: release(43, 'failed') }))[0]?.title).toBe(
      "Version 43 didn't start"
    );
  });

  it('takes the tone of the worst problem, so a part that is down is not a mere warning', () => {
    const info = describeHealth(
      env({
        observed: {
          services: [
            { name: 'web', status: 'running', health: 'healthy' },
            { name: 'worker', status: 'exited', health: 'unhealthy' },
          ],
        },
      })
    );
    expect(info).toMatchObject({ health: 'trouble', tone: 'danger' });
  });

  it('says a deploy takes the app offline until the new version is up', () => {
    const info = describeHealth(
      env({
        latestRelease: release(43, 'applying'),
        observed: { status: 'applying', appliedSeq: 43 },
      })
    );
    expect(info).toMatchObject({ health: 'deploying', label: 'Deploying v43' });
    expect(info.sentence).toBe("Version 43 is starting. The app is offline until it's up.");
  });

  it('says what Start brings back, and warns when that version failed last time', () => {
    expect(describeHealth(env({ status: 'stopped' })).sentence).toBe(
      'Not running. Starting brings version 42 back with its saved data.'
    );
    expect(
      describeHealth(env({ status: 'stopped', latestRelease: release(43, 'failed') })).sentence
    ).toBe("Not running. Starting tries version 43 again, which didn't start last time.");
    expect(
      versionOnStart(env({ status: 'stopped', latestRelease: release(43, 'failed') }))
    ).toEqual({
      version: 43,
      failedBefore: true,
    });
  });

  it('tells a placement failure, a failed start and a failed pause apart', () => {
    const placement = env({
      status: 'error',
      nodeId: null,
      node: null,
      latestRelease: release(1, 'failed'),
      observed: {
        status: 'failed',
        appliedSeq: null,
        errorMessage: `${DEPLOYMENT_PLACEMENT_ERROR_PREFIX} failed: hetzner has no cx32 capacity in nbg1`,
      },
    });
    expect(failureKind(placement)).toBe('placement');
    expect(describeHealth(placement).sentence).toBe(
      "SAM couldn't get a server for version 1, so nothing is running."
    );

    const start = env({
      status: 'error',
      nodeId: null,
      node: null,
      observed: { status: 'failed', errorMessage: 'provider token expired' },
    });
    expect(failureKind(start)).toBe('start');
    expect(describeHealth(start).sentence).toBe("Starting didn't finish, so nothing is running.");

    const pause = env({
      status: 'error',
      observed: {
        status: 'failed',
        errorMessage: `${DEPLOYMENT_STOP_ERROR_PREFIX} while tearing down the deployment node: timeout`,
      },
    });
    expect(failureKind(pause)).toBe('pause');
    expect(describeHealth(pause)).toMatchObject({
      label: "Pause didn't finish",
      sentence: 'SAM stopped partway, so the app may still be running.',
    });
  });

  it('says a new environment has nothing running until an agent deploys', () => {
    expect(
      describeHealth(env({ latestRelease: null, observed: { status: null, appliedSeq: null } }))
    ).toMatchObject({
      health: 'new',
      sentence: 'Nothing runs here until an agent deploys to it.',
    });
  });
});

describe('describeProblems', () => {
  it('offers to deploy again for a placement failure, with neutral words and the reason', () => {
    const problems = describeProblems(
      env({
        status: 'error',
        nodeId: null,
        node: null,
        latestRelease: release(1, 'failed'),
        observed: {
          status: 'failed',
          appliedSeq: null,
          errorMessage: `${DEPLOYMENT_PLACEMENT_ERROR_PREFIX} failed: quota`,
        },
      })
    );
    expect(problems[0]).toMatchObject({ id: 'placement', fixes: ['redeploy'] });
    expect(problems[0]?.body).toMatch(/limit or a credential needs fixing first/);
    expect(problems[0]?.detail).toContain('quota');
  });

  it('treats an unhealthy server as silent, like a stale one: neither means load', () => {
    for (const healthStatus of ['stale', 'unhealthy'] as const) {
      const silent = env({ node: { healthStatus, lastHeartbeatAt: ago(3 * HOUR) } });
      expect(serverSilent(silent)).toBe(true);
      expect(describeProblems(silent)[0]).toMatchObject({
        id: 'server-silent',
        title: "The server hasn't checked in for 3 hours",
      });
    }
    // A server still being created has not had the chance to check in.
    expect(serverSilent(env({ node: { status: 'creating', healthStatus: 'stale' } }))).toBe(false);
  });

  it('reads the agent status dimensions only when present, in the agent vocabulary', () => {
    expect(describeProblems(env())).toEqual([]);
    const problems = describeProblems(
      env({ observed: { deployStatus: { routeCertState: 'failed', diskPressure: 'critical' } } })
    );
    expect(problems.map((problem) => problem.id)).toEqual(['https-failed', 'disk-full']);
  });

  it('flags parts of a live app that are not running', () => {
    const problems = describeProblems(
      env({
        observed: {
          services: [
            { name: 'web', status: 'running', health: 'healthy' },
            { name: 'worker', status: 'exited', health: 'unhealthy' },
          ],
        },
      })
    );
    expect(problems[0]).toMatchObject({ id: 'services', title: "worker isn't running properly" });
  });
});

describe('releaseOutcome', () => {
  it('labels each release relative to what runs now', () => {
    const current = env({
      latestRelease: release(43, 'failed'),
      observed: { status: 'reverted', appliedSeq: 42 },
    });
    expect(releaseOutcome(release(43, 'failed'), current).label).toBe("Didn't start");
    expect(releaseOutcome(release(42, 'applied'), current).label).toBe('Live');
    expect(releaseOutcome(release(41, 'applied'), current).label).toBe('Replaced');
    // Superseded before a server picked it up: the heartbeat only offers the newest release.
    expect(releaseOutcome(release(40, 'created'), current).label).toBe('Skipped');
  });

  it("shows a restarting environment's newest release as on its way, not skipped", () => {
    const starting = env({
      status: 'starting',
      latestRelease: release(7, 'created'),
      observed: { status: null, appliedSeq: null },
    });
    expect(releaseOutcome(release(7, 'created'), starting).label).toBe('Deploying');
  });

  it('says what comes back on start for a paused environment', () => {
    expect(releaseOutcome(release(42, 'applied'), env({ status: 'stopped' })).label).toBe(
      'Comes back on start'
    );
  });
});

describe('custom domains', () => {
  function domain(overrides: Partial<DeploymentCustomDomain>): DeploymentCustomDomain {
    return {
      id: 'dom-1',
      environmentId: 'env-1',
      service: 'web',
      port: 3000,
      routeIndex: 0,
      hostname: 'beta.example.com',
      verificationStatus: 'pending',
      verificationError: null,
      verifiedAt: null,
      verifiedCnameTarget: null,
      desiredState: 'active',
      routingStatus: 'pending_dns',
      servingStatus: 'pending_dns',
      activationRoutingRevision: null,
      deactivationRoutingRevision: null,
      deletedAt: null,
      createdBy: 'user-1',
      createdAt: ago(HOUR),
      cnameTarget: 'r1-web-3000-env-1.apps.example.com',
      routeTargetChanged: false,
      environmentStatus: 'active',
      desiredRoutingRevision: 1,
      observedRoutingRevision: 1,
      observedRoutingStatus: null,
      observedRoutingError: null,
      ...overrides,
    };
  }

  it('keeps a domain that never passed a DNS check waiting, not broken', () => {
    const fresh = domain({
      verificationStatus: 'failed',
      verificationError: 'No CNAME record found yet.',
    });
    expect(domainState(fresh)).toEqual({ label: 'Waiting for DNS', tone: 'info' });
    expect(domainProblems([fresh])).toEqual([]);
  });

  it('flags a domain that worked before and now points elsewhere', () => {
    const changed = domain({
      verificationStatus: 'failed',
      verifiedAt: ago(6 * 24 * HOUR),
      servingStatus: 'failed',
    });
    expect(domainState(changed)).toEqual({ label: 'Points elsewhere', tone: 'warning' });
    expect(domainProblems([changed])).toHaveLength(1);
  });
});

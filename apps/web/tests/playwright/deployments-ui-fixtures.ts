/**
 * Fixtures for the Deployments pages audit (`deployments-ui-audit.spec.ts`).
 *
 * One realistic project with every state an environment can be in:
 * - live
 * - a failed deploy with the previous version still live
 * - deploying
 * - paused
 * - a silent server
 * - a first deploy that never got a server
 * - never deployed
 * - starting again
 * - a pause that stopped partway
 * Times are relative to now so "3 h ago" reads the same in every run.
 *
 * Shapes follow what production sends today: the node reports its apply status
 * (applied / applying / reverted / failed / failed-initial), the applied version, an error
 * and per-service state. `deployStatus` and `diskTelemetry` stay null because no agent
 * sets them yet (packages/vm-agent/internal/deploy/types.go).
 */
import { makeMockUser } from './audit-helpers';

const now = Date.now();
export const minsAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const hoursAgo = (hours: number) => minsAgo(hours * 60);
const daysAgo = (days: number) => minsAgo(days * 24 * 60);

export const PROJECT_ID = 'proj-northwind';
export const USER_ID = 'user-northwind';

export const MOCK_USER = makeMockUser({
  email: 'raphael@northwind.dev',
  name: 'Raphaël',
  role: 'superadmin',
  sessionId: 'session-northwind',
  userId: USER_ID,
});

export const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Northwind Storefront',
  repository: 'northwind/storefront',
  defaultBranch: 'main',
  userId: USER_ID,
  githubInstallationId: 'inst-northwind',
  defaultVmSize: 'medium',
  defaultAgentType: 'claude-code',
  defaultProvider: 'hetzner',
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: daysAgo(90),
  updatedAt: daysAgo(1),
};

function profile(id: string, name: string, agentType = 'claude-code') {
  return {
    id,
    projectId: PROJECT_ID,
    name,
    description: null,
    agentType,
    defaultModel: null,
    permissionMode: 'workspace-write',
    vmSize: 'medium',
    provider: 'hetzner',
    workspaceProfile: 'full',
    isDefault: false,
    createdAt: daysAgo(60),
    updatedAt: daysAgo(60),
  };
}

export const PROFILES = [
  profile('p-opus', 'Opus 5.5 Chat'),
  profile('p-sol', 'Sol', 'openai-codex'),
  profile('p-astra', 'Astra High', 'openai-codex'),
  profile('p-captain', 'Release Captain'),
  profile('p-fable', 'Fable'),
];

export const TASK_TITLES: Record<string, string> = {
  't-applepay': 'Add Apple Pay to checkout',
  't-pg17': 'Upgrade the database to Postgres 17',
  't-preview': 'Preview the new product page for design review',
  't-tax': 'Fix tax rounding on EU orders',
  't-node24': 'Bump Node to 24',
  't-demo': 'Seed the demo store with sample products',
  't-mirror': 'Set up an EU mirror close to customers',
  't-qa': 'Spin up a QA copy for the checkout tests',
  't-search': 'Faster product search',
  't-images': 'Serve product images as WebP',
  't-docs': 'Publish the docs site',
  't-load': 'Load-test checkout at 10x traffic',
};

const by = (agentProfileId: string, taskId: string) => ({
  userId: USER_ID,
  workspaceId: `ws-${taskId}`,
  taskId,
  agentProfileId,
});

function release(
  envId: string,
  version: number,
  status: string,
  createdAt: string,
  submittedBy: ReturnType<typeof by>
) {
  return {
    id: `rel-${envId}-${version}`,
    environmentId: envId,
    version,
    status,
    createdBy: USER_ID,
    createdAt,
    submittedBy,
  };
}

function node(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name,
    status: 'running',
    healthStatus: 'healthy',
    cloudProvider: 'hetzner',
    vmSize: 'medium',
    providerInstanceType: 'cx32',
    providerInstanceVcpuCount: 4,
    providerInstanceMemoryMb: 8192,
    providerInstanceDiskGb: 80,
    vmLocation: 'nbg1',
    nodeRole: 'deployment',
    ipAddress: '10.0.0.12',
    lastHeartbeatAt: minsAgo(1),
    errorMessage: null,
    createdAt: daysAgo(30),
    updatedAt: minsAgo(1),
    ...overrides,
  };
}

const SERVICES = [
  { name: 'web', status: 'running', health: 'healthy' },
  { name: 'api', status: 'running', health: 'healthy' },
  { name: 'worker', status: 'running', health: 'none' },
  { name: 'db', status: 'running', health: 'healthy' },
];

function observed(
  appliedSeq: number | null,
  status: string | null,
  extra: Record<string, unknown> = {}
) {
  return {
    appliedSeq,
    status,
    errorMessage: null,
    services: status === 'applied' || status === 'reverted' ? SERVICES : null,
    deployStatus: null,
    diskTelemetry: null,
    observedAt: minsAgo(1),
    ...extra,
  };
}

function policy(enabled: boolean, allowed: string[] = []) {
  return {
    agentDeployEnabled: enabled,
    agentDeployEnabledBy: enabled ? USER_ID : null,
    agentDeployEnabledAt: enabled ? daysAgo(20) : null,
    agentDeployDisabledAt: null,
    allowedDeployProfileIds: allowed,
  };
}

const hosts = (envKey: string, ...services: Array<[string, number]>) =>
  services.map(
    ([service, port], index) => `r${index + 1}-${service}-${port}-env-${envKey}.apps.sammy.party`
  );

export const PREVIEW_NAME = 'preview-pr-2417-new-product-page-with-a-really-long-branch-name';

const NODE_SHARED = node('node-staging', 'deploy-staging-01', {
  providerInstanceType: 'cx22',
  providerInstanceVcpuCount: 2,
  providerInstanceMemoryMb: 4096,
});

export const RELEASES: Record<string, ReturnType<typeof release>[]> = {
  'env-prod': [
    release('env-prod', 42, 'applied', hoursAgo(3), by('p-opus', 't-applepay')),
    release('env-prod', 41, 'applied', daysAgo(1), by('p-sol', 't-tax')),
    release('env-prod', 40, 'failed', daysAgo(2), by('p-astra', 't-node24')),
    release('env-prod', 39, 'applied', daysAgo(3), by('p-opus', 't-search')),
    // Superseded by v39 two minutes later, before the server picked it up: the heartbeat only
    // offers the newest release, and nothing marks the older one, so it stays `created`.
    release('env-prod', 38, 'created', minsAgo(3 * 24 * 60 + 2), by('p-captain', 't-images')),
    release('env-prod', 37, 'applied', daysAgo(8), by('p-sol', 't-search')),
  ],
  'env-staging': [
    release('env-staging', 43, 'failed', minsAgo(25), by('p-sol', 't-pg17')),
    release('env-staging', 42, 'applied', hoursAgo(4), by('p-opus', 't-applepay')),
    release('env-staging', 41, 'applied', daysAgo(1), by('p-sol', 't-tax')),
  ],
  'env-preview': [
    release('env-preview', 3, 'applying', minsAgo(1), by('p-astra', 't-preview')),
    release('env-preview', 2, 'applied', hoursAgo(1), by('p-astra', 't-preview')),
    release('env-preview', 1, 'applied', hoursAgo(2), by('p-astra', 't-preview')),
  ],
  'env-demo': [release('env-demo', 12, 'applied', daysAgo(6), by('p-fable', 't-demo'))],
  'env-eu': [
    release('env-eu', 40, 'applied', daysAgo(2), by('p-sol', 't-mirror')),
    release('env-eu', 39, 'applied', daysAgo(3), by('p-sol', 't-mirror')),
  ],
  'env-qa': [release('env-qa', 1, 'failed', minsAgo(40), by('p-astra', 't-qa'))],
  'env-sandbox': [],
  // Start resets the newest release to `created` while a server is found (markEnvironmentStarting).
  'env-docs': [
    release('env-docs', 7, 'created', daysAgo(9), by('p-fable', 't-docs')),
    release('env-docs', 6, 'applied', daysAgo(12), by('p-fable', 't-docs')),
  ],
  'env-load': [release('env-load', 5, 'applied', daysAgo(2), by('p-captain', 't-load'))],
};

const latest = (envId: string) => RELEASES[envId]?.[0] ?? null;

export const ENVIRONMENTS = [
  {
    id: 'env-prod',
    projectId: PROJECT_ID,
    name: 'production',
    status: 'active',
    nodeId: 'node-prod',
    provider: 'hetzner',
    location: 'nbg1',
    createdAt: daysAgo(60),
    updatedAt: hoursAgo(3),
    secretsUpdatedAt: daysAgo(4),
    observedDeployment: observed(42, 'applied'),
    agentPolicy: policy(true, ['p-captain', 'p-opus']),
    latestRelease: latest('env-prod'),
    routeHostnames: hosts('01m5prod', ['web', 3000], ['api', 8080]),
    node: node('node-prod', 'deploy-prod-01'),
  },
  {
    id: 'env-staging',
    projectId: PROJECT_ID,
    name: 'staging',
    status: 'active',
    nodeId: 'node-staging',
    provider: 'hetzner',
    location: 'nbg1',
    createdAt: daysAgo(60),
    updatedAt: minsAgo(25),
    secretsUpdatedAt: daysAgo(4),
    // v43 failed and the node put v42 back: `reverted` with appliedSeq 42.
    observedDeployment: observed(42, 'reverted', {
      errorMessage:
        'compose up failed: service "api" exited with code 1 — Error: connect ECONNREFUSED 10.0.0.12:5432 (postgres:17 was still starting; api gave up after 3 retries)',
    }),
    agentPolicy: policy(true),
    latestRelease: latest('env-staging'),
    routeHostnames: hosts('01m5stag', ['web', 3000], ['api', 8080]),
    node: NODE_SHARED,
  },
  {
    id: 'env-preview',
    projectId: PROJECT_ID,
    name: PREVIEW_NAME,
    status: 'active',
    nodeId: 'node-staging',
    provider: 'hetzner',
    location: 'nbg1',
    createdAt: hoursAgo(2),
    updatedAt: minsAgo(1),
    secretsUpdatedAt: null,
    // Mid-apply the node already reports the new version, and v2's containers are stopped.
    observedDeployment: observed(3, 'applying'),
    agentPolicy: policy(true),
    latestRelease: latest('env-preview'),
    routeHostnames: hosts('01m5prev', ['web', 3000]),
    node: NODE_SHARED,
  },
  {
    id: 'env-demo',
    projectId: PROJECT_ID,
    name: 'demo',
    status: 'stopped',
    nodeId: null,
    provider: 'hetzner',
    location: 'nbg1',
    createdAt: daysAgo(40),
    updatedAt: daysAgo(4),
    secretsUpdatedAt: null,
    observedDeployment: {
      appliedSeq: null,
      status: null,
      errorMessage: null,
      services: null,
      deployStatus: null,
      diskTelemetry: null,
      observedAt: null,
    },
    agentPolicy: policy(false),
    latestRelease: latest('env-demo'),
    routeHostnames: hosts('01m5demo', ['web', 3000]),
    node: null,
  },
  {
    id: 'env-eu',
    projectId: PROJECT_ID,
    name: 'eu-mirror',
    status: 'active',
    nodeId: 'node-eu',
    provider: 'hetzner',
    location: 'hel1',
    createdAt: daysAgo(20),
    updatedAt: daysAgo(2),
    secretsUpdatedAt: null,
    observedDeployment: observed(40, 'applied', { observedAt: hoursAgo(3) }),
    agentPolicy: policy(true, ['p-sol']),
    latestRelease: latest('env-eu'),
    routeHostnames: hosts('01m5euro', ['web', 3000]),
    node: node('node-eu', 'deploy-eu-01', {
      vmLocation: 'hel1',
      healthStatus: 'stale',
      lastHeartbeatAt: hoursAgo(3),
      errorMessage: 'Heartbeat timeout exceeded 10800s',
    }),
  },
  {
    id: 'env-qa',
    projectId: PROJECT_ID,
    name: 'qa',
    status: 'error',
    nodeId: null,
    provider: 'hetzner',
    location: 'nbg1',
    createdAt: hoursAgo(1),
    updatedAt: minsAgo(40),
    secretsUpdatedAt: null,
    observedDeployment: {
      appliedSeq: null,
      status: null,
      errorMessage:
        'Deployment node placement stopped before a server was created: hetzner has no cx32 capacity in nbg1 right now',
      services: null,
      deployStatus: null,
      diskTelemetry: null,
      observedAt: minsAgo(40),
    },
    agentPolicy: policy(true),
    latestRelease: latest('env-qa'),
    routeHostnames: hosts('01m5qa', ['web', 3000]),
    node: null,
  },
  {
    id: 'env-sandbox',
    projectId: PROJECT_ID,
    name: 'sandbox',
    status: 'created',
    nodeId: null,
    provider: null,
    location: null,
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    secretsUpdatedAt: null,
    observedDeployment: {
      appliedSeq: null,
      status: null,
      errorMessage: null,
      services: null,
      deployStatus: null,
      diskTelemetry: null,
      observedAt: null,
    },
    agentPolicy: policy(false),
    latestRelease: null,
    routeHostnames: [],
    node: null,
  },
  {
    // Start was pressed a minute ago: a server is being created for the newest version.
    id: 'env-docs',
    projectId: PROJECT_ID,
    name: 'docs',
    status: 'starting',
    nodeId: 'node-docs',
    provider: 'hetzner',
    location: 'fsn1',
    createdAt: daysAgo(30),
    updatedAt: minsAgo(1),
    secretsUpdatedAt: null,
    observedDeployment: {
      appliedSeq: null,
      status: null,
      errorMessage: null,
      services: null,
      deployStatus: null,
      diskTelemetry: null,
      observedAt: null,
    },
    agentPolicy: policy(true),
    latestRelease: latest('env-docs'),
    routeHostnames: hosts('01m5docs', ['web', 4000]),
    node: node('node-docs', 'deploy-docs-01', {
      status: 'creating',
      healthStatus: 'stale',
      vmLocation: 'fsn1',
      lastHeartbeatAt: null,
      createdAt: minsAgo(1),
    }),
  },
  {
    // Pause failed halfway: the server teardown errored and it has not checked in since.
    // `markEnvironmentStopFailed` writes the reason onto the observed fields.
    id: 'env-load',
    projectId: PROJECT_ID,
    name: 'load-test',
    status: 'error',
    nodeId: 'node-load',
    provider: 'hetzner',
    location: 'nbg1',
    createdAt: daysAgo(3),
    updatedAt: minsAgo(12),
    secretsUpdatedAt: null,
    observedDeployment: observed(5, 'failed', {
      errorMessage:
        'Stop failed while tearing down the deployment node: hetzner API timed out after 120s',
      services: null,
      observedAt: minsAgo(12),
    }),
    agentPolicy: policy(true, ['p-captain']),
    latestRelease: latest('env-load'),
    routeHostnames: hosts('01m5load', ['web', 3000]),
    node: node('node-load', 'deploy-load-01', {
      status: 'error',
      healthStatus: 'stale',
      lastHeartbeatAt: minsAgo(14),
      errorMessage: 'Delete server request timed out',
    }),
  },
];

function route(envKey: string, service: string, port: number, index: number) {
  return {
    id: `${service}:${port}:${index}`,
    service,
    port,
    hostname: `r${index + 1}-${service}-${port}-env-${envKey}.apps.sammy.party`,
    hostPort: 36120 + index,
    routeIndex: index,
  };
}

export const PUBLIC_ROUTES: Record<string, unknown[]> = {
  'env-prod': [route('01m5prod', 'web', 3000, 0), route('01m5prod', 'api', 8080, 1)],
  'env-staging': [route('01m5stag', 'web', 3000, 0), route('01m5stag', 'api', 8080, 1)],
  'env-preview': [route('01m5prev', 'web', 3000, 0)],
  'env-demo': [route('01m5demo', 'web', 3000, 0)],
  'env-eu': [route('01m5euro', 'web', 3000, 0)],
  'env-qa': [route('01m5qa', 'web', 3000, 0)],
  'env-sandbox': [],
  'env-docs': [route('01m5docs', 'web', 4000, 0)],
  'env-load': [route('01m5load', 'web', 3000, 0)],
};

function domain(
  envId: string,
  hostname: string,
  service: string,
  overrides: Record<string, unknown> = {}
) {
  const envKey =
    { 'env-prod': '01m5prod', 'env-staging': '01m5stag', 'env-demo': '01m5demo' }[envId] ?? 'x';
  const port = service === 'api' ? 8080 : 3000;
  const index = service === 'api' ? 1 : 0;
  return {
    id: `dom-${hostname}`,
    environmentId: envId,
    service,
    port,
    routeIndex: index,
    hostname,
    verificationStatus: 'verified',
    verificationError: null,
    verifiedAt: daysAgo(10),
    verifiedCnameTarget: `r${index + 1}-${service}-${port}-env-${envKey}.apps.sammy.party`,
    desiredState: 'active',
    routingStatus: 'active',
    servingStatus: 'active',
    activationRoutingRevision: 2,
    deactivationRoutingRevision: null,
    deletedAt: null,
    createdBy: USER_ID,
    createdAt: daysAgo(10),
    cnameTarget: `r${index + 1}-${service}-${port}-env-${envKey}.apps.sammy.party`,
    routeTargetChanged: false,
    environmentStatus: 'active',
    desiredRoutingRevision: 2,
    observedRoutingRevision: 2,
    observedRoutingStatus: 'active',
    observedRoutingError: null,
    ...overrides,
  };
}

export const CUSTOM_DOMAINS: Record<string, unknown[]> = {
  'env-prod': [
    domain('env-prod', 'shop.northwind.dev', 'web'),
    domain('env-prod', 'api.northwind.dev', 'api'),
  ],
  'env-staging': [
    domain('env-staging', 'staging.northwind.dev', 'web'),
    // Worked last week; its record was changed since, so it is a problem now.
    domain('env-staging', 'beta.northwind.dev', 'web', {
      verificationStatus: 'failed',
      verificationError:
        'beta.northwind.dev resolves to 104.21.4.19 (a Cloudflare proxy), not the SAM route target.',
      servingStatus: 'failed',
      routingStatus: 'failed',
      verifiedAt: daysAgo(6),
    }),
    // Added minutes ago and checked straight away, before the record existed: still waiting.
    domain('env-staging', 'status.northwind.dev', 'web', {
      verificationStatus: 'failed',
      verificationError: 'No CNAME record found for status.northwind.dev yet.',
      servingStatus: 'pending_dns',
      routingStatus: 'pending_dns',
      verifiedAt: null,
    }),
  ],
  'env-demo': [
    domain('env-demo', 'demo.northwind.dev', 'web', {
      servingStatus: 'inactive_environment_stopped',
      environmentStatus: 'stopped',
    }),
  ],
};

function volume(envId: string, name: string, sizeGb: number, attached: boolean, n: number) {
  return {
    id: `vol-${envId}-${name}`,
    environmentId: envId,
    name,
    providerVolumeId: `hcloud-volume-10${n}`,
    providerName: 'hetzner',
    sizeGb,
    location: 'nbg1',
    status: attached ? 'in-use' : 'available',
    attachedServerId: attached ? 'server-0842d1a9' : null,
    linuxDevice: attached ? `/dev/disk/by-id/scsi-0HC_Volume_10${n}` : null,
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
  };
}

export const VOLUMES: Record<string, unknown[]> = {
  'env-prod': [
    volume('env-prod', 'postgres-data', 20, true, 1),
    volume('env-prod', 'uploads', 50, true, 2),
  ],
  'env-staging': [volume('env-staging', 'postgres-data', 10, true, 3)],
  'env-demo': [volume('env-demo', 'demo-data', 5, false, 4)],
};

function variable(key: string, value: string | null, isSecret = false) {
  return {
    key,
    value: isSecret ? null : value,
    isSecret,
    hasValue: true,
    createdAt: daysAgo(30),
    updatedAt: daysAgo(4),
  };
}

export const CONFIG: Record<string, unknown> = {
  'env-prod': {
    envVars: [
      variable('PUBLIC_URL', 'https://shop.northwind.dev'),
      variable('API_URL', 'https://api.northwind.dev'),
      variable('LOG_LEVEL', 'info'),
      variable('ASSETS_BASE_URL', 'https://cdn.northwind.dev/storefront/releases/2026-10-23/assets-4f2a9c1e7b'),
      variable('DATABASE_URL', null, true),
      variable('STRIPE_SECRET_KEY', null, true),
      variable('SESSION_SECRET', null, true),
    ],
    updatedAt: daysAgo(4),
    variableCount: 4,
    secretCount: 3,
  },
};

const log = (minutes: number, level: string, source: string, message: string) => ({
  timestamp: minsAgo(minutes),
  level,
  source,
  message,
});

export const LOGS: Record<string, unknown[]> = {
  'env-prod': [
    log(1, 'info', 'docker:storefront-web-1', 'GET /checkout 200 in 84ms'),
    log(2, 'info', 'docker:storefront-api-1', 'POST /v1/payments/apple-pay/session 201 in 212ms'),
    log(
      3,
      'warn',
      'docker:storefront-worker-1',
      'Retrying webhook delivery to fulfilment (attempt 2 of 5)'
    ),
    log(5, 'info', 'docker:storefront-web-1', 'GET /products?page=2 200 in 41ms'),
    log(180, 'info', 'agent', 'Release 42 is live: health check passed for web and api'),
  ],
  'env-staging': [
    log(24, 'error', 'agent', 'Release 43 failed. Version 42 is still running.'),
    log(24, 'error', 'docker:storefront-api-1', 'Error: connect ECONNREFUSED 10.0.0.12:5432'),
    log(
      25,
      'info',
      'docker:storefront-db-1',
      'PostgreSQL 17.0 starting: replaying WAL from 0/3A000028'
    ),
    log(25, 'info', 'agent', 'Pulled 3 images for release 43'),
  ],
};

export const CONTAINERS = {
  containers: [
    { id: 'c-web', name: 'storefront-web-1', image: 'web', state: 'running', status: 'Up 3 hours' },
    { id: 'c-api', name: 'storefront-api-1', image: 'api', state: 'running', status: 'Up 3 hours' },
    {
      id: 'c-worker',
      name: 'storefront-worker-1',
      image: 'worker',
      state: 'running',
      status: 'Up 3 hours',
    },
    {
      id: 'c-db',
      name: 'storefront-db-1',
      image: 'postgres:16',
      state: 'running',
      status: 'Up 8 days',
    },
  ],
};

export const SYSTEM_INFO = {
  cpu: { numCpu: 4, model: 'AMD EPYC', loadAvg1: 0.92, loadAvg5: 0.8, loadAvg15: 0.7 },
  memory: {
    totalBytes: 8_000_000_000,
    usedBytes: 4_900_000_000,
    availableBytes: 3_100_000_000,
    usedPercent: 61,
  },
  disk: {
    totalBytes: 80_000_000_000,
    usedBytes: 38_000_000_000,
    availableBytes: 42_000_000_000,
    usedPercent: 48,
    mountPath: '/',
  },
  network: { interface: 'eth0', rxBytes: 1234, txBytes: 5678 },
  uptime: { seconds: 720000, humanFormat: '8d' },
  docker: { running: true, version: '27.3.1', containers: 4, containerList: [] },
  software: { node: '22.16.0', docker: '27.3.1' },
  agent: { version: 'prototype', status: 'running' },
};

/** Event names exactly as `packages/vm-agent/internal/deploy/engine.go` reports them. */
const EVENT_PREFIX: Record<string, string> = {
  fetch_release: 'fetch',
  load_artifacts: 'artifacts_load',
  volume_mounts: 'volume_mount',
};

const event = (seq: number, step: string, kind: 'started' | 'completed', minutes: number) => ({
  seq,
  level: 'info',
  step,
  eventType: `deployment.apply.${EVENT_PREFIX[step] ?? step}_${kind}`,
  message: `${step} ${kind}`,
  createdAt: minsAgo(minutes),
});

const failed = (seq: number, minutes: number, message: string) => ({
  seq,
  level: 'error',
  step: 'failed',
  eventType: 'deployment.apply.failed',
  message,
  createdAt: minsAgo(minutes),
});

/** A successful revert ends with this one event; a failed revert sends nothing more. */
const reverted = (seq: number, minutes: number) => ({
  seq,
  level: 'warn',
  step: 'revert',
  eventType: 'deployment.apply.reverted',
  message: 'deployment reverted to previous release',
  createdAt: minsAgo(minutes),
});

/**
 * Steps nodes report while applying a release (`deployment_release_events`, written by
 * packages/vm-agent/internal/deploy/engine.go; no read route yet).
 */
export const RELEASE_EVENTS: Record<string, unknown[]> = {
  'rel-env-staging-43': [
    event(1, 'fetch_release', 'started', 25),
    event(2, 'fetch_release', 'completed', 25),
    event(3, 'previous_down', 'started', 25),
    event(4, 'previous_down', 'completed', 25),
    event(5, 'load_artifacts', 'started', 25),
    event(6, 'load_artifacts', 'completed', 25),
    event(7, 'compose_config', 'started', 25),
    event(8, 'compose_config', 'completed', 25),
    event(9, 'compose_up', 'started', 25),
    failed(10, 24, 'service "api" exited with code 1'),
    event(11, 'revert', 'started', 24),
    reverted(12, 24),
  ],
  'rel-env-preview-3': [
    event(1, 'fetch_release', 'started', 1),
    event(2, 'fetch_release', 'completed', 1),
    event(3, 'previous_down', 'started', 1),
    event(4, 'previous_down', 'completed', 1),
    event(5, 'load_artifacts', 'started', 1),
    event(6, 'load_artifacts', 'completed', 1),
    event(7, 'compose_config', 'started', 1),
    event(8, 'compose_config', 'completed', 1),
    event(9, 'compose_up', 'started', 0),
  ],
};

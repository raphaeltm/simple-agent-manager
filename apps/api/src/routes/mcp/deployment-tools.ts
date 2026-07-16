import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { parsePositiveInt } from '../../lib/route-helpers';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import {
  assertAgentDeploymentAllowed,
  createAgentDeploymentEnvironment,
  getTaskAgentProfileId,
  isDeploymentPolicyAllowedForProfile,
  toDeploymentAgentPolicy,
  toObservedDeploymentState,
} from '../../services/deployment-control';
import {
  buildDeploymentEnvironmentConfigResponse,
  loadDeploymentEnvironmentConfigRows,
  upsertDeploymentEnvironmentConfigVar,
} from '../../services/deployment-environment-config';
import { buildDeploymentEnvironmentResponse } from '../../services/deployment-environment-summary';
import {
  buildComposePublishRouteDiscovery,
  buildReleaseRouteDiscovery,
  type DeploymentRouteDiscovery,
  type DeploymentRoutePublicDiscovery,
  type DeploymentRouteTargetOptions,
} from '../../services/deployment-routing';
import { getRuntimeLimits } from '../../services/limits';
import { getNodeLogsFromNode } from '../../services/node-agent-diagnostics';
import { byteLength, PROJECT_ENV_KEY_PATTERN } from '../projects/_helpers';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
  sanitizeUserInput,
} from './_helpers';

type DeploymentDb = ReturnType<typeof drizzle<typeof schema>>;

interface DeploymentRouteCustomDomainDiscovery {
  id: string;
  service: string;
  containerPort: number;
  routeIndex: number;
  hostname: string;
  url: string;
  verificationStatus: string;
  verificationError: string | null;
  verifiedAt: string | null;
  createdAt: string;
  cnameTarget: string | null;
  verifiedCnameTarget: string | null;
  desiredState: string;
  routingStatus: string;
  activationRoutingRevision: number | null;
  deactivationRoutingRevision: number | null;
  routeAvailable: boolean;
  routeTargetChanged: boolean;
  willBeIncludedInRouteConfig: boolean;
}

type DeploymentRoutePublicDiscoveryWithCustomDomains = DeploymentRoutePublicDiscovery & {
  customDomains: DeploymentRouteCustomDomainDiscovery[];
};

type DeploymentRouteDiscoveryWithCustomDomains = Omit<DeploymentRouteDiscovery, 'publicRoutes'> & {
  publicRoutes: DeploymentRoutePublicDiscoveryWithCustomDomains[];
  customDomains: DeploymentRouteCustomDomainDiscovery[];
};

const DEFAULT_MCP_DEPLOYMENT_LOG_LIMIT = 200;
const DEFAULT_MCP_DEPLOYMENT_LOG_MAX_LIMIT = 1000;
const DEFAULT_MCP_DEPLOYMENT_COMPOSE_PREVIEW_MAX_BYTES = 128_000;

function jsonTextResult(requestId: string | number | null, payload: unknown): JsonRpcResponse {
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  });
}

function getDeploymentLogLimits(env: Env): { defaultLimit: number; maxLimit: number } {
  const maxLimit = parsePositiveInt(
    env.MCP_DEPLOYMENT_LOG_MAX_LIMIT,
    DEFAULT_MCP_DEPLOYMENT_LOG_MAX_LIMIT
  );
  const defaultLimit = Math.min(
    parsePositiveInt(env.MCP_DEPLOYMENT_LOG_DEFAULT_LIMIT, DEFAULT_MCP_DEPLOYMENT_LOG_LIMIT),
    maxLimit
  );
  return { defaultLimit, maxLimit };
}

function getComposePreviewMaxBytes(env: Env): number {
  return parsePositiveInt(
    env.MCP_DEPLOYMENT_COMPOSE_PREVIEW_MAX_BYTES,
    DEFAULT_MCP_DEPLOYMENT_COMPOSE_PREVIEW_MAX_BYTES
  );
}

function routeTargetOptions(env: Env, environmentId: string): DeploymentRouteTargetOptions {
  return {
    environmentId,
    baseDomain: env.BASE_DOMAIN,
    routePortBase: env.DEPLOYMENT_ROUTE_PORT_BASE,
    routePortSpan: env.DEPLOYMENT_ROUTE_PORT_SPAN,
  };
}

function emptyRouteDiscovery(env: Env, environmentId: string) {
  return buildComposePublishRouteDiscovery(
    { composeYaml: '' },
    routeTargetOptions(env, environmentId)
  );
}

function findPublicRoute(
  routes: DeploymentRouteDiscovery,
  service: string,
  port: number
): DeploymentRoutePublicDiscovery | null {
  return (
    routes.publicRoutes.find(
      (route) => route.service === service && route.containerPort === port
    ) ?? null
  );
}

async function loadRouteCustomDomains(
  db: DeploymentDb,
  environmentId: string,
  routes: DeploymentRouteDiscovery
): Promise<DeploymentRouteCustomDomainDiscovery[]> {
  const domains = await db
    .select({
      id: schema.deploymentCustomDomains.id,
      service: schema.deploymentCustomDomains.service,
      port: schema.deploymentCustomDomains.port,
      routeIndex: schema.deploymentCustomDomains.routeIndex,
      hostname: schema.deploymentCustomDomains.hostname,
      verificationStatus: schema.deploymentCustomDomains.verificationStatus,
      verificationError: schema.deploymentCustomDomains.verificationError,
      verifiedAt: schema.deploymentCustomDomains.verifiedAt,
      verifiedCnameTarget: schema.deploymentCustomDomains.verifiedCnameTarget,
      desiredState: schema.deploymentCustomDomains.desiredState,
      routingStatus: schema.deploymentCustomDomains.routingStatus,
      activationRoutingRevision: schema.deploymentCustomDomains.activationRoutingRevision,
      deactivationRoutingRevision: schema.deploymentCustomDomains.deactivationRoutingRevision,
      createdAt: schema.deploymentCustomDomains.createdAt,
    })
    .from(schema.deploymentCustomDomains)
    .where(
      and(
        eq(schema.deploymentCustomDomains.environmentId, environmentId),
        isNull(schema.deploymentCustomDomains.deletedAt)
      )
    )
    .orderBy(schema.deploymentCustomDomains.createdAt);

  return domains.map((domain) => {
    const parent = findPublicRoute(routes, domain.service, domain.port);
    const routeTargetChanged =
      !!domain.verifiedCnameTarget && !!parent && domain.verifiedCnameTarget !== parent.hostname;
    const willBeIncludedInRouteConfig =
      domain.verificationStatus === 'verified' &&
      domain.desiredState === 'active' &&
      parent !== null &&
      !!domain.verifiedCnameTarget &&
      domain.verifiedCnameTarget === parent.hostname;
    return {
      id: domain.id,
      service: domain.service,
      containerPort: domain.port,
      routeIndex: domain.routeIndex,
      hostname: domain.hostname,
      url: `https://${domain.hostname}`,
      verificationStatus: domain.verificationStatus,
      verificationError: domain.verificationError,
      verifiedAt: domain.verifiedAt,
      verifiedCnameTarget: domain.verifiedCnameTarget,
      desiredState: domain.desiredState,
      routingStatus: routeTargetChanged ? 'dns_recheck_required' : domain.routingStatus,
      activationRoutingRevision: domain.activationRoutingRevision,
      deactivationRoutingRevision: domain.deactivationRoutingRevision,
      createdAt: domain.createdAt,
      cnameTarget: parent?.hostname ?? null,
      routeAvailable: parent !== null,
      routeTargetChanged,
      willBeIncludedInRouteConfig,
    };
  });
}

async function withCustomDomains(
  db: DeploymentDb,
  environmentId: string,
  routes: DeploymentRouteDiscovery
): Promise<DeploymentRouteDiscoveryWithCustomDomains> {
  const customDomains = await loadRouteCustomDomains(db, environmentId, routes);
  return {
    ...routes,
    publicRoutes: routes.publicRoutes.map((route) => ({
      ...route,
      customDomains: customDomains.filter(
        (domain) => domain.service === route.service && domain.containerPort === route.containerPort
      ),
    })),
    customDomains,
  };
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = sanitizeUserInput(value).trim();
  return trimmed ? trimmed : null;
}

function requireEnvironmentName(
  requestId: string | number | null,
  toolArgs: Record<string, unknown>
): { value: string } | { response: JsonRpcResponse } {
  const environment = trimmedString(toolArgs.environment);
  if (!environment) {
    return {
      response: jsonRpcError(
        requestId,
        INVALID_PARAMS,
        'A deployment environment name is required.'
      ),
    };
  }
  return { value: environment };
}

async function resolveAccessibleEnvironment(
  requestId: string | number | null,
  db: DeploymentDb,
  tokenData: McpTokenData,
  toolArgs: Record<string, unknown>
): Promise<
  | {
      environment: schema.DeploymentEnvironmentRow;
      taskAgentProfileId: string | null;
    }
  | { response: JsonRpcResponse }
> {
  const parsed = requireEnvironmentName(requestId, toolArgs);
  if ('response' in parsed) return parsed;

  const access = await assertAgentDeploymentAllowed(
    db,
    tokenData.projectId,
    parsed.value,
    tokenData
  );
  if ('error' in access) {
    return { response: jsonRpcError(requestId, INVALID_PARAMS, access.error) };
  }

  const rows = await db
    .select()
    .from(schema.deploymentEnvironments)
    .where(
      and(
        eq(schema.deploymentEnvironments.id, access.environmentId),
        eq(schema.deploymentEnvironments.projectId, tokenData.projectId)
      )
    )
    .limit(1);

  const environment = rows[0];
  if (!environment) {
    return {
      response: jsonRpcError(requestId, INTERNAL_ERROR, 'Deployment environment disappeared.'),
    };
  }
  return { environment, taskAgentProfileId: access.taskAgentProfileId };
}

function summarizeEnvironment(
  row: schema.DeploymentEnvironmentRow,
  taskAgentProfileId: string | null
) {
  const policy = toDeploymentAgentPolicy(row);
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    nodeId: row.nodeId,
    provider: row.provider,
    location: row.location,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    configUpdatedAt: row.configUpdatedAt,
    observedDeployment: toObservedDeploymentState(row),
    access: {
      agentDeployEnabled: policy.agentDeployEnabled,
      allowedProfileRestricted: policy.allowedDeployProfileIds.length > 0,
      taskAgentProfileId,
    },
  };
}

export async function handleListDeploymentEnvironments(
  requestId: string | number | null,
  _toolArgs: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const db = drizzle(env.DATABASE, { schema });
  const taskAgentProfileId = tokenData.taskId
    ? await getTaskAgentProfileId(db, tokenData.taskId)
    : null;

  const rows = await db
    .select()
    .from(schema.deploymentEnvironments)
    .where(
      and(
        eq(schema.deploymentEnvironments.projectId, tokenData.projectId),
        eq(schema.deploymentEnvironments.status, 'active')
      )
    )
    .orderBy(schema.deploymentEnvironments.createdAt);

  const environments = rows
    .filter((row) =>
      isDeploymentPolicyAllowedForProfile(toDeploymentAgentPolicy(row), taskAgentProfileId)
    )
    .map((row) => summarizeEnvironment(row, taskAgentProfileId));

  return jsonTextResult(requestId, { environments });
}

export async function handleCreateDeploymentEnvironment(
  requestId: string | number | null,
  toolArgs: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const name = trimmedString(toolArgs.name);
  if (!name) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'A deployment environment name is required.');
  }

  const db = drizzle(env.DATABASE, { schema });
  const result = await createAgentDeploymentEnvironment(
    db,
    tokenData.projectId,
    name,
    tokenData,
    env.AGENT_DEPLOYMENT_RESERVED_ENVIRONMENT_NAMES
  );
  if ('error' in result) {
    return jsonRpcError(requestId, INVALID_PARAMS, result.error);
  }

  return jsonTextResult(requestId, {
    environment: await buildDeploymentEnvironmentResponse(db, env, result.environment),
    creatorProfileId: result.creatorProfileId,
  });
}

async function resolveDeploymentNode(
  db: DeploymentDb,
  environment: schema.DeploymentEnvironmentRow,
  userId: string
): Promise<
  | { kind: 'no_node' }
  | { kind: 'unavailable'; nodeId: string; reason: 'node_not_running' | 'node_not_found' }
  | { kind: 'ready'; nodeId: string }
> {
  if (!environment.nodeId) {
    return { kind: 'no_node' };
  }

  const nodes = await db
    .select({
      id: schema.nodes.id,
      status: schema.nodes.status,
    })
    .from(schema.nodes)
    .where(and(eq(schema.nodes.id, environment.nodeId), eq(schema.nodes.userId, userId)))
    .limit(1);

  const node = nodes[0];
  if (!node || node.status !== 'running') {
    return {
      kind: 'unavailable',
      nodeId: environment.nodeId,
      reason: node ? 'node_not_running' : 'node_not_found',
    };
  }

  return { kind: 'ready', nodeId: node.id };
}

function appendStringParam(params: URLSearchParams, key: string, value: unknown): void {
  const stringValue = trimmedString(value);
  if (stringValue) {
    params.set(key, stringValue);
  }
}

function buildLogQuery(
  requestId: string | number | null,
  toolArgs: Record<string, unknown>,
  env: Env
): { query: string; limit: number } | { response: JsonRpcResponse } {
  const { defaultLimit, maxLimit } = getDeploymentLogLimits(env);
  let limit = defaultLimit;
  if (toolArgs.limit !== undefined) {
    if (
      typeof toolArgs.limit !== 'number' ||
      !Number.isFinite(toolArgs.limit) ||
      toolArgs.limit <= 0
    ) {
      return {
        response: jsonRpcError(requestId, INVALID_PARAMS, 'limit must be a positive number.'),
      };
    }
    limit = Math.min(Math.floor(toolArgs.limit), maxLimit);
  }

  const params = new URLSearchParams();
  for (const key of ['source', 'level', 'container', 'since', 'until', 'search', 'cursor']) {
    appendStringParam(params, key, toolArgs[key]);
  }
  params.set('limit', String(limit));
  return { query: params.toString(), limit };
}

export async function handleReadDeploymentLogs(
  requestId: string | number | null,
  toolArgs: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const db = drizzle(env.DATABASE, { schema });
  const resolved = await resolveAccessibleEnvironment(requestId, db, tokenData, toolArgs);
  if ('response' in resolved) return resolved.response;

  const node = await resolveDeploymentNode(db, resolved.environment, tokenData.userId);
  if (node.kind !== 'ready') {
    return jsonTextResult(requestId, {
      environment: summarizeEnvironment(resolved.environment, resolved.taskAgentProfileId),
      logs: {
        entries: [],
        nextCursor: null,
        hasMore: false,
      },
      nodeId: node.kind === 'unavailable' ? node.nodeId : null,
      unavailableReason: node.kind === 'no_node' ? 'no_deployment_node' : node.reason,
    });
  }

  const query = buildLogQuery(requestId, toolArgs, env);
  if ('response' in query) return query.response;

  try {
    const logs = await getNodeLogsFromNode(node.nodeId, env, tokenData.userId, query.query);
    return jsonTextResult(requestId, {
      environment: summarizeEnvironment(resolved.environment, resolved.taskAgentProfileId),
      nodeId: node.nodeId,
      limit: query.limit,
      logs,
    });
  } catch {
    return jsonTextResult(requestId, {
      environment: summarizeEnvironment(resolved.environment, resolved.taskAgentProfileId),
      logs: {
        entries: [],
        nextCursor: null,
        hasMore: false,
      },
      nodeId: node.nodeId,
      unavailableReason: 'node_agent_unreachable',
    });
  }
}

export async function handlePreviewDeploymentRoutes(
  requestId: string | number | null,
  toolArgs: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const db = drizzle(env.DATABASE, { schema });
  const resolved = await resolveAccessibleEnvironment(requestId, db, tokenData, toolArgs);
  if ('response' in resolved) return resolved.response;

  if (typeof toolArgs.composeYaml !== 'string' || toolArgs.composeYaml.trim() === '') {
    return jsonRpcError(requestId, INVALID_PARAMS, 'composeYaml must be a non-empty string.');
  }

  const composeYaml = sanitizeUserInput(toolArgs.composeYaml);
  const maxBytes = getComposePreviewMaxBytes(env);
  if (byteLength(composeYaml) > maxBytes) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `composeYaml exceeds max size of ${maxBytes} bytes`
    );
  }

  try {
    const routes = buildComposePublishRouteDiscovery(
      { composeYaml },
      routeTargetOptions(env, resolved.environment.id)
    );

    return jsonTextResult(requestId, {
      environment: summarizeEnvironment(resolved.environment, resolved.taskAgentProfileId),
      routes,
      instructions:
        'Public routes get SAM-managed hostnames/URLs. Internal routes do not get public DNS and are reachable only within the deployed Compose stack/private network.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonRpcError(requestId, INVALID_PARAMS, message);
  }
}

export async function handleListDeploymentRoutes(
  requestId: string | number | null,
  toolArgs: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const db = drizzle(env.DATABASE, { schema });
  const resolved = await resolveAccessibleEnvironment(requestId, db, tokenData, toolArgs);
  if ('response' in resolved) return resolved.response;

  const releases = await db
    .select({
      id: schema.deploymentReleases.id,
      version: schema.deploymentReleases.version,
      status: schema.deploymentReleases.status,
      source: schema.deploymentReleases.source,
      createdAt: schema.deploymentReleases.createdAt,
      manifest: schema.deploymentReleases.manifest,
    })
    .from(schema.deploymentReleases)
    .where(eq(schema.deploymentReleases.environmentId, resolved.environment.id))
    .orderBy(desc(schema.deploymentReleases.version))
    .limit(1);

  const release = releases[0];
  if (!release) {
    const routes = emptyRouteDiscovery(env, resolved.environment.id);
    return jsonTextResult(requestId, {
      environment: summarizeEnvironment(resolved.environment, resolved.taskAgentProfileId),
      latestRelease: null,
      routes: await withCustomDomains(db, resolved.environment.id, routes),
    });
  }

  const routes = buildReleaseRouteDiscovery(
    release.manifest,
    routeTargetOptions(env, resolved.environment.id)
  );

  const routeDiscovery = routes ?? {
    ...emptyRouteDiscovery(env, resolved.environment.id),
    unavailableReason: 'release_manifest_unreadable',
  };

  return jsonTextResult(requestId, {
    environment: summarizeEnvironment(resolved.environment, resolved.taskAgentProfileId),
    latestRelease: {
      id: release.id,
      version: release.version,
      status: release.status,
      source: release.source ?? 'build-on-node',
      createdAt: release.createdAt,
    },
    routes: await withCustomDomains(db, resolved.environment.id, routeDiscovery),
  });
}

export async function handleListDeploymentEnvironmentConfig(
  requestId: string | number | null,
  toolArgs: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const db = drizzle(env.DATABASE, { schema });
  const resolved = await resolveAccessibleEnvironment(requestId, db, tokenData, toolArgs);
  if ('response' in resolved) return resolved.response;

  const config = await buildDeploymentEnvironmentConfigResponse(db, resolved.environment.id);
  return jsonTextResult(requestId, {
    environment: summarizeEnvironment(resolved.environment, resolved.taskAgentProfileId),
    config,
  });
}

export async function handleSetDeploymentEnvironmentConfig(
  requestId: string | number | null,
  toolArgs: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const db = drizzle(env.DATABASE, { schema });
  const resolved = await resolveAccessibleEnvironment(requestId, db, tokenData, toolArgs);
  if ('response' in resolved) return resolved.response;

  const envKey = trimmedString(toolArgs.key);
  if (!envKey || !PROJECT_ENV_KEY_PATTERN.test(envKey)) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'key must match [A-Za-z_][A-Za-z0-9_]*');
  }
  if (typeof toolArgs.value !== 'string') {
    return jsonRpcError(requestId, INVALID_PARAMS, 'value must be a string.');
  }
  const value = sanitizeUserInput(toolArgs.value);
  if (toolArgs.isSecret !== undefined && typeof toolArgs.isSecret !== 'boolean') {
    return jsonRpcError(requestId, INVALID_PARAMS, 'isSecret must be a boolean when provided.');
  }
  const isSecret = toolArgs.isSecret === true;
  if (isSecret && value.length === 0) {
    return jsonRpcError(requestId, INVALID_PARAMS, 'secret value must not be empty');
  }

  const limits = getRuntimeLimits(env);
  if (byteLength(value) > limits.maxDeploymentEnvValueBytes) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `value exceeds max size of ${limits.maxDeploymentEnvValueBytes} bytes`
    );
  }

  const existingRows = await db
    .select({ id: schema.deploymentEnvironmentConfigVars.id })
    .from(schema.deploymentEnvironmentConfigVars)
    .where(
      and(
        eq(schema.deploymentEnvironmentConfigVars.environmentId, resolved.environment.id),
        eq(schema.deploymentEnvironmentConfigVars.envKey, envKey)
      )
    )
    .limit(1);

  if (!existingRows[0]) {
    const countRows = await db
      .select({ count: count() })
      .from(schema.deploymentEnvironmentConfigVars)
      .where(eq(schema.deploymentEnvironmentConfigVars.environmentId, resolved.environment.id));
    if ((countRows[0]?.count ?? 0) >= limits.maxDeploymentEnvVarsPerEnvironment) {
      return jsonRpcError(
        requestId,
        INVALID_PARAMS,
        `Maximum ${limits.maxDeploymentEnvVarsPerEnvironment} deployment config vars allowed per environment`
      );
    }
  }

  const currentRows = await loadDeploymentEnvironmentConfigRows(db, resolved.environment.id);
  const existingTotalBytes = currentRows
    .filter((row) => row.envKey !== envKey)
    .reduce((sum, row) => sum + byteLength(`${row.envKey}=${row.storedValue}`) + 1, 0);
  const nextTotalBytes = existingTotalBytes + byteLength(`${envKey}=${value}`) + 1;
  if (nextTotalBytes > limits.maxDeploymentEnvTotalBytes) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      `deployment config exceeds max aggregate size of ${limits.maxDeploymentEnvTotalBytes} bytes`
    );
  }

  await upsertDeploymentEnvironmentConfigVar(db, {
    environmentId: resolved.environment.id,
    envKey,
    value,
    isSecret,
    encryptionKey: getCredentialEncryptionKey(env),
  });

  const config = await buildDeploymentEnvironmentConfigResponse(db, resolved.environment.id);
  return jsonTextResult(requestId, {
    environment: summarizeEnvironment(resolved.environment, resolved.taskAgentProfileId),
    config,
  });
}

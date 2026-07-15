import { and, desc, eq, inArray } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import type { McpTokenData } from './mcp-token';

const MAX_OBSERVED_ERROR_MESSAGE_LENGTH = 4096;
const MAX_OBSERVED_JSON_LENGTH = 64_000;

const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'failed-initial', 'reverted']);
const APPLY_SUCCESS_STATUSES = new Set(['applied', 'reverted', 'failed']);
const AGENT_CREATED_ENVIRONMENT_SOURCE = 'agent-mcp';
const DEFAULT_RESERVED_AGENT_ENVIRONMENT_NAMES = ['prod', 'production'];
export const DEPLOYMENT_ENVIRONMENT_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export interface DeploymentHeartbeatState {
  appliedSeq?: number;
  status?: string;
  errorMessage?: string;
  routingRevision?: number;
  routingStatus?: string;
  routingError?: string;
  services?: unknown;
  deployStatus?: unknown;
  diskTelemetry?: unknown;
}

export interface ObservedDeploymentState {
  appliedSeq: number | null;
  status: string | null;
  errorMessage: string | null;
  routingRevision: number;
  routingStatus: string | null;
  routingError: string | null;
  routingObservedAt: string | null;
  services: unknown | null;
  deployStatus: unknown | null;
  diskTelemetry: unknown | null;
  observedAt: string | null;
}

export interface DeploymentAgentPolicy {
  agentDeployEnabled: boolean;
  agentDeployEnabledBy: string | null;
  agentDeployEnabledAt: string | null;
  agentDeployDisabledAt: string | null;
  allowedDeployProfileIds: string[];
}

export function parseJsonField(value: string | null | undefined): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function truncateString(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function safeJsonStringify(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  try {
    const encoded = JSON.stringify(value);
    if (!encoded) return null;
    return encoded.length > MAX_OBSERVED_JSON_LENGTH
      ? JSON.stringify({ truncated: true, originalLength: encoded.length })
      : encoded;
  } catch {
    return JSON.stringify({ unsupported: true });
  }
}

function normalizeAppliedSeq(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function normalizeStatus(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed ? truncateString(trimmed, 64) : null;
}

export function buildObservedDeploymentUpdate(
  deployment: DeploymentHeartbeatState,
  observedAt: string
): Partial<schema.NewDeploymentEnvironmentRow> {
  const appliedSeq = normalizeAppliedSeq(deployment.appliedSeq);
  const status = normalizeStatus(deployment.status);
  const errorMessage =
    typeof deployment.errorMessage === 'string'
      ? truncateString(deployment.errorMessage, MAX_OBSERVED_ERROR_MESSAGE_LENGTH)
      : null;
  const routingRevision = normalizeAppliedSeq(deployment.routingRevision);
  const routingStatus = normalizeStatus(deployment.routingStatus);
  const routingError =
    typeof deployment.routingError === 'string'
      ? truncateString(deployment.routingError, MAX_OBSERVED_ERROR_MESSAGE_LENGTH)
      : null;

  const update: Partial<schema.NewDeploymentEnvironmentRow> = {
    observedAppliedSeq: appliedSeq,
    observedStatus: status,
    observedErrorMessage: errorMessage,
    observedServicesJson: safeJsonStringify(deployment.services),
    observedDeployStatusJson: safeJsonStringify(deployment.deployStatus),
    observedDiskTelemetryJson: safeJsonStringify(deployment.diskTelemetry),
    observedAt,
    updatedAt: observedAt,
  };

  if (routingRevision !== null) {
    update.observedRoutingRevision = routingRevision;
    update.observedRoutingAt = observedAt;
  }
  if (routingStatus !== null) {
    update.observedRoutingStatus = routingStatus;
    update.observedRoutingAt = observedAt;
  }
  if (routingError !== null) {
    update.observedRoutingError = routingError;
    update.observedRoutingAt = observedAt;
  }

  return update;
}

export function toObservedDeploymentState(
  row: Pick<
    schema.DeploymentEnvironmentRow,
    | 'observedAppliedSeq'
    | 'observedStatus'
    | 'observedErrorMessage'
    | 'observedRoutingRevision'
    | 'observedRoutingStatus'
    | 'observedRoutingError'
    | 'observedRoutingAt'
    | 'observedServicesJson'
    | 'observedDeployStatusJson'
    | 'observedDiskTelemetryJson'
    | 'observedAt'
  >
): ObservedDeploymentState {
  return {
    appliedSeq: row.observedAppliedSeq ?? null,
    status: row.observedStatus ?? null,
    errorMessage: row.observedErrorMessage ?? null,
    routingRevision: row.observedRoutingRevision ?? 0,
    routingStatus: row.observedRoutingStatus ?? null,
    routingError: row.observedRoutingError ?? null,
    routingObservedAt: row.observedRoutingAt ?? null,
    services: parseJsonField(row.observedServicesJson),
    deployStatus: parseJsonField(row.observedDeployStatusJson),
    diskTelemetry: parseJsonField(row.observedDiskTelemetryJson),
    observedAt: row.observedAt ?? null,
  };
}

export function parseAllowedDeployProfileIds(value: string | null | undefined): string[] {
  const parsed = parseJsonField(value);
  if (!Array.isArray(parsed)) return [];
  const unique = new Set<string>();
  for (const item of parsed) {
    if (typeof item === 'string' && item.trim()) {
      unique.add(item.trim());
    }
  }
  return [...unique];
}

export function uniqueDeployProfileIds(values: string[] | null | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function toDeploymentAgentPolicy(
  row: Pick<
    schema.DeploymentEnvironmentRow,
    | 'agentDeployEnabled'
    | 'agentDeployEnabledBy'
    | 'agentDeployEnabledAt'
    | 'agentDeployDisabledAt'
    | 'allowedDeployProfileIdsJson'
  >
): DeploymentAgentPolicy {
  return {
    agentDeployEnabled: Boolean(row.agentDeployEnabled),
    agentDeployEnabledBy: row.agentDeployEnabledBy ?? null,
    agentDeployEnabledAt: row.agentDeployEnabledAt ?? null,
    agentDeployDisabledAt: row.agentDeployDisabledAt ?? null,
    allowedDeployProfileIds: parseAllowedDeployProfileIds(row.allowedDeployProfileIdsJson),
  };
}

export async function reconcileDeploymentReleaseStatuses(
  db: ReturnType<typeof drizzle<typeof schema>>,
  environmentId: string,
  deployment: DeploymentHeartbeatState
): Promise<void> {
  const appliedSeq = normalizeAppliedSeq(deployment.appliedSeq) ?? 0;
  const status = normalizeStatus(deployment.status);
  if (!status) return;

  const latestRows = await db
    .select({
      id: schema.deploymentReleases.id,
      version: schema.deploymentReleases.version,
      status: schema.deploymentReleases.status,
    })
    .from(schema.deploymentReleases)
    .where(eq(schema.deploymentReleases.environmentId, environmentId))
    .orderBy(desc(schema.deploymentReleases.version))
    .limit(1);

  const latest = latestRows[0];

  if (appliedSeq > 0 && APPLY_SUCCESS_STATUSES.has(status)) {
    await db
      .update(schema.deploymentReleases)
      .set({ status: 'applied' })
      .where(
        and(
          eq(schema.deploymentReleases.environmentId, environmentId),
          eq(schema.deploymentReleases.version, appliedSeq)
        )
      );
  }

  if (!latest) return;

  if (status === 'applying' && latest.version > appliedSeq) {
    await db
      .update(schema.deploymentReleases)
      .set({ status: 'applying' })
      .where(eq(schema.deploymentReleases.id, latest.id));
    return;
  }

  if (status === 'applied' && latest.version === appliedSeq && latest.status !== 'applied') {
    await db
      .update(schema.deploymentReleases)
      .set({ status: 'applied' })
      .where(eq(schema.deploymentReleases.id, latest.id));
    return;
  }

  if (TERMINAL_FAILURE_STATUSES.has(status) && latest.version > appliedSeq) {
    const failedVersion = appliedSeq + 1;
    const failedRows = await db
      .select({
        id: schema.deploymentReleases.id,
        status: schema.deploymentReleases.status,
      })
      .from(schema.deploymentReleases)
      .where(
        and(
          eq(schema.deploymentReleases.environmentId, environmentId),
          eq(schema.deploymentReleases.version, failedVersion)
        )
      )
      .limit(1);
    const failedRelease = failedRows[0];
    if (!failedRelease || failedRelease.status === 'failed') return;

    await db
      .update(schema.deploymentReleases)
      .set({ status: 'failed' })
      .where(eq(schema.deploymentReleases.id, failedRelease.id));
  }
}

export async function getTaskAgentProfileId(
  db: ReturnType<typeof drizzle<typeof schema>>,
  taskId: string
): Promise<string | null> {
  if (!taskId) return null;
  const rows = await db
    .select({ agentProfileHint: schema.tasks.agentProfileHint })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);
  return rows[0]?.agentProfileHint ?? null;
}

export function isDeploymentPolicyAllowedForProfile(
  policy: DeploymentAgentPolicy,
  taskAgentProfileId: string | null | undefined
): boolean {
  if (!policy.agentDeployEnabled) {
    return false;
  }
  const normalizedProfileId = taskAgentProfileId?.trim() || null;
  return (
    policy.allowedDeployProfileIds.length === 0 ||
    (normalizedProfileId !== null && policy.allowedDeployProfileIds.includes(normalizedProfileId))
  );
}

export async function assertAgentDeploymentAllowed(
  db: ReturnType<typeof drizzle<typeof schema>>,
  projectId: string,
  environmentName: string,
  tokenData: McpTokenData
): Promise<
  | { environmentId: string; policy: DeploymentAgentPolicy; taskAgentProfileId: string | null }
  | { error: string }
> {
  const taskAgentProfileId = tokenData.taskId
    ? await getTaskAgentProfileId(db, tokenData.taskId)
    : null;

  return assertAgentDeploymentAllowedForProfile(
    db,
    projectId,
    environmentName,
    taskAgentProfileId,
    { taskId: tokenData.taskId || null }
  );
}

export async function assertAgentDeploymentAllowedForProfile(
  db: ReturnType<typeof drizzle<typeof schema>>,
  projectId: string,
  environmentName: string,
  taskAgentProfileId: string | null | undefined,
  context: { taskId?: string | null } = {}
): Promise<
  | { environmentId: string; policy: DeploymentAgentPolicy; taskAgentProfileId: string | null }
  | { error: string }
> {
  const rows = await db
    .select({
      id: schema.deploymentEnvironments.id,
      agentDeployEnabled: schema.deploymentEnvironments.agentDeployEnabled,
      agentDeployEnabledBy: schema.deploymentEnvironments.agentDeployEnabledBy,
      agentDeployEnabledAt: schema.deploymentEnvironments.agentDeployEnabledAt,
      agentDeployDisabledAt: schema.deploymentEnvironments.agentDeployDisabledAt,
      allowedDeployProfileIdsJson: schema.deploymentEnvironments.allowedDeployProfileIdsJson,
    })
    .from(schema.deploymentEnvironments)
    .where(
      and(
        eq(schema.deploymentEnvironments.projectId, projectId),
        eq(schema.deploymentEnvironments.name, environmentName),
        eq(schema.deploymentEnvironments.status, 'active')
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    return {
      error: `Deployment environment '${environmentName}' not found or inactive for this project.`,
    };
  }

  const policy = toDeploymentAgentPolicy(row);
  if (!policy.agentDeployEnabled) {
    return {
      error: `Agent deployment is disabled for environment '${environmentName}'. Enable it in the deployment environment policy before agents can use deployment tools.`,
    };
  }

  const normalizedProfileId = taskAgentProfileId?.trim() || null;

  if (!isDeploymentPolicyAllowedForProfile(policy, normalizedProfileId)) {
    log.warn('deployment_agent_policy.denied_profile', {
      projectId,
      environmentName,
      taskId: context.taskId ?? null,
      taskProfileId: normalizedProfileId,
    });
    return {
      error: `This agent profile is not allowed to deploy to environment '${environmentName}'.`,
    };
  }

  return { environmentId: row.id, policy, taskAgentProfileId: normalizedProfileId };
}

/**
 * Project-level agent-deploy gate for workspace callback flows that cannot
 * carry task/profile context, such as the VM-agent's internal registry
 * credential mint during a server-side build-and-publish. Agent-facing MCP
 * tools must use environment-scoped {@link assertAgentDeploymentAllowed}
 * before reaching those callback flows.
 */
export async function getProjectAgentDeployEnvironmentId(
  db: ReturnType<typeof drizzle<typeof schema>>,
  projectId: string
): Promise<string | null> {
  const rows = await db
    .select({ id: schema.deploymentEnvironments.id })
    .from(schema.deploymentEnvironments)
    .where(
      and(
        eq(schema.deploymentEnvironments.projectId, projectId),
        eq(schema.deploymentEnvironments.status, 'active'),
        eq(schema.deploymentEnvironments.agentDeployEnabled, true)
      )
    )
    .orderBy(schema.deploymentEnvironments.createdAt)
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function isProjectAgentDeployEnabled(
  db: ReturnType<typeof drizzle<typeof schema>>,
  projectId: string
): Promise<boolean> {
  return (await getProjectAgentDeployEnvironmentId(db, projectId)) !== null;
}

export function encodeAllowedDeployProfileIds(
  profileIds: string[] | null | undefined
): string | null {
  const unique = uniqueDeployProfileIds(profileIds);
  if (unique.length === 0) {
    return null;
  }
  return JSON.stringify(unique);
}

export async function validateAllowedDeployProfiles(
  db: ReturnType<typeof drizzle<typeof schema>>,
  projectId: string,
  allowedProfileIds: string[]
): Promise<void> {
  if (allowedProfileIds.length === 0) return;

  const rows = await db
    .select({ id: schema.agentProfiles.id })
    .from(schema.agentProfiles)
    .where(
      and(
        eq(schema.agentProfiles.projectId, projectId),
        inArray(schema.agentProfiles.id, allowedProfileIds)
      )
    );

  const found = new Set(rows.map((row) => row.id));
  const missing = allowedProfileIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(`Agent profile(s) not found in this project: ${missing.join(', ')}`);
  }
}

export type CreateAgentDeploymentEnvironmentResult =
  | { environment: schema.DeploymentEnvironmentRow; creatorProfileId: string }
  | { error: string; code: 'invalid_context' | 'invalid_name' | 'conflict' | 'invalid_profile' };

export async function createAgentDeploymentEnvironment(
  db: ReturnType<typeof drizzle<typeof schema>>,
  projectId: string,
  name: string,
  tokenData: McpTokenData,
  reservedEnvironmentNamesConfig?: string | null
): Promise<CreateAgentDeploymentEnvironmentResult> {
  const normalizedName = name.trim();
  if (!DEPLOYMENT_ENVIRONMENT_NAME_RE.test(normalizedName)) {
    return {
      code: 'invalid_name',
      error: 'Name must be lowercase alphanumeric with optional hyphens, 1-63 chars.',
    };
  }
  const reservedEnvironmentNames = parseReservedAgentEnvironmentNames(
    reservedEnvironmentNamesConfig
  );
  if (reservedEnvironmentNames.has(normalizedName)) {
    return {
      code: 'invalid_name',
      error:
        'Agents cannot create reserved deployment environment names through MCP. Ask the project owner to create this environment.',
    };
  }
  if (!tokenData.taskId) {
    return {
      code: 'invalid_context',
      error: 'Creating a deployment environment requires an MCP token with a task context.',
    };
  }

  const creatorProfileId = await getTaskAgentProfileId(db, tokenData.taskId);
  if (!creatorProfileId) {
    return {
      code: 'invalid_context',
      error:
        'Creating a deployment environment requires the current task to have a resolved agent profile.',
    };
  }

  try {
    await validateAllowedDeployProfiles(db, projectId, [creatorProfileId]);
  } catch (err) {
    return {
      code: 'invalid_profile',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const existing = await db
    .select({ id: schema.deploymentEnvironments.id })
    .from(schema.deploymentEnvironments)
    .where(
      and(
        eq(schema.deploymentEnvironments.projectId, projectId),
        eq(schema.deploymentEnvironments.name, normalizedName)
      )
    )
    .limit(1);
  if (existing.length > 0) {
    return {
      code: 'conflict',
      error: `Environment "${normalizedName}" already exists in this project`,
    };
  }

  const now = new Date().toISOString();
  const id = ulid();
  await db.insert(schema.deploymentEnvironments).values({
    id,
    projectId,
    name: normalizedName,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    createdByUserId: tokenData.userId,
    createdByAgentProfileId: creatorProfileId,
    createdByTaskId: tokenData.taskId,
    createdByWorkspaceId: tokenData.workspaceId || null,
    creationSource: AGENT_CREATED_ENVIRONMENT_SOURCE,
    agentDeployEnabled: true,
    agentDeployEnabledBy: tokenData.userId,
    agentDeployEnabledAt: now,
    agentDeployDisabledAt: null,
    allowedDeployProfileIdsJson: encodeAllowedDeployProfileIds([creatorProfileId]),
  });

  const [environment] = await db
    .select()
    .from(schema.deploymentEnvironments)
    .where(eq(schema.deploymentEnvironments.id, id))
    .limit(1);
  if (!environment) {
    return {
      code: 'conflict',
      error: 'Deployment environment could not be loaded after creation.',
    };
  }

  log.info('deployment_environment.agent_created', {
    projectId,
    environmentId: id,
    name: normalizedName,
    taskId: tokenData.taskId,
    creatorProfileId,
  });

  return { environment, creatorProfileId };
}

function parseReservedAgentEnvironmentNames(configValue: string | null | undefined): Set<string> {
  const rawNames =
    typeof configValue === 'string' && configValue.trim() !== ''
      ? configValue.split(',')
      : DEFAULT_RESERVED_AGENT_ENVIRONMENT_NAMES;

  return new Set(rawNames.map((name) => name.trim()).filter((name) => name !== ''));
}
